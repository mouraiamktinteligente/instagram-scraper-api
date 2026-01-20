/**
 * Instagram Service
 * Core scraping service using Playwright with multi-account login support
 */

const { firefox } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const speakeasy = require('speakeasy');
const config = require('../config');
const logger = require('../utils/logger');
const accountPool = require('./accountPool.service');
const aiSelectorFallback = require('./aiSelectorFallback.service');
const commentExtractor = require('./commentExtractor.service');
const {
    parseComment,
    getRandomUserAgent,
    getBrowserHeaders,
    randomDelay,
    extractPostId,
} = require('../utils/helpers');
const stealthService = require('./browser/stealth');

// Initialize Supabase client
const supabase = createClient(config.supabase.url, config.supabase.key);

// Services will be initialized async before first use
let servicesInitialized = false;

async function initializeServices() {
    if (servicesInitialized) return;

    await accountPool.initialize();
    servicesInitialized = true;
    logger.info('Instagram services initialized');
}

class InstagramService {
    constructor() {
        this.browser = null;
    }

    /**
     * Upload a debug screenshot to Supabase Storage
     * @param {Page} page - Playwright page
     * @param {string} stepName - Name of the step (e.g., 'login-step1', '2fa-before-submit')
     * @returns {Promise<string|null>} Public URL of the screenshot or null
     */
    async uploadDebugScreenshot(page, stepName) {
        try {
            const timestamp = Date.now();
            const screenshotBuffer = await page.screenshot({ fullPage: false });

            // Generate filename with step and timestamp
            const fileName = `debug/login/${stepName}-${timestamp}.png`;

            const { data: uploadData, error: uploadError } = await supabase.storage
                .from('screenshot')
                .upload(fileName, screenshotBuffer, {
                    contentType: 'image/png',
                    upsert: true
                });

            if (uploadError) {
                logger.warn(`[DEBUG] Screenshot upload error: ${uploadError.message}`);
                return null;
            }

            // Get public URL
            const { data: urlData } = supabase.storage
                .from('screenshot')
                .getPublicUrl(fileName);

            logger.info(`[DEBUG] 📸 Screenshot [${stepName}]: ${urlData.publicUrl}`);
            return urlData.publicUrl;
        } catch (error) {
            logger.warn(`[DEBUG] Screenshot capture failed: ${error.message}`);
            return null;
        }
    }

    /**
     * Main method to scrape comments from an Instagram post
     * @param {string} postUrl - Instagram post URL
     * @param {Object} proxy - Optional proxy configuration
     * @returns {Promise<Object>} Scraping result
     */
    async scrapeComments(postUrl, proxy = null, jobId = null, maxComments = null) {
        const postId = extractPostId(postUrl);
        if (!postId) {
            throw new Error('Invalid Instagram post URL');
        }

        // Ensure services are initialized (loads from database)
        await initializeServices();

        logger.info('[SCRAPE] Starting comment scrape', { postId, postUrl });

        let browser = null;
        let context = null;
        const comments = [];

        try {
            // Get next available account
            const account = accountPool.getNextAccount();
            if (!account) {
                throw new Error('No Instagram accounts available. Configure INSTAGRAM_ACCOUNTS env variable.');
            }

            logger.info(`[SCRAPE] Using account: ${account.username}`);

            // Reset comment extractor for this session (clear hashes)
            commentExtractor.reset();

            // Launch browser
            browser = await this.launchBrowser(proxy);

            // Create browser context
            context = await this.createBrowserContext(browser);

            // Try to load existing session or perform login
            const loggedIn = await this.ensureLoggedIn(context, account);
            if (!loggedIn) {
                accountPool.reportError(account.username, 'Login failed');
                throw new Error(`Failed to login with account ${account.username}`);
            }

            // Create page and setup interception
            const page = await context.newPage();
            this.setupInterception(page, comments, postId, postUrl);

            // Navigate to the post (optionally via profile first for human-like behavior)
            await this.navigateToPost(page, postUrl, false); // Set to true to visit profile first

            // Extract post metadata (author, description, likes)
            const postMetadata = await this.extractPostMetadata(page);

            // ⭐ RESET PAGE POSITION: Scroll to top to ensure proper viewport
            // This fixes issues where page loads with partial scroll, causing elements to be off-screen
            logger.info('[SCRAPE] 🔄 Resetting page position (scroll to top)...');
            await page.evaluate(() => window.scrollTo(0, 0));
            await randomDelay(300, 500);
            await page.evaluate(() => window.scrollTo(0, 0)); // Second scroll to ensure
            await randomDelay(500, 800);

            // Wait for comments to load
            await this.waitForComments(page);

            // Try to expand all comments (click "View all X comments" button)
            const expanded = await this.expandAllComments(page);
            if (expanded) {
                // ⭐ CRITICAL: Wait for GraphQL API to respond BEFORE scrolling
                logger.info('[SCRAPE] ⏳ Waiting for initial GraphQL response...');
                const initialCount = await this.waitForInitialGraphQLResponse(page, comments, 60000);
                logger.info(`[SCRAPE] ✅ Initial GraphQL loaded: ${initialCount} comments`);
            }

            // Scroll to load more comments (with optional limit)
            // ⭐ First, dismiss any blocking popups (Save Login Info, etc.)
            await this.dismissBlockingPopups(page);
            await this.scrollForMoreComments(page, maxComments, comments);

            // NEW FALLBACK: Extract visible comments from DOM directly (after scroll)
            // This catches comments that are visible in the modal/page but not intercepted via GraphQL
            if (comments.length < 20) {
                logger.info('[SCRAPE] 📥 Scrolling modal and extracting visible comments from DOM...');

                // First, aggressively scroll the modal to load ALL comments
                await this.scrollModalToLoadAllComments(page);

                const visibleComments = await this.extractVisibleCommentsFromDOM(page, postId, postUrl);
                if (visibleComments.length > 0) {
                    logger.info(`[SCRAPE] DOM extraction found ${visibleComments.length} comments`);

                    // Merge with existing, avoiding duplicates by text prefix
                    const existingTexts = new Set(comments.map(c => c.text?.substring(0, 40)));
                    let added = 0;
                    for (const domComment of visibleComments) {
                        const textKey = domComment.text?.substring(0, 40);
                        if (textKey && !existingTexts.has(textKey)) {
                            comments.push(domComment);
                            existingTexts.add(textKey);
                            added++;
                        }
                    }
                    logger.info(`[SCRAPE] Added ${added} new comments from DOM (total: ${comments.length})`);
                }
            }

            // Fallback 1: Extract comments from script tags (preloaded data)
            if (comments.length === 0) {
                logger.info('[SCRAPE] Trying to extract from script tags...');
                const scriptComments = await this.extractCommentsFromScripts(page, postId, postUrl);
                comments.push(...scriptComments);
            }

            // Fallback 2: Extract comments from DOM if still no comments
            if (comments.length === 0) {
                const domComments = await this.extractCommentsFromDOM(page, postId, postUrl);
                comments.push(...domComments);
            }

            // Fallback 3: If we have very few comments, use AI to detect total and extract ALL
            // Instagram typically shows ~15 comments initially, but posts often have more
            if (comments.length >= 0 && comments.length < 20) {
                logger.info(`[SCRAPE] Found only ${comments.length} comments, using AI to get all...`);

                try {
                    // Use the intelligent extraction that detects total and scrolls to load all
                    const aiResult = await aiSelectorFallback.extractAllCommentsWithAI(page, postId, postUrl);

                    if (aiResult.comments.length > 0) {
                        logger.info(`[SCRAPE] 🤖 AI extracted ${aiResult.comments.length}/${aiResult.totalExpected} comments (${aiResult.coverage}% coverage)`);

                        // Replace with AI comments if we got more
                        if (aiResult.comments.length > comments.length) {
                            // Merge: add AI comments that aren't already in our list
                            const existingTexts = new Set(comments.map(c => c.text?.substring(0, 50)));
                            for (const aiComment of aiResult.comments) {
                                const textKey = aiComment.text?.substring(0, 50);
                                if (!existingTexts.has(textKey)) {
                                    comments.push(aiComment);
                                    existingTexts.add(textKey);
                                }
                            }
                        }

                        logger.info(`[SCRAPE] Total after AI merge: ${comments.length} comments`);
                    }
                } catch (aiError) {
                    logger.warn('[SCRAPE] AI full extraction failed:', aiError.message);
                }
            }

            // Fallback 4: window._sharedData (quando GraphQL/DOM falham completamente)
            if (comments.length < 5) {
                logger.warn('[SCRAPE] Very few comments, trying window._sharedData fallback...');

                const sharedDataComments = await this.extractSharedData(page, postId, postUrl);

                if (sharedDataComments.length > 0) {
                    logger.info(`[SCRAPE] ✅ window._sharedData rescued ${sharedDataComments.length} comments!`);

                    // Merge com comentários existentes
                    const existingTexts = new Set(comments.map(c => c.text?.substring(0, 40)));
                    let added = 0;
                    for (const sdComment of sharedDataComments) {
                        const textKey = sdComment.text?.substring(0, 40);
                        if (textKey && !existingTexts.has(textKey)) {
                            comments.push(sdComment);
                            existingTexts.add(textKey);
                            added++;
                        }
                    }
                    logger.info(`[SCRAPE] Added ${added} new comments from _sharedData (total: ${comments.length})`);
                }
            }

            // Report success
            accountPool.reportSuccess(account.username);

            // Save comments to database
            const savedCount = await this.saveComments(comments, postId);

            logger.info('[SCRAPE] Scrape completed', {
                postId,
                commentsFound: comments.length,
                commentsSaved: savedCount,
                postAuthor: postMetadata.post_author,
            });

            return {
                success: true,
                postId,
                postUrl,
                commentsCount: comments.length,
                savedCount,
                account: account.username,
                // Post metadata
                post_author: postMetadata.post_author,
                post_description: postMetadata.post_description,
                post_likes_count: postMetadata.post_likes_count,
            };

        } catch (error) {
            logger.error('Error scraping comments:', {
                postUrl,
                error: error.message,
                stack: error.stack
            });
            throw error;

        } finally {
            if (context) {
                try { await context.close(); } catch (e) { /* ignore */ }
            }
            if (browser) {
                try { await browser.close(); } catch (e) { /* ignore */ }
            }
        }
    }

    /**
     * Ensure user is logged in, either by loading session or performing login
     * @param {BrowserContext} context 
     * @param {Object} account 
     * @returns {Promise<boolean>}
     */
    async ensureLoggedIn(context, account) {
        // Try to load existing session
        const cookies = accountPool.loadSession(account.username);
        if (cookies && cookies.length > 0) {
            await context.addCookies(cookies);
            logger.debug(`Loaded existing session for ${account.username}`);

            // Verify session is still valid
            const page = await context.newPage();
            try {
                await page.goto('https://www.instagram.com/', {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000
                });
                await randomDelay(2000, 3000);

                // Check if we're still logged in
                const isLoggedIn = await this.checkLoggedIn(page);
                await page.close();

                if (isLoggedIn) {
                    logger.info(`Session valid for ${account.username}`);
                    return true;
                }
                logger.warn(`Session expired for ${account.username}, will re-login`);
            } catch (error) {
                logger.warn(`Error verifying session: ${error.message}`);
                try { await page.close(); } catch (e) { /* ignore */ }
            }
        }

        // Perform fresh login
        return await this.performLogin(context, account);
    }

