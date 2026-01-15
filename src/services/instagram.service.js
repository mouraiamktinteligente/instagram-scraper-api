/**
 * Instagram Service
 * Main scraping logic using Playwright with stealth configuration
 */

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const Bottleneck = require('bottleneck');
const config = require('../config');
const logger = require('../utils/logger');
const {
    randomDelay,
    extractPostId,
    normalizeInstagramUrl,
    parseComment,
    getRandomUserAgent,
    getBrowserHeaders,
    retryWithBackoff,
} = require('../utils/helpers');
const docIdService = require('./docid.service');

// Supabase client
const supabase = createClient(config.supabase.url, config.supabase.key);

class InstagramService {
    constructor() {
        // Rate limiter per instance
        this.limiter = new Bottleneck({
            minTime: Math.floor(60000 / config.rateLimit.requestsPerMinute),
            maxConcurrent: 1,
        });

        this.activeBrowsers = new Set();
    }

    /**
     * Main method to scrape comments from an Instagram post
     * @param {string} postUrl - Instagram post URL
     * @param {Object} proxy - Proxy configuration
     * @param {string} jobId - Job ID for tracking
     * @returns {Promise<Object>} Scraping result with comments
     */
    async scrapeComments(postUrl, proxy, jobId) {
        const startTime = Date.now();
        const normalizedUrl = normalizeInstagramUrl(postUrl);
        const postId = extractPostId(normalizedUrl);

        if (!postId) {
            throw new Error(`Invalid Instagram URL: ${postUrl}`);
        }

        logger.scrape('Starting comment scrape', { postUrl: normalizedUrl, postId, jobId });

        let browser = null;
        const comments = [];

        try {
            // Launch browser with proxy
            browser = await this.launchBrowser(proxy);
            this.activeBrowsers.add(browser);

            const context = await this.createBrowserContext(browser);
            const page = await context.newPage();

            // Set up request/response interception
            const interceptedComments = [];
            this.setupInterception(page, interceptedComments, postId, normalizedUrl);

            // Navigate to post
            await this.navigateToPost(page, normalizedUrl);

            // Scroll and load comments
            await this.loadAllComments(page);

            // Wait a bit for any pending responses
            await randomDelay(2000, 3000);

            // Process intercepted comments
            comments.push(...interceptedComments);

            // Also try to extract comments from page content (fallback)
            const pageComments = await this.extractCommentsFromPage(page, postId, normalizedUrl);

            // Merge and deduplicate
            const commentMap = new Map();
            [...comments, ...pageComments].forEach(comment => {
                if (comment.comment_id && !commentMap.has(comment.comment_id)) {
                    commentMap.set(comment.comment_id, comment);
                }
            });

            const uniqueComments = Array.from(commentMap.values());

            await browser.close();
            this.activeBrowsers.delete(browser);

            const duration = Date.now() - startTime;
            logger.scrape('Scrape completed', {
                postId,
                commentsCount: uniqueComments.length,
                duration: `${duration}ms`,
            });

            return {
                success: true,
                postId,
                postUrl: normalizedUrl,
                commentsCount: uniqueComments.length,
                comments: uniqueComments,
                duration,
            };

        } catch (error) {
            logger.error('Error scraping comments:', {
                postUrl,
                error: error.message,
                stack: error.stack,
            });

            if (browser) {
                try {
                    await browser.close();
                    this.activeBrowsers.delete(browser);
                } catch (e) {
                    // Ignore close errors
                }
            }

            throw error;
        }
    }

    /**
     * Launch browser with stealth configuration
     * @param {Object} proxy - Proxy configuration
     * @returns {Promise<Browser>}
     */
    async launchBrowser(proxy) {
        const launchOptions = {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=1920,1080',
                '--disable-blink-features=AutomationControlled',
            ],
        };

