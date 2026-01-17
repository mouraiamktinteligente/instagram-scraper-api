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
const {
    parseComment,
    getRandomUserAgent,
    getBrowserHeaders,
    randomDelay,
    extractPostId,
} = require('../utils/helpers');

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

            // Wait for comments to load
            await this.waitForComments(page);

            // Scroll to load more comments (with optional limit)
            await this.scrollForMoreComments(page, maxComments, comments);

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

            // Step 6: Click login button
            logger.info('[LOGIN] Step 6: Clicking login button...');
            await page.click('button[type="submit"]');
            logger.info('[LOGIN] Step 6: Login button clicked, waiting for response...');

            // Step 6: Wait for navigation or error
            await randomDelay(5000, 8000);

            const currentUrl = page.url();
            logger.info(`[LOGIN] Step 6: Current URL after login attempt: ${currentUrl}`);

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
                await page.close();
                return false;
            }

            // Step 8: Handle post-login popups
            logger.info('[LOGIN] Step 8: Handling post-login popups...');
            await randomDelay(2000, 3000);

            // Handle "Save Login Info" popup
            try {
                const notNowButtons = await page.$$('button:has-text("Not Now")');
                for (const btn of notNowButtons) {
                    try {
                        await btn.click();
                        logger.info('[LOGIN] Clicked "Not Now" popup');
                        await randomDelay(1000, 2000);
                    } catch (e) { /* button might not be clickable */ }
                }
            } catch (e) { /* ignore */ }

            // Handle notifications popup
            try {
                const turnOnBtn = await page.$('button:has-text("Turn On")');
                const notNowBtn = await page.$('button:has-text("Not Now")');
                if (notNowBtn) {
                    await notNowBtn.click();
                    logger.info('[LOGIN] Dismissed notifications popup');
                    await randomDelay(1000, 2000);
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
     * @param {Page} page
     * @param {Object} account
     * @returns {Promise<boolean>} true if 2FA was handled, false if not
     */
    async handle2FAChallenge(page, account) {
        // Check if account has TOTP secret
        if (!account.totpSecret) {
            logger.warn('[2FA] Account does not have TOTP secret configured');
            return false;
        }

        try {
            logger.info('[2FA] ========== 2FA DEBUG START ==========');
            logger.info(`[2FA] Account: ${account.username}`);
            logger.info(`[2FA] TOTP Secret (first 8 chars): ${account.totpSecret.substring(0, 8)}...`);
            logger.info(`[2FA] TOTP Secret length: ${account.totpSecret.length}`);
            logger.info(`[2FA] Current URL: ${page.url()}`);

            // Generate TOTP code
            const totpCode = speakeasy.totp({
                secret: account.totpSecret,
                encoding: 'base32'
            });

            // Log FULL code for debugging (remove in production)
            logger.info(`[2FA] Generated TOTP code: ${totpCode}`);
            logger.info(`[2FA] Code length: ${totpCode.length}`);
            logger.info(`[2FA] Code type: ${typeof totpCode}`);

            // Wait for the 2FA input field
            logger.info('[2FA] Waiting for 2FA page to load...');
            await randomDelay(2000, 3000);

            // Log page content for debugging
            const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
            logger.info(`[2FA] Page content preview: ${pageText.replace(/\n/g, ' ')}`);

            // Look for 2FA code input field (various selectors)
            const codeInputSelectors = [
                'input[name="verificationCode"]',
                'input[name="security_code"]',
                'input[aria-label*="Security code"]',
                'input[aria-label*="código"]',
                'input[aria-label*="Código"]',
                'input[placeholder*="code"]',
                'input[placeholder*="código"]',
                'input[type="text"][maxlength="6"]',
                'input[type="number"]',
                'input[type="tel"]',
            ];

            let codeInput = null;
            for (const selector of codeInputSelectors) {
                try {
                    codeInput = await page.waitForSelector(selector, { timeout: 3000 });
                    if (codeInput) {
                        const isVisible = await codeInput.isVisible().catch(() => false);
                        logger.info(`[2FA] Found input with selector: ${selector} (visible: ${isVisible})`);
                        if (isVisible) break;
                        codeInput = null; // Reset if not visible
                    }
                } catch (e) {
                    logger.debug(`[2FA] Selector ${selector} not found`);
                }
            }

            if (!codeInput) {
                logger.error('[2FA] ❌ Could not find 2FA code input field');
                logger.error(`[2FA] Available inputs: ${await page.$$eval('input', inputs => inputs.map(i => `${i.name || i.type || 'unknown'}[${i.placeholder || ''}]`).join(', '))}`);
                return false;
            }

            // Clear and type the code
            logger.info('[2FA] Filling code input...');
            await codeInput.fill('');
            await codeInput.type(totpCode, { delay: 150 });

            // Verify what was typed
            const typedValue = await codeInput.inputValue();
            logger.info(`[2FA] Value in input field: ${typedValue}`);
            logger.info(`[2FA] Match: ${typedValue === totpCode}`);

            // Wait before submitting
            await randomDelay(1000, 1500);

            // Take screenshot of page state (log URL and title)
            const urlBeforeSubmit = page.url();
            const titleBeforeSubmit = await page.title();
            logger.info(`[2FA] Before submit - URL: ${urlBeforeSubmit}`);
            logger.info(`[2FA] Before submit - Title: ${titleBeforeSubmit}`);

            // Look for submit/confirm button
            const submitSelectors = [
                'button[type="submit"]',
                'button:has-text("Confirm")',
                'button:has-text("Confirmar")',
                'button:has-text("Verificar")',
                'button:has-text("Verify")',
                'button:has-text("Submit")',
                'button:has-text("Enviar")',
                'div[role="button"]:has-text("Confirm")',
                'div[role="button"]:has-text("Confirmar")',
            ];

            let submitted = false;
            let clickedSelector = '';
            for (const selector of submitSelectors) {
                try {
                    const submitBtn = await page.$(selector);
                    if (submitBtn) {
                        const btnText = await submitBtn.textContent().catch(() => '');
                        const isVisible = await submitBtn.isVisible().catch(() => false);
                        logger.info(`[2FA] Found button: ${selector} (text: "${btnText}", visible: ${isVisible})`);

                        if (isVisible) {
                            // Try human-like click with hover first
                            logger.info('[2FA] Attempting human-like click...');

                            // Hover over button first
                            await submitBtn.hover();
                            await randomDelay(300, 500);

                            // Click with force option
                            await submitBtn.click({ force: true });
                            clickedSelector = selector;
                            submitted = true;
                            logger.info(`[2FA] ✅ Clicked submit button with force: ${selector}`);

                            // Wait a bit and check if page changed
                            await randomDelay(1500, 2000);

                            // If still on same page, try JavaScript click
                            const urlCheck1 = page.url();
                            if (urlCheck1.includes('two_factor')) {
                                logger.info('[2FA] Still on 2FA page, trying JavaScript click...');
                                await page.evaluate((sel) => {
                                    const btn = document.querySelector(sel) ||
                                        document.querySelector('button[type="submit"]') ||
                                        Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Confirm') || b.textContent.includes('Confirmar'));
                                    if (btn) {
                                        btn.click();
                                        // Try to submit the form too
                                        const form = btn.closest('form');
                                        if (form) form.submit();
                                    }
                                }, 'button[type="submit"]');

                                await randomDelay(1500, 2000);

                                // Try form submit directly
                                const urlCheck2 = page.url();
                                if (urlCheck2.includes('two_factor')) {
                                    logger.info('[2FA] Trying direct form submit...');
                                    await page.evaluate(() => {
                                        const forms = document.querySelectorAll('form');
                                        forms.forEach(f => {
                                            try { f.submit(); } catch (e) { }
                                        });
                                    });
                                }
                            }

                            break;
                        }
                    }
                } catch (e) {
                    logger.debug(`[2FA] Button selector ${selector} failed: ${e.message}`);
                }
            }

            if (!submitted) {
                logger.warn('[2FA] No submit button found, trying Enter key...');
                // Focus on input first
                await codeInput.focus();
                await randomDelay(200, 300);
                await page.keyboard.press('Enter');
                clickedSelector = 'Enter key';
                logger.info('[2FA] Pressed Enter to submit');
            }

            // Wait for navigation/response
            logger.info('[2FA] Waiting for response after submit...');
            await randomDelay(3000, 4000);

            // Try to wait for navigation
            try {
                await page.waitForLoadState('networkidle', { timeout: 8000 });
                logger.info('[2FA] Network idle reached');
            } catch (e) {
                logger.warn('[2FA] Network idle timeout - continuing anyway');
            }

            // Check result
            const urlAfterSubmit = page.url();
            const titleAfterSubmit = await page.title();
            logger.info(`[2FA] After submit - URL: ${urlAfterSubmit}`);
            logger.info(`[2FA] After submit - Title: ${titleAfterSubmit}`);

            // Check for error messages on page
            const errorTexts = await page.$$eval('[role="alert"], .error, [class*="error"], [class*="Error"]',
                elements => elements.map(e => e.textContent?.trim()).filter(Boolean)
            ).catch(() => []);

            if (errorTexts.length > 0) {
                logger.error(`[2FA] ❌ Error messages found: ${errorTexts.join(' | ')}`);
            }

            // Log final page content
            const finalPageText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
            logger.info(`[2FA] Final page content: ${finalPageText.replace(/\n/g, ' ')}`);

            logger.info('[2FA] ========== 2FA DEBUG END ==========');
            return true;

        } catch (error) {
            logger.error('[2FA] ❌ Exception in 2FA handler:', error.message);
            logger.error('[2FA] Stack:', error.stack);
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
                const extractedComments = this.deepSearchForComments(data, postId, postUrl);

                if (extractedComments.length > 0) {
                    commentApiCalls++;
                    logger.info(`[INTERCEPT] 🎯 Found ${extractedComments.length} comments in API call #${apiCallCount}`);

                    // Log sample comment for debugging
                    const sample = extractedComments[0];
                    logger.info(`[INTERCEPT] Sample comment: id=${sample.comment_id}, text="${sample.text?.substring(0, 30)}...", user=${sample.username}`);

                    // Add unique comments only
                    const existingIds = new Set(comments.map(c => c.comment_id));
                    for (const comment of extractedComments) {
                        if (!existingIds.has(comment.comment_id)) {
                            comments.push(comment);
                            existingIds.add(comment.comment_id);
                        }
                    }

                    logger.info(`[INTERCEPT] Total unique comments: ${comments.length}`);
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
     * Navigate to the Instagram post
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

        await page.goto(postUrl, {
            waitUntil: 'domcontentloaded',
            timeout: config.scraping.pageTimeout,
        });

        // Wait for JavaScript to render content
        logger.info('[SCRAPE] Waiting for post content to render...');
        try {
            await page.waitForFunction(() => {
                return document.querySelector('article') !== null ||
                    document.querySelectorAll('img').length > 2 ||
                    document.body.innerText.length > 500;
            }, { timeout: 30000 });
            logger.info('[SCRAPE] Post content rendered');
        } catch (e) {
            logger.warn('[SCRAPE] Timeout waiting for post content, continuing...');
        }

        // Wait for network to settle
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

        // Log current page state
        const pageInfo = await page.evaluate(() => ({
            url: window.location.href,
            title: document.title,
            hasArticle: !!document.querySelector('article'),
            imgCount: document.querySelectorAll('img').length,
            textLength: document.body?.innerText?.length || 0
        }));
        logger.info('[SCRAPE] Post page state:', pageInfo);

        await randomDelay(3000, 5000);
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
     * Scroll to load more comments
     * @param {Page} page
     */
    async scrollForMoreComments(page, maxComments = null, commentsArray = []) {
        const maxScrolls = config.scraping.maxScrolls || 100; // Safety limit
        const maxNoChangeIterations = 5; // Stop after 5 iterations with no new comments
        let totalClicks = 0;
        let previousCommentCount = 0;
        let noChangeCount = 0;

        const hasLimit = maxComments && maxComments > 0;
        logger.info(`[SCRAPE] Starting intelligent scroll for comments (limit: ${hasLimit ? maxComments : 'unlimited'}, safety: ${maxScrolls})...`);

        for (let i = 0; i < maxScrolls; i++) {
            // Count current comments (via intercepted data or DOM)
            const currentCommentCount = await page.evaluate(() => {
                // Count comment elements in DOM
                const commentElements = document.querySelectorAll('ul ul li, article ul > div > li');
                return commentElements.length;
            });

            // Check if new comments were loaded
            if (currentCommentCount === previousCommentCount) {
                noChangeCount++;
                logger.debug(`[SCRAPE] No new comments (${noChangeCount}/${maxNoChangeIterations})`);

                if (noChangeCount >= maxNoChangeIterations) {
                    logger.info(`[SCRAPE] ✅ All comments loaded! No new data after ${noChangeCount} scrolls`);
                    break;
                }
            } else {
                noChangeCount = 0; // Reset counter if new comments found
                logger.info(`[SCRAPE] Comments: ${previousCommentCount} → ${currentCommentCount} (+${currentCommentCount - previousCommentCount})`);
            }
            previousCommentCount = currentCommentCount;

            // Check if we've reached the comment limit (using intercepted comments array)
            if (hasLimit && commentsArray.length >= maxComments) {
                logger.info(`[SCRAPE] ✅ Reached comment limit! ${commentsArray.length}/${maxComments}`);
                break;
            }

            // Look for "Load more comments" or "View all comments" buttons/links
            const loadMoreSelectors = [
                // English
                'span:has-text("View all")',
                'button:has-text("View more comments")',
                'button:has-text("Load more")',
                'a:has-text("View all")',
                // Portuguese
                'span:has-text("Ver todos")',
                'button:has-text("Ver mais comentários")',
                'span:has-text("Ver mais")',
                'a:has-text("Ver todos")',
                // Generic - hidden comment expanders
                'ul li button',
                'div[role="button"]:has-text("+")',
            ];

            let clicked = false;
            for (const selector of loadMoreSelectors) {
                try {
                    const buttons = await page.$$(selector);
                    for (const button of buttons) {
                        const isVisible = await button.isVisible().catch(() => false);
                        if (isVisible) {
                            await button.click().catch(() => { });
                            clicked = true;
                            totalClicks++;
                            await randomDelay(1500, 2500);
                            break;
                        }
                    }
                    if (clicked) break;
                } catch (e) {
                    // Button not found or not clickable
                }
            }

            // Scroll within article/main content
            await page.evaluate(() => {
                const article = document.querySelector('article');
                if (article) {
                    article.scrollTop += 500;
                }
                window.scrollBy(0, 400);
            });

            await randomDelay(1000, 2000);

            // Log progress every 10 iterations
            if ((i + 1) % 10 === 0) {
                logger.info(`[SCRAPE] Progress: iteration ${i + 1}, comments: ${currentCommentCount}, clicks: ${totalClicks}`);
            }
        }

        logger.info(`[SCRAPE] Scrolling complete. Total iterations: ${previousCommentCount > 0 ? 'found data' : 'no data'}, clicks: ${totalClicks}`);
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
            }

        } catch (error) {
            logger.error('[SCRAPE] Error extracting comments from DOM:', error.message);
        }

        return comments;
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
                                content: content.substring(0, 50000) // Limit size
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
                                content: content.substring(0, 50000)
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
            // Deduplicate by comment_id
            const uniqueComments = [];
            const seenIds = new Set();

            for (const comment of comments) {
                if (!seenIds.has(comment.comment_id)) {
                    seenIds.add(comment.comment_id);
                    uniqueComments.push(comment);
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