    /**
     * Check if currently logged in
     * @param {Page} page 
     * @returns {Promise<boolean>}
     */
    async checkLoggedIn(page) {
        try {
            // Look for elements that only appear when logged in
            const loggedInIndicators = [
                'svg[aria-label="Home"]',
                'svg[aria-label="Início"]',
                'a[href="/direct/inbox/"]',
                'span[aria-label="Profile"]'
            ];

            for (const selector of loggedInIndicators) {
                const element = await page.$(selector);
                if (element) return true;
            }

            // Check URL - if redirected to login, not logged in
            const url = page.url();
            if (url.includes('/accounts/login')) return false;

            // Check for login form
            const loginForm = await page.$('input[name="username"]');
            if (loginForm) return false;

            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Perform Instagram login
     * @param {BrowserContext} context 
     * @param {Object} account 
     * @returns {Promise<boolean>}
     */
    async performLogin(context, account) {
        const page = await context.newPage();

        try {
            logger.info(`[LOGIN] Starting login for ${account.username}`);

            // Step 1: Navigate to login page and wait for React to render
            logger.info('[LOGIN] Step 1: Navigating to login page...');
            await page.goto('https://www.instagram.com/accounts/login/', {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });

            // Wait for JavaScript to fully execute (Instagram is a React SPA)
            logger.info('[LOGIN] Step 1: Waiting for JavaScript to render...');
            try {
                // Wait for any input or button to appear (React hydration)
                await page.waitForFunction(() => {
                    return document.querySelectorAll('input').length > 0 ||
                        document.querySelectorAll('button').length > 0 ||
                        document.body.innerText.length > 100;
                }, { timeout: 30000 });
                logger.info('[LOGIN] Step 1: JavaScript rendered content');
            } catch (e) {
                logger.warn('[LOGIN] Step 1: Timeout waiting for JS render, continuing...');
            }

            // Additional wait for full page load
            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
            logger.info('[LOGIN] Step 1: Login page loaded');

            // 📸 DEBUG SCREENSHOT: Capture state after page load
            await this.uploadDebugScreenshot(page, 'step1-page-loaded');

            await randomDelay(3000, 5000);  // Longer delay to let React fully hydrate

            // Step 2: Handle cookie consent modal - REQUIRED before login form appears
            logger.info('[LOGIN] Step 2: Handling cookie consent...');
            try {
                // Wait a bit for cookie dialog to appear
                await randomDelay(1000, 2000);

                // Multiple possible selectors for cookie consent
                const cookieSelectors = [
                    // English variants
                    'button:has-text("Allow all cookies")',
                    'button:has-text("Allow essential and optional cookies")',
                    'button:has-text("Accept All")',
                    'button:has-text("Accept")',
                    'button:has-text("Only allow essential cookies")',
                    // Portuguese variants
                    'button:has-text("Permitir todos os cookies")',
                    'button:has-text("Permitir cookies essenciais e opcionais")',
                    'button:has-text("Aceitar tudo")',
                    'button:has-text("Aceitar")',
                    'button:has-text("Permitir somente cookies essenciais")',
                    // Generic patterns
                    '[role="dialog"] button:first-of-type',
                    'div[role="dialog"] button',
                    'button._a9--._a9_1',
                ];

                let clicked = false;
                for (const selector of cookieSelectors) {
                    try {
                        const btn = await page.$(selector);
                        if (btn) {
                            const isVisible = await btn.isVisible();
                            if (isVisible) {
                                await btn.click();
                                logger.info(`[LOGIN] Step 2: Cookie consent clicked (${selector})`);
                                clicked = true;
                                await randomDelay(2000, 3000);
                                break;
                            }
                        }
                    } catch (e) {
                        // Try next selector
                    }
                }

                if (!clicked) {
                    // Try clicking any visible button in a dialog
                    const dialogButtons = await page.$$('[role="dialog"] button, [role="presentation"] button');
                    for (const btn of dialogButtons) {
                        try {
                            const isVisible = await btn.isVisible();
                            if (isVisible) {
                                const text = await btn.textContent();
                                logger.info(`[LOGIN] Step 2: Found dialog button with text: "${text}"`);
                                if (text && (text.toLowerCase().includes('allow') ||
                                    text.toLowerCase().includes('accept') ||
                                    text.toLowerCase().includes('permitir') ||
                                    text.toLowerCase().includes('aceitar'))) {
                                    await btn.click();
                                    logger.info('[LOGIN] Step 2: Clicked cookie button by text match');
                                    clicked = true;
                                    await randomDelay(2000, 3000);
                                    break;
                                }
                            }
                        } catch (e) {
                            continue;
                        }
                    }
                }

                if (!clicked) {
                    logger.warn('[LOGIN] Step 2: No cookie consent button found - continuing anyway');
                }
            } catch (e) {
                logger.warn('[LOGIN] Step 2: Cookie consent handling error:', e.message);
            }

            // Step 3: Debug - log what's on the page
            logger.info('[LOGIN] Step 3: Analyzing page content...');
            try {
                // Wait for page to be fully loaded
                await page.waitForLoadState('domcontentloaded');
                await randomDelay(2000, 3000);

                // Log page title and current URL
                const title = await page.title();
                const currentUrl = page.url();
                logger.info(`[LOGIN] Page title: "${title}"`);
                logger.info(`[LOGIN] Current URL: ${currentUrl}`);

                // Check what elements exist on the page
                const hasUsernameInput = await page.$('input[name="username"]');
                const hasPasswordInput = await page.$('input[name="password"]');
                const hasLoginButton = await page.$('button[type="submit"]');
                const hasAnyInput = await page.$$('input');
                const hasAnyButton = await page.$$('button');

                logger.info(`[LOGIN] Found elements: username=${!!hasUsernameInput}, password=${!!hasPasswordInput}, loginBtn=${!!hasLoginButton}`);
                logger.info(`[LOGIN] Total inputs: ${hasAnyInput.length}, Total buttons: ${hasAnyButton.length}`);

                // Log first 500 chars of page content for debugging
                const bodyContent = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || 'No body content');
                logger.info(`[LOGIN] Page text preview: ${bodyContent.replace(/\n/g, ' ').substring(0, 200)}`);

                // Check if page is showing login blocked message
                const pageHtml = await page.content();
                if (pageHtml.includes('suspicious') || pageHtml.includes('Suspicious')) {
                    logger.error('[LOGIN] Instagram detected suspicious activity');
                }
                if (pageHtml.includes('try again') || pageHtml.includes('Try Again')) {
                    logger.error('[LOGIN] Instagram showing "try again" message');
                }
                if (pageHtml.includes('JavaScript') || pageHtml.includes('javascript')) {
                    logger.warn('[LOGIN] Page may require JavaScript - checking...');
                }

            } catch (debugError) {
                logger.warn('[LOGIN] Debug error:', debugError.message);
            }

            // Step 4: Wait for and fill username (with longer timeout)
            logger.info('[LOGIN] Step 4: Waiting for username field...');

            // Try multiple selectors for username field
            const usernameSelectors = [
                'input[name="username"]',
                'input[aria-label="Phone number, username, or email"]',
                'input[aria-label="Telefone, nome de usuário ou email"]',
                'input[type="text"]',
                'form input:first-of-type'
            ];

            let usernameInput = null;
            for (const selector of usernameSelectors) {
                try {
                    await page.waitForSelector(selector, { timeout: 5000 });
                    usernameInput = await page.$(selector);
                    if (usernameInput) {
                        logger.info(`[LOGIN] Found username field with selector: ${selector}`);
                        break;
                    }
                } catch (e) {
                    // Try next selector
                }
            }

            if (!usernameInput) {
                logger.error('[LOGIN] Could not find any username input field!');
                logger.error('[LOGIN] This may be due to Instagram blocking headless browsers');

                // 📸 DEBUG SCREENSHOT: Capture state when username field not found
                await this.uploadDebugScreenshot(page, 'error-no-username-field');

                await page.close();
                return false;
            }

            await usernameInput.fill(account.username);
            logger.info('[LOGIN] Step 4: Username filled');
            await randomDelay(500, 1000);

            // Step 5: Fill password - use type selector for new Instagram structure
            logger.info('[LOGIN] Step 5: Filling password...');

            // Try multiple selectors for password field
            const passwordSelectors = [
                'input[name="password"]',
                'input[type="password"]',
                'input[aria-label*="password"]',
                'input[aria-label*="Senha"]',
            ];

            let passwordFilled = false;
            for (const selector of passwordSelectors) {
                try {
                    const pwdField = await page.$(selector);
                    if (pwdField) {
                        await pwdField.fill(account.password);
                        passwordFilled = true;
                        logger.info(`[LOGIN] Step 5: Password filled using ${selector}`);
                        break;
                    }
                } catch (e) {
                    // Try next selector
                }
            }

            if (!passwordFilled) {
                logger.error('[LOGIN] Could not find password field');
                await page.close();
                return false;
            }

            await randomDelay(500, 1000);

            // Step 6: Click login button - try multiple selectors (Instagram changes frequently)
            logger.info('[LOGIN] Step 6: Clicking login button...');

            const loginButtonSelectors = [
                'button[type="submit"]',
                'button:has-text("Log in")',
                'button:has-text("Log In")',
                'button:has-text("Entrar")',
                'div[role="button"]:has-text("Log in")',
                'div[role="button"]:has-text("Entrar")',
                'button._acan._acap._acas._aj1-._ap30',
                'form button',
            ];

            let loginClicked = false;
            for (const selector of loginButtonSelectors) {
                try {
                    const btn = await page.$(selector);
                    if (btn && await btn.isVisible()) {
                        // Use force:true and multiple click strategies
                        await btn.click({ force: true });
                        loginClicked = true;
                        logger.info(`[LOGIN] Step 6: Clicked login button with selector: ${selector}`);
                        break;
                    }
                } catch (e) {
                    // Try next selector
                }
            }

            // ALWAYS try Enter key as redundancy (most reliable)
            logger.info('[LOGIN] Step 6: Pressing Enter key as redundancy...');
            await page.keyboard.press('Enter');
            await randomDelay(1000, 1500);

            // Try clicking again with JavaScript if first click didn't work
            if (loginClicked) {
                try {
                    await page.evaluate(() => {
                        const btns = document.querySelectorAll('button, div[role="button"]');
                        for (const btn of btns) {
                            const text = btn.innerText?.toLowerCase() || '';
                            if (text.includes('entrar') || text.includes('log in')) {
                                btn.click();
                                break;
                            }
                        }
                    });
                    logger.info('[LOGIN] Step 6: JavaScript click executed');
                } catch (e) {
                    // Ignore JS click errors
                }
            }

            logger.info('[LOGIN] Step 6: Login button clicked, waiting for response...');

            // Step 6: Wait for navigation or error - increase wait time
            await randomDelay(6000, 10000);

            const currentUrl = page.url();
            logger.info(`[LOGIN] Step 6: Current URL after login attempt: ${currentUrl}`);

            // 📸 DEBUG SCREENSHOT: Capture state after login attempt
            await this.uploadDebugScreenshot(page, 'step6-after-login-click');

            // Step 7: Check for various states
            // Check for login error message
            const errorMessage = await page.$('p[data-testid="login-error-message"]');
            if (errorMessage) {
                const errorText = await errorMessage.textContent();
                logger.error(`[LOGIN] Error message found: ${errorText}`);
                await page.close();
                return false;
            }

            // Check for checkpoint/challenge (includes 2FA)
            if (currentUrl.includes('challenge') || currentUrl.includes('checkpoint') || currentUrl.includes('two_factor')) {
                logger.info('[LOGIN] Step 7: 2FA/Challenge detected, checking if we can handle it...');

                // Check if this is a 2FA challenge we can handle
                const is2FAChallenge = await this.handle2FAChallenge(page, account);

                if (is2FAChallenge) {
                    // Check if we successfully completed 2FA
                    const finalUrl = page.url();
                    if (!finalUrl.includes('challenge') && !finalUrl.includes('checkpoint') && !finalUrl.includes('two_factor')) {
                        logger.info('[LOGIN] ✅ 2FA completed successfully!');

                        // ⭐ IMPROVEMENT: Click "Trust this device" to avoid 2FA in future logins
                        logger.info('[LOGIN] Step 7b: Looking for "Trust this device" option...');
                        try {
                            await randomDelay(1000, 2000);
                            const trustSelectors = [
                                // Checkbox for "Confiar neste dispositivo"
                                'input[type="checkbox"]',
                                'label:has-text("Confiar")',
                                'label:has-text("Trust")',
                                '[class*="checkbox"]',
                            ];

                            for (const selector of trustSelectors) {
                                try {
                                    const trustCheckbox = await page.$(selector);
                                    if (trustCheckbox) {
                                        const isChecked = await trustCheckbox.isChecked().catch(() => false);
                                        if (!isChecked) {
                                            await trustCheckbox.click();
                                            logger.info(`[LOGIN] ✅ Checked "Trust this device": ${selector}`);
                                            await randomDelay(500, 1000);
                                        }
                                        break;
                                    }
                                } catch (e) { /* try next */ }
                            }
                        } catch (e) {
                            logger.debug('[LOGIN] No trust device option found (this is OK)');
                        }

                        // Continue with login success flow
                    } else {
                        logger.error('[LOGIN] ❌ 2FA failed - still on challenge page');
                        await page.close();
                        return false;
                    }
                } else {
                    logger.error('[LOGIN] Instagram requires verification (challenge/checkpoint) that we cannot handle');
                    logger.error('[LOGIN] Please verify the account manually first');
                    await page.close();
                    return false;
                }
            }

            // Check for suspicious login activity
            const suspiciousLogin = await page.$('text=Suspicious Login Attempt');
            if (suspiciousLogin) {
                logger.error('[LOGIN] Suspicious login attempt detected');
                await page.close();
                return false;
            }

            // Check if still on login page
            if (currentUrl.includes('/accounts/login')) {
                logger.warn('[LOGIN] Still on login page, checking for errors...');

                // Get page content for debugging
                const pageContent = await page.content();
                const pageText = await page.evaluate(() => document.body?.innerText || '');

                // Log first 500 chars of page text for debugging
                logger.info('[LOGIN] Page text after login attempt:', {
                    preview: pageText.substring(0, 500).replace(/\n/g, ' ')
                });

                // ⭐ FIX: Check if this is actually a 2FA page by content (even if URL is still /login/#)
                const is2FAByContent =
                    pageText.includes('código de 6 dígitos') ||
                    pageText.includes('6-digit code') ||
                    pageText.includes('Código de segurança') ||
                    pageText.includes('Security code') ||
                    pageText.includes('app de autenticação') ||
                    pageText.includes('authentication app') ||
                    pageText.includes('Duo Mobile') ||
                    pageText.includes('Google Authenticator');

                if (is2FAByContent) {
                    logger.info('[LOGIN] ✅ 2FA page detected by content (URL still shows /login/#)');
                    logger.info('[LOGIN] Redirecting to 2FA handler...');

                    // Handle 2FA
                    const is2FAChallenge = await this.handle2FAChallenge(page, account);

                    if (is2FAChallenge) {
                        const finalUrl = page.url();
                        if (!finalUrl.includes('challenge') && !finalUrl.includes('checkpoint') && !finalUrl.includes('two_factor') && !finalUrl.includes('/accounts/login')) {
                            logger.info('[LOGIN] ✅ 2FA completed successfully!');
                            // Continue with login success flow below
                        } else {
                            logger.error('[LOGIN] ❌ 2FA failed - still on challenge page');
                            await page.close();
                            return false;
                        }
                    } else {
                        logger.error('[LOGIN] ❌ 2FA handler failed');
                        await page.close();
                        return false;
                    }
                } else {
                    // Try to get any visible error text
                    if (pageContent.includes('Sorry, your password was incorrect') || pageText.includes('senha incorreta')) {
                        logger.error('[LOGIN] Password incorrect');
                    } else if (pageContent.includes('Please wait a few minutes') || pageText.includes('Aguarde alguns minutos')) {
                        logger.error('[LOGIN] Rate limited - too many attempts');
                    } else if (pageText.includes('suspeita') || pageText.includes('suspicious')) {
                        logger.error('[LOGIN] Suspicious activity detected');
                    } else if (pageText.includes('verificar') || pageText.includes('verify') || pageText.includes('codigo')) {
                        logger.error('[LOGIN] Verification required');
                    } else if (pageText.includes('incorreta') || pageText.includes('incorrect') || pageText.includes('errada')) {
                        logger.error('[LOGIN] Credentials incorrect');
                    } else {
                        logger.error('[LOGIN] Unknown error - still on login page');
                        // Log more details for debugging
                        logger.debug('[LOGIN] Full page text:', { text: pageText.substring(0, 2000) });
                    }

                    // 📸 DEBUG SCREENSHOT: Capture state when login error
                    await this.uploadDebugScreenshot(page, 'error-still-on-login-page');

                    await page.close();
                    return false;
                }
            }

            // Step 8: Handle post-login popups
            logger.info('[LOGIN] Step 8: Handling post-login popups...');
            await randomDelay(2000, 3000);

            // Handle "Save Login Info" popup - both English and Portuguese
            try {
                // Try Portuguese first (Agora não), then English (Not Now)
                const dismissSelectors = [
                    'button:has-text("Agora não")',
                    'button:has-text("Agora Não")',
                    'div[role="button"]:has-text("Agora não")',
                    'button:has-text("Not Now")',
                    'button:has-text("Not now")',
                ];

                for (const selector of dismissSelectors) {
                    try {
                        const btn = await page.$(selector);
                        if (btn) {
                            await btn.click();
                            logger.info(`[LOGIN] Clicked dismiss button: ${selector}`);
                            await randomDelay(1500, 2500);
                            break;
                        }
                    } catch (e) { /* try next selector */ }
                }
            } catch (e) { /* ignore */ }

            // Handle notifications popup
            try {
                const notificationDismiss = [
                    'button:has-text("Agora não")',
                    'button:has-text("Not Now")',
                    'button:has-text("Turn On")',
                ];

                for (const selector of notificationDismiss) {
                    try {
                        const btn = await page.$(selector);
                        if (btn) {
                            await btn.click();
                            logger.info('[LOGIN] Dismissed notifications popup');
                            await randomDelay(1000, 2000);
                            break;
                        }
                    } catch (e) { /* try next */ }
                }
            } catch (e) { /* ignore */ }

            // Step 9: Verify login succeeded
            logger.info('[LOGIN] Step 9: Verifying login success...');
            const isLoggedIn = await this.checkLoggedIn(page);

            if (isLoggedIn) {
                // Save session cookies
                const cookies = await context.cookies();
                await accountPool.saveSession(account.username, cookies);
                logger.info(`[LOGIN] ✅ Login successful for ${account.username}`);
                await page.close();
                return true;
            }

            logger.error(`[LOGIN] ❌ Login verification failed for ${account.username}`);
            logger.error(`[LOGIN] Final URL: ${page.url()}`);
            await page.close();
            return false;

        } catch (error) {
            logger.error(`[LOGIN] ❌ Exception during login for ${account.username}: ${error.message}`);

            // Try to capture current state
            try {
                const url = page.url();
                logger.error(`[LOGIN] URL at error: ${url}`);
            } catch (e) { /* ignore */ }

            try { await page.close(); } catch (e) { /* ignore */ }
            return false;
        }
    }

    /**
     * Handle 2FA challenge by generating TOTP code
     * Improvements: time tolerance, robustClick, error detection, retry with new code
     * @param {Page} page
     * @param {Object} account
     * @param {number} retryCount - Current retry attempt (max 3)
     * @returns {Promise<boolean>} true if 2FA was handled, false if not
     */
    async handle2FAChallenge(page, account, retryCount = 0) {
        const MAX_2FA_RETRIES = 3;

        // Check if account has TOTP secret
        if (!account.totpSecret) {
            logger.warn('[2FA] Account does not have TOTP secret configured');
            return false;
        }

        try {
            logger.info('[2FA] ========================================');
            logger.info(`[2FA] 🔐 2FA ATTEMPT ${retryCount + 1}/${MAX_2FA_RETRIES}`);
            logger.info('[2FA] ========================================');
            logger.info(`[2FA] Account: ${account.username}`);
            logger.info(`[2FA] TOTP Secret (first 8 chars): ${account.totpSecret.substring(0, 8)}...`);
            logger.info(`[2FA] Current URL: ${page.url()}`);

            // ⭐ TIME SYNC CHECK: Log server time for debugging
            const serverTime = new Date();
            logger.info(`[2FA] ⏱️ Server time: ${serverTime.toISOString()} (UTC offset: ${serverTime.getTimezoneOffset()} min)`);

            // Wait for the 2FA page to fully load
            logger.info('[2FA] Waiting for 2FA page to stabilize...');
            await randomDelay(2000, 3000);

            // Wait for network idle
            try {
                await page.waitForLoadState('networkidle', { timeout: 5000 });
            } catch (e) { /* ignore timeout */ }

            // 📸 DEBUG SCREENSHOT: Capture 2FA page state
            await this.uploadDebugScreenshot(page, `2fa-attempt-${retryCount + 1}`);

            // ⭐ IMPROVEMENT 1: Generate TOTP with time tolerance
            // Wait until we're at least 5 seconds into a new period to avoid expiration during submission
            const currentTime = Math.floor(Date.now() / 1000);
            const timeInPeriod = currentTime % 30;

            if (timeInPeriod > 25) {
                // Too close to next period, wait for new code
                const waitTime = (30 - timeInPeriod + 2) * 1000;
                logger.info(`[2FA] ⏳ Waiting ${waitTime}ms for fresh TOTP code (current position: ${timeInPeriod}s)`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }

            // Generate TOTP code using 2fa.live API (more reliable than local speakeasy)
            // The 2fa.live service generates codes that work correctly with Instagram

            // ⭐ Sanitize TOTP secret: remove spaces and convert to uppercase
            const sanitizedSecret = account.totpSecret.replace(/\s+/g, '').toUpperCase();

            // Log secret validation info
            logger.info(`[2FA] 🔑 Secret length: ${sanitizedSecret.length} chars`);
            logger.info(`[2FA] 🔑 Secret preview: ${sanitizedSecret.substring(0, 4)}...${sanitizedSecret.substring(sanitizedSecret.length - 4)}`);

            let totpCode = null;

            // ⭐ PRIMARY: Use 2fa.live API for TOTP generation
            try {
                logger.info(`[2FA] 🌐 Fetching TOTP from 2fa.live API...`);

                const https = require('https');
                const fetch2faCode = () => {
                    return new Promise((resolve, reject) => {
                        const req = https.get(`https://2fa.live/tok/${sanitizedSecret}`, { timeout: 5000 }, (res) => {
                            let data = '';
                            res.on('data', chunk => data += chunk);
                            res.on('end', () => {
                                try {
                                    const json = JSON.parse(data);
                                    resolve(json.token);
                                } catch (e) {
                                    reject(new Error('Invalid JSON response'));
                                }
                            });
                        });
                        req.on('error', reject);
                        req.on('timeout', () => {
                            req.destroy();
                            reject(new Error('Request timeout'));
                        });
                    });
                };

                totpCode = await fetch2faCode();
                logger.info(`[2FA] ✅ 2fa.live returned code: ${totpCode}`);

            } catch (apiError) {
                logger.warn(`[2FA] ⚠️ 2fa.live API failed: ${apiError.message}`);
                logger.info(`[2FA] 🔄 Falling back to local speakeasy generation...`);

                // FALLBACK: Use local speakeasy if API fails
                const totpWindow = retryCount === 0 ? 1 : 2;
                totpCode = speakeasy.totp({
                    secret: sanitizedSecret,
                    encoding: 'base32',
                    window: totpWindow,
                    step: 30
                });
                logger.info(`[2FA] ✅ Speakeasy fallback code: ${totpCode}`);
            }

            // Log timing info
            const currentTimeInPeriod = Math.floor(Date.now() / 1000) % 30;
            logger.info(`[2FA] ⏰ Time in period: ${currentTimeInPeriod}s (code valid for ~${30 - currentTimeInPeriod}s)`);

            // Log page content for debugging
            const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
            logger.info(`[2FA] Page content: ${pageText.replace(/\n/g, ' ').substring(0, 200)}...`);

            // Look for 2FA code input field (various selectors)
            const codeInputSelectors = [
                'input[name="verificationCode"]',
                'input[name="security_code"]',
                'input[aria-label*="Security code"]',
                'input[aria-label*="código"]',
                'input[aria-label*="Código"]',
                'input[aria-label*="Código de segurança"]',
                'input[placeholder*="code"]',
                'input[placeholder*="código"]',
                'input[type="text"][maxlength="6"]',
                'input[type="number"]',
                'input[type="tel"]',
            ];

            let codeInput = null;
            for (const selector of codeInputSelectors) {
                try {
                    codeInput = await page.waitForSelector(selector, { timeout: 2000 });
                    if (codeInput) {
                        const isVisible = await codeInput.isVisible().catch(() => false);
                        if (isVisible) {
                            logger.info(`[2FA] ✅ Found input: ${selector}`);
                            break;
                        }
                        codeInput = null;
                    }
                } catch (e) { /* try next */ }
            }

            if (!codeInput) {
                logger.error('[2FA] ❌ Could not find 2FA code input field');
                const inputs = await page.$$eval('input', inputs =>
                    inputs.map(i => `${i.name || i.type || 'unknown'}[${i.placeholder || ''}]`)
                );
                logger.error(`[2FA] Available inputs: ${inputs.join(', ')}`);
                return false;
            }

            // Clear and type the code with human-like delay
            logger.info('[2FA] 📝 Filling code input...');
            await codeInput.click();
            await randomDelay(200, 400);
            await codeInput.fill('');
            await randomDelay(100, 200);

            // Type code one digit at a time for more human-like behavior
            for (const digit of totpCode) {
                await codeInput.type(digit, { delay: 100 + Math.random() * 100 });
            }

            // Verify what was typed
            const typedValue = await codeInput.inputValue();
            logger.info(`[2FA] Typed value: ${typedValue} (match: ${typedValue === totpCode})`);

            if (typedValue !== totpCode) {
                logger.error('[2FA] ❌ Code mismatch! Retrying...');
                await codeInput.fill('');
                await codeInput.type(totpCode, { delay: 150 });
            }

            // Wait before submitting
            await randomDelay(800, 1200);

            // ⭐ IMPROVEMENT 2: Use robustClick for the submit button
            const submitSelectors = [
                'button[type="submit"]',
                'button:has-text("Confirmar")',
                'button:has-text("Confirm")',
                'button:has-text("Verificar")',
                'button:has-text("Verify")',
                'div[role="button"]:has-text("Confirmar")',
                'div[role="button"]:has-text("Confirm")',
            ];

            let submitBtn = null;
            let submitSelector = '';
            for (const selector of submitSelectors) {
                try {
                    submitBtn = await page.$(selector);
                    if (submitBtn) {
                        const isVisible = await submitBtn.isVisible().catch(() => false);
                        if (isVisible) {
                            submitSelector = selector;
                            logger.info(`[2FA] ✅ Found submit button: ${selector}`);
                            break;
                        }
                        submitBtn = null;
                    }
                } catch (e) { /* try next */ }
            }

            if (!submitBtn) {
                logger.warn('[2FA] No submit button found, trying Enter key...');
                await codeInput.focus();
                await randomDelay(200, 300);
                await page.keyboard.press('Enter');
            } else {
                // Execute robustClick (multiple strategies)
                logger.info('[2FA] 🖱️ Executing robust multi-strategy click...');

                // Strategy 1: Regular click with hover
                try {
                    await submitBtn.hover();
                    await randomDelay(200, 400);
                    await submitBtn.click();
                    logger.info('[2FA] Strategy 1 (hover+click): ✅');
                } catch (e) {
                    logger.warn(`[2FA] Strategy 1 failed: ${e.message}`);
                }

                await randomDelay(500, 800);

                // ⭐ Helper function to safely check if still on 2FA page
                const isStillOn2FAPage = async () => {
                    try {
                        const currentUrl = page.url();
                        // Success indicators: navigated away from two_factor
                        const successUrls = ['onetap', 'instagram.com/', 'accounts/access_tool'];
                        for (const successUrl of successUrls) {
                            if (currentUrl.includes(successUrl) && !currentUrl.includes('two_factor')) {
                                logger.info(`[2FA] ✅ Navigation detected! URL: ${currentUrl}`);
                                return false; // NOT on 2FA page = success!
                            }
                        }
                        return currentUrl.includes('two_factor') || currentUrl.includes('challenge');
                    } catch (e) {
                        // If we can't get URL, page may be navigating = potential success
                        logger.info('[2FA] Page may be navigating...');
                        await randomDelay(1000, 1500);
                        try {
                            const newUrl = page.url();
                            return newUrl.includes('two_factor') || newUrl.includes('challenge');
                        } catch (e2) {
                            return false; // Assume success if we can't get URL
                        }
                    }
                };

                // Check if still on 2FA page after Strategy 1
                if (await isStillOn2FAPage()) {
                    // Strategy 2: JavaScript click
                    logger.info('[2FA] Still on 2FA page, trying Strategy 2 (JS click)...');
                    try {
                        await page.evaluate((sel) => {
                            const btn = document.querySelector(sel) ||
                                document.querySelector('button[type="submit"]') ||
                                Array.from(document.querySelectorAll('button')).find(b =>
                                    b.textContent.includes('Confirm') || b.textContent.includes('Confirmar')
                                );
                            if (btn) btn.click();
                        }, submitSelector);
                        logger.info('[2FA] Strategy 2 (JS click): ✅');
                    } catch (e) {
                        logger.debug(`[2FA] Strategy 2 error: ${e.message}`);
                    }

                    await randomDelay(500, 800);
                }

                // Check again
                if (await isStillOn2FAPage()) {
                    // Strategy 3: Dispatchevent click
                    logger.info('[2FA] Trying Strategy 3 (dispatchEvent)...');
                    try {
                        await page.evaluate(() => {
                            const btn = document.querySelector('button[type="submit"]') ||
                                Array.from(document.querySelectorAll('button')).find(b =>
                                    b.textContent.includes('Confirm') || b.textContent.includes('Confirmar')
                                );
                            if (btn) {
                                btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                            }
                        });
                        logger.info('[2FA] Strategy 3 (dispatchEvent): ✅');
                    } catch (e) {
                        logger.debug(`[2FA] Strategy 3 error: ${e.message}`);
                    }

                    await randomDelay(500, 800);
                }

                // Check again
                if (await isStillOn2FAPage()) {
                    // Strategy 4: Form submit
                    logger.info('[2FA] Trying Strategy 4 (form.submit)...');
                    try {
                        await page.evaluate(() => {
                            const forms = document.querySelectorAll('form');
                            forms.forEach(f => {
                                try { f.submit(); } catch (e) { }
                            });
                        });
                    } catch (e) {
                        logger.debug(`[2FA] Strategy 4 error: ${e.message}`);
                    }

                    await randomDelay(500, 800);
                }

                // Strategy 5: Enter key as final fallback
                if (await isStillOn2FAPage()) {
                    logger.info('[2FA] Trying Strategy 5 (Enter key)...');
                    try {
                        await codeInput.focus();
                        await page.keyboard.press('Enter');
                    } catch (e) {
                        logger.debug(`[2FA] Strategy 5 error: ${e.message}`);
                    }
                }
            }

            // Wait for navigation/response
            logger.info('[2FA] ⏳ Waiting for response after submit...');
            await randomDelay(3000, 4000);

            // Wait for network idle
            try {
                await page.waitForLoadState('networkidle', { timeout: 8000 });
            } catch (e) { /* ignore */ }

            // ⭐ IMPROVEMENT 3: Check for error messages
            const urlAfterSubmit = page.url();
            logger.info(`[2FA] After submit - URL: ${urlAfterSubmit}`);

            // 📸 DEBUG SCREENSHOT: Capture state after 2FA submission
            await this.uploadDebugScreenshot(page, '2fa-after-submit');

            // Check for common error messages (Portuguese and English)
            const errorMessages = await page.evaluate(() => {
                const errorSelectors = [
                    '[role="alert"]',
                    '.error',
                    '[class*="error"]',
                    '[class*="Error"]',
                    'p[data-testid*="error"]',
                    'span[data-testid*="error"]',
                ];

                const errors = [];
                for (const sel of errorSelectors) {
                    const elements = document.querySelectorAll(sel);
                    elements.forEach(el => {
                        const text = el.textContent?.trim();
                        if (text && text.length > 5) errors.push(text);
                    });
                }

                // Also check page text for common error phrases
                const pageText = document.body?.innerText || '';
                const errorPhrases = [
                    'código incorreto',
                    'incorrect code',
                    'código inválido',
                    'invalid code',
                    'tente novamente',
                    'try again',
                    'expirou',
                    'expired',
                ];

                for (const phrase of errorPhrases) {
                    if (pageText.toLowerCase().includes(phrase.toLowerCase())) {
                        errors.push(`Found phrase: "${phrase}"`);
                    }
                }

                return errors;
            });

            if (errorMessages.length > 0) {
                logger.error(`[2FA] ❌ Error messages detected: ${errorMessages.join(' | ')}`);
            }

            // Check if we're still on 2FA page or if we succeeded
            // SUCCESS URLs: onetap (save login), home page, feed, etc.
            const successIndicators = ['onetap', 'instagram.com/$', 'instagram.com/?'];
            const isSuccess = successIndicators.some(indicator => {
                if (indicator.includes('$')) {
                    // Exact match for home
                    return urlAfterSubmit === 'https://www.instagram.com/' ||
                        urlAfterSubmit.endsWith('instagram.com/');
                }
                return urlAfterSubmit.includes(indicator);
            });

            // Also check: NOT on two_factor AND NOT on challenge
            const stillOnChallenge = urlAfterSubmit.includes('two_factor') ||
                urlAfterSubmit.includes('challenge');

            if (isSuccess || !stillOnChallenge) {
                // Success! 
                logger.info('[2FA] ✅ Successfully passed 2FA challenge!');
                logger.info(`[2FA] New URL: ${urlAfterSubmit}`);
                return true;
            }

            // Still on challenge page
            logger.warn('[2FA] ⚠️ Still on 2FA/challenge page after submit');

            // ⭐ IMPROVEMENT 4: Retry with new code
            if (retryCount < MAX_2FA_RETRIES - 1) {
                logger.info(`[2FA] 🔄 Retrying with fresh TOTP code (attempt ${retryCount + 2}/${MAX_2FA_RETRIES})...`);

                // ⚠️ FIX: Don't wait 31 seconds - page may expire! 
                // With window=2 we already have tolerance, just wait 5s for page stability
                const waitForRetry = 5000;
                logger.info(`[2FA] ⏳ Waiting ${waitForRetry / 1000}s before retry...`);
                await new Promise(resolve => setTimeout(resolve, waitForRetry));

                // Check if page expired during wait
                const currentPageText = await page.evaluate(() => document.body?.innerText || '');
                logger.info(`[2FA] 📄 Page text before retry (first 200 chars): ${currentPageText.substring(0, 200).replace(/\n/g, ' ')}`);

                if (currentPageText.includes('não está disponível') || currentPageText.includes('not available') || currentPageText.includes('foi removida')) {
                    logger.error('[2FA] ❌ Page expired or invalid - Instagram rejected the code');

                    // 📸 DEBUG SCREENSHOT: Capture expired page
                    await this.uploadDebugScreenshot(page, '2fa-page-expired');

                    return false;
                }

                // Clear input and retry
                try {
                    const retryInput = await page.$('input[name="verificationCode"]') ||
                        await page.$('input[type="text"][maxlength="6"]');
                    if (retryInput) {
                        await retryInput.fill('');
                    }
                } catch (e) { /* ignore */ }

                return await this.handle2FAChallenge(page, account, retryCount + 1);
            }

            logger.error(`[2FA] ❌ All ${MAX_2FA_RETRIES} attempts failed`);
            return false;

        } catch (error) {
            logger.error('[2FA] ❌ Exception in 2FA handler:', error.message);

            // IMPORTANT: Check if we actually succeeded despite the exception
            // (navigation during click can cause exceptions but still work)
            try {
                const currentUrl = page.url();
                logger.info(`[2FA] Exception occurred, but checking URL: ${currentUrl}`);

                // If we're on onetap or home, 2FA actually succeeded!
                if (currentUrl.includes('onetap') ||
                    (currentUrl.includes('instagram.com') && !currentUrl.includes('two_factor') && !currentUrl.includes('challenge'))) {
                    logger.info('[2FA] ✅ Exception occurred but 2FA actually succeeded! (navigation completed)');
                    return true;
                }
            } catch (urlError) {
                // Can't get URL, page might be navigating = potential success
                logger.info('[2FA] Could not check URL, waiting...');
                await randomDelay(2000, 3000);
                try {
                    const newUrl = page.url();
                    if (!newUrl.includes('two_factor') && !newUrl.includes('challenge')) {
                        logger.info('[2FA] ✅ 2FA succeeded after exception!');
                        return true;
                    }
                } catch (e) { /* ignore */ }
            }

            // Retry on exception if we're still on 2FA page
            if (retryCount < MAX_2FA_RETRIES - 1) {
                logger.info(`[2FA] 🔄 Retrying after exception (attempt ${retryCount + 2}/${MAX_2FA_RETRIES})...`);
                await randomDelay(5000, 8000);
                return await this.handle2FAChallenge(page, account, retryCount + 1);
            }

            return false;
        }
    }

    /**
     * Launch Playwright browser
     * @param {Object} proxy - Optional proxy configuration
     * @returns {Promise<Browser>}
     */
    async launchBrowser(proxy = null) {
        const launchOptions = {
            headless: true,
            // Firefox-specific args
            firefoxUserPrefs: {
                'media.navigator.enabled': false,
                'media.peerconnection.enabled': false,
            },
        };

        if (proxy && proxy.server) {
            // Try passing credentials separately (Playwright's recommended approach)
            launchOptions.proxy = {
                server: proxy.server,  // Without credentials in URL
            };

            // Add credentials if available
            if (proxy.username) {
                launchOptions.proxy.username = proxy.username;
            }
            if (proxy.password) {
                launchOptions.proxy.password = proxy.password;
            }

            logger.info('[BROWSER] Using proxy:', {
                server: proxy.server,
                hasUsername: !!proxy.username,
                hasPassword: !!proxy.password,
            });
        }

        logger.info('[BROWSER] Launching Firefox browser...');
        return await firefox.launch(launchOptions);
    }

    /**
     * Create browser context with realistic settings
     * @param {Browser} browser
     * @returns {Promise<BrowserContext>}
     */
    async createBrowserContext(browser) {
        // Randomize viewport to avoid fingerprinting
        const viewports = [
            { width: 1920, height: 1080 },
            { width: 1366, height: 768 },
            { width: 1536, height: 864 },
            { width: 1440, height: 900 },
            { width: 1280, height: 720 },
        ];
        const randomViewport = viewports[Math.floor(Math.random() * viewports.length)];

        // Random device scale factor
        const scaleFactors = [1, 1.25, 1.5];
        const randomScale = scaleFactors[Math.floor(Math.random() * scaleFactors.length)];

        const context = await browser.newContext({
            userAgent: getRandomUserAgent(),
            locale: 'pt-BR',
            timezoneId: 'America/Sao_Paulo',
            viewport: randomViewport,
            deviceScaleFactor: randomScale,
            hasTouch: false,
            extraHTTPHeaders: getBrowserHeaders(),
            colorScheme: Math.random() > 0.5 ? 'light' : 'dark',
            javaScriptEnabled: true,
            bypassCSP: true,
        });

        logger.debug('[BROWSER] Context created with viewport:', randomViewport);

        // Enhanced stealth scripts to avoid detection
        await context.addInitScript(() => {
            // Remove webdriver property
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            delete navigator.__proto__.webdriver;

            // Add realistic plugins array
            Object.defineProperty(navigator, 'plugins', {
                get: () => {
                    const plugins = [
                        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
                    ];
                    plugins.length = 3;
                    return plugins;
                },
            });

            // Add realistic mimeTypes
            Object.defineProperty(navigator, 'mimeTypes', {
                get: () => {
                    const mimeTypes = [
                        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
                        { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' }
                    ];
                    mimeTypes.length = 2;
                    return mimeTypes;
                },
            });

            // Add languages
            Object.defineProperty(navigator, 'languages', {
                get: () => ['pt-BR', 'pt', 'en-US', 'en'],
            });

            // Add platform
            Object.defineProperty(navigator, 'platform', {
                get: () => 'Win32',
            });

            // Add deviceMemory
            Object.defineProperty(navigator, 'deviceMemory', {
                get: () => 8,
            });

            // Add hardwareConcurrency
            Object.defineProperty(navigator, 'hardwareConcurrency', {
                get: () => 8,
            });

            // Fix permissions
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) =>
                parameters.name === 'notifications'
                    ? Promise.resolve({ state: 'denied' })
                    : originalQuery(parameters);

            // Add chrome object (important for detection)
            window.chrome = {
                runtime: {},
                loadTimes: function () { },
                csi: function () { },
                app: {}
            };

            // Fix iframe contentWindow access
            const originalIframeContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
            Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
                get: function () {
                    return originalIframeContentWindow.get.call(this);
                }
            });

            // Add WebGL vendor and renderer
            const getParameterProxyHandler = {
                apply: function (target, thisArg, args) {
                    const param = args[0];
                    const gl = thisArg;
                    // UNMASKED_VENDOR_WEBGL
                    if (param === 37445) return 'Google Inc. (NVIDIA)';
                    // UNMASKED_RENDERER_WEBGL
                    if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0, D3D11)';
                    return target.apply(thisArg, args);
                }
            };

            try {
                const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
                WebGLRenderingContext.prototype.getParameter = new Proxy(originalGetParameter, getParameterProxyHandler);
            } catch (e) { }

            try {
                const originalGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
                WebGL2RenderingContext.prototype.getParameter = new Proxy(originalGetParameter2, getParameterProxyHandler);
            } catch (e) { }
        });

