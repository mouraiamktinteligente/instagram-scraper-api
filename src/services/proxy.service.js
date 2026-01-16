/**
 * Proxy Service
 * Manages proxy rotation for distributed scraping
 * Loads proxies from Supabase database
 */

const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');

class ProxyService {
    constructor() {
        this.proxies = [];
        this.proxyMap = new Map(); // Map DB id to proxy data
        this.currentIndex = 0;
        this.proxyStats = new Map();
        this.initialized = false;

        // Initialize Supabase client
        this.supabase = createClient(config.supabase.url, config.supabase.key);
    }

    /**
     * Initialize service by loading proxies from database
     */
    async initialize() {
        if (this.initialized) return;

        try {
            await this.loadProxiesFromDatabase();
            this.initialized = true;
        } catch (error) {
            logger.error('Failed to initialize ProxyService:', error.message);
            // Fall back to empty proxies
            this.proxies = [];
        }
    }

    /**
     * Load proxies from Supabase database
     */
    async loadProxiesFromDatabase() {
        try {
            const { data, error } = await this.supabase
                .from('instagram_proxies')
                .select('*')
                .eq('is_active', true)
                .order('created_at', { ascending: true });

            if (error) {
                throw error;
            }

            this.proxies = (data || []).map(row => ({
                id: row.id,
                server: `http://${row.host}:${row.port}`,  // Playwright requires http:// prefix
                host: row.host,
                port: row.port,
                username: row.username,
                password: row.password,
            }));

            // Initialize stats for each proxy
            this.proxyMap.clear();
            this.proxyStats.clear();

            this.proxies.forEach((proxy, index) => {
                this.proxyMap.set(proxy.id, { proxy, index });
                this.proxyStats.set(index, {
                    dbId: proxy.id,
                    requests: 0,
                    successes: 0,
                    failures: 0,
                    lastUsed: null,
                    blocked: false,
                });
            });

            logger.info(`ProxyService loaded ${this.proxies.length} proxies from database`);
        } catch (error) {
            logger.error('Error loading proxies from database:', error.message);
            throw error;
        }
    }

    /**
     * Reload proxies from database (can be called to refresh)
     */
    async reloadProxies() {
        this.initialized = false;
        await this.initialize();
    }

    /**
     * Get the next proxy in rotation
     */
    getNextProxy() {
        if (this.proxies.length === 0) {
            logger.warn('No proxies configured');
            return null;
        }

        const startIndex = this.currentIndex;
        let attempts = 0;

        while (attempts < this.proxies.length) {
            const proxy = this.proxies[this.currentIndex];
            const stats = this.proxyStats.get(this.currentIndex);

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
     */
    async reportSuccess(proxyIndex) {
        const stats = this.proxyStats.get(proxyIndex);
        if (stats) {
            stats.successes++;
            stats.blocked = false;
            logger.debug(`Proxy ${proxyIndex} success (total: ${stats.successes})`);

            // Update last_used_at in database
            try {
                await this.supabase
                    .from('instagram_proxies')
                    .update({
                        last_used_at: new Date().toISOString(),
                        fail_count: 0
                    })
                    .eq('id', stats.dbId);
            } catch (e) {
                logger.debug('Failed to update proxy stats in DB:', e.message);
            }
        }
    }

    /**
     * Report failed request for a proxy
     */
    async reportFailure(proxyIndex, reason = 'unknown') {
        const stats = this.proxyStats.get(proxyIndex);
        if (stats) {
            stats.failures++;

            const failureRate = stats.failures / (stats.requests || 1);
            if (failureRate > 0.5 && stats.requests >= 3) {
                stats.blocked = true;
                logger.warn(`Proxy ${proxyIndex} blocked due to high failure rate`, {
                    failures: stats.failures,
                    requests: stats.requests,
                    reason,
                });
            }

            // Update fail_count in database
            try {
                await this.supabase
                    .from('instagram_proxies')
                    .update({ fail_count: stats.failures })
                    .eq('id', stats.dbId);
            } catch (e) {
                logger.debug('Failed to update proxy fail_count in DB:', e.message);
            }
        }
    }

    /**
     * Reset all proxy stats
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
     */
    getProxyCount() {
        return this.proxies.length;
    }

    /**
     * Get available (non-blocked) proxy count
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
const proxyService = new ProxyService();
module.exports = proxyService;
