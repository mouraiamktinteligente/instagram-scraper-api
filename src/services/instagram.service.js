/**
 * Instagram Service
 * Core scraping service using Playwright with multi-account login support
 */

const { firefox } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
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

// Initialize account pool
accountPool.initialize();

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
    async scrapeComments(postUrl, proxy = null) {
        const postId = extractPostId(postUrl);
        if (!postId) {
            throw new Error('Invalid Instagram post URL');
        }

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

            // Navigate to the post
            await this.navigateToPost(page, postUrl);

            // Wait for comments to load
            await this.waitForComments(page);

            // Scroll to load more comments
            await this.scrollForMoreComments(page);

            // Fallback: Extract comments from DOM if interception didn't catch them
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
                commentsSaved: savedCount
            });

            return {
                success: true,
                postId,
                postUrl,
                commentsCount: comments.length,
                savedCount,
                account: account.username
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

            // Step 5: Fill password
            logger.info('[LOGIN] Step 5: Filling password...');
            await page.fill('input[name="password"]', account.password);
            logger.info('[LOGIN] Step 5: Password filled');
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

            // Check for checkpoint/challenge
            if (currentUrl.includes('challenge') || currentUrl.includes('checkpoint')) {
                logger.error('[LOGIN] Instagram requires verification (challenge/checkpoint)');
                logger.error('[LOGIN] Please verify the account manually first');
                await page.close();
                return false;
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

                // Try to get any visible error text
                const pageContent = await page.content();
                if (pageContent.includes('Sorry, your password was incorrect')) {
                    logger.error('[LOGIN] Password incorrect');
                } else if (pageContent.includes('Please wait a few minutes')) {
                    logger.error('[LOGIN] Rate limited - too many attempts');
                } else {
                    logger.error('[LOGIN] Unknown error - still on login page');
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
                accountPool.saveSession(account.username, cookies);
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
            launchOptions.proxy = {
                server: proxy.server,
                username: proxy.username,
                password: proxy.password,
            };
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
        const context = await browser.newContext({
            userAgent: getRandomUserAgent(),
            locale: 'pt-BR',
            timezoneId: 'America/Sao_Paulo',
            viewport: { width: 1920, height: 1080 },
            deviceScaleFactor: 1,
            hasTouch: false,
            extraHTTPHeaders: getBrowserHeaders(),
            colorScheme: 'light',
            javaScriptEnabled: true,
            bypassCSP: true,
        });

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

                // Deep search for comments in the response
                const extractedComments = this.deepSearchForComments(data, postId, postUrl);

                if (extractedComments.length > 0) {
                    commentApiCalls++;
                    logger.info(`[INTERCEPT] 🎯 Found ${extractedComments.length} comments in API call #${apiCallCount}`);

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
     */
    deepSearchForComments(obj, postId, postUrl, depth = 0) {
        const comments = [];
        const maxDepth = 15;

        if (depth > maxDepth || !obj) return comments;

        // If it's an array, search each element
        if (Array.isArray(obj)) {
            for (const item of obj) {
                comments.push(...this.deepSearchForComments(item, postId, postUrl, depth + 1));
            }
            return comments;
        }

        // If it's not an object, skip
        if (typeof obj !== 'object') return comments;

        // Check if this object looks like a comment
        if (this.looksLikeComment(obj)) {
            const parsed = parseComment(obj, postId, postUrl);
            if (parsed && parsed.comment_id && parsed.text) {
                comments.push(parsed);
            }
        }

        // Also check for edge/node structures
        if (obj.node && this.looksLikeComment(obj.node)) {
            const parsed = parseComment(obj.node, postId, postUrl);
            if (parsed && parsed.comment_id && parsed.text) {
                comments.push(parsed);
            }
        }

        // Recursively search all object properties
        for (const key of Object.keys(obj)) {
            // Skip properties that are unlikely to contain comments
            if (['extensions', 'headers', 'request_id', 'trace_id'].includes(key)) continue;

            // Prioritize properties that likely contain comments
            const priorityKeys = ['edges', 'comments', 'comment', 'nodes', 'items', 'data', 'threads'];

            if (priorityKeys.includes(key) || key.includes('comment')) {
                comments.push(...this.deepSearchForComments(obj[key], postId, postUrl, depth + 1));
            } else if (typeof obj[key] === 'object') {
                comments.push(...this.deepSearchForComments(obj[key], postId, postUrl, depth + 1));
            }
        }

        return comments;
    }

    /**
     * Check if an object looks like a real comment (not UI element)
     */
    looksLikeComment(obj) {
        if (!obj || typeof obj !== 'object') return false;

        // A comment typically has text and some form of ID
        const text = obj.text || obj.comment_text || obj.body || '';
        const hasText = text && text.length > 0;
        const hasId = !!(obj.id || obj.pk || obj.comment_id || obj.node_id);
        const hasUser = !!(obj.user || obj.owner || obj.from || obj.username);

        // Must have text and either ID or user info
        if (!hasText || (!hasId && !hasUser)) return false;

        // Filter out Instagram UI elements and menu items (false positives)
        const commentId = String(obj.id || obj.pk || obj.comment_id || obj.node_id || '').toLowerCase();
        const textLower = text.toLowerCase();

        // Known UI element IDs to exclude
        const uiElementIds = [
            'snooze_suggested',
            'dont_suggest',
            'hide_suggested',
            'not_interested',
            'report',
            'unfol',
            'block',
            'restrict',
            'uncomfortable',
            'feedback',
            'about_this',
            'why_seeing',
            'cancel',
            '_author',
            '_posts',
            '_from',
            'suggested'
        ];

        for (const uiId of uiElementIds) {
            if (commentId.includes(uiId)) {
                return false; // This is a UI element, not a comment
            }
        }

        // Known UI text patterns to exclude
        const uiTextPatterns = [
            'ativar modo soneca',
            'não sugerir',
            'ocultar sugerido',
            'denunciar',
            'bloquear',
            'restringir',
            'não me senti bem',
            'escalar sem destruir',
            'sobre esta conta',
            'por que estou vendo',
            'cancelar',
            'add to favorites',
            'go to post',
            'embed',
            'share to',
            'copy link',
            'hide like count',
            'turn off commenting'
        ];

        for (const pattern of uiTextPatterns) {
            if (textLower.includes(pattern)) {
                return false; // This is UI text, not a comment
            }
        }

        // Additional validation: real comments usually have certain properties
        // Check for timestamp (created_at, created_time, taken_at, timestamp)
        const hasTimestamp = !!(obj.created_at || obj.created_time || obj.taken_at || obj.timestamp || obj.created_at_utc);

        // Real comments often have like counts
        const hasLikes = obj.like_count !== undefined || obj.likes !== undefined || obj.comment_like_count !== undefined;

        // If it looks like a comment structure (has timestamp or likes), it's more likely real
        if (hasTimestamp || hasLikes) {
            return true;
        }

        // If text is very short (emoji only) and has user, probably real comment
        if (hasUser && text.length > 0 && text.length < 50) {
            return true;
        }

        // Be more strict: require user info for longer texts
        if (text.length > 50 && !hasUser) {
            return false;
        }

        return hasUser; // Require user info as final check
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
    async navigateToPost(page, postUrl) {
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
    async scrollForMoreComments(page) {
        const maxScrolls = config.scraping.maxScrolls || 15;
        let totalClicks = 0;

        logger.info(`[SCRAPE] Starting scroll/click for more comments (max ${maxScrolls} iterations)...`);

        for (let i = 0; i < maxScrolls; i++) {
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
                            await randomDelay(2000, 3500);
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

            await randomDelay(1500, 2500);

            // Log progress every 5 iterations
            if ((i + 1) % 5 === 0) {
                logger.info(`[SCRAPE] Scroll progress: ${i + 1}/${maxScrolls}, clicks: ${totalClicks}`);
            }

            // Stop if no clickable elements found for 4 iterations
            if (!clicked && i >= 4) {
                logger.info(`[SCRAPE] No more "load more" buttons found after ${i + 1} iterations`);
                break;
            }
        }

        logger.info(`[SCRAPE] Scrolling complete. Total clicks: ${totalClicks}`);
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