        // Apply additional stealth patches from stealth service
        logger.info('[STEALTH] Applying additional anti-detection patches...');
        await stealthService.applyStealthPatches(context);

        return context;
    }

    /**
     * Setup response interception to capture comments from GraphQL responses
     * @param {Page} page
     * @param {Array} comments - Array to store intercepted comments
     * @param {string} postId
     * @param {string} postUrl
     */
    setupInterception(page, comments, postId, postUrl) {
        // Counter for API calls
        let apiCallCount = 0;
        let commentApiCalls = 0;

        page.on('response', async (response) => {
            const url = response.url();
            const status = response.status();

            // Skip non-success responses
            if (status < 200 || status >= 300) return;

            // Check for any API/GraphQL endpoints
            const isApiCall =
                url.includes('/graphql') ||
                url.includes('/api/') ||
                url.includes('/web/') ||
                url.includes('query') ||
                url.includes('/v1/');

            if (!isApiCall) return;

            try {
                const ct = (response.headers()['content-type'] || '').toLowerCase();
                if (!ct.includes('json') && !url.includes('graphql')) return;

                apiCallCount++;
                const data = await response.json();

                // Log summary of API call for debugging
                const urlShort = url.split('?')[0].substring(url.indexOf('instagram.com') + 13);
                logger.debug(`[INTERCEPT] API #${apiCallCount}: ${urlShort}`);

                // Log response structure keys for debugging
                const topKeys = Object.keys(data || {});
                const dataKeys = data?.data ? Object.keys(data.data) : [];
                logger.info(`[INTERCEPT] API #${apiCallCount} structure: top=[${topKeys.join(',')}] data=[${dataKeys.join(',')}]`);

                // If this looks like a comment-related response, log more details
                const jsonStr = JSON.stringify(data).substring(0, 500);
                if (jsonStr.includes('comment') || jsonStr.includes('edge_media')) {
                    logger.info(`[INTERCEPT] 📝 Potential comment data in API #${apiCallCount}`);
                    // Log first comment-like object structure if found
                    const samplePath = this.findCommentPath(data);
                    if (samplePath) {
                        logger.info(`[INTERCEPT] Comment path found: ${samplePath}`);
                    }
                }

                // Deep search for comments in the response
                // Using the new commentExtractor for GraphQL data
                const extractedComments = commentExtractor.extractFromGraphQL(data, postId, postUrl);

                if (extractedComments.length > 0) {
                    commentApiCalls++;
                    logger.info(`[INTERCEPT] 🎯 Found ${extractedComments.length} NEW comments in API call #${apiCallCount}`);

                    // Log sample comment for debugging
                    const sample = extractedComments[0];
                    logger.info(`[INTERCEPT] Sample comment: id=${sample.comment_id}, text="${sample.text?.substring(0, 30)}...", user=${sample.username}`);

                    // Add to comments array (already deduplicated by commentExtractor)
                    for (const comment of extractedComments) {
                        comments.push(comment);
                    }

                    logger.info(`[INTERCEPT] Total comments so far: ${comments.length} (${commentExtractor.getStats().uniqueHashes} unique hashes)`);

                    // ⭐ LOG PAGINATION INFO to understand if more comments are available
                    const paginationInfo = this.extractPaginationInfo(data);
                    if (paginationInfo) {
                        logger.info(`[INTERCEPT] 📄 Pagination: has_next_page=${paginationInfo.hasNextPage}, cursor=${paginationInfo.endCursor ? paginationInfo.endCursor.substring(0, 30) + '...' : 'none'}`);
                    }
                }

            } catch (e) {
                // Ignore parsing errors
            }
        });

        // Log interception setup
        logger.info('[INTERCEPT] GraphQL/API interception enabled');
    }

    /**
     * Deep search for comments in any JSON structure
     * Uses recursive pattern matching to find comment-like objects
     * Also extracts nested replies with parent_comment_id
     */
    deepSearchForComments(obj, postId, postUrl, depth = 0, parentCommentId = null) {
        const comments = [];
        const maxDepth = 15;

        if (depth > maxDepth || !obj) return comments;

        // If it's an array, search each element
        if (Array.isArray(obj)) {
            for (const item of obj) {
                comments.push(...this.deepSearchForComments(item, postId, postUrl, depth + 1, parentCommentId));
            }
            return comments;
        }

        // If it's not an object, skip
        if (typeof obj !== 'object') return comments;

        // Check if this object looks like a comment
        if (this.looksLikeComment(obj)) {
            const parsed = parseComment(obj, postId, postUrl, parentCommentId);
            if (parsed && parsed.comment_id && parsed.text) {
                comments.push(parsed);

                // Extract replies/child comments
                const replyContainers = [
                    obj.edge_threaded_comments?.edges,
                    obj.replies?.edges,
                    obj.preview_child_comments,
                    obj.child_comments,
                    obj.child_comments?.edges
                ];

                for (const replies of replyContainers) {
                    if (Array.isArray(replies) && replies.length > 0) {
                        logger.debug(`[REPLIES] Found ${replies.length} replies for comment ${parsed.comment_id}`);
                        for (const reply of replies) {
                            const replyNode = reply.node || reply;
                            if (this.looksLikeComment(replyNode)) {
                                const replyParsed = parseComment(replyNode, postId, postUrl, parsed.comment_id);
                                if (replyParsed && replyParsed.comment_id && replyParsed.text) {
                                    comments.push(replyParsed);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Also check for edge/node structures
        if (obj.node && this.looksLikeComment(obj.node)) {
            const parsed = parseComment(obj.node, postId, postUrl, parentCommentId);
            if (parsed && parsed.comment_id && parsed.text) {
                comments.push(parsed);

                // Extract replies from node
                const replyContainers = [
                    obj.node.edge_threaded_comments?.edges,
                    obj.node.replies?.edges,
                    obj.node.preview_child_comments,
                    obj.node.child_comments
                ];

                for (const replies of replyContainers) {
                    if (Array.isArray(replies) && replies.length > 0) {
                        logger.debug(`[REPLIES] Found ${replies.length} replies for node comment ${parsed.comment_id}`);
                        for (const reply of replies) {
                            const replyNode = reply.node || reply;
                            if (this.looksLikeComment(replyNode)) {
                                const replyParsed = parseComment(replyNode, postId, postUrl, parsed.comment_id);
                                if (replyParsed && replyParsed.comment_id && replyParsed.text) {
                                    comments.push(replyParsed);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Recursively search all object properties (but skip reply containers we already processed)
        for (const key of Object.keys(obj)) {
            // Skip properties that are unlikely to contain comments or already processed
            if (['extensions', 'headers', 'request_id', 'trace_id', 'edge_threaded_comments', 'preview_child_comments', 'child_comments'].includes(key)) continue;

            // Prioritize properties that likely contain comments
            const priorityKeys = ['edges', 'comments', 'comment', 'nodes', 'items', 'data', 'threads'];

            if (priorityKeys.includes(key) || key.includes('comment')) {
                comments.push(...this.deepSearchForComments(obj[key], postId, postUrl, depth + 1, null));
            } else if (typeof obj[key] === 'object') {
                comments.push(...this.deepSearchForComments(obj[key], postId, postUrl, depth + 1, null));
            }
        }

        return comments;
    }

    /**
     * Find the path to comment data in the response (for debugging)
     */
    findCommentPath(obj, path = '', depth = 0) {
        if (depth > 10 || !obj) return null;

        if (typeof obj !== 'object') return null;

        // Check for comment-related key names
        const commentKeys = ['edge_media_to_comment', 'edge_media_to_parent_comment', 'comments', 'comment_list'];

        for (const key of Object.keys(obj)) {
            if (commentKeys.some(ck => key.includes(ck))) {
                const value = obj[key];
                if (value && (value.edges || value.length > 0 || value.count !== undefined)) {
                    return `${path}.${key}`;
                }
            }

            if (typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
                const result = this.findCommentPath(obj[key], `${path}.${key}`, depth + 1);
                if (result) return result;
            }
        }

        return null;
    }
    /**
     * Extract pagination information from GraphQL response
     * Looks for has_next_page and end_cursor in the response
     */
    extractPaginationInfo(obj, depth = 0) {
        if (depth > 15 || !obj) return null;

        // Check if this object directly has pagination info
        if (obj.page_info && typeof obj.page_info === 'object') {
            return {
                hasNextPage: obj.page_info.has_next_page || false,
                endCursor: obj.page_info.end_cursor || null
            };
        }

        // Also check for has_next_page at this level
        if ('has_next_page' in obj && 'end_cursor' in obj) {
            return {
                hasNextPage: obj.has_next_page || false,
                endCursor: obj.end_cursor || null
            };
        }

        // Recursively search in nested objects
        if (typeof obj === 'object') {
            for (const key of Object.keys(obj)) {
                const value = obj[key];
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    const result = this.extractPaginationInfo(value, depth + 1);
                    if (result) return result;
                }
            }
        }

        return null;
    }

    /**
     * Check if an object looks like a real Instagram comment
     * Real structure: { pk, user: { username }, text, created_at }
     */
    looksLikeComment(obj) {
        if (!obj || typeof obj !== 'object') return false;

        // Get text from various possible properties
        const text = obj.text || obj.comment_text || obj.body || '';
        const hasText = typeof text === 'string' && text.length > 0;

        // Check for comment ID (pk is most common in Instagram)
        const commentId = obj.pk || obj.id || obj.comment_id || obj.node_id;
        const hasId = !!commentId;

        // Check for user info - Instagram uses user.username structure
        let hasUser = false;
        let username = '';

        if (obj.user && typeof obj.user === 'object' && obj.user.username) {
            hasUser = true;
            username = obj.user.username;
        } else if (obj.owner && typeof obj.owner === 'object' && obj.owner.username) {
            hasUser = true;
            username = obj.owner.username;
        } else if (obj.username) {
            hasUser = true;
            username = obj.username;
        }

        // Must have text AND (ID or user info)
        if (!hasText) return false;
        if (!hasId && !hasUser) return false;

        // Filter out Instagram UI elements by ID pattern
        const idStr = String(commentId || '').toLowerCase();
        const uiElementPatterns = [
            'snooze', 'dont_suggest', 'hide_', 'not_interested', 'report',
            'block', 'restrict', 'uncomfortable', 'feedback', 'about_this',
            'why_seeing', 'cancel', '_author', '_posts', 'suggested', 'menu'
        ];

        for (const pattern of uiElementPatterns) {
            if (idStr.includes(pattern)) {
                logger.debug(`[FILTER] Rejecting UI element: id=${idStr}`);
                return false;
            }
        }

        // Filter out UI text patterns
        const textLower = text.toLowerCase();
        const uiTextPatterns = [
            'ativar modo', 'não sugerir', 'ocultar', 'denunciar', 'bloquear',
            'restringir', 'não me senti', 'sobre esta conta', 'cancelar',
            'add to favorites', 'go to post', 'embed', 'share to', 'copy link',
            'hide like count', 'turn off commenting', 'escalar sem'
        ];

        for (const pattern of uiTextPatterns) {
            if (textLower.includes(pattern)) {
                logger.debug(`[FILTER] Rejecting UI text: "${text.substring(0, 30)}"`);
                return false;
            }
        }

        // Real comments have created_at as Unix timestamp (number) or ISO string
        const hasTimestamp = typeof obj.created_at === 'number' ||
            (typeof obj.created_at === 'string' && obj.created_at.length > 0) ||
            typeof obj.created_time === 'number';

        // Log when we find a valid comment (for debugging)
        if (hasText && hasId && hasUser && hasTimestamp) {
            logger.debug(`[DETECT] Valid comment: pk=${commentId}, user=${username}, text="${text.substring(0, 20)}..."`);
            return true;
        }

        // Accept if has user and timestamp even without strict ID
        if (hasUser && hasTimestamp && hasText) {
            return true;
        }

        // Accept short emoji comments with user info
        if (hasUser && hasText && text.length < 50) {
            return true;
        }

        return false;
    }

    /**
     * Extract comments from GraphQL response data
     * @param {Object} data - Response data
     * @param {string} postId
     * @param {string} postUrl
     * @returns {Array} Extracted comments
     */
    extractCommentsFromResponse(data, postId, postUrl) {
        const comments = [];

        try {
            // Handle different response structures - Instagram changes these frequently
            const paths = [
                // GraphQL query response (classic)
                data?.data?.shortcode_media?.edge_media_to_parent_comment?.edges,
                data?.data?.shortcode_media?.edge_media_to_comment?.edges,

                // XDT structures (newer)
                data?.data?.xdt_shortcode_media?.edge_media_to_parent_comment?.edges,
                data?.data?.xdt_shortcode_media?.edge_media_to_comment?.edges,

                // API v1 connection structures (very common now)
                data?.data?.xdt_api__v1__media__comments__connection_v2?.edges,
                data?.data?.xdt_api__v1__media__comments__connection?.edges,
                data?.data?.xdt_api__v1__media__comments__threaded__connection?.edges,

                // Direct API responses
                data?.comments,
                data?.comment_list,
                data?.edges,

                // Sometimes nested under "data" directly
                data?.data?.comments,
                data?.data?.edges,
            ];

            for (const edges of paths) {
                if (Array.isArray(edges)) {
                    for (const edge of edges) {
                        const node = edge.node || edge;

                        // Ensure we have a comment_id (support pk as fallback)
                        if (!node.id && !node.pk && !node.comment_id) continue;

                        const comment = parseComment(node, postId, postUrl);
                        if (comment && comment.comment_id) {
                            comments.push(comment);

                            // Also extract reply comments from various structures
                            const replies =
                                node.edge_threaded_comments?.edges ||
                                node.replies?.edges ||
                                node.preview_child_comments ||
                                node.child_comments ||
                                [];

                            for (const reply of replies) {
                                const replyNode = reply.node || reply;
                                const replyComment = parseComment(replyNode, postId, postUrl);
                                if (replyComment && replyComment.comment_id) {
                                    comments.push(replyComment);
                                }
                            }
                        }
                    }
                }
            }

        } catch (e) {
            logger.debug('Error extracting comments from response:', e.message);
        }

        return comments;
    }

    /**
     * Navigate to the Instagram post with layout detection and FEED INLINE forcing
     * Instagram serves 2 different layouts - we need FEED_INLINE for reliable scraping
     * @param {Page} page
     * @param {string} postUrl
     */
    async navigateToPost(page, postUrl, visitProfileFirst = false) {
        // Option to navigate via profile first (more human-like)
        if (visitProfileFirst) {
            const username = this.extractUsernameFromPostPage(postUrl);
            if (username) {
                await this.navigateViaProfile(page, username, postUrl);
                return;
            }
        }

        logger.info('[SCRAPE] Navigating to post:', postUrl);

        // STRATEGY 1: First load Instagram feed to initialize session properly
        logger.info('[SCRAPE] Loading Instagram feed first (ensures proper session)...');
        try {
            await page.goto('https://www.instagram.com/', {
                waitUntil: 'domcontentloaded',
                timeout: 30000,
            });
            await page.waitForTimeout(2000);
        } catch (e) {
            logger.warn('[SCRAPE] Feed pre-load failed, continuing directly...');
        }

        // Navigate to post
        await page.goto(postUrl, {
            waitUntil: 'domcontentloaded',
            timeout: config.scraping.pageTimeout,
        });

        // Wait for JavaScript to render content
        logger.info('[SCRAPE] Waiting for post content to render...');
        try {
            await page.waitForFunction(() => {
                return document.querySelector('article') !== null ||
                    document.querySelector('div[role="dialog"]') !== null ||
                    document.querySelectorAll('img').length > 2 ||
                    document.body.innerText.length > 500;
            }, { timeout: 30000 });
            logger.info('[SCRAPE] Post content rendered');
        } catch (e) {
            logger.warn('[SCRAPE] Timeout waiting for post content, continuing...');
        }

        // Wait for network to settle
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

        // LAYOUT DETECTION: Check which layout Instagram served
        const layoutInfo = await this.detectLayoutType(page);
        logger.info('[LAYOUT] Detected layout:', layoutInfo);

        // If MODAL_POST_VIEW detected, try to convert to FEED_INLINE
        if (layoutInfo.layoutType === 'MODAL_POST_VIEW') {
            logger.warn('[LAYOUT] ⚠️ MODAL_POST_VIEW detected - may have limited scroll. Trying workarounds...');

            // The modal/post view is still usable, we just need different scroll strategy
            // Store layout type for later use in scroll functions
            this.currentLayoutType = 'MODAL_POST_VIEW';
            this.layoutInfo = layoutInfo;
        } else {
            this.currentLayoutType = layoutInfo.layoutType;
            this.layoutInfo = layoutInfo;
        }

        // Log current page state
        const pageInfo = await page.evaluate(() => ({
            url: window.location.href,
            title: document.title,
            hasArticle: !!document.querySelector('article'),
            hasDialog: !!document.querySelector('div[role="dialog"]'),
            imgCount: document.querySelectorAll('img').length,
            textLength: document.body?.innerText?.length || 0
        }));
        logger.info('[SCRAPE] Post page state:', pageInfo);

        // Simular comportamento humano para evitar detecção
        await this.humanDelay(1500, 3000);
        await this.simulateHumanBehavior(page);

        await randomDelay(2000, 4000);
    }

    /**
     * Detect which layout Instagram is serving
     * Uses ROBUST selectors based on visual structure, not just article/dialog
     * @param {Page} page 
     * @returns {Promise<Object>} Layout information
     */
    async detectLayoutType(page) {
        const detection = await page.evaluate(() => {
            // === ROBUST LAYOUT DETECTION ===
            // Multiple indicators to confidently detect MODAL vs FEED_INLINE

            // === INDICATOR 1: Dialog/Modal detection ===
            const dialogSelectors = [
                'div[role="dialog"]',
                'div[aria-modal="true"]',
                '[class*="Modal"]',
                '[class*="_aao_"]', // Instagram modal class pattern
            ];
            let dialog = null;
            let dialogIndicators = 0;

            for (const sel of dialogSelectors) {
                const el = document.querySelector(sel);
                if (el && el.offsetWidth > 500 && el.offsetHeight > 400) {
                    dialog = el;
                    dialogIndicators++;
                    break;
                }
            }

            // Check for aria-modal attribute (strong indicator)
            const ariaModal = document.querySelector('[aria-modal="true"]');
            if (ariaModal) dialogIndicators++;

            // === INDICATOR 2: Backdrop/Overlay (dark background) ===
            let hasBackdrop = false;
            const allDivs = document.querySelectorAll('div');
            for (const div of allDivs) {
                const style = window.getComputedStyle(div);
                const bgColor = style.backgroundColor;
                const opacity = parseFloat(style.opacity);

                // Check for semi-transparent dark overlay
                if (bgColor.includes('rgba') && bgColor.includes('0,') && div.offsetWidth === window.innerWidth) {
                    hasBackdrop = true;
                    dialogIndicators++;
                    break;
                }
                // Check for high z-index overlay
                if (parseInt(style.zIndex) > 100 && div.offsetWidth > window.innerWidth * 0.8) {
                    hasBackdrop = true;
                    dialogIndicators++;
                    break;
                }
            }

            // === INDICATOR 3: Close button (X) - modals have this ===
            const closeButtonSelectors = [
                'button[aria-label="Close"]',
                'button[aria-label="Fechar"]',
                'svg[aria-label="Close"]',
                'svg[aria-label="Fechar"]',
                'div[role="dialog"] button',
            ];
            let hasCloseButton = false;
            for (const sel of closeButtonSelectors) {
                if (document.querySelector(sel)) {
                    hasCloseButton = true;
                    dialogIndicators++;
                    break;
                }
            }

            // === INDICATOR 4: Video position ===
            // In MODAL: video is centered or takes left half
            // In FEED_INLINE: video takes most of center, comments on right
            const video = document.querySelector('video');
            let videoPosition = 'unknown';
            let hasLargeVideo = false;
            if (video) {
                const rect = video.getBoundingClientRect();
                hasLargeVideo = rect.width > 300;
                // Video in left 60% of screen = likely MODAL
                // Video in center = could be either
                if (rect.x < window.innerWidth * 0.1 && rect.width > window.innerWidth * 0.4) {
                    videoPosition = 'left-large'; // MODAL pattern
                } else if (rect.x + rect.width / 2 < window.innerWidth * 0.5) {
                    videoPosition = 'left'; // Could be MODAL
                } else {
                    videoPosition = 'center'; // FEED_INLINE pattern
                }
            }

            // === INDICATOR 5: Article detection ===
            const articleSelectors = ['article', 'main article', '[role="main"]'];
            let article = null;
            for (const sel of articleSelectors) {
                const el = document.querySelector(sel);
                if (el && el.offsetWidth > 300) {
                    article = el;
                    break;
                }
            }

            // Comment panel detection - look for scrollable section with UL
            const sections = document.querySelectorAll('section');
            let commentPanel = null;
            let commentPanelRect = null;

            for (const section of sections) {
                const ul = section.querySelector('ul');
                if (ul) {
                    const rect = section.getBoundingClientRect();
                    // Panel should be on the right side and have reasonable size
                    if (rect.width > 200 && rect.height > 200) {
                        commentPanel = section;
                        commentPanelRect = {
                            x: rect.x,
                            y: rect.y,
                            width: rect.width,
                            height: rect.height,
                            scrollHeight: section.scrollHeight,
                            clientHeight: section.clientHeight,
                            isScrollable: section.scrollHeight > section.clientHeight + 50
                        };
                        break;
                    }
                }
            }

            // Count visible comments
            const allLists = document.querySelectorAll('ul');
            let visibleComments = 0;
            for (const ul of allLists) {
                const items = ul.querySelectorAll('li');
                for (const li of items) {
                    const text = li.innerText || '';
                    if (text.includes('@') || text.includes('Responder') || text.includes('Reply')) {
                        visibleComments++;
                    }
                }
            }

            // Check for comment indicators in page
            const pageText = document.body.innerText || '';
            const hasCommentIndicators = pageText.includes('curtida') ||
                pageText.includes('like') ||
                pageText.includes('comentário') ||
                pageText.includes('comment');

            // Follow button detection
            const buttons = Array.from(document.querySelectorAll('button'));
            const hasFollowButton = buttons.some(b =>
                b.textContent.includes('Seguir') || b.textContent.includes('Follow')
            );

            return {
                hasDialog: !!dialog,
                hasArticle: !!article,
                hasVideo: !!video,
                hasLargeVideo,
                hasCommentPanel: !!commentPanel,
                commentPanelRect,
                visibleComments,
                hasFollowButton,
                hasCommentIndicators,
                // New robust indicators
                dialogIndicators, // Count of modal indicators (0 = likely FEED_INLINE, 2+ = likely MODAL)
                hasBackdrop,
                hasCloseButton,
                videoPosition,
                viewport: { width: window.innerWidth, height: window.innerHeight }
            };
        });

        // Log detection details
        logger.info(`[LAYOUT-DETECT] hasDialog=${detection.hasDialog}, hasArticle=${detection.hasArticle}, hasVideo=${detection.hasVideo}, hasCommentPanel=${detection.hasCommentPanel}`);
        logger.info(`[LAYOUT-DETECT] visibleComments=${detection.visibleComments}, hasFollowButton=${detection.hasFollowButton}`);
        logger.info(`[LAYOUT-DETECT] 🎯 Modal indicators: ${detection.dialogIndicators} (backdrop=${detection.hasBackdrop}, closeBtn=${detection.hasCloseButton}, videoPos=${detection.videoPosition})`);
        if (detection.commentPanelRect) {
            logger.info(`[LAYOUT-DETECT] commentPanel: ${detection.commentPanelRect.width}x${detection.commentPanelRect.height}, scrollable=${detection.commentPanelRect.isScrollable}`);
        }

        // === LAYOUT DETERMINATION ===
        // Uses multiple indicators for robust detection
        // dialogIndicators: 0 = likely FEED_INLINE, 1 = uncertain, 2+ = likely MODAL
        let layoutType = 'UNKNOWN';

        // HIGH CONFIDENCE MODAL: 2+ indicators OR has dialog
        if (detection.dialogIndicators >= 2 || detection.hasDialog) {
            layoutType = 'MODAL_POST_VIEW';
            logger.info(`[LAYOUT-DETECT] High confidence MODAL (${detection.dialogIndicators} indicators)`);
        }
        // HIGH CONFIDENCE FEED: No dialog + has article + 0-1 indicators
        else if (!detection.hasDialog && detection.hasArticle && detection.dialogIndicators <= 1) {
            layoutType = 'FEED_INLINE';
            logger.info(`[LAYOUT-DETECT] High confidence FEED_INLINE (${detection.dialogIndicators} indicators, hasArticle=true)`);
        }
        // MODAL FALLBACK: Has video + comment panel but uncertain indicators
        else if (detection.hasVideo && detection.hasCommentPanel) {
            layoutType = 'MODAL_POST_VIEW';
            logger.info('[LAYOUT-DETECT] Fallback → MODAL_POST_VIEW (video + commentPanel)');
        }
        // FEED_INLINE FALLBACK: Has comment indicators and visible comments
        else if (detection.hasCommentIndicators) {
            layoutType = 'FEED_INLINE';
            logger.info('[LAYOUT-DETECT] Fallback → FEED_INLINE (comment indicators)');
        }

        logger.info(`[LAYOUT] 📱 Detected layout: ${layoutType}`);

        return {
            layoutType,
            ...detection
        };
    }

    /**
     * Get the optimal scroll strategy based on layout type
     * Uses ROBUST selectors to find the comment panel
     * @param {Page} page 
     * @returns {Promise<Object>} Scroll strategy with coords and type
     */
    async getScrollStrategy(page) {
        const layoutType = this.currentLayoutType || 'MODAL_POST_VIEW'; // Default to MODAL since that's most common

        const strategy = await page.evaluate((layout) => {
            // === FIND SCROLLABLE COMMENT PANEL ===
            // Try multiple strategies to find the right scrollable element

            // Strategy 1: Find section with UL (most reliable for comments)
            const sections = document.querySelectorAll('section');
            for (const section of sections) {
                const ul = section.querySelector('ul');
                if (ul) {
                    const rect = section.getBoundingClientRect();
                    // Check if section is scrollable or its parent is
                    const isScrollable = section.scrollHeight > section.clientHeight + 50;
                    const parentScrollable = section.parentElement &&
                        section.parentElement.scrollHeight > section.parentElement.clientHeight + 50;

                    if (rect.width > 200 && rect.height > 200) {
                        return {
                            type: isScrollable ? 'ELEMENT_SCROLL' : 'WHEEL_SCROLL',
                            selector: 'section',
                            coords: {
                                x: rect.x + rect.width * 0.5,
                                y: rect.y + rect.height * 0.5
                            },
                            elementInfo: {
                                scrollHeight: section.scrollHeight,
                                clientHeight: section.clientHeight,
                                isScrollable,
                                parentScrollable
                            }
                        };
                    }
                }
            }

            // Strategy 2: Find any UL with comments
            const allULs = document.querySelectorAll('ul');
            for (const ul of allULs) {
                const items = ul.querySelectorAll('li');
                if (items.length > 0) {
                    // Check if any item looks like a comment
                    let hasComments = false;
                    for (const li of items) {
                        const text = li.innerText || '';
                        if (text.includes('@') || text.includes('Responder')) {
                            hasComments = true;
                            break;
                        }
                    }

                    if (hasComments) {
                        const rect = ul.getBoundingClientRect();
                        // Find the scrollable parent
                        let scrollParent = ul.parentElement;
                        while (scrollParent && scrollParent !== document.body) {
                            if (scrollParent.scrollHeight > scrollParent.clientHeight + 50) {
                                break;
                            }
                            scrollParent = scrollParent.parentElement;
                        }

                        return {
                            type: 'WHEEL_SCROLL',
                            selector: 'ul-comments',
                            coords: {
                                x: rect.x + rect.width * 0.5,
                                y: rect.y + 100
                            },
                            elementInfo: {
                                ulItems: items.length,
                                scrollParent: scrollParent?.tagName || 'none'
                            }
                        };
                    }
                }
            }

            // Strategy 3: Find div with overflow on right side of viewport
            const divs = document.querySelectorAll('div');
            for (const div of divs) {
                const style = window.getComputedStyle(div);
                const rect = div.getBoundingClientRect();

                // Look for scrollable divs on the right side
                if (rect.x > window.innerWidth * 0.4 && rect.width > 200 && rect.height > 200) {
                    if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                        return {
                            type: 'WHEEL_SCROLL',
                            selector: 'div-overflow',
                            coords: {
                                x: rect.x + rect.width * 0.5,
                                y: rect.y + rect.height * 0.5
                            }
                        };
                    }
                }
            }

            // Strategy 4: Fallback - use right side of viewport (where comments typically are)
            return {
                type: 'WHEEL_SCROLL',
                selector: 'viewport-right',
                coords: {
                    x: window.innerWidth * 0.75,
                    y: window.innerHeight * 0.5
                }
            };
        }, layoutType);

        logger.info(`[SCROLL-STRATEGY] type=${strategy.type}, selector=${strategy.selector}, coords=(${Math.round(strategy.coords.x)}, ${Math.round(strategy.coords.y)})`);
        if (strategy.elementInfo) {
            logger.info(`[SCROLL-STRATEGY] elementInfo:`, strategy.elementInfo);
        }

        return strategy;
    }

    /**
     * Extract post metadata (author, description)
     * @param {Page} page
     * @returns {Object} Post metadata
     */
    async extractPostMetadata(page) {
        const metadata = {
            post_author: null,
            post_description: null,
            post_likes_count: null,
        };

        try {
            const data = await page.evaluate(() => {
                const result = {};

                // Extract author username
                const authorLink = document.querySelector('article header a[href^="/"]');
                if (authorLink) {
                    const href = authorLink.getAttribute('href');
                    result.author = href?.replace(/\//g, '') || null;
                }

                // Extract post description/caption
                const captionElement = document.querySelector('article div > span[dir="auto"]');
                if (captionElement) {
                    result.description = captionElement.innerText?.substring(0, 1000) || null;
                }

                // Try alternative caption selector
                if (!result.description) {
                    const altCaption = document.querySelector('article h1, article div[class*="Caption"] span');
                    if (altCaption) {
                        result.description = altCaption.innerText?.substring(0, 1000) || null;
                    }
                }

                // Extract likes count
                const likesElement = document.querySelector('section span[class*="like"], a[href*="liked_by"] span');
                if (likesElement) {
                    const likesText = likesElement.innerText;
                    const match = likesText.match(/[\d,.]+/);
                    if (match) {
                        result.likes = parseInt(match[0].replace(/[,.]/g, '')) || null;
                    }
                }

                return result;
            });

            metadata.post_author = data.author || null;
            metadata.post_description = data.description || null;
            metadata.post_likes_count = data.likes || null;

            logger.info('[SCRAPE] Post metadata extracted:', {
                author: metadata.post_author,
                descriptionLength: metadata.post_description?.length || 0,
                likes: metadata.post_likes_count,
            });

        } catch (error) {
            logger.warn('[SCRAPE] Could not extract post metadata:', error.message);
        }

        return metadata;
    }

    /**
     * Navigate via profile first (more human-like behavior)
     * @param {Page} page
     * @param {string} username
     * @param {string} postUrl
     */
    async navigateViaProfile(page, username, postUrl) {
        logger.info('[SCRAPE] Navigating via profile first:', username);

        // Navigate to profile
        await page.goto(`https://www.instagram.com/${username}/`, {
            waitUntil: 'domcontentloaded',
            timeout: config.scraping.pageTimeout,
        });

        // Wait for profile to load
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

        // Human-like delay to "browse" profile
        await randomDelay(3000, 6000);

        // Now navigate to the actual post
        await page.goto(postUrl, {
            waitUntil: 'domcontentloaded',
            timeout: config.scraping.pageTimeout,
        });

        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

        logger.info('[SCRAPE] Arrived at post via profile');
        await randomDelay(2000, 4000);
    }

    /**
     * Extract username from post URL pattern
     * @param {string} url
     * @returns {string|null}
     */
    extractUsernameFromPostPage(url) {
        if (!url) return null;
        try {
            const match = url.match(/instagram\.com\/([^\/]+)\/(?:p|reel|tv)\//);
            if (match && match[1] && match[1] !== 'www' && match[1] !== 'p') {
                return match[1];
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Wait for comments section to load
     * @param {Page} page
     */
    /**
     * Wait for the initial GraphQL response after clicking "View all comments"
     * The Instagram API takes 30-60 seconds to respond, so we must wait
     * before starting the scroll loop
     * 
     * @param {Page} page - Playwright page
     * @param {Array} commentsArray - Reference to intercepted comments array
     * @param {number} timeoutMs - Maximum wait time (default: 60s)
     * @returns {Promise<number>} - Number of comments loaded
     */
    async waitForInitialGraphQLResponse(page, commentsArray, timeoutMs = 60000) {
        const startTime = Date.now();
        let lastCount = 0;
        let stableCount = 0;

        while (Date.now() - startTime < timeoutMs) {
            const currentCount = commentsArray.length;
            const elapsed = Math.floor((Date.now() - startTime) / 1000);

            // If we have comments and count is stable for 3 checks
            if (currentCount > 0) {
                if (currentCount === lastCount) {
                    stableCount++;

                    // If stable for 3 seconds, consider it ready
                    if (stableCount >= 3) {
                        logger.info(`[SCRAPE] GraphQL stable at ${currentCount} comments`);
                        return currentCount;
                    }
                } else {
                    stableCount = 0; // Reset if still changing
                    logger.info(`[SCRAPE] GraphQL loading... (${currentCount} comments, ${elapsed}s)`);
                }
            } else {
                // Log progress every 5 seconds while waiting
                if (elapsed > 0 && elapsed % 5 === 0) {
                    logger.info(`[SCRAPE] Waiting for GraphQL... (${elapsed}s, still 0 comments)`);
                }
            }

            lastCount = currentCount;
            await page.waitForTimeout(1000);
        }

        // Timeout reached
        logger.warn(`[SCRAPE] ⚠️ GraphQL timeout after ${timeoutMs / 1000}s (got ${commentsArray.length} comments)`);
        return commentsArray.length;
    }

    async waitForComments(page) {
        // Instagram's comment section selectors (updated for 2024+ DOM structure)
        const commentSelectors = [
            'article div > ul', // Common comment list structure
            'article ul li div span', // Comment text areas
            'div[role="dialog"] ul > div', // Modal comment structure
            '[data-testid="post-comment-root"]',
            'ul ul', // Nested list structure
            'div[class*="Comment"]', // Class-based detection
            'article section', // Post sections
        ];

        logger.info('[SCRAPE] Looking for comments section...');

        for (const selector of commentSelectors) {
            try {
                const element = await page.waitForSelector(selector, { timeout: 8000 });
                if (element) {
                    logger.info(`[SCRAPE] Comments section found with selector: ${selector}`);
                    return true;
                }
            } catch (e) {
                // Try next selector
            }
        }

        // Even if we can't find specific comments, the page might still have them
        // via GraphQL interception
        logger.warn('[SCRAPE] Could not find comments section, proceeding with GraphQL interception...');
        return false;
    }

    /**
     * Intelligently find and click "View all X comments" button
     * Uses Playwright's built-in text locators which are more reliable
     * @param {Page} page
     * @returns {Promise<boolean>} Whether comments were expanded
     */
    async expandAllComments(page) {
        logger.info('[SCRAPE] 🔍 Looking for "View all comments" button...');

        // Text patterns to look for (Playwright getByText)
        const textPatterns = [
            // Portuguese - exact patterns
            /Ver todos os \d+ comentários/i,
            /Ver \d+ comentários/i,
            /Ver todos os comentários/i,
            // English
            /View all \d+ comments/i,
            /View \d+ comments/i,
            /View all comments/i,
        ];

        try {
            // Strategy 1: Use Playwright's getByText with regex (most reliable)
            for (const pattern of textPatterns) {
                try {
                    const locator = page.getByText(pattern);
                    const count = await locator.count();

                    if (count > 0) {
                        // Get the first visible one
                        const element = locator.first();
                        const isVisible = await element.isVisible().catch(() => false);

                        if (isVisible) {
                            const text = await element.textContent();
                            logger.info(`[SCRAPE] ✅ Found expand button: "${text?.trim()}"`);

                            // ⭐ SCROLL to make button visible and centered
                            await element.scrollIntoViewIfNeeded().catch(() => { });
                            await randomDelay(500, 1000);

                            // ⭐ WAIT for page to stabilize before clicking
                            logger.info('[SCRAPE] Waiting for page to stabilize...');
                            await randomDelay(3000, 4000);

                            // ⭐ MULTI-STRATEGY CLICK with verification
                            const clickSuccess = await this.robustClick(page, element, text);

                            if (clickSuccess) {
                                // Wait for modal or new content to load
                                await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
                                logger.info('[SCRAPE] ✅ Clicked expand button, waiting for comments to load...');

                                // ⭐ VERIFY: Check if comments modal/panel actually opened
                                await randomDelay(2000, 3000);
                                const modalOpened = await page.evaluate(() => {
                                    // Check for visible comment input field (indicates comments section is open)
                                    const commentInput = document.querySelector('textarea[placeholder*="comentário"], textarea[placeholder*="comment"], input[placeholder*="comentário"]');
                                    // Check for visible comment list
                                    const commentList = document.querySelector('ul li span');
                                    // Check for dialog that might contain comments
                                    const dialog = document.querySelector('div[role="dialog"]');

                                    return !!(commentInput || commentList || dialog);
                                });

                                if (!modalOpened) {
                                    logger.warn('[SCRAPE] ⚠️ Modal may not have opened, trying double-click...');
                                    // Try clicking again
                                    await randomDelay(500, 1000);
                                    await this.robustClick(page, element, text);
                                    await randomDelay(2000, 3000);
                                }

                                return true;
                            }
                        }
                    }
                } catch (e) {
                    // Pattern not found, try next
                }
            }

            // Strategy 2: Look for any element containing "comentário" or "comment" count
            logger.info('[SCRAPE] Pattern matching failed, trying text search...');

            const commentLinkInfo = await page.evaluate(() => {
                // Find all spans and links
                const elements = document.querySelectorAll('span, a, div[role="button"]');

                for (const el of elements) {
                    const text = el.innerText?.trim() || '';

                    // Must contain a number and "comentário" or "comment"
                    const hasNumber = /\d+/.test(text);
                    const hasComment = /coment[áa]rio|comment/i.test(text);
                    const hasView = /ver|view/i.test(text);

                    if (hasNumber && hasComment && hasView) {
                        const rect = el.getBoundingClientRect();
                        if (rect.height > 0 && rect.width > 0) {
                            return {
                                found: true,
                                text: text.substring(0, 100),
                                x: rect.x + rect.width / 2,
                                y: rect.y + rect.height / 2
                            };
                        }
                    }
                }

                return { found: false };
            });

            if (commentLinkInfo.found) {
                logger.info(`[SCRAPE] ✅ Found via text search: "${commentLinkInfo.text}"`);

                await page.mouse.click(commentLinkInfo.x, commentLinkInfo.y);
                await randomDelay(2000, 3000);
                await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

                logger.info('[SCRAPE] ✅ Clicked expand button, waiting for comments to load...');
                return true;
            }

            // Strategy 3: Check if comments are already expanded (modal is open)
            const hasModal = await page.$('div[role="dialog"]');
            if (hasModal) {
                logger.info('[SCRAPE] Comments modal already open');
                return true;
            }

            // DIAGNOSTIC: Get all text on page that contains "comentário" or "comment"
            const diagnosticInfo = await page.evaluate(() => {
                const results = [];
                const elements = document.querySelectorAll('span, a, div[role="button"], button');

                for (const el of elements) {
                    const text = el.innerText?.trim() || '';
                    if (text.toLowerCase().includes('coment') || text.toLowerCase().includes('comment')) {
                        const rect = el.getBoundingClientRect();
                        results.push({
                            text: text.substring(0, 80),
                            tag: el.tagName,
                            visible: rect.height > 0 && rect.width > 0,
                            className: el.className?.substring(0, 50) || ''
                        });
                    }
                }

                return {
                    foundElements: results.slice(0, 10),
                    pageTitle: document.title,
                    pageUrl: location.href
                };
            });

            // Log detailed diagnostic for debugging
            logger.error('[SCRAPE] ❌ FAILED TO FIND "View all comments" button');
            logger.error('[SCRAPE] 📋 DIAGNOSTIC INFO:');
            logger.error(`[SCRAPE] Page: ${diagnosticInfo.pageUrl}`);
            logger.error(`[SCRAPE] Title: ${diagnosticInfo.pageTitle}`);
            logger.error(`[SCRAPE] Elements containing "coment/comment":`);

            if (diagnosticInfo.foundElements.length === 0) {
                logger.error('[SCRAPE] ⚠️ NO elements found with "comentário" or "comment" text!');
                logger.error('[SCRAPE] ⚠️ Post may have comments disabled or page structure changed');
            } else {
                diagnosticInfo.foundElements.forEach((el, i) => {
                    logger.error(`[SCRAPE]   ${i + 1}. [${el.tag}] "${el.text}" (visible: ${el.visible})`);
                });
            }

            return false;

        } catch (error) {
            logger.error('[SCRAPE] Error expanding comments:', error.message);
            return false;
        }
    }

    /**
     * Scroll to load more comments
     * IMPROVED: Uses GraphQL intercepted array as source of truth (not DOM counting)
     * @param {Page} page
     * @param {number} maxComments - Optional limit
     * @param {Array} commentsArray - Reference to GraphQL intercepted comments
     */
    async scrollForMoreComments(page, maxComments = null, commentsArray = []) {
        const MAX_SCROLLS = 25; // Increased from 5
        const MAX_NO_CHANGE = 7; // Stop after 7 iterations with no new GraphQL data
        const SCROLL_DELAY = 4500; // 4.5 seconds between scrolls

        let totalClicks = 0;
        let previousGraphQLCount = commentsArray.length;
        let noChangeCount = 0;

        const hasLimit = maxComments && maxComments > 0;
        logger.info(`[SCROLL] Starting smart scroll for comments`);
        logger.info(`[SCROLL] Initial GraphQL count: ${previousGraphQLCount}, limit: ${hasLimit ? maxComments : 'unlimited'}, max scrolls: ${MAX_SCROLLS}`);

        // First, diagnose and find the correct scroll container
        const scrollContainer = await this.findScrollContainer(page);
        logger.info(`[SCROLL] Using container: ${scrollContainer?.name || 'window (fallback)'} (useModal: ${scrollContainer?.useModal || false})`);

        // Try to open comments modal if not already open
        const commentsOpened = await this.openCommentsModal(page);
        if (commentsOpened) {
            logger.info('[SCROLL] Comments modal/section opened');
            await randomDelay(2500, 3500);
        }

        // 📸 DEBUG SCREENSHOT: Capture state before scrolling and upload to Supabase
        try {
            const timestamp = Date.now();
            const screenshotBuffer = await page.screenshot({ fullPage: false });

            // Upload to Supabase Storage
            const fileName = `debug/before-scroll-${timestamp}.png`;
            const { data: uploadData, error: uploadError } = await supabase.storage
                .from('screenshot')
                .upload(fileName, screenshotBuffer, {
                    contentType: 'image/png',
                    upsert: true
                });

            if (uploadError) {
                logger.warn(`[DEBUG] Upload error: ${uploadError.message}`);
            } else {
                // Get public URL
                const { data: urlData } = supabase.storage
                    .from('screenshot')
                    .getPublicUrl(fileName);

                logger.info(`[DEBUG] 📸 Screenshot uploaded: ${urlData.publicUrl}`);
            }

            // Also capture DOM info about the dialog
            const dialogInfo = await page.evaluate(() => {
                const dialog = document.querySelector('div[role="dialog"]');
                if (!dialog) return { exists: false };

                const rect = dialog.getBoundingClientRect();
                const allDivs = dialog.querySelectorAll('div');
                const scrollableDivs = [];

                for (const div of allDivs) {
                    const style = window.getComputedStyle(div);
                    const overflowY = style.overflowY;
                    const scrollable = div.scrollHeight > div.clientHeight;

                    if (scrollable && div.clientHeight > 50) {
                        scrollableDivs.push({
                            overflowY,
                            clientHeight: div.clientHeight,
                            scrollHeight: div.scrollHeight,
                            scrollTop: div.scrollTop,
                            className: div.className?.substring(0, 30) || 'no-class'
                        });
                    }
                }

                return {
                    exists: true,
                    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                    totalDivs: allDivs.length,
                    scrollableDivs: scrollableDivs.slice(0, 5), // First 5
                    innerText: dialog.innerText?.substring(0, 200) || ''
                };
            });

            logger.info(`[DEBUG] 🔍 Dialog info: exists=${dialogInfo.exists}`);
            if (dialogInfo.exists) {
                logger.info(`[DEBUG] Dialog rect: ${JSON.stringify(dialogInfo.rect)}`);
                logger.info(`[DEBUG] Total divs: ${dialogInfo.totalDivs}, Scrollable: ${dialogInfo.scrollableDivs.length}`);
                if (dialogInfo.scrollableDivs.length > 0) {
                    logger.info(`[DEBUG] Scrollable divs: ${JSON.stringify(dialogInfo.scrollableDivs)}`);
                }
                logger.info(`[DEBUG] Dialog text preview: "${dialogInfo.innerText.substring(0, 100)}..."`);
            }
        } catch (debugError) {
            logger.warn(`[DEBUG] Screenshot error: ${debugError.message}`);
        }

        for (let i = 0; i < MAX_SCROLLS; i++) {
            const currentGraphQLCount = commentsArray.length;
            const timestamp = new Date().toISOString().substr(11, 8);

            logger.info(`[SCROLL] [${timestamp}] Iteration ${i + 1}/${MAX_SCROLLS}`);
            logger.info(`[SCROLL] GraphQL has ${currentGraphQLCount} comments`);

            // Check if new comments were loaded via GraphQL
            if (currentGraphQLCount === previousGraphQLCount) {
                noChangeCount++;
                logger.debug(`[SCROLL] No new GraphQL data (${noChangeCount}/${MAX_NO_CHANGE})`);

                if (noChangeCount >= MAX_NO_CHANGE) {
                    logger.info(`[SCROLL] ✅ Complete! No new data after ${noChangeCount} attempts`);
                    break;
                }
            } else {
                const newComments = currentGraphQLCount - previousGraphQLCount;
                logger.info(`[SCROLL] ✅ +${newComments} new comments! (${previousGraphQLCount} → ${currentGraphQLCount})`);
                noChangeCount = 0; // Reset counter
            }
            previousGraphQLCount = currentGraphQLCount;

            // Check if we've reached the target
            if (hasLimit && currentGraphQLCount >= maxComments) {
                logger.info(`[SCROLL] ✅ Reached target! ${currentGraphQLCount}/${maxComments}`);
                break;
            }

            // STEP 1: Click "View replies" / "Load more" buttons
            const clicked = await this.clickLoadMoreButtons(page);
            if (clicked) {
                totalClicks++;
                await randomDelay(2000, 3500);
            }

            // STEP 2: Scroll in the correct container (using intelligent detection)
            // First, try to scroll via JavaScript
            const jsScrolled = await page.evaluate((containerInfo) => {
                // If modal is detected, find the scrollable element inside
                if (containerInfo && containerInfo.useModal) {
                    const dialog = document.querySelector('div[role="dialog"]');
                    if (dialog) {
                        // Find the scrollable div inside the modal
                        const allDivs = dialog.querySelectorAll('div');
                        for (const div of allDivs) {
                            const style = window.getComputedStyle(div);
                            if ((style.overflowY === 'auto' || style.overflowY === 'scroll') &&
                                div.scrollHeight > div.clientHeight + 20) {
                                console.log('[SCROLL] Scrolling modal inner div');
                                div.scrollTop = div.scrollHeight;
                                return true;
                            }
                        }
                        // Fallback: scroll the dialog itself
                        console.log('[SCROLL] Scrolling modal dialog');
                        dialog.scrollTop = dialog.scrollHeight;
                        return true;
                    }
                }

                // Try selector if provided
                if (containerInfo && containerInfo.selector) {
                    const container = document.querySelector(containerInfo.selector);
                    if (container) {
                        console.log('[SCROLL] Scrolling by selector:', containerInfo.selector);
                        container.scrollTop = container.scrollHeight;
                        return true;
                    }
                }

                return false;
            }, scrollContainer);

            // STEP 3: If JS scroll didn't work, use mouse.wheel
            if (!jsScrolled) {
                // First, check if we have feed panel coordinates from findScrollContainer
                if (scrollContainer && scrollContainer.useFeedPanel && scrollContainer.panelCoords) {
                    // Use coordinates from the detected inline comments panel
                    await page.mouse.move(scrollContainer.panelCoords.x, scrollContainer.panelCoords.y);
                    await page.mouse.wheel(0, 500); // Scroll down 500px
                    logger.info(`[SCROLL] 🖱️ Mouse wheel on feed panel at (${Math.round(scrollContainer.panelCoords.x)}, ${Math.round(scrollContainer.panelCoords.y)})`);
                } else {
                    // Find dialog and use mouse wheel directly
                    const dialogBox = await page.evaluate(() => {
                        const dialog = document.querySelector('div[role="dialog"]');
                        if (dialog) {
                            const rect = dialog.getBoundingClientRect();
                            return {
                                x: rect.x + rect.width / 2,
                                y: rect.y + rect.height / 2,
                                found: true,
                                type: 'dialog'
                            };
                        }

                        // Try to find comments area on the right side of the post
                        const article = document.querySelector('article');
                        if (article) {
                            // Comments are usually in the right half of the article
                            const rect = article.getBoundingClientRect();
                            // Use right side of article (where comments typically are)
                            return {
                                x: rect.x + rect.width * 0.75, // 75% from left (right side)
                                y: rect.y + rect.height / 2,
                                found: true,
                                type: 'article-right'
                            };
                        }

                        return { found: false };
                    });

                    if (dialogBox.found) {
                        // Move mouse to center of dialog/article and scroll
                        await page.mouse.move(dialogBox.x, dialogBox.y);
                        await page.mouse.wheel(0, 500); // Scroll down 500px
                        logger.info(`[SCROLL] 🖱️ Mouse wheel at ${dialogBox.type} (${Math.round(dialogBox.x)}, ${Math.round(dialogBox.y)})`);
                    } else if (this.currentLayoutType === 'FEED_INLINE') {
                        // FEED_INLINE: Scroll on the right side of the viewport where comments are
                        const viewport = page.viewportSize();
                        const feedScrollX = viewport.width * 0.70; // 70% from left (right side panel)
                        const feedScrollY = viewport.height * 0.50; // Middle of screen
                        await page.mouse.move(feedScrollX, feedScrollY);
                        await page.mouse.wheel(0, 400);
                        logger.info(`[SCROLL] 🖱️ FEED_INLINE scroll at (${Math.round(feedScrollX)}, ${Math.round(feedScrollY)})`);
                    } else {
                        // Last fallback: scroll window
                        await page.evaluate(() => window.scrollBy(0, 600));
                        logger.info('[SCROLL] Window scroll fallback');
                    }
                }
            }

            // Wait for API to respond
            await randomDelay(SCROLL_DELAY, SCROLL_DELAY + 1500);

            // Log progress every 3 iterations
            if ((i + 1) % 3 === 0) {
                logger.info(`[SCROLL] Progress: iteration ${i + 1}, GraphQL: ${commentsArray.length}, clicks: ${totalClicks}`);
            }
        }

        logger.info(`[SCROLL] Complete! Final count: ${commentsArray.length} comments, ${totalClicks} button clicks`);
    }

    /**
     * Perform a robust click on an element using multiple strategies
     * Strategy 1: element.click()
     * Strategy 2: JavaScript click
     * Strategy 3: Mouse click at coordinates
     * 
     * @param {Page} page - Playwright page
     * @param {Locator} element - Element to click
     * @param {string} text - Text of the button (for logging)
     * @returns {Promise<boolean>} - Whether click was successful
     */
    async robustClick(page, element, text) {
        logger.info('[SCRAPE] Executing robust multi-strategy click...');

        let clickCount = 0;

        // Strategy 1: Normal Playwright click
        try {
            await element.click({ timeout: 5000 });
            clickCount++;
            logger.info('[SCRAPE] Strategy 1 (element.click): ✅ executed');
        } catch (e) {
            logger.warn('[SCRAPE] Strategy 1 (element.click): ❌ failed -', e.message);
        }

        await page.waitForTimeout(500);

        // Strategy 2: JavaScript click via element handle
        try {
            const handle = await element.elementHandle();
            if (handle) {
                await handle.evaluate(el => el.click());
                clickCount++;
                logger.info('[SCRAPE] Strategy 2 (JS click): ✅ executed');
            }
        } catch (e) {
            logger.warn('[SCRAPE] Strategy 2 (JS click): ❌ failed -', e.message);
        }

        await page.waitForTimeout(500);

        // Strategy 3: Mouse click at element coordinates
        try {
            const box = await element.boundingBox();
            if (box) {
                const x = box.x + box.width / 2;
                const y = box.y + box.height / 2;
                await page.mouse.click(x, y);
                clickCount++;
                logger.info(`[SCRAPE] Strategy 3 (mouse click at ${Math.round(x)},${Math.round(y)}): ✅ executed`);
            }
        } catch (e) {
            logger.warn('[SCRAPE] Strategy 3 (mouse click): ❌ failed -', e.message);
        }

        logger.info(`[SCRAPE] Click attempts: ${clickCount}/3 strategies executed`);

        // Success if at least one click executed
        return clickCount > 0;
    }

    /**
     * Find the best scrollable container for comments
     * Uses computed style to detect overflow properties
     * Returns CSS selector or null
     */
    async findScrollContainer(page) {
        try {
            const result = await page.evaluate(() => {
                // First, check if there's a dialog/modal open
                const dialog = document.querySelector('div[role="dialog"]');

                if (dialog) {
                    console.log('[CONTAINER] Modal detected, searching within modal...');

                    // Find all divs inside the modal and check their computed overflow
                    const allDivs = dialog.querySelectorAll('div');

                    for (const div of allDivs) {
                        const style = window.getComputedStyle(div);
                        const overflowY = style.overflowY;
                        const hasOverflow = overflowY === 'auto' || overflowY === 'scroll';
                        const canScroll = div.scrollHeight > div.clientHeight + 20;
                        const hasHeight = div.clientHeight > 100;

                        if (hasOverflow && canScroll && hasHeight) {
                            // Generate a unique selector for this element
                            const tagName = div.tagName.toLowerCase();
                            const classList = Array.from(div.classList).join('.');

                            console.log(`[CONTAINER] ✅ Found scrollable in modal: overflow=${overflowY}, height=${div.clientHeight}, scrollHeight=${div.scrollHeight}`);

                            return {
                                selector: 'div[role="dialog"]',
                                name: 'modal-scrollable',
                                scrollable: true,
                                details: {
                                    overflowY,
                                    clientHeight: div.clientHeight,
                                    scrollHeight: div.scrollHeight,
                                    classList: classList.substring(0, 50)
                                },
                                // Store the element index for later use
                                useModal: true
                            };
                        }
                    }

                    // If no scrollable div found, just use the dialog itself
                    console.log('[CONTAINER] No scrollable div in modal, using dialog');
                    return {
                        selector: 'div[role="dialog"]',
                        name: 'modal-fallback',
                        scrollable: true,
                        useModal: true
                    };
                }

                // NEW: Check for feed-style view (comments panel on the right side of post)
                // This is when you navigate directly to /p/XXX/ and comments are inline
                const article = document.querySelector('article');
                if (article) {
                    console.log('[CONTAINER] Article found, checking for inline comments panel...');

                    // In feed view, comments are in a scrollable section to the right
                    // Look for any div that contains comments and is scrollable
                    const allDivs = article.querySelectorAll('div');

                    for (const div of allDivs) {
                        const style = window.getComputedStyle(div);
                        const overflowY = style.overflowY;
                        const hasOverflow = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'hidden';
                        const canScroll = div.scrollHeight > div.clientHeight + 50;
                        const hasHeight = div.clientHeight > 200;

                        // Check if this div contains comment-like content
                        const containsCommentText = div.innerText?.includes('@') ||
                            div.innerText?.includes('Responder') ||
                            div.innerText?.includes('Reply');

                        if (hasOverflow && canScroll && hasHeight && containsCommentText) {
                            const rect = div.getBoundingClientRect();
                            console.log(`[CONTAINER] ✅ Found inline comments panel: overflow=${overflowY}, height=${div.clientHeight}, scrollHeight=${div.scrollHeight}`);

                            return {
                                selector: null, // Will use coordinates instead
                                name: 'inline-comments-panel',
                                scrollable: true,
                                useModal: false,
                                useFeedPanel: true,
                                panelCoords: {
                                    x: rect.x + rect.width / 2,
                                    y: rect.y + rect.height / 2
                                },
                                details: {
                                    overflowY,
                                    clientHeight: div.clientHeight,
                                    scrollHeight: div.scrollHeight
                                }
                            };
                        }
                    }

                    // Try to find comments section by looking for specific patterns
                    const sections = article.querySelectorAll('section');
                    for (const section of sections) {
                        const canScroll = section.scrollHeight > section.clientHeight + 50;
                        if (canScroll && section.clientHeight > 200) {
                            const rect = section.getBoundingClientRect();
                            console.log(`[CONTAINER] ✅ Found article section for comments`);
                            return {
                                selector: null,
                                name: 'article-section',
                                scrollable: true,
                                useModal: false,
                                useFeedPanel: true,
                                panelCoords: {
                                    x: rect.x + rect.width / 2,
                                    y: rect.y + rect.height / 2
                                }
                            };
                        }
                    }
                }

                // Legacy: check article/page containers
                const candidates = [
                    'article section:last-child',
                    'article > div > div:nth-child(2)',
                    '[style*="overflow-y: auto"]',
                    '[style*="overflow-y: scroll"]',
                    '[style*="overflow: auto"]'
                ];

                for (const sel of candidates) {
                    const el = document.querySelector(sel);
                    if (el && el.scrollHeight > el.clientHeight + 50) {
                        console.log(`[CONTAINER] Found article container: ${sel}`);
                        return {
                            selector: sel,
                            name: 'article-container',
                            scrollable: true,
                            useModal: false
                        };
                    }
                }

                // FALLBACK: If article exists but no scrollable container found,
                // still return article coords for mouse.wheel scroll
                if (article) {
                    const rect = article.getBoundingClientRect();
                    console.log('[CONTAINER] No scrollable found, using article fallback');
                    return {
                        selector: null,
                        name: 'article-fallback',
                        scrollable: false, // No JS scroll, but we can use mouse.wheel
                        useModal: false,
                        useFeedPanel: true,
                        panelCoords: {
                            x: rect.x + rect.width * 0.75, // Right side (comments)
                            y: rect.y + rect.height * 0.5
                        }
                    };
                }

                return { selector: null, name: 'none', scrollable: false, useModal: false };
            });

            if (result.scrollable) {
                logger.info(`[SCROLL] ✅ Found container: ${result.name} (${result.selector})`);
                if (result.details) {
                    logger.info(`[SCROLL] Container details: overflow=${result.details.overflowY}, height=${result.details.clientHeight}px, scroll=${result.details.scrollHeight}px`);
                }
            } else {
                logger.warn('[SCROLL] ⚠️ No scrollable container found');
            }

            return result;

        } catch (error) {
            logger.error('[SCROLL] Error finding scroll container:', error.message);
            return { selector: null, name: 'error', scrollable: false, useModal: false };
        }
    }

    /**
     * Try to open the comments modal (clicking on comments link)
     * Instagram often shows comments in a modal overlay
     */
    async openCommentsModal(page) {
        try {
            // Check if modal is already open
            const hasModal = await page.$('div[role="dialog"]');
            if (hasModal) {
                return true;
            }

            // Try to click on elements that open comments
            const openSelectors = [
                // Link to comments (speech bubble icon or text)
                'a[href*="/comments/"]',
                'svg[aria-label*="Comment"]',
                'svg[aria-label*="Comentário"]',
                // Comment count click area
                'span:has-text("comentário")',
                'span:has-text("comment")',
            ];

            for (const selector of openSelectors) {
                try {
                    const el = await page.$(selector);
                    if (el && await el.isVisible()) {
                        await el.click();
                        await randomDelay(2000, 3000);

                        // Check if modal opened
                        const modalOpened = await page.$('div[role="dialog"]');
                        if (modalOpened) {
                            return true;
                        }
                    }
                } catch (e) {
                    // Try next
                }
            }

            return false;
        } catch (error) {
            logger.debug('[SCRAPE] Could not open comments modal:', error.message);
            return false;
        }
    }

    /**
     * Click on "Load more comments" or "View replies" buttons
     * Returns true if any button was clicked
     */
    async clickLoadMoreButtons(page) {
        const buttonPatterns = [
            // Portuguese
            { text: /ver mais respostas/i, priority: 1 },
            { text: /ver respostas/i, priority: 1 },
            { text: /carregar mais/i, priority: 2 },
            { text: /mais comentários/i, priority: 2 },
            // English
            { text: /view.*replies/i, priority: 1 },
            { text: /load more/i, priority: 2 },
            { text: /more comments/i, priority: 2 },
            // Generic expand
            { text: /^\+$/, priority: 3 },
            { text: /ver mais/i, priority: 3 },
        ];

        try {
            for (const pattern of buttonPatterns.sort((a, b) => a.priority - b.priority)) {
                const locator = page.getByText(pattern.text);
                const count = await locator.count();

                if (count > 0) {
                    // Click the first visible match
                    for (let i = 0; i < Math.min(count, 3); i++) {
                        const element = locator.nth(i);
                        if (await element.isVisible().catch(() => false)) {
                            await element.click().catch(() => { });
                            logger.debug(`[SCRAPE] Clicked: "${pattern.text}"`);
                            return true;
                        }
                    }
                }
            }
        } catch (error) {
            logger.debug('[SCRAPE] Error clicking load more:', error.message);
        }

        return false;
    }

    /**
     * Extract comments directly from DOM as fallback
     * @param {Page} page
     * @param {string} postId
     * @param {string} postUrl
     * @returns {Promise<Array>}
     */
    async extractCommentsFromDOM(page, postId, postUrl) {
        const comments = [];
        logger.info('[SCRAPE] Attempting DOM extraction for comments...');

        try {
            // Multiple selector strategies for Instagram's DOM
            const commentContainerSelectors = [
                'article ul > ul > div', // Nested comment structure
                'article div[role="button"] + ul li', // Comment list after buttons
                'ul ul li', // Generic nested list
                'div[class*="Comment"] > div', // Class-based
            ];

            let commentElements = [];
            let usedAI = false;

            // Try traditional selectors first
            for (const selector of commentContainerSelectors) {
                try {
                    const elements = await page.$$(selector);
                    if (elements.length > 0) {
                        logger.info(`[SCRAPE] Found ${elements.length} potential comment elements with: ${selector}`);
                        commentElements = elements;
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }

            // If no comments found, try AI fallback
            if (commentElements.length === 0) {
                logger.info('[SCRAPE] Traditional selectors failed, trying AI fallback...');

                const aiResult = await aiSelectorFallback.findAllElements(page, 'comment_item', 'post_page');

                if (aiResult.elements && aiResult.elements.length > 0) {
                    commentElements = aiResult.elements;
                    usedAI = true;
                    logger.info(`[SCRAPE] 🤖 AI found ${aiResult.count} comment elements with: ${aiResult.usedSelector}`);
                }
            }

            // Log page structure for debugging
            const pageStats = await page.evaluate(() => {
                return {
                    totalLinks: document.querySelectorAll('a').length,
                    totalSpans: document.querySelectorAll('span').length,
                    totalUls: document.querySelectorAll('ul').length,
                    hasArticle: !!document.querySelector('article'),
                    bodyTextLength: document.body?.innerText?.length || 0
                };
            });
            logger.info('[SCRAPE] Page DOM stats:', pageStats);

            for (const element of commentElements) {
                try {
                    // Try multiple approaches to extract username and text
                    const usernameEl = await element.$('a[href^="/"][role="link"]') ||
                        await element.$('a[href^="/"]') ||
                        await element.$('span a');
                    const textEl = await element.$('span[dir="auto"]') ||
                        await element.$('span > span') ||
                        await element.$('div > span');

                    if (usernameEl && textEl) {
                        const usernameHref = await usernameEl.getAttribute('href');
                        const text = await textEl.textContent();

                        if (usernameHref && text && text.trim().length > 0) {
                            const username = usernameHref.replace(/\//g, '').split('?')[0];

                            // Skip if this looks like the post author or navigation
                            if (username && username.length > 0 && !username.includes('explore')) {
                                comments.push({
                                    post_id: postId,
                                    post_url: postUrl,
                                    comment_id: `dom_${Date.now()}_${comments.length}`,
                                    text: text.trim(),
                                    username: username,
                                    created_at: new Date().toISOString(),
                                    user_id: '',
                                    profile_pic_url: '',
                                    like_count: 0,
                                });
                            }
                        }
                    }
                } catch (e) {
                    // Skip invalid element
                }
            }

            if (comments.length > 0) {
                logger.info(`[SCRAPE] Extracted ${comments.length} comments from DOM`);
            } else {
                logger.warn('[SCRAPE] No comments extracted from DOM');

                // Final fallback: try direct AI extraction
                logger.info('[SCRAPE] Trying direct AI extraction as final fallback...');
                const aiComments = await aiSelectorFallback.extractCommentsDirectly(page, postId, postUrl);

                if (aiComments.length > 0) {
                    logger.info(`[SCRAPE] 🤖 AI directly extracted ${aiComments.length} comments!`);
                    return aiComments;
                }
            }

        } catch (error) {
            logger.error('[SCRAPE] Error extracting comments from DOM:', error.message);
        }

        return comments;
    }

    /**
     * Extract visible comments directly from the current page DOM
     * This is used when comments are visible in the modal/page but not captured via GraphQL
     * @param {Page} page 
     * @param {string} postId 
     * @param {string} postUrl 
     * @returns {Promise<Array>}
     */
    async extractVisibleCommentsFromDOM(page, postId, postUrl) {
        const comments = [];

        try {
            // Extract all visible comments from the page
            const extractedData = await page.evaluate(() => {
                const results = [];

                // Strategy 1: Look for comment elements containing username links and text
                // Instagram comments typically have: <a href="/username">username</a> followed by <span>comment text</span>

                // Find all links that look like usernames (start with / and are short)
                const allLinks = document.querySelectorAll('a[href^="/"]');

                for (const link of allLinks) {
                    const href = link.getAttribute('href');
                    // Skip non-username links
                    if (!href || href.includes('/p/') || href.includes('/explore') ||
                        href.includes('/accounts') || href.length > 50 || href.split('/').length > 3) {
                        continue;
                    }

                    // Extract potential username
                    const username = href.replace(/^\//, '').replace(/\/$/, '');
                    if (!username || username.length < 2 || username.length > 30 || username.includes(' ')) {
                        continue;
                    }

                    // Look for text near this username link
                    // Check parent, siblings, and nearby elements
                    const parent = link.parentElement;
                    const grandparent = parent?.parentElement;
                    const container = grandparent?.parentElement;

                    // Try to find comment text in various positions
                    let commentText = null;

                    // Check siblings of the link
                    if (parent) {
                        const spans = parent.querySelectorAll('span');
                        for (const span of spans) {
                            const text = span.innerText?.trim();
                            if (text && text.length > 0 && text.length < 2000 && text !== username) {
                                // Skip timestamps and other short labels
                                if (text.match(/^\d+\s*(sem|min|h|d|w|m|y|s)$/)) continue;
                                if (text === 'Responder' || text === 'Reply') continue;
                                if (text === 'Ver respostas' || text === 'View replies') continue;
                                if (text.startsWith('Ver ') || text.startsWith('View ')) continue;
                                commentText = text;
                                break;
                            }
                        }
                    }

                    // If not found, check grandparent
                    if (!commentText && grandparent) {
                        const spans = grandparent.querySelectorAll('span[dir="auto"]');
                        for (const span of spans) {
                            const text = span.innerText?.trim();
                            if (text && text.length > 0 && text.length < 2000 && text !== username &&
                                !text.match(/^\d+\s*(sem|min|h|d|w|m|y|s)$/) &&
                                text !== 'Responder' && text !== 'Reply') {
                                commentText = text;
                                break;
                            }
                        }
                    }

                    // If still not found, try container
                    if (!commentText && container) {
                        const spans = container.querySelectorAll('span[dir="auto"]');
                        for (const span of spans) {
                            const text = span.innerText?.trim();
                            if (text && text.length > 3 && text.length < 2000 && text !== username &&
                                !text.match(/^\d+\s*(sem|min|h|d|w|m|y|s)$/) &&
                                text !== 'Responder' && text !== 'Reply') {
                                commentText = text;
                                break;
                            }
                        }
                    }

                    if (commentText && username) {
                        // Avoid duplicates
                        const isDuplicate = results.some(r =>
                            r.username === username && r.text === commentText
                        );

                        if (!isDuplicate) {
                            results.push({
                                username,
                                text: commentText
                            });
                        }
                    }
                }

                return results;
            });

            // Convert to standard comment format
            const timestamp = new Date().toISOString();
            for (const item of extractedData) {
                if (item.username && item.text) {
                    comments.push({
                        comment_id: `dom_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        text: item.text,
                        username: item.username,
                        created_at: timestamp,
                        post_id: postId,
                        post_url: postUrl,
                        user_id: '',
                        profile_pic_url: '',
                        like_count: 0
                    });
                }
            }

            logger.info(`[DOM] Extracted ${comments.length} visible comments from page`);

        } catch (error) {
            logger.error('[DOM] Error extracting visible comments:', error.message);
        }

        return comments;
    }

    /**
     * Aggressively scroll the modal/page to load ALL comments before DOM extraction
     * Uses getScrollStrategy to pick the best scroll method
     * Includes progressive comment counting
     * @param {Page} page 
     */
    async scrollModalToLoadAllComments(page) {
        const MAX_SCROLL_ATTEMPTS = 25; // Increased for more comments
        const SCROLL_DELAY = 600;

        try {
            // Use stored layout type or detect on the fly
            const layoutType = this.currentLayoutType || 'MODAL_POST_VIEW';
            logger.info(`[SCROLL] 📱 Layout type: ${layoutType}`);

            // Get optimal scroll strategy
            const strategy = await this.getScrollStrategy(page);

            // Move mouse to scroll target
            if (strategy.coords) {
                await page.mouse.move(strategy.coords.x, strategy.coords.y);
            }

            // Count initial comments
            let previousCount = await this.countVisibleComments(page);
            let sameCountIterations = 0;

            logger.info(`[SCROLL] Starting with ${previousCount} visible comments`);

            // Progressive scroll loop
            for (let i = 0; i < MAX_SCROLL_ATTEMPTS; i++) {
                // Scroll using the determined strategy
                if (strategy.type === 'ELEMENT_SCROLL') {
                    // Try scrolling elements via JS
                    await page.evaluate(() => {
                        const scrollables = document.querySelectorAll('section, ul, div');
                        for (const el of scrollables) {
                            if (el.scrollHeight > el.clientHeight + 50) {
                                el.scrollTop += 500;
                            }
                        }
                    });
                }

                // Always also use mouse wheel at the target coords
                if (strategy.coords) {
                    await page.mouse.wheel(0, 500);
                }

                await page.waitForTimeout(SCROLL_DELAY);

                // Count comments after scroll
                const currentCount = await this.countVisibleComments(page);

                if (currentCount > previousCount) {
                    logger.info(`[SCROLL] Iteration ${i + 1}: ${previousCount} → ${currentCount} comments (+${currentCount - previousCount})`);
                    previousCount = currentCount;
                    sameCountIterations = 0;
                } else {
                    sameCountIterations++;
                    logger.debug(`[SCROLL] Iteration ${i + 1}: No new comments (${sameCountIterations}/3)`);

                    // If count hasn't changed for 3 iterations, probably reached end
                    if (sameCountIterations >= 3) {
                        logger.info(`[SCROLL] No new comments after 3 iterations, stopping`);
                        break;
                    }
                }

                // Check if we've reached the input field (end of comments)
                if (await this.hasReachedCommentsBottom(page)) {
                    logger.info(`[SCROLL] ✅ Reached comment input after ${i + 1} scrolls`);
                    break;
                }
            }

            // Final count
            const finalCount = await this.countVisibleComments(page);
            logger.info(`[SCROLL] ✅ Scroll complete. Final visible comments: ${finalCount}`);

            // Final wait for lazy-loaded content
            await page.waitForTimeout(1000);

            logger.info('[SCROLL] ✅ Scroll complete');

        } catch (error) {
            logger.warn('[SCROLL] Error during scroll:', error.message);
        }
    }

    /**
     * Detect the current Instagram view type with detailed logging
     * @param {Page} page 
     * @returns {Promise<{type: 'MODAL'|'FEED_INLINE'|'UNKNOWN', scrollTarget: {x, y}|null, debug: object}>}
     */
    async detectViewType(page) {
        const debug = await page.evaluate(() => {
            const result = {
                hasDialog: false,
                dialogRect: null,
                hasArticle: false,
                articleRect: null,
                hasCommentIndicators: false,
                indicators: [],
                bodyTextSample: ''
            };

            // Check for dialog
            const dialog = document.querySelector('div[role="dialog"]');
            if (dialog) {
                result.hasDialog = true;
                const rect = dialog.getBoundingClientRect();
                result.dialogRect = { width: rect.width, height: rect.height, x: rect.x, y: rect.y };
            }

            // Check for article
            const article = document.querySelector('article');
            if (article) {
                result.hasArticle = true;
                const rect = article.getBoundingClientRect();
                result.articleRect = { width: rect.width, height: rect.height, x: rect.x, y: rect.y };
            }

            // Check for comment indicators in body
            const bodyText = document.body.innerText || '';
            result.bodyTextSample = bodyText.substring(0, 500);

            const indicators = ['Responder', 'Reply', 'curtida', 'like', 'comentário', 'comment', '@'];
            for (const ind of indicators) {
                if (bodyText.toLowerCase().includes(ind.toLowerCase())) {
                    result.indicators.push(ind);
                }
            }
            result.hasCommentIndicators = result.indicators.length > 0;

            return result;
        });

        // Log debug info
        logger.info(`[VIEW-DEBUG] hasDialog=${debug.hasDialog}, hasArticle=${debug.hasArticle}, indicators=[${debug.indicators.join(',')}]`);
        if (debug.dialogRect) {
            logger.info(`[VIEW-DEBUG] Dialog: ${debug.dialogRect.width}x${debug.dialogRect.height} at (${Math.round(debug.dialogRect.x)},${Math.round(debug.dialogRect.y)})`);
        }
        if (debug.articleRect) {
            logger.info(`[VIEW-DEBUG] Article: ${debug.articleRect.width}x${debug.articleRect.height} at (${Math.round(debug.articleRect.x)},${Math.round(debug.articleRect.y)})`);
        }

        // Determine view type based on debug info
        if (debug.hasDialog && debug.dialogRect && debug.dialogRect.width > 300 && debug.dialogRect.height > 300) {
            return {
                type: 'MODAL',
                scrollTarget: {
                    x: debug.dialogRect.x + debug.dialogRect.width * 0.7,
                    y: debug.dialogRect.y + debug.dialogRect.height * 0.5
                },
                debug
            };
        }

        // If article exists, it's FEED_INLINE (even without specific indicators)
        if (debug.hasArticle && debug.articleRect) {
            return {
                type: 'FEED_INLINE',
                scrollTarget: {
                    x: debug.articleRect.x + debug.articleRect.width * 0.75,
                    y: debug.articleRect.y + debug.articleRect.height * 0.5
                },
                debug
            };
        }

        // Fallback: use viewport center-right
        logger.warn('[VIEW] Could not detect view type, using UNKNOWN fallback');
        return {
            type: 'UNKNOWN',
            scrollTarget: {
                x: 800, // ~70% of typical viewport
                y: 400  // ~50% of typical viewport
            },
            debug
        };
    }

    /**
     * Check if we've scrolled to the bottom of comments
     * @param {Page} page 
     * @returns {Promise<boolean>}
     */
    async hasReachedCommentsBottom(page) {
        return await page.evaluate(() => {
            const text = document.body.innerText;
            return text.includes('Adicione um comentário') ||
                text.includes('Add a comment') ||
                text.includes('Escreva um comentário');
        });
    }

    /**
     * Count visible comments on the page
     * @param {Page} page 
     * @returns {Promise<number>}
     */
    async countVisibleComments(page) {
        return await page.evaluate(() => {
            let count = 0;
            const allLists = document.querySelectorAll('ul');
            for (const ul of allLists) {
                const items = ul.querySelectorAll('li');
                for (const li of items) {
                    const text = li.innerText || '';
                    // Comment indicators: @username, Responder, Reply, or likes
                    if (text.includes('@') ||
                        text.includes('Responder') ||
                        text.includes('Reply') ||
                        text.includes('curtida')) {
                        count++;
                    }
                }
            }
            return count;
        });
    }

    /**
     * Dismiss any blocking popups (Save Login Info, Notifications, etc.)
     * Must be called before scrolling to ensure popups don't block the comment modal
     * @param {Page} page 
     */
    async dismissBlockingPopups(page) {
        try {
            // Check for "Save Login Info" popup
            const popupSelectors = [
                // Portuguese
                'button:has-text("Agora não")',
                'button:has-text("Agora Não")',
                'div[role="button"]:has-text("Agora não")',
                // English
                'button:has-text("Not Now")',
                'button:has-text("Not now")',
                // Generic X close button
                'div[role="dialog"] button[aria-label="Close"]',
                'div[role="dialog"] svg[aria-label="Close"]',
            ];

            for (const selector of popupSelectors) {
                try {
                    const btn = await page.$(selector);
                    if (btn) {
                        const isVisible = await btn.isVisible();
                        if (isVisible) {
                            await btn.click();
                            logger.info(`[POPUP] ✅ Dismissed blocking popup: ${selector}`);
                            await randomDelay(1000, 2000);
                            return true;
                        }
                    }
                } catch (e) { /* try next selector */ }
            }

            return false;
        } catch (error) {
            logger.warn('[POPUP] Error dismissing popup:', error.message);
            return false;
        }
    }

    /**
     * Extrai dados do window._sharedData (fallback quando GraphQL falha)
     * @param {Page} page 
     * @param {string} postId 
     * @param {string} postUrl 
     */
    async extractSharedData(page, postId, postUrl) {
        const comments = [];

        try {
            const sharedData = await page.evaluate(() => {
                // Método 1: Tentar window._sharedData global
                if (typeof window._sharedData !== 'undefined') {
                    return window._sharedData;
                }

                // Método 2: Buscar em todos os scripts
                const scripts = Array.from(document.querySelectorAll('script'));
                for (const script of scripts) {
                    const text = script.textContent || '';

                    // Procurar window._sharedData
                    if (text.includes('window._sharedData')) {
                        try {
                            const match = text.match(/window\._sharedData\s*=\s*(\{.+?\});/s);
                            if (match && match[1]) {
                                return JSON.parse(match[1]);
                            }
                        } catch (e) {
                            console.error('Failed to parse _sharedData:', e);
                        }
                    }
                }

                // Método 3: Buscar por application/ld+json
                const ldJson = document.querySelector('script[type="application/ld+json"]');
                if (ldJson && ldJson.textContent) {
                    try {
                        return { ldJson: JSON.parse(ldJson.textContent) };
                    } catch (e) {
                        console.error('Failed to parse LD+JSON:', e);
                    }
                }

                return null;
            });

            if (!sharedData) {
                logger.warn('[SHARED-DATA] window._sharedData not found in page');
                return [];
            }

            logger.info('[SHARED-DATA] ✅ Successfully extracted window._sharedData');

            // Tentar extrair comentários do PostPage
            if (sharedData.entry_data?.PostPage?.[0]?.graphql?.shortcode_media) {
                const media = sharedData.entry_data.PostPage[0].graphql.shortcode_media;
                const commentEdges = media.edge_media_to_parent_comment?.edges || [];

                const timestamp = new Date().toISOString();
                for (const edge of commentEdges) {
                    if (edge.node?.text && edge.node?.owner?.username) {
                        comments.push({
                            comment_id: edge.node.id || `shared_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                            text: edge.node.text,
                            username: edge.node.owner.username,
                            created_at: edge.node.created_at ?
                                new Date(edge.node.created_at * 1000).toISOString() : timestamp,
                            post_id: postId,
                            post_url: postUrl,
                            user_id: edge.node.owner.id || '',
                            profile_pic_url: edge.node.owner.profile_pic_url || '',
                            like_count: edge.node.edge_liked_by?.count || 0
                        });
                    }
                }

                logger.info(`[SHARED-DATA] Extracted ${comments.length} comments from PostPage`);
            }

            return comments;
        } catch (error) {
            logger.error('[SHARED-DATA] Error extracting:', error.message);
            return [];
        }
    }

    /**
     * Delay aleatório que simula comportamento humano
     * @param {number} minMs 
     * @param {number} maxMs 
     */
    async humanDelay(minMs = 500, maxMs = 2000) {
        const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    /**
     * Simula movimento de mouse humano
     * @param {Page} page 
     */
    async simulateHumanBehavior(page) {
        try {
            // Mouse movements aleatórios
            const moves = Math.floor(Math.random() * 3) + 2; // 2-4 movimentos
            for (let i = 0; i < moves; i++) {
                const x = Math.floor(Math.random() * 1920);
                const y = Math.floor(Math.random() * 1080);
                await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 10) + 5 });
                await this.humanDelay(100, 500);
            }

            // Scroll suave
            await page.evaluate(() => {
                window.scrollBy({
                    top: Math.random() * 300 + 100,
                    behavior: 'smooth'
                });
            });
            await this.humanDelay(800, 1500);

            // Scroll de volta
            await page.evaluate(() => {
                window.scrollBy({
                    top: -(Math.random() * 200 + 50),
                    behavior: 'smooth'
                });
            });
            await this.humanDelay(500, 1000);

            logger.info('[HUMAN-SIM] ✅ Human behavior simulation complete');
        } catch (error) {
            logger.warn('[HUMAN-SIM] Failed to simulate:', error.message);
        }
    }

    /**
     * Extract comments from script tags containing preloaded JSON data
     * Instagram preloads comment data in script tags with IDs like 'PolarisPostCommentsContainerQueryRelayPreloader'
     */
    async extractCommentsFromScripts(page, postId, postUrl) {
        const comments = [];

        try {
            // Get all script tag contents that might contain comment data
            const scriptData = await page.evaluate(() => {
                const results = [];
                const scripts = document.querySelectorAll('script[type="application/json"]');

                scripts.forEach((script, index) => {
                    try {
                        const content = script.textContent;
                        if (content && (content.includes('comment') || content.includes('edge_media'))) {
                            results.push({
                                id: script.id || `script-${index}`,
                                content: content.substring(0, 200000) // Increased limit for large comment sections
                            });
                        }
                    } catch (e) { }
                });

                // Also check for script tags with specific IDs
                const preloaderScripts = document.querySelectorAll('script[id*="Preloader"]');
                preloaderScripts.forEach((script, index) => {
                    try {
                        const content = script.textContent;
                        if (content) {
                            results.push({
                                id: script.id || `preloader-${index}`,
                                content: content.substring(0, 200000)
                            });
                        }
                    } catch (e) { }
                });

                // Also look in __NEXT_DATA__ or other common stores
                const nextData = document.getElementById('__NEXT_DATA__');
                if (nextData && nextData.textContent) {
                    results.push({
                        id: '__NEXT_DATA__',
                        content: nextData.textContent.substring(0, 50000)
                    });
                }

                return results;
            });

            logger.info(`[SCRIPTS] Found ${scriptData.length} script tags with potential comment data`);

            for (const script of scriptData) {
                try {
                    const data = JSON.parse(script.content);
                    logger.debug(`[SCRIPTS] Parsing script: ${script.id}`);

                    // Use deep search to find comments
                    const extracted = this.deepSearchForComments(data, postId, postUrl);

                    if (extracted.length > 0) {
                        logger.info(`[SCRIPTS] 🎯 Found ${extracted.length} comments in script: ${script.id}`);

                        // Add unique comments only
                        const existingIds = new Set(comments.map(c => c.comment_id));
                        for (const comment of extracted) {
                            if (!existingIds.has(comment.comment_id)) {
                                comments.push(comment);
                                existingIds.add(comment.comment_id);
                            }
                        }
                    }
                } catch (e) {
                    // Script content wasn't valid JSON or parsing failed
                    logger.debug(`[SCRIPTS] Failed to parse script ${script.id}: ${e.message}`);
                }
            }

            if (comments.length > 0) {
                logger.info(`[SCRIPTS] Total comments extracted from scripts: ${comments.length}`);
            } else {
                logger.warn('[SCRIPTS] No comments found in script tags');
            }

        } catch (error) {
            logger.error('[SCRIPTS] Error extracting from scripts:', error.message);
        }

        return comments;
    }

    /**
     * Save comments to Supabase
     * @param {Array} comments
     * @param {string} postId
     * @returns {Promise<number>} Number of saved comments
     */
    async saveComments(comments, postId) {
        if (comments.length === 0) {
            return 0;
        }

        try {
            // Filter out invalid DOM-extracted comments
            const validComments = comments.filter(comment => {
                // Skip if comment_id starts with 'dom_' and text is likely UI element
                if (comment.comment_id?.startsWith('dom_')) {
                    const text = (comment.text || '').trim().toLowerCase();

                    // Invalid: Known UI elements
                    const invalidTexts = ['perfil', 'reels', 'pesquisa', 'explorar', 'mensagens',
                        'notificações', 'criar', 'painel', 'mais', 'search',
                        'explore', 'messages', 'notifications', 'create', 'more'];
                    if (invalidTexts.includes(text)) {
                        logger.debug(`[FILTER] Removing UI element: "${comment.text}"`);
                        return false;
                    }

                    // Invalid: Post description (contains "..." or "mais" at end)
                    if (text.includes('...') && text.includes('mais')) {
                        logger.debug(`[FILTER] Removing post description: "${comment.text?.substring(0, 50)}..."`);
                        return false;
                    }

                    // Invalid: Very short text that's not an emoji (likely UI)
                    if (text.length < 2 && !/[\u{1F300}-\u{1F9FF}]/u.test(text)) {
                        logger.debug(`[FILTER] Removing short text: "${comment.text}"`);
                        return false;
                    }

                    // Invalid: Same username as post author and looks like description
                    if (comment.username?.toLowerCase() === 'governobarroalto' && text.length > 100) {
                        logger.debug(`[FILTER] Removing post author description`);
                        return false;
                    }
                }

                return true;
            });

            if (validComments.length < comments.length) {
                logger.info(`[FILTER] Removed ${comments.length - validComments.length} invalid DOM comments`);
            }

            // Deduplicate by comment_id and remove columns that don't exist in the database
            const uniqueComments = [];
            const seenIds = new Set();

            for (const comment of validComments) {
                if (!seenIds.has(comment.comment_id)) {
                    seenIds.add(comment.comment_id);
                    // Remove fields that don't exist in the database schema
                    const { extracted_by, ...cleanComment } = comment;
                    uniqueComments.push(cleanComment);
                }
            }

            // Upsert to Supabase (insert or update on conflict)
            const { data, error } = await supabase
                .from('instagram_comments')
                .upsert(uniqueComments, {
                    onConflict: 'comment_id',
                    ignoreDuplicates: false,
                });

            if (error) {
                logger.error('Error saving comments to Supabase:', error);
                return 0;
            }

            logger.info(`Saved ${uniqueComments.length} comments to database`);
            return uniqueComments.length;

        } catch (error) {
            logger.error('Error in saveComments:', error);
            return 0;
        }
    }
}

// Export singleton instance
module.exports = new InstagramService();
