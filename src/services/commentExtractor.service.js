/**
 * Comment Extractor Service
 * Uses Cheerio for robust HTML parsing and hash-based deduplication
 * 
 * Features:
 * - Precise HTML parsing with Cheerio
 * - Hash-based deduplication (prevents duplicates even with different IDs)
 * - Multiple extraction strategies
 * - Structured data validation
 */

const cheerio = require('cheerio');
const crypto = require('crypto');
const logger = require('../utils/logger');

class CommentExtractorService {
    constructor() {
        this.extractedHashes = new Set(); // Track comment hashes to avoid duplicates
    }

    /**
     * Reset the hash set for a new scraping session
     */
    reset() {
        this.extractedHashes.clear();
    }

    /**
     * Generate a unique hash for a comment based on username and text
     * This prevents duplicates even if Instagram assigns different IDs
     */
    generateCommentHash(username, text) {
        const normalized = `${(username || '').toLowerCase().trim()}:${(text || '').trim().substring(0, 100)}`;
        return crypto.createHash('md5').update(normalized).digest('hex');
    }

    /**
     * Check if a comment is duplicate based on its hash
     */
    isDuplicate(username, text) {
        const hash = this.generateCommentHash(username, text);
        if (this.extractedHashes.has(hash)) {
            return true;
        }
        this.extractedHashes.add(hash);
        return false;
    }

