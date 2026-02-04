/**
 * Change Detector Service
 * Detects structural changes in Instagram pages
 * Creates DOM fingerprints to identify when Instagram updates their layout
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');

class ChangeDetectorService {
    constructor() {
        this.supabase = createClient(config.supabase.url, config.supabase.key);
        this.pageFingerprints = new Map();
        this.listeners = [];
        this.initialized = false;
    }

    /**
     * Initialize service and load known fingerprints
     */
    async initialize() {
        if (this.initialized) return;

        try {
            const { data, error } = await this.supabase
                .from('page_fingerprints')
                .select('*')
                .eq('is_current', true);

            if (error) {
                logger.warn('[CHANGE] Could not load fingerprints:', error.message);
            } else if (data) {
                for (const row of data) {
                    this.pageFingerprints.set(row.page_type, {
                        hash: row.fingerprint_hash,
                        structure: row.structure_data,
                        capturedAt: row.captured_at,
                        version: row.version
                    });
                }
                logger.info(`[CHANGE] Loaded ${data.length} page fingerprints`);
            }

            this.initialized = true;
        } catch (e) {
            logger.error('[CHANGE] Initialization error:', e.message);
        }
    }

    /**
     * Register a listener for change detection events
     * @param {Function} callback - Function to call when change is detected
     */
    onChange(callback) {
        this.listeners.push(callback);
    }

    /**
     * Create a fingerprint of the page structure
     * @param {Page} page - Playwright page
     * @param {string} pageType - Type of page (login, post, 2fa, etc.)
     * @returns {Object} Fingerprint data
     */
    async captureFingerprint(page, pageType) {
        try {
            const structure = await page.evaluate(() => {
                // Capture structural information (not content)
                const getElementInfo = (selector) => {
                    const elements = document.querySelectorAll(selector);
                    return {
                        count: elements.length,
                        visible: Array.from(elements).filter(e => e.offsetParent !== null).length
                    };
                };

                // Map inputs with their structural properties
                const inputsInfo = Array.from(document.querySelectorAll('input')).map(i => ({
                    type: i.type || 'text',
                    name: i.name || null,
                    hasPlaceholder: !!i.placeholder,
                    hasAriaLabel: !!i.getAttribute('aria-label'),
                    maxLength: i.maxLength > 0 ? i.maxLength : null,
                    autocomplete: i.autocomplete || null,
                    inputMode: i.inputMode || null,
                    visible: i.offsetParent !== null
                })).filter(i => i.visible);

                // Map buttons with their structural properties
                const buttonsInfo = Array.from(document.querySelectorAll('button, [role="button"]')).map(b => ({
                    tagName: b.tagName,
                    hasType: !!b.type,
                    hasAriaLabel: !!b.getAttribute('aria-label'),
                    visible: b.offsetParent !== null,
                    textLength: (b.innerText || '').trim().length > 0
                })).filter(b => b.visible);

                return {
                    // Form structure
                    formsCount: document.forms.length,
                    inputs: inputsInfo,
                    buttons: buttonsInfo,

                    // Container structure
                    hasMain: !!document.querySelector('main'),
                    hasArticle: !!document.querySelector('article'),
                    hasDialog: !!document.querySelector('[role="dialog"]'),
                    hasNav: !!document.querySelector('nav'),

                    // Semantic elements
                    headingsCount: document.querySelectorAll('h1, h2, h3').length,
                    linksCount: getElementInfo('a[href]'),

                    // Instagram-specific
                    hasCommentSection: !!(document.querySelector('ul[class*="comment"]') ||
                        document.querySelector('[data-testid*="comment"]')),

                    // Layout hints
                    viewportWidth: window.innerWidth,
                    isMobileLayout: window.innerWidth < 768
                };
            });

            const fingerprint = {
                pageType,
                timestamp: new Date().toISOString(),
                structure,
                hash: this.hashStructure(structure)
            };

            return fingerprint;

        } catch (error) {
            logger.error('[CHANGE] Error capturing fingerprint:', error.message);
            return null;
        }
    }

    /**
     * Create a hash from the structure data
     * @param {Object} structure
     * @returns {string} Hash
     */
    hashStructure(structure) {
        // Create a normalized string from key structural elements
        const normalized = JSON.stringify({
            forms: structure.formsCount,
            inputCount: structure.inputs?.length || 0,
            inputTypes: (structure.inputs || []).map(i => i.type).sort(),
            buttonCount: structure.buttons?.length || 0,
            hasMain: structure.hasMain,
            hasArticle: structure.hasArticle,
            hasDialog: structure.hasDialog,
            hasCommentSection: structure.hasCommentSection,
            isMobileLayout: structure.isMobileLayout
        });

        return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 16);
    }

    /**
     * Detect if page structure has changed
     * @param {Page} page - Playwright page
     * @param {string} pageType - Type of page
     * @returns {Object} Change detection result
     */
    async detectChange(page, pageType) {
        await this.initialize();

        const current = await this.captureFingerprint(page, pageType);
        if (!current) {
            return { changed: false, error: 'Could not capture fingerprint' };
        }

        const stored = this.pageFingerprints.get(pageType);

        if (!stored) {
            // First time seeing this page type
            logger.info(`[CHANGE] New page type detected: ${pageType}`);
            this.pageFingerprints.set(pageType, {
                hash: current.hash,
                structure: current.structure,
                capturedAt: current.timestamp,
                version: 1
            });

            await this.saveFingerprint(pageType, current, 1);

            return {
                changed: false,
                isNew: true,
                fingerprint: current
            };
        }

        // Compare hashes
        if (current.hash !== stored.hash) {
            logger.warn(`[CHANGE] Page structure changed: ${pageType}`);
            logger.warn(`[CHANGE] Old hash: ${stored.hash}, New hash: ${current.hash}`);

            // Calculate what changed
            const diff = this.computeDiff(stored.structure, current.structure);

            // Update stored fingerprint
            const newVersion = (stored.version || 1) + 1;
            this.pageFingerprints.set(pageType, {
                hash: current.hash,
                structure: current.structure,
                capturedAt: current.timestamp,
                version: newVersion
            });

            // Save new version to database
            await this.saveNewVersion(pageType, current, stored, newVersion);

            // Notify listeners
            this.notifyChange(pageType, {
                oldHash: stored.hash,
                newHash: current.hash,
                diff,
                version: newVersion
            });

            return {
                changed: true,
                oldVersion: stored,
                newVersion: current,
                diff
            };
        }

        return { changed: false };
    }

    /**
     * Compute differences between two structures
     * @param {Object} oldStructure
     * @param {Object} newStructure
     * @returns {Object} Differences
     */
    computeDiff(oldStructure, newStructure) {
        const diff = {
            added: [],
            removed: [],
            changed: []
        };

        // Compare key properties
        const keysToCompare = [
            'formsCount', 'hasMain', 'hasArticle', 'hasDialog',
            'hasCommentSection', 'headingsCount', 'isMobileLayout'
        ];

        for (const key of keysToCompare) {
            const oldVal = oldStructure?.[key];
            const newVal = newStructure?.[key];

            if (oldVal !== newVal) {
                diff.changed.push({
                    property: key,
                    old: oldVal,
                    new: newVal
                });
            }
        }

        // Compare input counts
        const oldInputCount = oldStructure?.inputs?.length || 0;
        const newInputCount = newStructure?.inputs?.length || 0;
        if (oldInputCount !== newInputCount) {
            diff.changed.push({
                property: 'inputCount',
                old: oldInputCount,
                new: newInputCount
            });
        }

        // Compare button counts
        const oldButtonCount = oldStructure?.buttons?.length || 0;
        const newButtonCount = newStructure?.buttons?.length || 0;
        if (oldButtonCount !== newButtonCount) {
            diff.changed.push({
                property: 'buttonCount',
                old: oldButtonCount,
                new: newButtonCount
            });
        }

        return diff;
    }

    /**
     * Notify all listeners about a change
     */
    notifyChange(pageType, details) {
        for (const listener of this.listeners) {
            try {
                listener(pageType, details);
            } catch (e) {
                logger.error('[CHANGE] Error in change listener:', e.message);
            }
        }
    }

    /**
     * Preflight check before scraping
     * @param {Page} page - Playwright page
     * @param {string} pageType - Type of page
     * @returns {Object} Check result
     */
    async preflightCheck(page, pageType) {
        const change = await this.detectChange(page, pageType);

        if (change.changed) {
            logger.warn(`[CHANGE] Preflight detected change in ${pageType} - selectors may need update`);

            // Could trigger invalidation of selectors here
            // await aiSelectorFallback.invalidateContext(pageType);
        }

        return change;
    }

    /**
     * Save fingerprint to database
     */
    async saveFingerprint(pageType, fingerprint, version) {
        try {
            await this.supabase
                .from('page_fingerprints')
                .insert({
                    page_type: pageType,
                    fingerprint_hash: fingerprint.hash,
                    structure_data: fingerprint.structure,
                    captured_at: fingerprint.timestamp,
                    version,
                    is_current: true
                });

            logger.debug(`[CHANGE] Saved fingerprint for ${pageType} (v${version})`);
        } catch (e) {
            logger.warn('[CHANGE] Could not save fingerprint:', e.message);
        }
    }

    /**
     * Save new version when change is detected
     */
    async saveNewVersion(pageType, newFingerprint, oldFingerprint, newVersion) {
        try {
            // Mark old version as not current
            await this.supabase
                .from('page_fingerprints')
                .update({ is_current: false })
                .eq('page_type', pageType)
                .eq('is_current', true);

            // Insert new version
            await this.supabase
                .from('page_fingerprints')
                .insert({
                    page_type: pageType,
                    fingerprint_hash: newFingerprint.hash,
                    structure_data: newFingerprint.structure,
                    captured_at: newFingerprint.timestamp,
                    version: newVersion,
                    is_current: true,
                    previous_hash: oldFingerprint.hash
                });

            logger.info(`[CHANGE] Saved new fingerprint version for ${pageType} (v${newVersion})`);
        } catch (e) {
            logger.warn('[CHANGE] Could not save new version:', e.message);
        }
    }

    /**
     * Get history of fingerprints for a page type
     */
    async getHistory(pageType) {
        try {
            const { data, error } = await this.supabase
                .from('page_fingerprints')
                .select('*')
                .eq('page_type', pageType)
                .order('version', { ascending: false });

            if (error) throw error;
            return data;
        } catch (e) {
            logger.error('[CHANGE] Error getting history:', e.message);
            return [];
        }
    }

    /**
     * Get all currently tracked page types
     */
    getTrackedPageTypes() {
        return Array.from(this.pageFingerprints.keys());
    }
}

module.exports = new ChangeDetectorService();
