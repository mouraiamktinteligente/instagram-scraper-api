/**
 * Auto Recovery Service
 * Orchestrates the complete self-healing process for selector failures
 * Coordinates between DOM analysis, vision analysis, and fallback strategies
 */

const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');

// Import other self-healing services
const aiSelectorFallback = require('./aiSelectorFallback.service');
const visionAnalyzer = require('./visionAnalyzer.service');
const selectorHealth = require('./selectorHealth.service');

class AutoRecoveryService {
    constructor() {
        this.supabase = createClient(config.supabase.url, config.supabase.key);
        this.recoveryInProgress = new Set();
        this.recoveryHistory = new Map();
        this.maxHistorySize = 100;

        // Wire up health monitor to trigger recovery
        selectorHealth.onDegradation(this.handleDegradation.bind(this));
    }

    /**
     * Handle degradation alert from health monitor
     */
    async handleDegradation(selectorName, context, details) {
        logger.info(`[RECOVERY] Degradation alert received: ${context}:${selectorName}`);

        // Schedule proactive rediscovery if severity is critical
        if (details.severity === 'critical') {
            this.scheduleRediscovery(selectorName, context);
        }
    }

    /**
     * Schedule selector rediscovery for next opportunity
     */
    scheduleRediscovery(selectorName, context) {
        const key = `${context}:${selectorName}`;

        // Add to rediscovery queue (will be processed on next page load)
        if (!this.pendingRediscovery) {
            this.pendingRediscovery = new Set();
        }
        this.pendingRediscovery.add(key);

        logger.info(`[RECOVERY] Scheduled rediscovery for: ${key}`);
    }

    /**
     * Check if rediscovery is pending for a selector
     */
    isRediscoveryPending(selectorName, context) {
        const key = `${context}:${selectorName}`;
        return this.pendingRediscovery?.has(key) || false;
    }

    /**
     * Main recovery method - orchestrates the full recovery process
     * @param {string} selectorName - Name of the selector that failed
     * @param {string} context - Page context (login, post, 2fa, etc.)
     * @param {Page} page - Playwright page
     * @param {string|null} screenshotPath - Optional screenshot path for vision analysis
     * @returns {Object|null} Recovery result with element and selector
     */
    async recover(selectorName, context, page, screenshotPath = null) {
        const recoveryKey = `${context}:${selectorName}`;
        const startTime = Date.now();

        // Prevent concurrent recovery for same selector
        if (this.recoveryInProgress.has(recoveryKey)) {
            logger.info(`[RECOVERY] Already recovering: ${recoveryKey}`);
            return null;
        }

        this.recoveryInProgress.add(recoveryKey);
        logger.info(`[RECOVERY] Starting recovery for: ${recoveryKey}`);

        const recoveryAttempt = {
            selectorName,
            context,
            startTime: new Date().toISOString(),
            phases: []
        };

        try {
            // Phase 1: DOM-based AI discovery (fast)
            logger.info('[RECOVERY] Phase 1: DOM analysis...');
            recoveryAttempt.phases.push({ name: 'dom_analysis', startedAt: Date.now() });

            const domResult = await aiSelectorFallback.discoverSelectorWithAI(
                page, selectorName, context
            );

            if (domResult?.element) {
                logger.info(`[RECOVERY] Phase 1 SUCCESS: Found via DOM analysis`);
                recoveryAttempt.phases[0].success = true;
                recoveryAttempt.phases[0].selector = domResult.usedSelector;

                await this.recordSuccess(selectorName, context, domResult.usedSelector, 'dom_analysis');
                return domResult;
            }

            recoveryAttempt.phases[0].success = false;

            // Phase 2: Vision-based analysis (if configured)
            if (screenshotPath && visionAnalyzer.isConfigured()) {
                logger.info('[RECOVERY] Phase 2: Vision analysis...');
                recoveryAttempt.phases.push({ name: 'vision_analysis', startedAt: Date.now() });

                const visionResult = await visionAnalyzer.analyzeFailure(
                    screenshotPath, selectorName, context
                );

                if (visionResult?.suggestedSelectors?.length > 0) {
                    // Try vision-suggested selectors
                    for (const selector of visionResult.suggestedSelectors) {
                        try {
                            const element = await page.$(selector);
                            if (element && await element.isVisible()) {
                                logger.info(`[RECOVERY] Phase 2 SUCCESS: Vision selector works: ${selector}`);
                                recoveryAttempt.phases[1].success = true;
                                recoveryAttempt.phases[1].selector = selector;

                                await this.recordSuccess(selectorName, context, selector, 'vision_analysis');
                                return { element, usedSelector: selector, fromAI: true, fromVision: true };
                            }
                        } catch (e) {
                            // Try next selector
                        }
                    }
                }

                recoveryAttempt.phases[1].success = false;
            }

            // Phase 3: Generic fallback strategies
            logger.info('[RECOVERY] Phase 3: Generic fallback...');
            recoveryAttempt.phases.push({ name: 'generic_fallback', startedAt: Date.now() });

            const genericResult = await this.tryGenericFallback(page, selectorName, context);

            if (genericResult?.element) {
                logger.info(`[RECOVERY] Phase 3 SUCCESS: Generic fallback found element`);
                recoveryAttempt.phases[recoveryAttempt.phases.length - 1].success = true;
                recoveryAttempt.phases[recoveryAttempt.phases.length - 1].selector = genericResult.usedSelector;

                await this.recordSuccess(selectorName, context, genericResult.usedSelector, 'generic_fallback');
                return genericResult;
            }

            // All phases failed
            logger.error(`[RECOVERY] All phases failed for: ${recoveryKey}`);
            recoveryAttempt.success = false;
            recoveryAttempt.duration = Date.now() - startTime;

            await this.recordFailure(selectorName, context, recoveryAttempt);
            return null;

        } finally {
            this.recoveryInProgress.delete(recoveryKey);

            // Remove from pending rediscovery
            this.pendingRediscovery?.delete(recoveryKey);

            // Add to history
            this.addToHistory(recoveryKey, recoveryAttempt);
        }
    }