        if (proxy && proxy.server) {
            launchOptions.proxy = {
                server: proxy.server,
                username: proxy.username,
                password: proxy.password,
            };
            logger.debug('Using proxy:', { server: proxy.server });
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
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });

            // Mock plugins
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5],
            });

            // Mock languages
            Object.defineProperty(navigator, 'languages', {
                get: () => ['pt-BR', 'pt', 'en-US', 'en'],
            });

            // Mock platform
            Object.defineProperty(navigator, 'platform', {
                get: () => 'Win32',
            });

            // Mock hardware concurrency
            Object.defineProperty(navigator, 'hardwareConcurrency', {
                get: () => 8,
            });

            // Mock WebGL
            const getParameter = WebGLRenderingContext.prototype.getParameter;
            WebGLRenderingContext.prototype.getParameter = function (parameter) {
                if (parameter === 37445) {
                    return 'Intel Inc.';
                }
                if (parameter === 37446) {
                    return 'Intel Iris OpenGL Engine';
                }
                return getParameter.call(this, parameter);
            };

            // Mock chrome object
            window.chrome = {
                runtime: {},
            };

            // Override permissions query
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
            );
        });

        return context;
    }

    /**
     * Set up request/response interception to capture comments
     * @param {Page} page
     * @param {Array} comments - Array to store intercepted comments
     * @param {string} postId
     * @param {string} postUrl
     */
    setupInterception(page, comments, postId, postUrl) {
        page.on('response', async (response) => {
            const url = response.url();

            // Check for GraphQL endpoints that might contain comments
            if (url.includes('/graphql') || url.includes('/api/v1/media')) {
                try {
                    const contentType = response.headers()['content-type'] || '';
                    if (!contentType.includes('application/json')) return;

                    const data = await response.json();

                    // Extract comments from various response structures
                    const extractedComments = this.extractCommentsFromResponse(data, postId, postUrl);
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
            // Handle different response structures
            const paths = [
                // GraphQL query response
                data?.data?.shortcode_media?.edge_media_to_parent_comment?.edges,
                data?.data?.shortcode_media?.edge_media_to_comment?.edges,
                // API response
                data?.comments,
                data?.edges,
                // Nested structures
                data?.data?.xdt_shortcode_media?.edge_media_to_parent_comment?.edges,
            ];

            for (const edges of paths) {
                if (Array.isArray(edges)) {
                    for (const edge of edges) {
                        const node = edge.node || edge;
                        const comment = parseComment(node, postId, postUrl);
                        if (comment && comment.comment_id) {
                            comments.push(comment);

                            // Also extract reply comments
                            const replies = node.edge_threaded_comments?.edges || node.replies?.edges || [];
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
        // First visit Instagram homepage
        await page.goto('https://www.instagram.com/', {
            waitUntil: 'domcontentloaded',
            timeout: config.scraping.pageTimeout,
        });

        await randomDelay(1500, 2500);

        // Handle cookie consent popup if present
        try {
            const acceptButton = await page.$('button:has-text("Accept")');
            if (acceptButton) {
                await acceptButton.click();
                await randomDelay(500, 1000);
            }
        } catch (e) {
            // Ignore
        }

        // Navigate to the specific post
        await page.goto(postUrl, {
            waitUntil: 'networkidle',
            timeout: config.scraping.pageTimeout,
        });

        await randomDelay(2000, 3000);

        // Wait for comments section to load
        await page.waitForSelector('article', { timeout: 10000 }).catch(() => { });
    }

    /**
     * Scroll and load all comments
     * @param {Page} page
     */
    async loadAllComments(page) {
        let scrollCount = 0;
        let lastCommentCount = 0;
        let noNewCommentsCount = 0;

        while (scrollCount < config.scraping.maxScrolls) {
            // Try to click "Load more comments" button if available
            try {
                const loadMoreSelectors = [
                    'button:has-text("View more comments")',
                    'button:has-text("View all")',
                    'button:has-text("Load more")',
                    '[aria-label="Load more comments"]',
                    'li button svg[aria-label="Load more comments"]',
                ];

                for (const selector of loadMoreSelectors) {
                    const button = await page.$(selector);
                    if (button) {
                        await button.click();
                        await randomDelay(1500, 2500);
                    }
                }
            } catch (e) {
                // No more load buttons
            }

            // Scroll down to load more comments
            await page.evaluate(() => {
                const commentsSection = document.querySelector('ul[class*="Comment"]') || document.body;
                commentsSection.scrollTop = commentsSection.scrollHeight;
                window.scrollBy(0, 500);
            });

            await randomDelay(config.scraping.minDelay, config.scraping.maxDelay);

            // Count current comments on page
            const currentCommentCount = await page.evaluate(() => {
                const commentElements = document.querySelectorAll('ul li span[dir="auto"]');
                return commentElements.length;
            });

            // Check if we're still loading new comments
            if (currentCommentCount === lastCommentCount) {
                noNewCommentsCount++;
                if (noNewCommentsCount >= 3) {
                    logger.debug('No new comments loaded, stopping scroll');
                    break;
                }
            } else {
                noNewCommentsCount = 0;
                lastCommentCount = currentCommentCount;
            }

            scrollCount++;
            logger.debug(`Scroll ${scrollCount}/${config.scraping.maxScrolls}, comments: ${currentCommentCount}`);
        }
    }

    /**
     * Extract comments directly from page HTML (fallback method)
     * @param {Page} page
     * @param {string} postId
     * @param {string} postUrl
     * @returns {Promise<Array>} Extracted comments
     */
    async extractCommentsFromPage(page, postId, postUrl) {
        const comments = [];

        try {
            // Try to get comments from page data
            const pageData = await page.evaluate(() => {
                // Look for embedded data
                const scripts = document.querySelectorAll('script[type="application/json"]');
                for (const script of scripts) {
                    try {
                        const data = JSON.parse(script.textContent);
                        if (data && (data.shortcode_media || data.graphql)) {
                            return data;
                        }
                    } catch (e) { }
                }

                // Try window data
                if (window.__additionalDataLoaded) {
                    return window.__additionalDataLoaded;
                }

                if (window._sharedData) {
                    return window._sharedData;
                }

                return null;
            });

            if (pageData) {
                const extracted = this.extractCommentsFromResponse(pageData, postId, postUrl);
                comments.push(...extracted);
            }

        } catch (e) {
            logger.debug('Error extracting comments from page:', e.message);
        }

        return comments;
    }

    /**
     * Save comments to Supabase
     * @param {Array} comments - Comments to save
     * @returns {Promise<Object>} Result with saved count
     */
    async saveComments(comments) {
        if (!comments || comments.length === 0) {
            return { saved: 0, errors: 0 };
        }

        let saved = 0;
        let errors = 0;

        // Batch insert (Supabase supports upsert)
        const batchSize = 100;
        for (let i = 0; i < comments.length; i += batchSize) {
            const batch = comments.slice(i, i + batchSize);

            try {
                const { error } = await supabase
                    .from('instagram_comments')
                    .upsert(batch, {
                        onConflict: 'comment_id',
                        ignoreDuplicates: true,
                    });

                if (error) {
                    logger.error('Error saving comments batch:', error);
                    errors += batch.length;
                } else {
                    saved += batch.length;
                }
            } catch (e) {
                logger.error('Error in saveComments:', e);
                errors += batch.length;
            }
        }

        logger.info(`Saved ${saved} comments, ${errors} errors`);
        return { saved, errors };
    }

    /**
     * Close all active browsers (cleanup)
     */
    async cleanup() {
        for (const browser of this.activeBrowsers) {
            try {
                await browser.close();
            } catch (e) {
                // Ignore
            }
        }
        this.activeBrowsers.clear();
        logger.info('Instagram service cleanup completed');
    }
}

// Export singleton instance
module.exports = new InstagramService();
