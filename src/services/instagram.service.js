/**
 * Instagram Service
 * Core scraping service using Playwright with multi-account login support
 */

const { chromium } = require('playwright');
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
            logger.info(`Performing login for ${account.username}`);

            // Navigate to login page
            await page.goto('https://www.instagram.com/accounts/login/', {
                waitUntil: 'networkidle',
                timeout: 60000
            });

            await randomDelay(2000, 4000);

            // Handle cookie consent if present
            try {
                const cookieButton = await page.$('button:has-text("Allow all cookies")');
                if (cookieButton) {
                    await cookieButton.click();
                    await randomDelay(1000, 2000);
                }
            } catch (e) { /* ignore */ }

            // Wait for and fill username
            await page.waitForSelector('input[name="username"]', { timeout: 10000 });
            await page.fill('input[name="username"]', account.username);
            await randomDelay(500, 1000);

            // Fill password
            await page.fill('input[name="password"]', account.password);
            await randomDelay(500, 1000);

            // Click login button
            await page.click('button[type="submit"]');

            // Wait for navigation or error
            await Promise.race([
                page.waitForURL('**/instagram.com/**', { timeout: 30000 }),
                page.waitForSelector('p[data-testid="login-error-message"]', { timeout: 30000 }).catch(() => null)
            ]);

            await randomDelay(3000, 5000);

            // Check for login error
            const errorMessage = await page.$('p[data-testid="login-error-message"]');
            if (errorMessage) {
                const errorText = await errorMessage.textContent();
                logger.error(`Login failed for ${account.username}: ${errorText}`);
                await page.close();
                return false;
            }

            // Handle "Save Login Info" popup
            try {
                const saveInfoButton = await page.$('button:has-text("Not Now")');
                if (saveInfoButton) {
                    await saveInfoButton.click();
                    await randomDelay(1000, 2000);
                }
            } catch (e) { /* ignore */ }

            // Handle notifications popup
            try {
                const notNowButton = await page.$('button:has-text("Not Now")');
                if (notNowButton) {
                    await notNowButton.click();
                    await randomDelay(1000, 2000);
                }
            } catch (e) { /* ignore */ }

            // Verify login succeeded
            const isLoggedIn = await this.checkLoggedIn(page);

            if (isLoggedIn) {
                // Save session cookies
                const cookies = await context.cookies();
                accountPool.saveSession(account.username, cookies);
                logger.info(`Login successful for ${account.username}`);
                await page.close();
                return true;
            }

            logger.error(`Login verification failed for ${account.username}`);
            await page.close();
            return false;

        } catch (error) {
            logger.error(`Login error for ${account.username}:`, error.message);
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
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=1920,1080',
            ],
        };

        if (proxy && proxy.server) {
            launchOptions.proxy = {
                server: proxy.server,
                username: proxy.username,
                password: proxy.password,
            };
        }

        return await chromium.launch(launchOptions);
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
        });

        // Add stealth scripts
        await context.addInitScript(() => {
            // Remove webdriver property
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

            // Add plugins
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5],
            });

            // Add languages
            Object.defineProperty(navigator, 'languages', {
                get: () => ['pt-BR', 'pt', 'en-US', 'en'],
            });

            // Override permissions
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) =>
                parameters.name === 'notifications'
                    ? Promise.resolve({ state: 'denied' })
                    : originalQuery(parameters);
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
        page.on('response', async (response) => {
            const url = response.url();

            // Check for GraphQL/API endpoints that might contain comments
            const isLikelyCommentsApi =
                url.includes('/graphql') ||
                url.includes('/api/graphql') ||
                url.includes('/graphql/query') ||
                url.includes('/api/v1/media') ||
                url.includes('/comments');

            if (isLikelyCommentsApi) {
                try {
                    // Relaxed content-type check
                    const ct = (response.headers()['content-type'] || '').toLowerCase();
                    if (!(ct.includes('json') || url.includes('graphql'))) return;

                    // Log for debugging
                    logger.debug('Intercepted API response', { url: url.substring(0, 100) });

                    const data = await response.json();

                    // Extract comments from various response structures
                    const extractedComments = this.extractCommentsFromResponse(data, postId, postUrl);

                    if (extractedComments.length > 0) {
                        logger.debug(`Extracted ${extractedComments.length} comments from response`);
                    }

                    comments.push(...extractedComments);

                } catch (e) {
                    // Ignore parsing errors - not all responses are JSON
                }
            }
        });
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
        logger.debug('Navigating to post', { postUrl });

        await page.goto(postUrl, {
            waitUntil: 'networkidle',
            timeout: config.scraping.pageTimeout,
        });

        await randomDelay(2000, 4000);
    }

    /**
     * Wait for comments section to load
     * @param {Page} page
     */
    async waitForComments(page) {
        const commentSelectors = [
            'ul ul', // Comment list structure
            '[data-testid="post-comment"]',
            'div[class*="comment"]',
        ];

        for (const selector of commentSelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 10000 });
                logger.debug('Comments section found', { selector });
                return;
            } catch (e) {
                // Try next selector
            }
        }

        logger.warn('Could not find comments section, proceeding anyway');
    }

    /**
     * Scroll to load more comments
     * @param {Page} page
     */
    async scrollForMoreComments(page) {
        const maxScrolls = config.scraping.maxScrolls || 10;

        for (let i = 0; i < maxScrolls; i++) {
            // Look for "Load more comments" button
            const loadMoreButtons = [
                'button:has-text("View more comments")',
                'button:has-text("Ver mais comentários")',
                'button:has-text("Load more")',
                'span:has-text("View all")',
            ];

            let clicked = false;
            for (const selector of loadMoreButtons) {
                try {
                    const button = await page.$(selector);
                    if (button) {
                        await button.click();
                        clicked = true;
                        await randomDelay(1500, 3000);
                        break;
                    }
                } catch (e) {
                    // Button not found or not clickable
                }
            }

            // Also scroll the page
            await page.evaluate(() => window.scrollBy(0, 300));
            await randomDelay(1000, 2000);

            // If no load more button found for 3 iterations, stop
            if (!clicked && i >= 3) {
                break;
            }
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

        try {
            // Try to find comment elements
            const commentElements = await page.$$('ul ul li');

            for (const element of commentElements) {
                try {
                    const usernameEl = await element.$('a[href^="/"]');
                    const textEl = await element.$('span[dir="auto"]');

                    if (usernameEl && textEl) {
                        const username = await usernameEl.getAttribute('href');
                        const text = await textEl.textContent();

                        if (username && text && text.trim()) {
                            comments.push({
                                post_id: postId,
                                post_url: postUrl,
                                comment_id: `dom_${Date.now()}_${comments.length}`,
                                text: text.trim(),
                                username: username.replace(/\//g, ''),
                                created_at: new Date().toISOString(),
                                user_id: '',
                                profile_pic_url: '',
                                like_count: 0,
                            });
                        }
                    }
                } catch (e) {
                    // Skip invalid element
                }
            }

            if (comments.length > 0) {
                logger.info(`Extracted ${comments.length} comments from DOM`);
            }

        } catch (error) {
            logger.debug('Error extracting comments from DOM:', error.message);
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