    /**
     * Try generic fallback strategies based on element type
     */
    async tryGenericFallback(page, selectorName, context) {
        // Define generic fallback strategies per element type
        const strategies = {
            'login_button': [
                { selector: 'button[type="submit"]', description: 'Submit button' },
                { selector: 'button:has-text("Log in")', description: 'Button with Log in text' },
                { selector: 'button:has-text("Entrar")', description: 'Button with Entrar text' },
                { selector: 'div[role="button"]:has-text("Log")', description: 'Role button with Log text' }
            ],
            'username_field': [
                { selector: 'input[name="username"]', description: 'Username input' },
                { selector: 'input[autocomplete="username"]', description: 'Autocomplete username' },
                { selector: 'input[type="text"]:visible', description: 'First visible text input' }
            ],
            'password_field': [
                { selector: 'input[type="password"]', description: 'Password input' },
                { selector: 'input[name="password"]', description: 'Named password input' }
            ],
            '2fa_input': [
                { selector: 'input[autocomplete="one-time-code"]', description: 'OTP input' },
                { selector: 'input[inputmode="numeric"]', description: 'Numeric input' },
                { selector: 'input[maxlength="6"]', description: '6-digit input' },
                { selector: 'input[type="tel"]', description: 'Tel input' }
            ],
            'view_more_comments': [
                { selector: 'span:has-text("View all")', description: 'View all span' },
                { selector: 'span:has-text("Ver todos")', description: 'Ver todos span' },
                { selector: 'a:has-text("comment")', description: 'Comment link' }
            ],
            'comment_list': [
                { selector: 'ul[class*="comment"]', description: 'Comment UL' },
                { selector: 'div[class*="comment"]', description: 'Comment DIV' },
                { selector: 'article ul', description: 'UL in article' }
            ]
        };

        const elementStrategies = strategies[selectorName] || [];

        for (const strategy of elementStrategies) {
            try {
                const element = await page.$(strategy.selector);
                if (element && await element.isVisible()) {
                    logger.info(`[RECOVERY] Generic fallback found: ${strategy.description}`);
                    return {
                        element,
                        usedSelector: strategy.selector,
                        fromAI: false,
                        fromFallback: true
                    };
                }
            } catch (e) {
                // Try next strategy
            }
        }

        return null;
    }

    /**
     * Record successful recovery
     */
    async recordSuccess(selectorName, context, selector, method) {
        try {
            // Update selector registry with new selector
            await aiSelectorFallback.saveDiscoveredSelector(
                selectorName, context, selector, [selector], 0.85
            );

            // Save version history
            await this.saveVersion(selectorName, context, selector, method);

            // Reset health metrics for this selector
            selectorHealth.reset(selectorName, context);

            logger.info(`[RECOVERY] Recorded success: ${context}:${selectorName} via ${method}`);

        } catch (e) {
            logger.error('[RECOVERY] Error recording success:', e.message);
        }
    }

    /**
     * Record failed recovery attempt
     */
    async recordFailure(selectorName, context, attempt) {
        try {
            await this.supabase
                .from('recovery_failures')
                .insert({
                    selector_name: selectorName,
                    selector_context: context,
                    phases_attempted: attempt.phases.map(p => p.name),
                    duration_ms: attempt.duration,
                    created_at: new Date().toISOString()
                });
        } catch (e) {
            logger.debug('[RECOVERY] Could not log failure:', e.message);
        }
    }

