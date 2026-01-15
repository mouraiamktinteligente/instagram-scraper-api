/**
 * Helper Utilities
 * Common functions used across the application
 */

/**
 * Generate a random delay between min and max milliseconds
 * Used to simulate human-like behavior
 * @param {number} min - Minimum delay in ms
 * @param {number} max - Maximum delay in ms
 * @returns {Promise} Resolves after the random delay
 */
function randomDelay(min = 1000, max = 3000) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Extract post ID from Instagram URL
 * Supports various URL formats:
 * - https://www.instagram.com/p/ABC123/
 * - https://instagram.com/p/ABC123
 * - https://www.instagram.com/reel/ABC123/
 * @param {string} url - Instagram post URL
 * @returns {string|null} Post ID or null if invalid
 */
function extractPostId(url) {
    if (!url) return null;

    try {
        // Match /p/CODE or /reel/CODE patterns
        const patterns = [
            /instagram\.com\/p\/([A-Za-z0-9_-]+)/,
            /instagram\.com\/reel\/([A-Za-z0-9_-]+)/,
            /instagram\.com\/tv\/([A-Za-z0-9_-]+)/,
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match && match[1]) {
                return match[1];
            }
        }

        return null;
    } catch (error) {
        return null;
    }
}

/**
 * Validate Instagram post URL
 * @param {string} url - URL to validate
 * @returns {boolean} True if valid Instagram post URL
 */
function validatePostUrl(url) {
    if (!url || typeof url !== 'string') {
        return false;
    }

    // Must be Instagram domain
    const isInstagram = /^https?:\/\/(www\.)?instagram\.com\//i.test(url);
    if (!isInstagram) {
        return false;
    }

    // Must have a post ID
    const postId = extractPostId(url);
    return postId !== null;
}

/**
 * Normalize Instagram URL to standard format
 * @param {string} url - Input URL
 * @returns {string} Normalized URL
 */
function normalizeInstagramUrl(url) {
    if (!url) return url;

    // Remove query parameters and trailing slashes
    let normalized = url.split('?')[0].replace(/\/+$/, '');

    // Ensure https://
    if (!normalized.startsWith('http')) {
        normalized = 'https://' + normalized;
    }

    // Ensure www.
    normalized = normalized.replace('://instagram.com', '://www.instagram.com');

    return normalized + '/';
}

/**
 * Parse Instagram comment from GraphQL response
 * @param {Object} node - Comment node from GraphQL
 * @param {string} postId - Parent post ID
 * @param {string} postUrl - Parent post URL
 * @returns {Object} Parsed comment object
 */
function parseComment(node, postId, postUrl) {
    try {
        const owner = node.owner || {};

        return {
            post_id: postId,
            post_url: postUrl,
            comment_id: node.id || node.pk,
            text: node.text || '',
            created_at: node.created_at
                ? new Date(node.created_at * 1000).toISOString()
                : new Date().toISOString(),
            username: owner.username || '',
            user_id: owner.id || owner.pk || '',
            profile_pic_url: owner.profile_pic_url || '',
            like_count: node.edge_liked_by?.count || node.like_count || 0,
        };
    } catch (error) {
        return null;
    }
}

/**
 * Get a random user agent string
 * @returns {string} User agent string
 */
function getRandomUserAgent() {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    ];

    return userAgents[Math.floor(Math.random() * userAgents.length)];
}

/**
 * Generate browser headers for requests
 * @returns {Object} Headers object
 */
function getBrowserHeaders() {
    return {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
    };
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 * @param {Function} fn - Function to retry
 * @param {number} maxRetries - Maximum retry attempts
 * @param {number} baseDelay - Base delay in ms
 * @returns {Promise} Result of the function
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            if (attempt < maxRetries) {
                const delay = baseDelay * Math.pow(2, attempt - 1);
                await sleep(delay);
            }
        }
    }

    throw lastError;
}

module.exports = {
    randomDelay,
    extractPostId,
    validatePostUrl,
    normalizeInstagramUrl,
    parseComment,
    getRandomUserAgent,
    getBrowserHeaders,
    sleep,
    retryWithBackoff,
};
