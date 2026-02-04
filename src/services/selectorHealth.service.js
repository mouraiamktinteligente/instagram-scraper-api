/**
 * Selector Health Service
 * Monitors the health of CSS selectors in real-time
 * Triggers proactive self-healing when degradation is detected
 */

const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');

class SelectorHealthService {
    constructor() {
        this.supabase = createClient(config.supabase.url, config.supabase.key);
        this.healthMetrics = new Map();
        this.degradationThreshold = 0.7; // 70% success rate
        this.alertThreshold = 0.5;       // 50% triggers immediate action
        this.minAttemptsForAlert = 5;    // Minimum attempts before alerting
        this.listeners = [];
    }

    /**
     * Register a listener for degradation events
     * @param {Function} callback - Function to call when degradation is detected
     */
    onDegradation(callback) {
        this.listeners.push(callback);
    }

    /**
     * Record a selector attempt (success or failure)
     * @param {string} selectorName - Name of the selector
     * @param {string} context - Page context (e.g., 'post_page', 'login_page')
     * @param {boolean} success - Whether the selector worked
     * @param {string} usedSelector - The actual CSS selector used (optional)
     */
    recordAttempt(selectorName, context, success, usedSelector = null) {
        const key = `${context}:${selectorName}`;

        const metrics = this.healthMetrics.get(key) || {
            attempts: 0,
            successes: 0,
            failures: 0,
            lastSuccess: null,
            lastFailure: null,
            lastUsedSelector: null,
            consecutiveFailures: 0,
            recentHistory: [] // Last 20 attempts
        };

        metrics.attempts++;
        metrics.recentHistory.push({
            success,
            timestamp: new Date().toISOString(),
            selector: usedSelector
        });

        // Keep only last 20 attempts
        if (metrics.recentHistory.length > 20) {
            metrics.recentHistory.shift();
        }

        if (success) {
            metrics.successes++;
            metrics.lastSuccess = new Date();
            metrics.lastUsedSelector = usedSelector;
            metrics.consecutiveFailures = 0;
        } else {
            metrics.failures++;
            metrics.lastFailure = new Date();
            metrics.consecutiveFailures++;
        }

        this.healthMetrics.set(key, metrics);

        // Check health and potentially trigger self-healing
        this.checkHealth(selectorName, context, metrics);

        // Persist metrics periodically (every 10 attempts)
        if (metrics.attempts % 10 === 0) {
            this.persistMetrics(selectorName, context, metrics).catch(e =>
                logger.debug('[HEALTH] Failed to persist metrics:', e.message)
            );
        }
    }

    /**
     * Check selector health and trigger alerts if needed
     * @param {string} selectorName
     * @param {string} context
     * @param {Object} metrics
     */
    checkHealth(selectorName, context, metrics) {
        if (metrics.attempts < this.minAttemptsForAlert) {
            return; // Not enough data yet
        }

        const successRate = metrics.successes / metrics.attempts;
        const recentSuccessRate = this.calculateRecentSuccessRate(metrics);

        // Alert conditions:
        // 1. Overall success rate below alert threshold
        // 2. Recent success rate significantly degraded
        // 3. Consecutive failures exceed threshold

        if (successRate < this.alertThreshold ||
            recentSuccessRate < this.alertThreshold ||
            metrics.consecutiveFailures >= 3) {

            const severity = metrics.consecutiveFailures >= 5 ? 'critical' :
                            successRate < this.alertThreshold ? 'warning' : 'info';

            logger.warn(`[HEALTH] ${severity.toUpperCase()}: Selector degradation detected`, {
                selector: `${context}:${selectorName}`,
                successRate: (successRate * 100).toFixed(1) + '%',
                recentSuccessRate: (recentSuccessRate * 100).toFixed(1) + '%',
                consecutiveFailures: metrics.consecutiveFailures
            });

            // Notify listeners (e.g., autoRecovery service)
            this.notifyDegradation(selectorName, context, {
                successRate,
                recentSuccessRate,
                consecutiveFailures: metrics.consecutiveFailures,
                severity
            });
        }
    }

    /**
     * Calculate success rate from recent attempts only
     * @param {Object} metrics
     * @returns {number} Recent success rate (0-1)
     */
    calculateRecentSuccessRate(metrics) {
        if (metrics.recentHistory.length === 0) return 1;

        const recentSuccesses = metrics.recentHistory.filter(h => h.success).length;
        return recentSuccesses / metrics.recentHistory.length;
    }

    /**
     * Notify all listeners about degradation
     */
    notifyDegradation(selectorName, context, details) {
        for (const listener of this.listeners) {
            try {
                listener(selectorName, context, details);
            } catch (e) {
                logger.error('[HEALTH] Error in degradation listener:', e.message);
            }
        }
    }