    /**
     * Save new selector version with history
     */
    async saveVersion(selectorName, context, selector, discoveredBy) {
        try {
            // Get current version number
            const { data: current } = await this.supabase
                .from('selector_versions')
                .select('version')
                .eq('selector_name', selectorName)
                .eq('selector_context', context)
                .order('version', { ascending: false })
                .limit(1);

            const newVersion = (current?.[0]?.version || 0) + 1;

            // Mark previous as not current
            await this.supabase
                .from('selector_versions')
                .update({ is_active: false, replaced_at: new Date().toISOString() })
                .eq('selector_name', selectorName)
                .eq('selector_context', context)
                .eq('is_active', true);

            // Insert new version
            await this.supabase
                .from('selector_versions')
                .insert({
                    selector_name: selectorName,
                    selector_context: context,
                    version: newVersion,
                    primary_selector: selector,
                    discovered_by: discoveredBy,
                    is_active: true,
                    confidence_score: 0.85
                });

            logger.info(`[RECOVERY] Saved selector version ${newVersion} for ${context}:${selectorName}`);

        } catch (e) {
            logger.debug('[RECOVERY] Could not save version:', e.message);
        }
    }

    /**
     * Add recovery attempt to history
     */
    addToHistory(key, attempt) {
        this.recoveryHistory.set(key, {
            ...attempt,
            recordedAt: Date.now()
        });

        // Trim history if too large
        if (this.recoveryHistory.size > this.maxHistorySize) {
            const oldest = this.recoveryHistory.keys().next().value;
            this.recoveryHistory.delete(oldest);
        }
    }

    /**
     * Get recovery history for a selector
     */
    getHistory(selectorName, context) {
        const key = `${context}:${selectorName}`;
        return this.recoveryHistory.get(key) || null;
    }

    /**
     * Get all recovery statistics
     */
    getStats() {
        const history = Array.from(this.recoveryHistory.values());

        return {
            totalAttempts: history.length,
            successful: history.filter(h => h.phases?.some(p => p.success)).length,
            failed: history.filter(h => !h.phases?.some(p => p.success)).length,
            averageDuration: history.length > 0
                ? Math.round(history.reduce((sum, h) => sum + (h.duration || 0), 0) / history.length)
                : 0,
            byMethod: {
                dom_analysis: history.filter(h => h.phases?.find(p => p.name === 'dom_analysis' && p.success)).length,
                vision_analysis: history.filter(h => h.phases?.find(p => p.name === 'vision_analysis' && p.success)).length,
                generic_fallback: history.filter(h => h.phases?.find(p => p.name === 'generic_fallback' && p.success)).length
            },
            currentlyRecovering: this.recoveryInProgress.size,
            pendingRediscovery: this.pendingRediscovery?.size || 0
        };
    }

    /**
     * Force immediate recovery attempt (used by API)
     */
    async forceRecovery(selectorName, context, page, screenshotPath = null) {
        // Clear any cached data
        aiSelectorFallback.clearCache?.(selectorName, context);

        // Run recovery
        return this.recover(selectorName, context, page, screenshotPath);
    }

    /**
     * Rollback to a previous selector version
     */
    async rollback(selectorName, context, toVersion = null) {
        try {
            // Get version to rollback to
            let targetVersion;
            if (toVersion) {
                const { data } = await this.supabase
                    .from('selector_versions')
                    .select('*')
                    .eq('selector_name', selectorName)
                    .eq('selector_context', context)
                    .eq('version', toVersion)
                    .single();
                targetVersion = data;
            } else {
                // Get previous version (second newest)
                const { data } = await this.supabase
                    .from('selector_versions')
                    .select('*')
                    .eq('selector_name', selectorName)
                    .eq('selector_context', context)
                    .order('version', { ascending: false })
                    .limit(2);

                targetVersion = data?.[1]; // Second item is previous
            }

            if (!targetVersion) {
                logger.warn(`[RECOVERY] No previous version to rollback to for ${context}:${selectorName}`);
                return false;
            }

            // Mark current as inactive
            await this.supabase
                .from('selector_versions')
                .update({ is_active: false })
                .eq('selector_name', selectorName)
                .eq('selector_context', context)
                .eq('is_active', true);

            // Mark target as active
            await this.supabase
                .from('selector_versions')
                .update({ is_active: true })
                .eq('id', targetVersion.id);

            // Update main registry
            await aiSelectorFallback.saveDiscoveredSelector(
                selectorName, context, targetVersion.primary_selector,
                targetVersion.fallback_selectors || [targetVersion.primary_selector],
                targetVersion.confidence_score || 0.8
            );

            logger.info(`[RECOVERY] Rolled back ${context}:${selectorName} to version ${targetVersion.version}`);
            return true;

        } catch (e) {
            logger.error('[RECOVERY] Rollback failed:', e.message);
            return false;
        }
    }
}

module.exports = new AutoRecoveryService();
