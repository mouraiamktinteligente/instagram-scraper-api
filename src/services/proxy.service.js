/**
 * Proxy Service
 * Manages proxy rotation for distributed scraping
 */

const config = require('../config');
const logger = require('../utils/logger');

class ProxyService {
    constructor() {
        this.proxies = config.proxies;
        this.currentIndex = 0;
        this.proxyStats = new Map(); // Track success/failure per proxy

        // Initialize stats for each proxy
        this.proxies.forEach((proxy, index) => {
            this.proxyStats.set(index, {
                requests: 0,
                successes: 0,
                failures: 0,
                lastUsed: null,
                blocked: false,
            });
        });

        logger.info(`ProxyService initialized with ${this.proxies.length} proxies`);
    }

    /**
     * Get the next proxy in rotation
     * Skips blocked proxies
     * @returns {Object|null} Proxy configuration or null if none available
     */
    getNextProxy() {
        if (this.proxies.length === 0) {
            logger.warn('No proxies configured');
            return null;
        }

        // Find next non-blocked proxy
        const startIndex = this.currentIndex;
        let attempts = 0;

        while (attempts < this.proxies.length) {
            const proxy = this.proxies[this.currentIndex];
            const stats = this.proxyStats.get(this.currentIndex);

            // Move to next index for next call
            this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
            attempts++;

            if (!stats.blocked) {
                stats.lastUsed = new Date();
                stats.requests++;

                return {
                    ...proxy,
                    index: (this.currentIndex - 1 + this.proxies.length) % this.proxies.length,
                };
            }
        }

        // All proxies are blocked, reset and try again
        logger.warn('All proxies are blocked, resetting...');
        this.resetAllProxies();

        const proxy = this.proxies[0];
        this.currentIndex = 1;

        return {
            ...proxy,
            index: 0,
        };
    }

    /**
     * Get all configured proxies
     * @returns {Array} Array of proxy configurations
     */
    getAllProxies() {
        return this.proxies.map((proxy, index) => ({
            ...proxy,
            index,
            stats: this.proxyStats.get(index),
        }));
    }

    /**
     * Get proxy by index
     * @param {number} index - Proxy index
     * @returns {Object|null} Proxy configuration
     */
    getProxyByIndex(index) {
        if (index < 0 || index >= this.proxies.length) {
            return null;
        }

        return {
            ...this.proxies[index],
            index,
        };
    }

    /**
     * Report successful request for a proxy
     * @param {number} proxyIndex - Index of the proxy
     */
    reportSuccess(proxyIndex) {
        const stats = this.proxyStats.get(proxyIndex);
        if (stats) {
            stats.successes++;
            stats.blocked = false; // Unblock on success
            logger.debug(`Proxy ${proxyIndex} success (total: ${stats.successes})`);
        }
    }

    /**
     * Report failed request for a proxy
     * @param {number} proxyIndex - Index of the proxy
     * @param {string} reason - Failure reason
     */
    reportFailure(proxyIndex, reason = 'unknown') {
        const stats = this.proxyStats.get(proxyIndex);
        if (stats) {
            stats.failures++;

            // Block proxy after 3 consecutive failures
            const failureRate = stats.failures / (stats.requests || 1);
            if (failureRate > 0.5 && stats.requests >= 3) {
                stats.blocked = true;
                logger.warn(`Proxy ${proxyIndex} blocked due to high failure rate`, {
                    failures: stats.failures,
                    requests: stats.requests,
                    reason,
                });
            }
        }
    }

    /**
     * Reset all proxy stats and unblock them
     */
    resetAllProxies() {
        this.proxyStats.forEach((stats, index) => {
            stats.requests = 0;
            stats.successes = 0;
            stats.failures = 0;
            stats.blocked = false;
        });
        this.currentIndex = 0;
        logger.info('All proxy stats reset');
    }

    /**
     * Get proxy count
     * @returns {number} Number of configured proxies
     */
    getProxyCount() {
        return this.proxies.length;
    }

    /**
     * Get available (non-blocked) proxy count
     * @returns {number} Number of available proxies
     */
    getAvailableProxyCount() {
        let available = 0;
        this.proxyStats.forEach(stats => {
            if (!stats.blocked) available++;
        });
        return available;
    }

    /**
     * Get proxy statistics
     * @returns {Object} Aggregated statistics
     */
    getStats() {
        let totalRequests = 0;
        let totalSuccesses = 0;
        let totalFailures = 0;
        let blockedCount = 0;

        this.proxyStats.forEach(stats => {
            totalRequests += stats.requests;
            totalSuccesses += stats.successes;
            totalFailures += stats.failures;
            if (stats.blocked) blockedCount++;
        });

        return {
            totalProxies: this.proxies.length,
            availableProxies: this.proxies.length - blockedCount,
            blockedProxies: blockedCount,
            totalRequests,
            totalSuccesses,
            totalFailures,
            successRate: totalRequests > 0
                ? ((totalSuccesses / totalRequests) * 100).toFixed(2) + '%'
                : '0%',
        };
    }
}

// Export singleton instance
module.exports = new ProxyService();
