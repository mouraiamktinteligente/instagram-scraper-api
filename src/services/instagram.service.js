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
     * @param {string} jobId - Optional job ID for tracking
     * @param {number} maxComments - Optional max comments to extract
     * @param {string} mode - Scraping mode: 'public' | 'authenticated' | 'auto' (default: 'auto')
     * @returns {Promise<Object>} Scraping result
     */
    async scrapeComments(postUrl, proxy = null, jobId = null, maxComments = null, mode = 'auto') {
        const postId = extractPostId(postUrl);
        if (!postId) {
            throw new Error('Invalid Instagram post URL');
        }

        // Ensure services are initialized (loads from database)
        await initializeServices();

        logger.info('[SCRAPE] Starting comment scrape', { postId, postUrl, mode });

        // Handle different modes
        if (mode === 'public') {
            // Public-only mode: never try authenticated
            return await this.scrapePublicComments(postUrl, proxy, maxComments);
        }

        if (mode === 'auto') {
            // Auto mode: try public first, fall back to authenticated
            const accountCount = accountPool.getAccountCount();

            // If no accounts available, use public mode
            if (accountCount === 0) {
                logger.info('[SCRAPE] No accounts available, using public mode...');
                try {
                    const publicResult = await this.scrapePublicComments(postUrl, proxy, maxComments);
                    if (publicResult.commentsCount > 0) {
                        return publicResult;
                    }
                    logger.info('[SCRAPE] Public mode found 0 comments, no fallback available');
                    return publicResult;
                } catch (publicError) {
                    logger.error('[SCRAPE] Public mode failed:', publicError.message);
                    throw new Error('No accounts available and public extraction failed: ' + publicError.message);
                }
            }

            // Try public mode first (faster, no account ban risk)
            logger.info('[SCRAPE] Auto mode: trying public extraction first...');
            try {
                const publicResult = await this.scrapePublicComments(postUrl, proxy, maxComments);

                // Force authenticated mode if login wall was detected (GraphQL won't work without auth)
                if (publicResult.loginWallDetected) {
                    logger.info('[SCRAPE] Login wall detected - forcing authenticated mode for complete data');
                    // Don't return, continue to authenticated mode below
                } else if (publicResult.commentsCount >= 5) {
                    logger.info(`[SCRAPE] Public mode succeeded with ${publicResult.commentsCount} comments`);
                    return publicResult;
                } else {
                    logger.info(`[SCRAPE] Public mode found only ${publicResult.commentsCount} comments, trying authenticated...`);
                }
            } catch (publicError) {
                logger.info('[SCRAPE] Public mode failed, trying authenticated:', publicError.message);
            }
        }

        // Authenticated mode (mode === 'authenticated' or auto fallback)
        // ⭐ FALLBACK SYSTEM: Try all accounts for BOTH login AND scrape
        // If scrape fails with one account, automatically try the next

        const maxAccountAttempts = accountPool.getAccountCount();
        let lastError = null;

        for (let accountAttempt = 0; accountAttempt < maxAccountAttempts; accountAttempt++) {
            let browser = null;
            let context = null;
            let account = null;
            const comments = [];

            try {
                // Get next available account
                account = accountPool.getNextAccount();
                if (!account) {
                    logger.warn('[SCRAPE] No more accounts available');
                    break;
                }

                logger.info(`[SCRAPE] 🔄 Trying account: ${account.username} (${accountAttempt + 1}/${maxAccountAttempts})`);

                // Step 1: Login
                browser = await this.launchBrowser(proxy);
                context = await this.createBrowserContext(browser);
                const loggedIn = await this.ensureLoggedIn(context, account);

                if (!loggedIn) {
                    logger.warn(`[SCRAPE] Account ${account.username} login failed, trying next account...`);
                    accountPool.reportError(account.username, 'Login failed - possible 2FA challenge issue');
                    continue; // Try next account
                }

                logger.info(`[SCRAPE] ✅ Logged in with account: ${account.username}`);

                // Step 2: Scrape (entire process wrapped in this try block)
                // Reset comment extractor for this session (clear hashes)
            commentExtractor.reset();

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
                const initialCount = await this.waitForInitialGraphQLResponse(page, comments, 30000);
                logger.info(`[SCRAPE] ✅ Initial GraphQL loaded: ${initialCount} comments`);
            }

            // ⭐ NEW: If no comments yet, force open the comments modal
            if (comments.length === 0) {
                logger.info('[SCRAPE] 🔄 No comments intercepted, forcing modal open...');
                const modalOpened = await this.openCommentsModal(page);
                if (modalOpened) {
                    logger.info('[SCRAPE] ✅ Modal opened, waiting for comments to load...');
                    await randomDelay(3000, 4000);
                    // Check if comments were intercepted
                    if (comments.length === 0) {
                        // Try clicking "load more" buttons that might be visible
                        await this.clickLoadMoreButtons(page);
                        await randomDelay(2000, 3000);
                    }
                }
            }

            // ⭐ NEW: Try to trigger comment loading via scroll in comment panel
            if (comments.length === 0) {
                logger.info('[SCRAPE] 🔄 Still no comments, attempting targeted scroll...');
                await this.triggerCommentLoading(page);
                await randomDelay(2000, 3000);
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
                    // Detect the scroll container to pass to AI logic
                    const scrollContainer = await this.findScrollContainer(page);

                    // Use the intelligent extraction that detects total and scrolls to load all
                    const aiResult = await aiSelectorFallback.extractAllCommentsWithAI(page, postId, postUrl, scrollContainer);

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

            } catch (scrapeError) {
                // ⭐ FALLBACK: Save error and try next account
                lastError = scrapeError;
                logger.warn(`[SCRAPE] ⚠️ Account ${account?.username} failed: ${scrapeError.message}`);

                if (account) {
                    accountPool.reportError(account.username, scrapeError.message);
                }

                // Continue to next account (don't throw yet)

            } finally {
                // Cleanup browser/context before trying next account
                if (context) {
                    try { await context.close(); } catch (e) { /* ignore */ }
                }
                if (browser) {
                    try { await browser.close(); } catch (e) { /* ignore */ }
                }
            }
        }

        // ⭐ If we get here, ALL accounts failed
        logger.error('[SCRAPE] ❌ All accounts failed to scrape post', { postUrl, lastError: lastError?.message });
        throw lastError || new Error('All Instagram accounts failed to scrape');
    }

    /**
     * Scrape comments without login (public mode)
     * Extracts only comments visible to non-authenticated users
     * Similar to Apify's "No Login" Instagram Comment Scraper approach
     *
     * @param {string} postUrl - Instagram post URL
     * @param {Object} proxy - Optional proxy configuration
     * @param {number} maxComments - Optional max comments to extract
     * @returns {Promise<Object>} Scraping result
     */
    async scrapePublicComments(postUrl, proxy = null, maxComments = null) {
        const postId = extractPostId(postUrl);
        if (!postId) {
            throw new Error('Invalid Instagram post URL');
        }

        logger.info('[PUBLIC SCRAPE] Starting public comment extraction (no login)', { postId, postUrl });

        let browser = null;
        let context = null;
        const comments = [];
        let loginWallDetected = false;

        try {
            // Launch browser without login
            browser = await this.launchBrowser(proxy);
            context = await this.createBrowserContext(browser);

            // Reset comment extractor for this session
            commentExtractor.reset();

            // Create page and setup interception BEFORE navigation
            const page = await context.newPage();
            this.setupInterception(page, comments, postId, postUrl);

            logger.info('[PUBLIC SCRAPE] Navigating to post...');

            // Navigate directly to the post
            await page.goto(postUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });

            // Wait for the page to stabilize
            await randomDelay(2000, 3000);

            // Check if we hit a login wall
            const isLoginRequired = await page.evaluate(() => {
                // Check for login form elements (using valid CSS selectors only)
                const hasLoginInput = document.querySelector('input[name="username"]') !== null;
                const hasLoginButton = document.querySelector('[data-testid="login-button"]') !== null;
                const hasLoginLink = document.querySelector('a[href*="/accounts/login"]') !== null;

                // Check for "Log In" text in buttons (since :has-text is not valid CSS)
                const buttons = document.querySelectorAll('button');
                const hasLoginText = Array.from(buttons).some(btn =>
                    btn.textContent?.toLowerCase().includes('log in') ||
                    btn.textContent?.toLowerCase().includes('entrar')
                );

                return hasLoginInput || hasLoginButton || hasLoginLink || hasLoginText;
            });

            if (isLoginRequired) {
                logger.warn('[PUBLIC SCRAPE] Login wall detected - post may require authentication');
                loginWallDetected = true;
                // Continue anyway - some content may still be visible
            }

            // Extract post metadata if available
            let postMetadata = { post_author: null, post_description: null, post_likes_count: null };
            try {
                postMetadata = await this.extractPostMetadata(page);
            } catch (e) {
                logger.debug('[PUBLIC SCRAPE] Could not extract post metadata');
            }

            // Reset page position
            await page.evaluate(() => window.scrollTo(0, 0));
            await randomDelay(500, 800);

            // Wait for comments section to appear
            try {
                await this.waitForComments(page);
            } catch (e) {
                logger.debug('[PUBLIC SCRAPE] Comments section not found initially');
            }

            // Try to expand comments if "View all X comments" button exists
            try {
                const expanded = await this.expandAllComments(page);
                if (expanded) {
                    logger.info('[PUBLIC SCRAPE] Expanded comments, waiting for data...');
                    await this.waitForInitialGraphQLResponse(page, comments, 30000);
                }
            } catch (e) {
                logger.debug('[PUBLIC SCRAPE] Could not expand comments:', e.message);
            }

            // Scroll to trigger more comments loading
            logger.info('[PUBLIC SCRAPE] Scrolling to load more comments...');
            await this.scrollForMoreComments(page, maxComments || 100, comments);

            // DOM extraction fallback
            if (comments.length < 10) {
                logger.info('[PUBLIC SCRAPE] Trying DOM extraction...');

                // First, aggressively scroll the modal/page
                await this.scrollModalToLoadAllComments(page);

                const visibleComments = await this.extractVisibleCommentsFromDOM(page, postId, postUrl);
                if (visibleComments.length > 0) {
                    logger.info(`[PUBLIC SCRAPE] DOM extraction found ${visibleComments.length} comments`);

                    const existingTexts = new Set(comments.map(c => c.text?.substring(0, 40)));
                    for (const domComment of visibleComments) {
                        const textKey = domComment.text?.substring(0, 40);
                        if (textKey && !existingTexts.has(textKey)) {
                            comments.push(domComment);
                            existingTexts.add(textKey);
                        }
                    }
                }
            }

            // Script tag extraction fallback
            if (comments.length === 0) {
                logger.info('[PUBLIC SCRAPE] Trying script tag extraction...');
                const scriptComments = await this.extractCommentsFromScripts(page, postId, postUrl);
                comments.push(...scriptComments);
            }

            // sharedData fallback
            if (comments.length < 5) {
                const sharedDataComments = await this.extractSharedData(page, postId, postUrl);
                if (sharedDataComments.length > 0) {
                    logger.info(`[PUBLIC SCRAPE] _sharedData found ${sharedDataComments.length} comments`);
                    const existingTexts = new Set(comments.map(c => c.text?.substring(0, 40)));
                    for (const sdComment of sharedDataComments) {
                        const textKey = sdComment.text?.substring(0, 40);
                        if (textKey && !existingTexts.has(textKey)) {
                            comments.push(sdComment);
                        }
                    }
                }
            }

            // Save comments to database
            const savedCount = await this.saveComments(comments, postId);

            logger.info('[PUBLIC SCRAPE] Completed', {
                postId,
                commentsFound: comments.length,
                commentsSaved: savedCount,
                mode: 'public'
            });

            return {
                success: true,
                mode: 'public',
                postId,
                postUrl,
                commentsCount: comments.length,
                savedCount,
                loginWallDetected,
                account: null, // No account used
                post_author: postMetadata.post_author,
                post_description: postMetadata.post_description,
                post_likes_count: postMetadata.post_likes_count,
            };

        } catch (error) {
            logger.error('[PUBLIC SCRAPE] Error:', {
                postUrl,
                error: error.message
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
                    // Portuguese variants (First, as system is pt-BR)
                    'button:has-text("Permitir todos os cookies")',
                    'button:has-text("Permitir cookies essenciais e opcionais")',
                    'button:has-text("Aceitar tudo")',
                    'button:has-text("Aceitar")',
                    'button:has-text("Permitir somente cookies essenciais")',
                    'button[role="button"]:has-text("Permitir")',
                    // English variants
                    'button:has-text("Allow all cookies")',
                    'button:has-text("Allow essential and optional cookies")',
                    'button:has-text("Accept All")',
                    'button:has-text("Accept")',
                    'button:has-text("Only allow essential cookies")',
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
                'input[name="email"]',
                'input[aria-label*="usuário"]',
                'input[aria-label*="username"]',
                'input[aria-label*="email"]',
                'input[aria-label*="celular"]',
                'input[placeholder*="usuário"]',
                'input[placeholder*="email"]',
                'input[placeholder*="celular"]',
                'input[type="text"]:first-of-type',
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
                'input[name="pass"]',
                'input[type="password"]',
                'input[aria-label*="password"]',
                'input[aria-label*="Senha"]',
                'input[placeholder*="Senha"]',
                'input[placeholder*="Password"]',
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
                'button:has-text("Entrar")',
                'button:has-text("Log in")',
                'button:has-text("Log In")',
                'div[role="button"]:has-text("Entrar")',
                'div[role="button"]:has-text("Log in")',
                'button._acan._acap._acas._aj1-._ap30',
                'form button',
                'button:first-of-type',
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

            let currentUrl = page.url();
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
                        // ⭐ FIX: Update currentUrl after successful 2FA to avoid "still on login page" error
                        currentUrl = page.url();
                        logger.info(`[LOGIN] Updated URL after 2FA: ${currentUrl}`);
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

            // ⭐ FIX: Handle post-login popups IMMEDIATELY after any navigation
            // The "Save Login Info" modal appears and blocks further actions
            logger.info('[LOGIN] 🔍 Checking for post-login popups...');

            // First, check if "Save Login Info" modal is visible
            try {
                const pageText = await page.evaluate(() => document.body?.innerText || '');

                // Check for "Save Login Info" popup indicators
                const hasSaveInfoPopup =
                    pageText.includes('Salvar suas informações de login') ||
                    pageText.includes('Save your login info') ||
                    pageText.includes('Salvar informações') ||
                    pageText.includes('Save Login Info');

                if (hasSaveInfoPopup) {
                    logger.info('[LOGIN] ✅ Detected "Save Login Info" popup - this means login was successful!');

                    // Try to click "Salvar informações" or "Not Now" / "Agora não"
                    const saveInfoSelectors = [
                        'button:has-text("Salvar informações")',
                        'button:has-text("Salvar info")',
                        'button:has-text("Save Info")',
                        'button:has-text("Agora não")',
                        'button:has-text("Not Now")',
                        'div[role="button"]:has-text("Agora não")',
                    ];

                    for (const selector of saveInfoSelectors) {
                        try {
                            const btn = await page.$(selector);
                            if (btn) {
                                await btn.click();
                                logger.info(`[LOGIN] ✅ Clicked popup button: ${selector}`);
                                await page.waitForTimeout(2000);
                                break;
                            }
                        } catch (e) { /* try next */ }
                    }
                }
            } catch (e) {
                logger.warn(`[LOGIN] Error checking popups: ${e.message}`);
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
                // Standard 2FA input names
                'input[name="verificationCode"]',
                'input[name="security_code"]',
                'input[name="code"]',
                'input[name="otp"]',

                // Aria labels (multilingual)
                'input[aria-label*="Security code"]',
                'input[aria-label*="security code"]',
                'input[aria-label*="código"]',
                'input[aria-label*="Código"]',
                'input[aria-label*="Código de segurança"]',
                'input[aria-label*="verification"]',
                'input[aria-label*="Verification"]',

                // Placeholders
                'input[placeholder*="code"]',
                'input[placeholder*="Code"]',
                'input[placeholder*="código"]',
                'input[placeholder*="Código"]',

                // Modern HTML5 attributes (used by Instagram for 2FA)
                'input[autocomplete="one-time-code"]',
                'input[inputmode="numeric"]',
                'input[enterkeyhint="done"]',
                'input[pattern*="[0-9]"]',

                // Data attributes
                'input[data-testid*="code"]',
                'input[data-testid*="2fa"]',
                'input[data-testid*="verification"]',

                // Type-based selectors
                'input[type="text"][maxlength="6"]',
                'input[type="text"][maxlength="8"]',
                'input[type="number"]',
                'input[type="tel"]',

                // Form-context selectors
                'form input[maxlength="6"]',
                'form input[maxlength="8"]',
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

            // Fallback: try to find any visible input that could be the 2FA field
            if (!codeInput) {
                logger.warn('[2FA] ⚠️ No specific selector matched, trying generic fallback...');

                try {
                    const allInputs = await page.$$('input:not([type="hidden"]):not([type="password"]):not([type="email"])');
                    for (const input of allInputs) {
                        const isVisible = await input.isVisible().catch(() => false);
                        if (!isVisible) continue;

                        const inputType = await input.getAttribute('type').catch(() => null);
                        const inputName = await input.getAttribute('name').catch(() => '');
                        const maxLength = await input.getAttribute('maxlength').catch(() => null);

                        // Look for inputs that look like 2FA code fields
                        const isLikelyCodeInput =
                            !inputType || inputType === 'text' || inputType === 'tel' || inputType === 'number' ||
                            (maxLength && parseInt(maxLength) >= 6 && parseInt(maxLength) <= 8);

                        if (isLikelyCodeInput) {
                            codeInput = input;
                            logger.info(`[2FA] ✅ Found input via generic fallback (name: ${inputName || 'none'}, type: ${inputType || 'text'})`);
                            break;
                        }
                    }
                } catch (fallbackError) {
                    logger.error(`[2FA] Fallback search failed: ${fallbackError.message}`);
                }
            }

            // Final check - if still no input found, log detailed debug info and return false
            if (!codeInput) {
                logger.error('[2FA] ❌ Could not find 2FA code input field with any method');

                // Detailed debug information
                try {
                    const pageInfo = await page.evaluate(() => ({
                        url: window.location.href,
                        title: document.title,
                        formsCount: document.forms.length,
                        inputs: Array.from(document.querySelectorAll('input')).map(i => ({
                            name: i.name || '',
                            type: i.type || 'text',
                            placeholder: i.placeholder || '',
                            ariaLabel: i.getAttribute('aria-label') || '',
                            maxLength: i.maxLength > 0 ? i.maxLength : null,
                            autocomplete: i.autocomplete || '',
                            inputMode: i.inputMode || '',
                            visible: i.offsetParent !== null,
                            className: i.className.substring(0, 50)
                        }))
                    }));
                    logger.error('[2FA] Page debug info:', JSON.stringify(pageInfo, null, 2));
                } catch (debugError) {
                    logger.error(`[2FA] Could not get debug info: ${debugError.message}`);
                }

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
                // ⭐ SIMPLIFIED SUBMIT: Only ONE click + wait for navigation
                // Multiple strategies were causing repeated submissions = Instagram block!
                logger.info('[2FA] 🖱️ Clicking submit button...');

                try {
                    // Single click with navigation wait
                    await submitBtn.hover();
                    await randomDelay(100, 200);

                    // Click and wait for potential navigation
                    await Promise.all([
                        submitBtn.click(),
                        page.waitForNavigation({ timeout: 10000, waitUntil: 'domcontentloaded' }).catch(() => {
                            // Navigation may not happen if error
                        })
                    ]);

                    logger.info('[2FA] ✅ Submit button clicked');
                } catch (clickError) {
                    logger.warn(`[2FA] Click error: ${clickError.message}, trying Enter key...`);
                    try {
                        await codeInput.focus();
                        await page.keyboard.press('Enter');
                        logger.info('[2FA] ✅ Fallback: Enter key pressed');
                    } catch (e) { }
                }
            }

            // Wait for Instagram to fully process the code
            logger.info('[2FA] ⏳ Waiting for Instagram to process code...');
            await randomDelay(5000, 6000);

            // Wait for network to settle
            try {
                await page.waitForLoadState('networkidle', { timeout: 8000 });
            } catch (e) { /* ignore timeout */ }

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

            // ⭐ NEW: Check for BAD states that should NOT be considered success
            const badStatePatterns = [
                '/accounts/suspended',
                '/accounts/disabled',
                '/accounts/banned',
                '/checkpoint/',
                'confirm_email',
                'confirm_phone'
            ];
            const isInBadState = badStatePatterns.some(pattern => urlAfterSubmit.includes(pattern));

            if (isInBadState) {
                logger.error(`[2FA] ❌ Account is in a bad state: ${urlAfterSubmit}`);

                // Detect specific state
                if (urlAfterSubmit.includes('suspended')) {
                    logger.error('[2FA] ❌ Account is SUSPENDED - requires human verification');
                } else if (urlAfterSubmit.includes('disabled') || urlAfterSubmit.includes('banned')) {
                    logger.error('[2FA] ❌ Account is BANNED/DISABLED');
                } else if (urlAfterSubmit.includes('checkpoint')) {
                    logger.error('[2FA] ❌ Account requires checkpoint verification');
                } else if (urlAfterSubmit.includes('confirm_')) {
                    logger.error('[2FA] ❌ Account requires email/phone verification');
                }

                // 📸 DEBUG SCREENSHOT
                await this.uploadDebugScreenshot(page, '2fa-bad-state');

                return false;
            }

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

        // Store pagination cursors for potential manual fetching
        this.paginationCursors = [];

        page.on('response', async (response) => {
            const url = response.url();
            const status = response.status();

            // Skip non-success responses
            if (status < 200 || status >= 300) return;

            // ENHANCED: Check for more API/GraphQL endpoints including new Instagram patterns
            const isApiCall =
                url.includes('/graphql') ||
                url.includes('/api/') ||
                url.includes('/web/') ||
                url.includes('query') ||
                url.includes('/v1/') ||
                url.includes('/v2/') ||
                url.includes('i.instagram.com') ||
                url.includes('comments') ||
                url.includes('media');

            if (!isApiCall) return;

            // Early exit for URLs that never contain comments
            const bannedPatterns = ['ads', 'metrics', 'insights', 'profile_pic', 'image/', 'video/', 'story/', 'reel/', 'music', 'audio', 'logging', 'pixel'];
            if (bannedPatterns.some(p => url.includes(p))) return;

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

                // ENHANCED: More comprehensive comment detection
                const jsonStr = JSON.stringify(data).substring(0, 2000);
                const isCommentRelated =
                    jsonStr.includes('comment') ||
                    jsonStr.includes('edge_media') ||
                    jsonStr.includes('edge_threaded') ||
                    jsonStr.includes('preview_child') ||
                    jsonStr.includes('"text"') && jsonStr.includes('"user"') ||
                    jsonStr.includes('"pk"') && jsonStr.includes('"text"') ||
                    url.includes('comment');

                if (isCommentRelated) {
                    logger.info(`[INTERCEPT] 📝 Potential comment data in API #${apiCallCount}`);
                    // Log first comment-like object structure if found
                    const samplePath = this.findCommentPath(data);
                    if (samplePath) {
                        logger.info(`[INTERCEPT] Comment path found: ${samplePath}`);
                    }
                }

                // Deep search for comments in the response
                // Using the new commentExtractor for GraphQL data
                let extractedComments = commentExtractor.extractFromGraphQL(data, postId, postUrl);

                // ENHANCED: If no comments found but looks like comment data, try alternative extraction
                if (extractedComments.length === 0 && isCommentRelated) {
                    extractedComments = this.alternativeCommentExtraction(data, postId, postUrl);
                    if (extractedComments.length > 0) {
                        logger.info(`[INTERCEPT] 🔄 Alternative extraction found ${extractedComments.length} comments`);
                    }
                }

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
                }

                // ⭐ ALWAYS extract and store pagination info for potential manual fetching
                const paginationInfo = this.extractPaginationInfo(data);
                if (paginationInfo && paginationInfo.hasNextPage && paginationInfo.endCursor) {
                    logger.info(`[INTERCEPT] 📄 Pagination: has_next_page=${paginationInfo.hasNextPage}, cursor=${paginationInfo.endCursor.substring(0, 30)}...`);
                    this.paginationCursors.push({
                        cursor: paginationInfo.endCursor,
                        timestamp: Date.now()
                    });
                }

            } catch (e) {
                // Ignore parsing errors
            }
        });

        // Log interception setup
        logger.info('[INTERCEPT] GraphQL/API interception enabled');
    }

    /**
     * Alternative comment extraction for newer Instagram API structures
     * Handles cases where standard extraction fails
     */
    alternativeCommentExtraction(data, postId, postUrl) {
        const comments = [];
        const seen = new Set();

        const extract = (obj, depth = 0) => {
            if (depth > 20 || !obj) return;

            if (Array.isArray(obj)) {
                obj.forEach(item => extract(item, depth + 1));
                return;
            }

            if (typeof obj !== 'object') return;

            // Pattern 1: Direct comment object with text + user/owner
            if (obj.text && typeof obj.text === 'string' && obj.text.length > 0) {
                const username = obj.user?.username || obj.owner?.username ||
                    obj.from?.username || obj.author?.username;
                const id = obj.pk || obj.id || obj.comment_id || obj.node?.id;

                if (username && id) {
                    const key = `${username}:${obj.text.substring(0, 50)}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        comments.push({
                            post_id: postId,
                            post_url: postUrl,
                            comment_id: String(id),
                            text: obj.text,
                            username: username,
                            created_at: obj.created_at ? new Date(obj.created_at * 1000).toISOString() : new Date().toISOString(),
                            like_count: obj.comment_like_count || obj.like_count || 0,
                            extracted_by: 'alternative_intercept'
                        });
                    }
                }
            }

            // Pattern 2: Node wrapper structure
            if (obj.node && obj.node.text) {
                extract(obj.node, depth + 1);
            }

            // Pattern 3: Edges array
            if (obj.edges && Array.isArray(obj.edges)) {
                obj.edges.forEach(edge => extract(edge, depth + 1));
            }

            // Recurse into all properties
            for (const key of Object.keys(obj)) {
                if (['extensions', 'request_id', 'trace_id'].includes(key)) continue;
                extract(obj[key], depth + 1);
            }
        };

        extract(data);
        return comments;
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

        // === STRATEGY: RENDER VERIFICATION LOOP ===
        let attempts = 0;
        const maxAttempts = 2;
        let success = false;

        while (attempts < maxAttempts && !success) {
            attempts++;
            logger.info(`[SCRAPE] Navigation attempt ${attempts}/${maxAttempts}...`);

            try {
                // Navigate to post
                await page.goto(postUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: config.scraping.pageTimeout || 45000,
                });

                // Wait for JavaScript to render content with multiple indicators
                logger.info('[SCRAPE] Waiting for post content to render (Success Indicators)...');
                try {
                    await page.waitForFunction(() => {
                        const hasArticle = !!document.querySelector('article');
                        const hasDialog = !!document.querySelector('div[role="dialog"]');
                        const hasVideo = !!document.querySelector('video');
                        const hasImg = document.querySelectorAll('img').length > 5;
                        const hasContent = document.body.innerText.length > 800;
                        const isNotFound = document.title.toLowerCase().includes('não encontrad') || document.title.toLowerCase().includes('not found');

                        return (hasArticle || hasDialog || hasVideo || hasImg || hasContent) && !isNotFound;
                    }, { timeout: 35000 });

                    // Verify if it's not a "Page Not Found" or blank page
                    const isBlank = await page.evaluate(() => {
                        const title = document.title.toLowerCase();
                        return title.includes('not found') || title.includes('encontrada') || document.body.innerText.length < 50;
                    });

                    if (!isBlank) {
                        success = true;
                        logger.info('[SCRAPE] ✅ Post content rendered successfully');
                    } else {
                        logger.warn('[SCRAPE] ⚠️ Page appears blank or "Not Found", retrying...');
                    }
                } catch (e) {
                    logger.warn(`[SCRAPE] ⚠️ Detection timeout (Attempt ${attempts}): ${e.message}`);
                }

                if (!success && attempts < maxAttempts) {
                    logger.info('[SCRAPE] 🔄 Reloading page as fallback...');
                    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => { });
                    await page.waitForTimeout(5000);
                }
            } catch (err) {
                logger.error(`[SCRAPE] ❌ Navigation failed (Attempt ${attempts}): ${err.message}`);
                if (attempts === maxAttempts) throw err;
            }
        }

        // Wait for network to settle
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

        // LAYOUT DETECTION: Check which layout Instagram served
        const layoutInfo = await this.detectLayoutType(page);
        logger.info('[LAYOUT] Detected layout:', layoutInfo);

        this.currentLayoutType = layoutInfo.layoutType;
        this.layoutInfo = layoutInfo;

        // Log final page state
        const pageInfo = await page.evaluate(() => ({
            url: window.location.href,
            title: document.title,
            hasArticle: !!document.querySelector('article'),
            hasDialog: !!document.querySelector('div[role="dialog"]'),
            imgCount: document.querySelectorAll('img').length,
            textLength: document.body?.innerText?.length || 0,
            viewport: { w: window.innerWidth, h: window.innerHeight }
        }));
        logger.info('[SCRAPE] Final page state:', pageInfo);

        // Human behavior simulation
        await this.humanDelay(2000, 4000);
        await this.simulateHumanBehavior(page);
        await randomDelay(1000, 2000);
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
        if (detection.hasDialog || detection.dialogIndicators >= 2) {
            layoutType = 'MODAL_POST_VIEW';
            logger.info(`[LAYOUT-DETECT] High confidence MODAL (${detection.dialogIndicators} indicators)`);
        }
        // HIGH CONFIDENCE FEED: No dialog + has article + 0-1 indicators
        else if (!detection.hasDialog && (detection.hasArticle || detection.hasLargeVideo) && detection.dialogIndicators <= 1) {
            layoutType = 'FEED_INLINE';
            logger.info(`[LAYOUT-DETECT] High confidence FEED_INLINE (${detection.dialogIndicators} indicators)`);
        }
        // MODAL FALLBACK: Has video + comment panel but uncertain indicators
        else if (detection.hasVideo && detection.hasCommentPanel && detection.viewport.width > 1000) {
            layoutType = 'MODAL_POST_VIEW';
            logger.info('[LAYOUT-DETECT] Fallback → MODAL_POST_VIEW (geometry-based)');
        }
        // FEED_INLINE FALLBACK: Has comment indicators and visible comments
        else if (detection.hasCommentIndicators || detection.visibleComments > 0) {
            layoutType = 'FEED_INLINE';
            logger.info('[LAYOUT-DETECT] Fallback → FEED_INLINE (structural comments)');
        } else {
            // New fallback: detect by aspect ratio
            if (detection.viewport.width > 1200) {
                layoutType = 'FEED_INLINE';
                logger.info('[LAYOUT-DETECT] Desktop View Fallback → FEED_INLINE');
            }
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
    async waitForInitialGraphQLResponse(page, commentsArray, timeoutMs = 30000) {
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
     * @param {Page} page
     * @returns {Promise<boolean>} Whether comments were expanded
     */
    async expandAllComments(page) {
        logger.info('[SCRAPE] 🔍 Attempting to expand comments (Advanced Strategy)...');

        try {
            // Strategy 0: High-confidence "View all comments" link/button
            const primarySelectors = [
                'a[href*="/comments/"]',
                'span:has-text("ver todos")',
                'span:has-text("view all")',
                'button:has-text("mais")',
                'button:has-text("more")',
            ];

            for (const selector of primarySelectors) {
                try {
                    const el = await page.$(selector);
                    if (el && await el.isVisible()) {
                        logger.info(`[SCRAPE] ✅ Strategy 0: Found primary button with: ${selector}`);
                        if (await this.robustClick(page, el, 'Primary Expand Button')) {
                            return true;
                        }
                    }
                } catch (e) { /* next */ }
            }

            // Strategy 1: Dynamic Structural Detection (Look for comment count patterns)
            const structuralSuccess = await page.evaluate(() => {
                const allElements = Array.from(document.querySelectorAll('span, div, a, button'));
                const pattern = /((\d+)\s+(comentário|comment|ver todos|view all))/i;

                for (const el of allElements) {
                    if (el.innerText && pattern.test(el.innerText)) {
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            el.click();
                            return true;
                        }
                    }
                }
                return false;
            });

            if (structuralSuccess) {
                logger.info('[SCRAPE] ✅ Strategy 1: Triggered expansion via structural pattern');
                await page.waitForTimeout(2000);
                return true;
            }

            // Strategy 2: AI discovery (Fallback)
            logger.info('[SCRAPE] 🤖 Normal search failed, requesting AI assistance...');
            const aiDiscovery = await aiSelectorFallback.findElement(page, 'view_more_comments', 'post_page');

            if (aiDiscovery.element) {
                logger.info(`[SCRAPE] ✅ Strategy 2: AI discovered expand button: ${aiDiscovery.usedSelector}`);
                const clickedByAI = await this.robustClick(page, aiDiscovery.element, 'AI discovered button');
                if (clickedByAI) {
                    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
                    return true;
                }
            }

            logger.warn('[SCRAPE] ⚠️ All expansion strategies failed');
            return false;

        } catch (error) {
            logger.error('[SCRAPE] Error in expandAllComments:', error.message);
            return false;
        }
    }

    /**
     * Scroll to load more comments
     * @param {Page} page
     * @param {number} maxComments - Optional limit
     * @param {Array} commentsArray - Reference to GraphQL intercepted comments
     */
    async scrollForMoreComments(page, maxComments = null, commentsArray = []) {
        const MAX_SCROLLS = 25;
        const MAX_NO_CHANGE = 4;     // Reduced from 7 - exit earlier when no change
        const SCROLL_DELAY = 3000;   // Reduced from 4500ms

        let totalClicks = 0;
        let previousGraphQLCount = commentsArray.length;
        let noChangeCount = 0;

        const hasLimit = maxComments && maxComments > 0;
        logger.info(`[SCROLL] Starting smart scroll for comments`);

        // Find correct scroll container
        const scrollContainer = await this.findScrollContainer(page);
        logger.info(`[SCROLL] Using container: ${scrollContainer?.name || 'window (fallback)'}`);

        // Try to open comments modal if not already open
        await this.openCommentsModal(page);

        for (let i = 0; i < MAX_SCROLLS; i++) {
            const currentGraphQLCount = commentsArray.length;
            const timestamp = new Date().toISOString().substr(11, 8);

            logger.info(`[SCROLL] [${timestamp}] Iteration ${i + 1}/${MAX_SCROLLS} (GraphQL: ${currentGraphQLCount})`);

            if (currentGraphQLCount === previousGraphQLCount) {
                noChangeCount++;
                if (noChangeCount >= MAX_NO_CHANGE) {
                    logger.info(`[SCROLL] ✅ Complete! No new data after ${noChangeCount} attempts`);
                    break;
                }
            } else {
                noChangeCount = 0;
            }
            previousGraphQLCount = currentGraphQLCount;

            if (hasLimit && currentGraphQLCount >= maxComments) {
                logger.info(`[SCROLL] ✅ Reached target! ${currentGraphQLCount}/${maxComments}`);
                break;
            }

            // Click "Load more"
            const clicked = await this.clickLoadMoreButtons(page);
            if (clicked) totalClicks++;

            // Perform scroll
            await this.performScroll(page, scrollContainer);

            // Wait for API
            await randomDelay(SCROLL_DELAY, SCROLL_DELAY + 1000);
        }

        logger.info(`[SCROLL] Complete! Final count: ${commentsArray.length} comments`);
    }

    /**
     * Perform the scroll operation based on container info
     */
    async performScroll(page, container) {
        const jsScrolled = await page.evaluate((info) => {
            if (info && info.useModal) {
                const dialog = document.querySelector('div[role="dialog"]');
                if (dialog) {
                    const scrollable = Array.from(dialog.querySelectorAll('div')).find(div => {
                        const s = window.getComputedStyle(div);
                        return (s.overflowY === 'auto' || s.overflowY === 'scroll') && div.scrollHeight > div.clientHeight;
                    });
                    if (scrollable) {
                        scrollable.scrollTop = scrollable.scrollHeight;
                        return true;
                    }
                    dialog.scrollTop = dialog.scrollHeight;
                    return true;
                }
            }
            if (info && info.selector) {
                const el = document.querySelector(info.selector);
                if (el) { el.scrollTop = el.scrollHeight; return true; }
            }
            return false;
        }, container);

        if (!jsScrolled) {
            if (container && container.panelCoords) {
                await page.mouse.move(container.panelCoords.x, container.panelCoords.y);
                await page.mouse.wheel(0, 500);
            } else {
                await page.evaluate(() => window.scrollBy(0, 600));
            }
        }
    }

    /**
     * Perform a robust click on an element using multiple strategies
     */
    async robustClick(page, element, description = 'better_element') {
        let clickCount = 0;

        try {
            await element.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => { });
            await page.evaluate((el) => {
                if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
            }, element);
            await randomDelay(500, 1000);
        } catch (e) { /* ignore */ }

        // Strategy 1: Regular click
        try {
            await element.click({ timeout: 5000 });
            clickCount++;
            return true;
        } catch (e) { /* next */ }

        // Strategy 2: JS Click
        try {
            await page.evaluate((el) => { if (el) el.click(); }, element);
            clickCount++;
            return true;
        } catch (e) { /* next */ }

        // Strategy 3: Mouse wheel and coords
        try {
            const box = await element.boundingBox();
            if (box) {
                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                clickCount++;
                return true;
            }
        } catch (e) { /* next */ }

        return clickCount > 0;
    }

    /**
     * Find best scrollable container
     */
    async findScrollContainer(page) {
        try {
            const result = await page.evaluate(() => {
                // Strategy 1: Modal dialog (highest priority)
                const dialog = document.querySelector('div[role="dialog"]');
                if (dialog) {
                    // Find the scrollable area WITHIN the dialog (usually the comments section)
                    const scrollables = Array.from(dialog.querySelectorAll('div, section, ul')).filter(el => {
                        const s = window.getComputedStyle(el);
                        return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 30;
                    });

                    // Prefer the one with UL (comments list)
                    const withUl = scrollables.find(el => el.querySelector('ul') || el.tagName === 'UL');
                    if (withUl) {
                        const r = withUl.getBoundingClientRect();
                        return {
                            name: 'modal-comments',
                            useModal: true,
                            scrollable: true,
                            selector: 'div[role="dialog"]',
                            panelCoords: { x: r.x + r.width / 2, y: r.y + r.height / 2 }
                        };
                    }

                    return { name: 'modal', useModal: true, scrollable: true, selector: 'div[role="dialog"]' };
                }

                // Strategy 2: Find comment panel by looking for sections with UL
                const sections = document.querySelectorAll('section');
                for (const section of sections) {
                    const ul = section.querySelector('ul');
                    if (ul) {
                        const sectionRect = section.getBoundingClientRect();
                        const style = window.getComputedStyle(section);
                        const parentStyle = section.parentElement ? window.getComputedStyle(section.parentElement) : null;

                        // Check if section or its parent is scrollable
                        const isScrollable =
                            section.scrollHeight > section.clientHeight + 30 ||
                            style.overflowY === 'auto' || style.overflowY === 'scroll' ||
                            (parentStyle && (parentStyle.overflowY === 'auto' || parentStyle.overflowY === 'scroll'));

                        if (sectionRect.width > 200 && sectionRect.height > 100) {
                            return {
                                name: 'comment-section',
                                scrollable: isScrollable,
                                selector: 'section',
                                panelCoords: { x: sectionRect.x + sectionRect.width / 2, y: sectionRect.y + sectionRect.height / 2 }
                            };
                        }
                    }
                }

                // Strategy 3: Find any scrollable container with comments-like content
                const allScrollables = Array.from(document.querySelectorAll('div, section')).filter(el => {
                    const s = window.getComputedStyle(el);
                    const isScroll = (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 50;
                    const hasCommentContent = el.innerText && (
                        el.innerText.includes('Responder') ||
                        el.innerText.includes('Reply') ||
                        el.innerText.includes('@')
                    );
                    return isScroll && hasCommentContent;
                });

                if (allScrollables.length > 0) {
                    // Prefer the smallest scrollable (more likely to be comments)
                    allScrollables.sort((a, b) => a.scrollHeight - b.scrollHeight);
                    const best = allScrollables[0];
                    const r = best.getBoundingClientRect();
                    return {
                        name: 'scrollable-with-comments',
                        scrollable: true,
                        panelCoords: { x: r.x + r.width / 2, y: r.y + r.height / 2 }
                    };
                }

                // Strategy 4: Article-based detection
                const article = document.querySelector('article');
                if (article) {
                    const scrollable = Array.from(article.querySelectorAll('div, section')).find(el => {
                        const s = window.getComputedStyle(el);
                        return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 50;
                    });
                    if (scrollable) {
                        const r = scrollable.getBoundingClientRect();
                        return { name: 'inline', scrollable: true, panelCoords: { x: r.x + r.width / 2, y: r.y + r.height / 2 } };
                    }
                }

                return { name: 'window', scrollable: false };
            });

            logger.info(`[SCROLL-CONTAINER] Detected: ${result.name}, scrollable=${result.scrollable}`);
            return result;
        } catch (e) {
            logger.warn('[SCROLL-CONTAINER] Detection error:', e.message);
            return { name: 'error', scrollable: false };
        }
    }

    /**
     * Try to open comments modal - ENHANCED with multiple strategies
     * This is CRITICAL for FEED_INLINE layouts where comments aren't loaded
     */
    async openCommentsModal(page) {
        try {
            // Check if modal is already open
            if (await page.$('div[role="dialog"]')) {
                logger.info('[MODAL] ✅ Modal already open');
                return true;
            }

            logger.info('[MODAL] 🔄 Attempting to open comments modal...');

            // ====== STRATEGY 1: Click on speech bubble (comment icon) ======
            // This is the most reliable way to open comments modal
            const iconStrategies = [
                // SVG with aria-label
                'svg[aria-label*="Comment"]',
                'svg[aria-label*="Comentar"]',
                'svg[aria-label*="Coment"]',
                // Parent of SVG (clickable container)
                'div:has(> svg[aria-label*="Comment"])',
                'div:has(> svg[aria-label*="Comentar"])',
                'span:has(> svg[aria-label*="Comment"])',
                // Generic comment icon patterns
                '[data-testid="comment"]',
                '[aria-label*="comment" i]',
                '[aria-label*="comentar" i]',
            ];

            for (const sel of iconStrategies) {
                try {
                    const el = await page.$(sel);
                    if (el && await el.isVisible()) {
                        logger.info(`[MODAL] Strategy 1: Clicking icon with: ${sel}`);
                        await el.click();
                        await randomDelay(2000, 3000);
                        if (await page.$('div[role="dialog"]')) {
                            logger.info('[MODAL] ✅ Modal opened via icon click');
                            return true;
                        }
                    }
                } catch (e) { /* try next */ }
            }

            // ====== STRATEGY 2: Click on comment count text ======
            // "Ver todos os X comentários" or "X comments"
            const commentTextClicked = await page.evaluate(() => {
                const patterns = [
                    /ver\s+todos?\s+os?\s+(\d+)\s*coment/i,
                    /view\s+all\s+(\d+)\s*comment/i,
                    /(\d+)\s*coment[áa]rios?/i,
                    /(\d+)\s*comments?/i,
                ];

                const elements = document.querySelectorAll('span, a, div, button');
                for (const el of elements) {
                    const text = el.innerText || el.textContent || '';
                    for (const pattern of patterns) {
                        if (pattern.test(text) && text.length < 50) {
                            const rect = el.getBoundingClientRect();
                            if (rect.width > 0 && rect.height > 0) {
                                el.click();
                                return { clicked: true, text: text.substring(0, 40) };
                            }
                        }
                    }
                }
                return { clicked: false };
            });

            if (commentTextClicked.clicked) {
                logger.info(`[MODAL] Strategy 2: Clicked on "${commentTextClicked.text}"`);
                await randomDelay(2500, 3500);
                if (await page.$('div[role="dialog"]')) {
                    logger.info('[MODAL] ✅ Modal opened via comment count click');
                    return true;
                }
            }

            // ====== STRATEGY 3: Direct navigation to /comments/ URL ======
            const currentUrl = page.url();
            if (currentUrl.includes('/p/') && !currentUrl.includes('/comments/')) {
                try {
                    const commentsUrl = currentUrl.replace(/\/?$/, '/comments/');
                    logger.info(`[MODAL] Strategy 3: Navigating to ${commentsUrl}`);
                    await page.goto(commentsUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
                    await randomDelay(2000, 3000);
                    // Check if comments loaded (may not open modal but will load comments)
                    const hasComments = await page.evaluate(() => {
                        return document.body.innerText.includes('Responder') ||
                            document.body.innerText.includes('Reply') ||
                            document.querySelectorAll('ul li').length > 5;
                    });
                    if (hasComments) {
                        logger.info('[MODAL] ✅ Comments loaded via direct URL navigation');
                        return true;
                    }
                } catch (e) {
                    logger.warn('[MODAL] Strategy 3 failed:', e.message);
                }
            }

            // ====== STRATEGY 4: Click within post action bar ======
            // Find the action bar (like, comment, share, save) and click comment
            const actionBarClicked = await page.evaluate(() => {
                // Look for the row of action buttons (usually contains Like, Comment, Share, Save)
                const sections = document.querySelectorAll('section');
                for (const section of sections) {
                    const svgs = section.querySelectorAll('svg');
                    if (svgs.length >= 3 && svgs.length <= 6) {
                        // This might be the action bar - click second SVG (usually comment)
                        const commentSvg = svgs[1];
                        if (commentSvg) {
                            const clickTarget = commentSvg.closest('div') || commentSvg.parentElement || commentSvg;
                            clickTarget.click();
                            return true;
                        }
                    }
                }
                return false;
            });

            if (actionBarClicked) {
                logger.info('[MODAL] Strategy 4: Clicked in action bar');
                await randomDelay(2000, 3000);
                if (await page.$('div[role="dialog"]')) {
                    logger.info('[MODAL] ✅ Modal opened via action bar click');
                    return true;
                }
            }

            // ====== STRATEGY 5: Use AI to find and click ======
            try {
                logger.info('[MODAL] Strategy 5: Using AI to find comment opener...');
                const aiResult = await aiSelectorFallback.findElement(page, 'view_more_comments', 'post_page');
                if (aiResult.element) {
                    await aiResult.element.click();
                    await randomDelay(2500, 3500);
                    if (await page.$('div[role="dialog"]')) {
                        logger.info('[MODAL] ✅ Modal opened via AI discovery');
                        return true;
                    }
                }
            } catch (e) { /* continue */ }

            logger.warn('[MODAL] ⚠️ Could not open comments modal with any strategy');
            return false;
        } catch (e) {
            logger.error('[MODAL] Error:', e.message);
            return false;
        }
    }

    /**
     * Click Load More buttons
     */
    async clickLoadMoreButtons(page) {
        const patterns = [/ver mais respostas/i, /ver respostas/i, /carregar mais/i, /load more/i, /view.*replies/i];
        try {
            for (const p of patterns) {
                const loc = page.getByText(p);
                if (await loc.count() > 0 && await loc.first().isVisible()) {
                    await loc.first().click().catch(() => { });
                    return true;
                }
            }
            return false;
        } catch (e) { return false; }
    }

    /**
     * Trigger comment loading through multiple strategies
     * Used when GraphQL interception fails to capture comments
     */
    async triggerCommentLoading(page) {
        logger.info('[TRIGGER] 🔄 Attempting to trigger comment loading...');

        try {
            // Strategy 1: Find and scroll within the comments panel directly
            const scrolledInPanel = await page.evaluate(() => {
                // Look for the comments section container
                const selectors = [
                    'div[role="dialog"] section',
                    'article section',
                    'div[style*="overflow"]',
                    'ul[class*="Comment"]',
                    'div[class*="Comment"]',
                ];

                for (const sel of selectors) {
                    const container = document.querySelector(sel);
                    if (container) {
                        const style = window.getComputedStyle(container);
                        const isScrollable = container.scrollHeight > container.clientHeight ||
                            style.overflowY === 'scroll' ||
                            style.overflowY === 'auto';
                        if (isScrollable || container.scrollHeight > 200) {
                            // Scroll down to trigger lazy loading
                            container.scrollTop = container.scrollHeight;
                            return { scrolled: true, selector: sel };
                        }
                    }
                }

                // Fallback: scroll within any section with UL
                const sections = document.querySelectorAll('section');
                for (const section of sections) {
                    if (section.querySelector('ul')) {
                        section.scrollTop = section.scrollHeight;
                        return { scrolled: true, selector: 'section with ul' };
                    }
                }

                return { scrolled: false };
            });

            if (scrolledInPanel.scrolled) {
                logger.info(`[TRIGGER] ✅ Scrolled in container: ${scrolledInPanel.selector}`);
                await randomDelay(1500, 2000);
            }

            // Strategy 2: Click any expandable elements
            const clickedExpandable = await page.evaluate(() => {
                const expandPatterns = [
                    /ver\s+\d+\s*respostas?/i,
                    /view\s+\d+\s*repl/i,
                    /mostrar\s+mais/i,
                    /show\s+more/i,
                    /\+\s*\d+/,
                    /\d+\s*mais/i,
                ];

                const elements = document.querySelectorAll('span, button, div[role="button"], a');
                let clicked = 0;

                for (const el of elements) {
                    const text = el.innerText || el.textContent || '';
                    for (const pattern of expandPatterns) {
                        if (pattern.test(text) && text.length < 40) {
                            el.click();
                            clicked++;
                            if (clicked >= 3) return clicked; // Limit clicks
                        }
                    }
                }

                return clicked;
            });

            if (clickedExpandable > 0) {
                logger.info(`[TRIGGER] ✅ Clicked ${clickedExpandable} expandable elements`);
                await randomDelay(2000, 3000);
            }

            // Strategy 3: Hover over comment area to trigger lazy loading
            const commentArea = await page.$('article ul, div[role="dialog"] ul, section ul');
            if (commentArea) {
                const box = await commentArea.boundingBox();
                if (box) {
                    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                    await randomDelay(500, 1000);
                    // Small scroll movement
                    await page.mouse.wheel({ deltaY: 300 });
                    await randomDelay(1000, 1500);
                    logger.info('[TRIGGER] ✅ Performed mouse hover + wheel in comment area');
                }
            }

            // Strategy 4: Focus on comment input to trigger loading
            const commentInput = await page.$('textarea[placeholder*="coment"], textarea[placeholder*="comment"], input[placeholder*="coment"]');
            if (commentInput) {
                await commentInput.focus();
                await randomDelay(500, 1000);
                logger.info('[TRIGGER] ✅ Focused on comment input');
            }

            return true;
        } catch (e) {
            logger.warn('[TRIGGER] Error:', e.message);
            return false;
        }
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

            // Sort by date (newest first) before saving
            uniqueComments.sort((a, b) => {
                const dateA = new Date(a.created_at).getTime();
                const dateB = new Date(b.created_at).getTime();
                return dateB - dateA;  // DESC - newest first
            });

            logger.info(`[SAVE] Saving ${uniqueComments.length} comments (sorted by date, newest first)`);

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