    /**
     * Get health status for a specific selector
     * @param {string} selectorName
     * @param {string} context
     * @returns {Object} Health status
     */
    getHealth(selectorName, context) {
        const key = `${context}:${selectorName}`;
        const metrics = this.healthMetrics.get(key);

        if (!metrics) {
            return {
                status: 'unknown',
                message: 'No data available'
            };
        }

        const successRate = metrics.attempts > 0 ? metrics.successes / metrics.attempts : 1;
        const recentSuccessRate = this.calculateRecentSuccessRate(metrics);

        let status = 'healthy';
        if (successRate < this.alertThreshold || metrics.consecutiveFailures >= 5) {
            status = 'critical';
        } else if (successRate < this.degradationThreshold || metrics.consecutiveFailures >= 3) {
            status = 'degraded';
        }

        return {
            status,
            successRate: (successRate * 100).toFixed(1) + '%',
            recentSuccessRate: (recentSuccessRate * 100).toFixed(1) + '%',
            attempts: metrics.attempts,
            successes: metrics.successes,
            failures: metrics.failures,
            consecutiveFailures: metrics.consecutiveFailures,
            lastSuccess: metrics.lastSuccess,
            lastFailure: metrics.lastFailure,
            lastUsedSelector: metrics.lastUsedSelector
        };
    }

    /**
     * Get full health report for all tracked selectors
     * @returns {Object} Health report
     */
    getHealthReport() {
        const report = [];

        for (const [key, metrics] of this.healthMetrics) {
            const [context, selectorName] = key.split(':');
            const successRate = metrics.attempts > 0 ? metrics.successes / metrics.attempts : 1;
            const recentSuccessRate = this.calculateRecentSuccessRate(metrics);

            let status = 'healthy';
            if (successRate < this.alertThreshold || metrics.consecutiveFailures >= 5) {
                status = 'critical';
            } else if (successRate < this.degradationThreshold || metrics.consecutiveFailures >= 3) {
                status = 'degraded';
            }

            report.push({
                selector: key,
                selectorName,
                context,
                status,
                successRate: (successRate * 100).toFixed(1) + '%',
                recentSuccessRate: (recentSuccessRate * 100).toFixed(1) + '%',
                attempts: metrics.attempts,
                consecutiveFailures: metrics.consecutiveFailures,
                lastSuccess: metrics.lastSuccess,
                lastFailure: metrics.lastFailure
            });
        }

        // Sort by status (critical first) then by success rate (lowest first)
        return report.sort((a, b) => {
            const statusOrder = { critical: 0, degraded: 1, healthy: 2 };
            const statusDiff = statusOrder[a.status] - statusOrder[b.status];
            if (statusDiff !== 0) return statusDiff;
            return parseFloat(a.successRate) - parseFloat(b.successRate);
        });
    }

    /**
     * Get summary statistics
     * @returns {Object} Summary
     */
    getSummary() {
        const report = this.getHealthReport();
        return {
            total: report.length,
            healthy: report.filter(r => r.status === 'healthy').length,
            degraded: report.filter(r => r.status === 'degraded').length,
            critical: report.filter(r => r.status === 'critical').length
        };
    }

    /**
     * Reset metrics for a specific selector
     * @param {string} selectorName
     * @param {string} context
     */
    reset(selectorName, context) {
        const key = `${context}:${selectorName}`;
        this.healthMetrics.delete(key);
        logger.info(`[HEALTH] Reset metrics for: ${key}`);
    }

    /**
     * Reset all metrics
     */
    resetAll() {
        this.healthMetrics.clear();
        logger.info('[HEALTH] All metrics reset');
    }

    /**
     * Persist metrics to database
     */
    async persistMetrics(selectorName, context, metrics) {
        try {
            await this.supabase
                .from('selector_health_metrics')
                .upsert({
                    selector_name: selectorName,
                    selector_context: context,
                    total_attempts: metrics.attempts,
                    total_successes: metrics.successes,
                    total_failures: metrics.failures,
                    consecutive_failures: metrics.consecutiveFailures,
                    last_success_at: metrics.lastSuccess,
                    last_failure_at: metrics.lastFailure,
                    last_used_selector: metrics.lastUsedSelector,
                    updated_at: new Date().toISOString()
                }, {
                    onConflict: 'selector_name,selector_context'
                });
        } catch (e) {
            // Silently fail - metrics are not critical
        }
    }

    /**
     * Load metrics from database on startup
     */
    async loadMetrics() {
        try {
            const { data, error } = await this.supabase
                .from('selector_health_metrics')
                .select('*');

            if (error) {
                logger.warn('[HEALTH] Could not load metrics from database:', error.message);
                return;
            }

            if (data) {
                for (const row of data) {
                    const key = `${row.selector_context}:${row.selector_name}`;
                    this.healthMetrics.set(key, {
                        attempts: row.total_attempts || 0,
                        successes: row.total_successes || 0,
                        failures: row.total_failures || 0,
                        consecutiveFailures: row.consecutive_failures || 0,
                        lastSuccess: row.last_success_at ? new Date(row.last_success_at) : null,
                        lastFailure: row.last_failure_at ? new Date(row.last_failure_at) : null,
                        lastUsedSelector: row.last_used_selector,
                        recentHistory: []
                    });
                }
                logger.info(`[HEALTH] Loaded ${data.length} selector metrics from database`);
            }
        } catch (e) {
            logger.warn('[HEALTH] Error loading metrics:', e.message);
        }
    }
}

module.exports = new SelectorHealthService();
