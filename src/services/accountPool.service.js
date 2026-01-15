/**
 * Account Pool Service
 * Manages multiple Instagram accounts for scraping with rotation and health monitoring
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

// Session storage directory
const SESSIONS_DIR = process.env.SESSIONS_DIR || '/data/sessions';

class AccountPoolService {
    constructor() {
        this.accounts = [];
        this.currentIndex = 0;
        this.accountStatus = new Map(); // username -> { status: 'active'|'banned'|'error', lastUsed, errorCount }
        this.initialized = false;
    }

    /**
     * Initialize the account pool from environment variable
     * Format: INSTAGRAM_ACCOUNTS=[{"username":"user1","password":"pass1"},...]
     */
    initialize() {
        if (this.initialized) return;

        try {
            const accountsJson = process.env.INSTAGRAM_ACCOUNTS || '[]';

            // Log for debugging
            logger.debug('Raw INSTAGRAM_ACCOUNTS value:', accountsJson.substring(0, 100));

            let parsed;
            try {
                parsed = JSON.parse(accountsJson);
            } catch (parseError) {
                logger.error('Failed to parse INSTAGRAM_ACCOUNTS JSON:', parseError.message);
                logger.error('Value received:', accountsJson.substring(0, 200));
                this.accounts = [];
                this.initialized = true;
                return;
            }

            // Ensure it's an array
            if (!Array.isArray(parsed)) {
                logger.error('INSTAGRAM_ACCOUNTS must be a JSON array, got:', typeof parsed);
                this.accounts = [];
                this.initialized = true;
                return;
            }

            this.accounts = parsed;

            if (this.accounts.length === 0) {
                logger.warn('No Instagram accounts configured. Add INSTAGRAM_ACCOUNTS env variable.');
                this.initialized = true;
                return;
            }

            // Validate each account
            this.accounts = this.accounts.filter((acc, index) => {
                if (!acc || typeof acc !== 'object') {
                    logger.warn(`Account at index ${index} is not an object, skipping`);
                    return false;
                }
                if (!acc.username || !acc.password) {
                    logger.warn(`Account at index ${index} missing username or password, skipping`);
                    return false;
                }
                return true;
            });

            // Initialize status for each account
            for (const acc of this.accounts) {
                this.accountStatus.set(acc.username, {
                    status: 'active',
                    lastUsed: null,
                    errorCount: 0,
                    lastError: null
                });
            }

            // Ensure sessions directory exists
            try {
                if (!fs.existsSync(SESSIONS_DIR)) {
                    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
                }
            } catch (fsError) {
                logger.warn('Could not create sessions directory:', fsError.message);
            }

            this.initialized = true;
            logger.info(`AccountPool initialized with ${this.accounts.length} accounts`);

        } catch (error) {
            logger.error('Error initializing account pool:', error.message);
            this.accounts = [];
            this.initialized = true;
        }
    }

    /**
     * Get the next available account using round-robin rotation
     * Skips banned accounts
     * @returns {Object|null} Account object with username, password, sessionPath
     */
    getNextAccount() {
        if (this.accounts.length === 0) {
            logger.error('No accounts available in pool');
            return null;
        }

        const startIndex = this.currentIndex;
        let attempts = 0;

        while (attempts < this.accounts.length) {
            const account = this.accounts[this.currentIndex];
            const status = this.accountStatus.get(account.username);

            // Move to next index
            this.currentIndex = (this.currentIndex + 1) % this.accounts.length;
            attempts++;

            // Skip banned accounts
            if (status.status === 'banned') {
                logger.debug(`Skipping banned account: ${account.username}`);
                continue;
            }

            // Return account with session path
            const sessionPath = path.join(SESSIONS_DIR, `${account.username}.json`);

            // Update last used
            status.lastUsed = new Date();

            logger.debug(`Using account: ${account.username}`);

            return {
                username: account.username,
                password: account.password,
                sessionPath
            };
        }

        logger.error('All accounts are banned or unavailable');
        return null;
    }

    /**
     * Mark an account as having an error
     * After 3 consecutive errors, marks as banned
     * @param {string} username 
     * @param {string} error 
     */
    reportError(username, error) {
        const status = this.accountStatus.get(username);
        if (!status) return;

        status.errorCount++;
        status.lastError = error;

        // Check for ban indicators in error message
        const banIndicators = [
            'login_required',
            'checkpoint_required',
            'This account has been suspended',
            'challenge_required',
            'blocked',
            'rate limit'
        ];

        const isBan = banIndicators.some(indicator =>
            error.toLowerCase().includes(indicator.toLowerCase())
        );

        if (isBan || status.errorCount >= 3) {
            status.status = 'banned';
            logger.warn(`Account ${username} marked as banned: ${error}`);
        }
    }

    /**
     * Mark an account as successfully used (reset error count)
     * @param {string} username 
     */
    reportSuccess(username) {
        const status = this.accountStatus.get(username);
        if (!status) return;

        status.errorCount = 0;
        status.lastError = null;
        status.status = 'active';
    }

    /**
     * Check if an account has a saved session
     * @param {string} username 
     * @returns {boolean}
     */
    hasSession(username) {
        const sessionPath = path.join(SESSIONS_DIR, `${username}.json`);
        return fs.existsSync(sessionPath);
    }

    /**
     * Save session cookies for an account
     * @param {string} username 
     * @param {Array} cookies 
     */
    saveSession(username, cookies) {
        const sessionPath = path.join(SESSIONS_DIR, `${username}.json`);
        fs.writeFileSync(sessionPath, JSON.stringify(cookies, null, 2));
        logger.info(`Session saved for ${username}`);
    }

    /**
     * Load session cookies for an account
     * @param {string} username 
     * @returns {Array|null}
     */
    loadSession(username) {
        const sessionPath = path.join(SESSIONS_DIR, `${username}.json`);
        if (!fs.existsSync(sessionPath)) {
            return null;
        }
        try {
            return JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
        } catch (error) {
            logger.warn(`Error loading session for ${username}:`, error.message);
            return null;
        }
    }

    /**
     * Get pool status summary
     * @returns {Object}
     */
    getStatus() {
        // Ensure accounts is always an array
        if (!Array.isArray(this.accounts)) {
            this.accounts = [];
        }

        const statuses = {
            total: this.accounts.length,
            active: 0,
            banned: 0,
            withSession: 0
        };

        for (const acc of this.accounts) {
            if (!acc || !acc.username) continue;
            const status = this.accountStatus.get(acc.username);
            if (status) {
                if (status.status === 'active') statuses.active++;
                if (status.status === 'banned') statuses.banned++;
            }
            if (this.hasSession(acc.username)) statuses.withSession++;
        }

        return {
            ...statuses,
            accounts: this.accounts.map(acc => ({
                username: acc?.username || 'unknown',
                ...(this.accountStatus.get(acc?.username) || {}),
                hasSession: acc?.username ? this.hasSession(acc.username) : false
            }))
        };
    }

    /**
     * Manually reset a banned account
     * @param {string} username 
     */
    resetAccount(username) {
        const status = this.accountStatus.get(username);
        if (status) {
            status.status = 'active';
            status.errorCount = 0;
            status.lastError = null;
            logger.info(`Account ${username} reset to active`);
        }
    }

    /**
     * Get count of active accounts
     * @returns {number}
     */
    getActiveCount() {
        let count = 0;
        this.accountStatus.forEach(status => {
            if (status.status === 'active') count++;
        });
        return count;
    }
}

// Export singleton instance
module.exports = new AccountPoolService();
