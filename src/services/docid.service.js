/**
 * Doc ID Service
 * Manages Instagram GraphQL doc_id auto-discovery and validation
 * 
 * Instagram uses doc_id in GraphQL queries that change every 2-4 weeks.
 * This service auto-discovers and maintains the current doc_id.
 */

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');
const { getRandomUserAgent, getBrowserHeaders, randomDelay } = require('../utils/helpers');

// Supabase client
const supabase = createClient(config.supabase.url, config.supabase.key);

// Known doc_id patterns for comments endpoint
const COMMENTS_DOC_ID_PATTERNS = [
    'CommentsListQuery',
    'CommentListQuery',
    'MediaComments',
];

class DocIdService {
    constructor() {
        this.cachedDocId = null;
        this.lastValidated = null;
        this.discoveryInProgress = false;
    }

    /**
     * Get the current doc_id for comments
     * First checks cache, then database, then auto-discovers
     * @returns {Promise<string|null>} The doc_id or null
     */
    async getDocId() {
        // Return cached value if recent (less than 1 hour old)
        if (this.cachedDocId && this.lastValidated) {
            const age = Date.now() - this.lastValidated.getTime();
            if (age < 60 * 60 * 1000) { // 1 hour
                return this.cachedDocId;
            }
        }

        try {
            // Fetch from database
            const { data, error } = await supabase
                .from('instagram_config')
                .select('doc_id_comments, last_updated, is_valid')
                .eq('id', 1)
                .single();

            if (error) {
                logger.error('Error fetching doc_id from database:', error);
                return this.cachedDocId; // Return cached if available
            }

            if (data && data.is_valid && data.doc_id_comments) {
                this.cachedDocId = data.doc_id_comments;
                this.lastValidated = new Date(data.last_updated);
                logger.info('Loaded doc_id from database', { docId: this.cachedDocId });
                return this.cachedDocId;
            }

            // Need to discover new doc_id
            logger.warn('No valid doc_id in database, starting discovery...');
            return await this.discoverDocId();

        } catch (error) {
            logger.error('Error in getDocId:', error);
            return this.cachedDocId;
        }
    }

    /**
     * Validate if the current doc_id is still working
     * @returns {Promise<boolean>} True if valid
     */
    async validateDocId() {
        const docId = await this.getDocId();

        if (!docId) {
            logger.warn('No doc_id to validate');
            return false;
        }

        try {
            // Try to use the doc_id in a request
            // If it fails with specific error, it's invalid
            logger.info('Validating doc_id...', { docId });

            // For now, we'll just check if it's set
            // Real validation would involve making a test request
            return true;

        } catch (error) {
            logger.error('Error validating doc_id:', error);
            return false;
        }
    }