    /**
     * Extract comments from HTML using Cheerio
     * @param {string} html - Raw HTML content
     * @param {string} postId - Post ID
     * @param {string} postUrl - Post URL
     * @returns {Array} Extracted comments
     */
    extractFromHTML(html, postId, postUrl) {
        const comments = [];

        try {
            const $ = cheerio.load(html);

            // Strategy 1: Look for comment patterns in nested lists
            // Instagram typically uses ul > ul structure for comments
            $('ul ul li, article ul > div, div[role="dialog"] ul > div').each((i, el) => {
                const $el = $(el);

                // Look for username link
                const $username = $el.find('a[href^="/"]').first();
                const usernameHref = $username.attr('href');

                if (!usernameHref) return;

                const username = usernameHref.replace(/\//g, '').split('?')[0];

                // Skip if not a valid username (e.g., explore, hashtags)
                if (!username || username.includes('explore') || username.includes('tags')) return;

                // Look for comment text (usually a span after the username link)
                const $textSpan = $el.find('span').filter((i, span) => {
                    const text = $(span).text().trim();
                    // Must have content and not be just the username
                    return text.length > 0 && text !== username && !text.match(/^\d+[hdwm]$/);
                }).first();

                const text = $textSpan.text().trim();

                if (text && text.length > 0 && !this.isDuplicate(username, text)) {
                    comments.push({
                        post_id: postId,
                        post_url: postUrl,
                        comment_id: `cheerio_${Date.now()}_${i}`,
                        text: text,
                        username: username,
                        created_at: new Date().toISOString(),
                        user_id: '',
                        profile_pic_url: '',
                        like_count: 0,
                        extracted_by: 'cheerio'
                    });
                }
            });

            // Strategy 2: Look for comment structure patterns
            // Instagram uses specific class patterns for comments
            $('[class*="Comment"], [class*="comment"]').each((i, el) => {
                const $el = $(el);

                const $username = $el.find('a[href^="/"]').first();
                const username = $username.attr('href')?.replace(/\//g, '').split('?')[0];

                if (!username || username.includes('explore')) return;

                // Get text that's not the username
                let text = '';
                $el.find('span').each((j, span) => {
                    const spanText = $(span).text().trim();
                    if (spanText && spanText !== username && spanText.length > 5) {
                        text = spanText;
                        return false; // break
                    }
                });

                if (text && !this.isDuplicate(username, text)) {
                    comments.push({
                        post_id: postId,
                        post_url: postUrl,
                        comment_id: `cheerio_${Date.now()}_s2_${i}`,
                        text: text,
                        username: username,
                        created_at: new Date().toISOString(),
                        user_id: '',
                        profile_pic_url: '',
                        like_count: 0,
                        extracted_by: 'cheerio_pattern'
                    });
                }
            });

            logger.info(`[CHEERIO] Extracted ${comments.length} unique comments from HTML`);

        } catch (error) {
            logger.error('[CHEERIO] Error extracting from HTML:', error.message);
        }

        return comments;
    }

    /**
     * Extract comments from GraphQL JSON response
     * This is more reliable than HTML parsing
     * @param {Object} data - GraphQL response data
     * @param {string} postId - Post ID
     * @param {string} postUrl - Post URL
     * @returns {Array} Extracted comments
     */
    extractFromGraphQL(data, postId, postUrl) {
        const comments = [];

        try {
            // Recursive function to find comments in any structure
            const findComments = (obj, depth = 0) => {
                if (depth > 15 || !obj) return;

                if (Array.isArray(obj)) {
                    obj.forEach(item => findComments(item, depth + 1));
                    return;
                }

                if (typeof obj !== 'object') return;

                // Check if this looks like a comment
                if (this.isCommentObject(obj)) {
                    const comment = this.parseCommentObject(obj, postId, postUrl);
                    if (comment && !this.isDuplicate(comment.username, comment.text)) {
                        comments.push(comment);
                    }
                }

                // Recurse into child properties
                for (const key of Object.keys(obj)) {
                    findComments(obj[key], depth + 1);
                }
            };

            findComments(data);

            logger.info(`[CHEERIO] Extracted ${comments.length} unique comments from GraphQL`);

        } catch (error) {
            logger.error('[CHEERIO] Error extracting from GraphQL:', error.message);
        }

        return comments;
    }

    /**
     * Check if an object looks like an Instagram comment
     */
    isCommentObject(obj) {
        // Must have text or text content
        const hasText = obj.text || obj.body || obj.content;

        // Must have user info
        const hasUser = obj.user || obj.owner || obj.username ||
            obj.from?.username || obj.user?.username;

        // Must have some kind of ID
        const hasId = obj.pk || obj.id || obj.comment_id || obj.node?.id;

        // Sanity check: not a post or media
        const isNotPost = !obj.is_video && !obj.media_type && !obj.carousel_media;

        return hasText && hasUser && hasId && isNotPost;
    }

    /**
     * Parse a comment object into our standard format
     */
    parseCommentObject(obj, postId, postUrl) {
        try {
            // Extract text
            const text = obj.text || obj.body || obj.content ||
                obj.node?.text || '';

            // Extract username
            let username = '';
            if (obj.user?.username) username = obj.user.username;
            else if (obj.owner?.username) username = obj.owner.username;
            else if (obj.from?.username) username = obj.from.username;
            else if (obj.username) username = obj.username;
            else if (obj.node?.owner?.username) username = obj.node.owner.username;

            // Extract ID
            const commentId = String(obj.pk || obj.id || obj.comment_id ||
                obj.node?.id || `gen_${Date.now()}`);

            // Extract timestamp
            let createdAt = new Date().toISOString();
            if (obj.created_at) {
                createdAt = new Date(obj.created_at * 1000).toISOString();
            } else if (obj.created_time) {
                createdAt = new Date(obj.created_time * 1000).toISOString();
            }

            // Validate
            if (!text || !username) return null;
            if (text.length < 1) return null;

            return {
                post_id: postId,
                post_url: postUrl,
                comment_id: commentId,
                text: text.trim(),
                username: username,
                created_at: createdAt,
                user_id: String(obj.user?.pk || obj.user?.id || obj.user_id || ''),
                profile_pic_url: obj.user?.profile_pic_url || '',
                like_count: obj.comment_like_count || obj.like_count || 0,
                extracted_by: 'graphql'
            };

        } catch (error) {
            return null;
        }
    }

    /**
     * Get deduplication stats
     */
    getStats() {
        return {
            uniqueHashes: this.extractedHashes.size
        };
    }
}

// Export singleton instance
module.exports = new CommentExtractorService();