    /**
     * Auto-discover the current doc_id by intercepting Instagram requests
     * @param {Object} proxy - Optional proxy to use
     * @returns {Promise<string|null>} Discovered doc_id or null
     */
    async discoverDocId(proxy = null) {
        // Prevent multiple simultaneous discoveries
        if (this.discoveryInProgress) {
            logger.info('Discovery already in progress, waiting...');
            await randomDelay(5000, 10000);
            return this.cachedDocId;
        }

        this.discoveryInProgress = true;
        let browser = null;

        try {
            logger.info('Starting doc_id auto-discovery...');

            // Launch browser
            const launchOptions = {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu',
                ],
            };

            if (proxy) {
                launchOptions.proxy = proxy;
            }

            browser = await chromium.launch(launchOptions);

            // Create context with realistic settings
            const context = await browser.newContext({
                userAgent: getRandomUserAgent(),
                locale: 'pt-BR',
                viewport: { width: 1920, height: 1080 },
                extraHTTPHeaders: getBrowserHeaders(),
            });

            // Remove webdriver detection
            await context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
            });

            const page = await context.newPage();
            let discoveredDocId = null;

            // Intercept requests to find doc_id
            page.on('request', (request) => {
                const url = request.url();

                if (url.includes('/graphql/query') || url.includes('/api/graphql')) {
                    try {
                        const postData = request.postData();
                        if (postData) {
                            // Look for doc_id in GraphQL requests
                            const docIdMatch = postData.match(/doc_id["\s:]+["']?(\d+)/);
                            if (docIdMatch) {
                                const docId = docIdMatch[1];

                                // Check if this is a comments-related query
                                if (COMMENTS_DOC_ID_PATTERNS.some(pattern =>
                                    postData.toLowerCase().includes(pattern.toLowerCase())
                                )) {
                                    logger.info(`Found comments doc_id: ${docId}`);
                                    discoveredDocId = docId;
                                }
                            }
                        }
                    } catch (e) {
                        // Ignore parsing errors
                    }
                }
            });

            // Visit a popular public post to trigger comment loading
            const testPosts = [
                'https://www.instagram.com/p/C1234567890/', // Replace with real public post
                'https://www.instagram.com/instagram/', // Instagram's official page
            ];

            for (const testUrl of testPosts) {
                if (discoveredDocId) break;

                try {
                    await page.goto('https://www.instagram.com/', {
                        waitUntil: 'networkidle',
                        timeout: 30000,
                    });

                    await randomDelay(2000, 3000);

                    // Navigate to a post page
                    await page.goto(testUrl, {
                        waitUntil: 'networkidle',
                        timeout: 30000,
                    });

                    await randomDelay(3000, 5000);

                    // Try to load more comments by scrolling
                    for (let i = 0; i < 3; i++) {
                        await page.evaluate(() => window.scrollBy(0, 300));
                        await randomDelay(1000, 2000);
                    }

                    // Click "load more comments" if available
                    const loadMoreButton = await page.$('button:has-text("View more comments")');
                    if (loadMoreButton) {
                        await loadMoreButton.click();
                        await randomDelay(2000, 3000);
                    }

                } catch (error) {
                    logger.warn(`Error visiting ${testUrl}:`, error.message);
                }
            }

            await browser.close();

            if (discoveredDocId) {
                // Save to database
                await this.updateDocId(discoveredDocId, 'auto-discovery');
                return discoveredDocId;
            }

            logger.warn('Could not discover doc_id');
            return null;

        } catch (error) {
            logger.error('Error in doc_id discovery:', error);
            if (browser) {
                try {
                    await browser.close();
                } catch (e) {
                    // Ignore close errors
                }
            }
            return null;

        } finally {
            this.discoveryInProgress = false;
        }
    }

    /**
     * Update the doc_id in the database
     * @param {string} docId - New doc_id
     * @param {string} method - How it was obtained (manual, auto-discovery, etc.)
     */
    async updateDocId(docId, method = 'manual') {
        try {
            // Upsert into instagram_config
            const { error } = await supabase
                .from('instagram_config')
                .upsert({
                    id: 1,
                    doc_id_comments: docId,
                    last_updated: new Date().toISOString(),
                    method: method,
                    is_valid: true,
                });

            if (error) {
                logger.error('Error updating doc_id in database:', error);
                return false;
            }

            // Update cache
            this.cachedDocId = docId;
            this.lastValidated = new Date();

            logger.info(`Updated doc_id: ${docId} (method: ${method})`);
            return true;

        } catch (error) {
            logger.error('Error in updateDocId:', error);
            return false;
        }
    }

    /**
     * Mark current doc_id as invalid
     */
    async invalidateDocId() {
        try {
            const { error } = await supabase
                .from('instagram_config')
                .update({ is_valid: false })
                .eq('id', 1);

            if (error) {
                logger.error('Error invalidating doc_id:', error);
            }

            this.cachedDocId = null;
            this.lastValidated = null;

            logger.warn('Doc_id marked as invalid');

        } catch (error) {
            logger.error('Error in invalidateDocId:', error);
        }
    }

    /**
     * Get current status
     * @returns {Object} Status object
     */
    getStatus() {
        return {
            cachedDocId: this.cachedDocId,
            lastValidated: this.lastValidated,
            discoveryInProgress: this.discoveryInProgress,
        };
    }
}

// Export singleton instance
module.exports = new DocIdService();
