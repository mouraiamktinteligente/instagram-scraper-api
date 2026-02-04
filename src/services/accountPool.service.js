/**
 * Account Pool Service
 * Manages multiple Instagram accounts for scraping with rotation and health monitoring
 * Loads accounts from Supabase database
 */

const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');

class AccountPoolService {
    constructor() {
        this.accounts = [];
        this.currentIndex = 0;
        this.accountStatus = new Map();
        this.initialized = false;

        // Initialize Supabase client
        this.supabase = createClient(config.supabase.url, config.supabase.key);
    }

    /**
     * Initialize the account pool from Supabase database
     */
    async initialize() {
        if (this.initialized) return;

        try {
            await this.loadAccountsFromDatabase();
            this.initialized = true;
        } catch (error) {
            logger.error('Error initializing account pool:', error.message);
            this.accounts = [];
            this.initialized = true;
        }
    }

    /**
     * Load accounts from Supabase database
     */
    async loadAccountsFromDatabase() {
        try {
            const { data, error } = await this.supabase
                .from('instagram_accounts')
                .select('*')
                .eq('is_active', true)
                .eq('is_banned', false)
                .order('created_at', { ascending: true });

            if (error) {
                throw error;
            }

            this.accounts = (data || []).map(row => ({
                id: row.id,
                username: row.username,
                password: row.password,
                totpSecret: row.totp_secret || null,  // 2FA TOTP secret
                sessionData: row.session_data,
            }));

            // Initialize status for each account
            this.accountStatus.clear();

            for (const acc of this.accounts) {
                this.accountStatus.set(acc.username, {
                    dbId: acc.id,
                    status: 'active',
                    lastUsed: null,
                    errorCount: 0,
                    lastError: null
                });
            }

            logger.info(`AccountPool loaded ${this.accounts.length} accounts from database`);

            // CRITICAL: Warn if no accounts are available
            if (this.accounts.length === 0) {
                logger.error('═══════════════════════════════════════════════════════════════');
                logger.error('[CRITICAL] NO INSTAGRAM ACCOUNTS AVAILABLE!');
                logger.error('═══════════════════════════════════════════════════════════════');
                logger.error('The scraper cannot work without accounts.');
                logger.error('');
                logger.error('Possible causes:');
                logger.error('  1. No accounts in instagram_accounts table');
                logger.error('  2. All accounts have is_active = false');
                logger.error('  3. All accounts have is_banned = true');
                logger.error('');
                logger.error('To fix, run this SQL in Supabase:');
                logger.error('  SELECT id, username, is_active, is_banned FROM instagram_accounts;');
                logger.error('');
                logger.error('To reset banned accounts:');
                logger.error('  UPDATE instagram_accounts SET is_banned = false, is_active = true, fail_count = 0;');
                logger.error('═══════════════════════════════════════════════════════════════');
            }

            // Debug: log accounts with TOTP
            const accountsWithTOTP = this.accounts.filter(a => a.totpSecret);
            logger.info(`[DEBUG] Accounts with TOTP secret: ${accountsWithTOTP.length}`);
            if (accountsWithTOTP.length > 0) {
                logger.info(`[DEBUG] TOTP accounts: ${accountsWithTOTP.map(a => a.username).join(', ')}`);
            }
        } catch (error) {
            logger.error('Error loading accounts from database:', error.message);
            throw error;
        }
    }

    /**
     * Reload accounts from database
     */
    async reloadAccounts() {
        this.initialized = false;
        await this.initialize();
    }

    /**
     * Get the next available account using round-robin rotation
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

            this.currentIndex = (this.currentIndex + 1) % this.accounts.length;
            attempts++;

            if (status.status === 'banned') {
                logger.debug(`Skipping banned account: ${account.username}`);
                continue;
            }

            status.lastUsed = new Date();
            logger.debug(`Using account: ${account.username}`);

            return {
                id: account.id,
                username: account.username,
                password: account.password,
                totpSecret: account.totpSecret,  // 2FA TOTP secret
                sessionData: account.sessionData
            };
        }

        logger.error('All accounts are banned or unavailable');
        return null;
    }

    /**
     * Get the number of available (non-banned) accounts
     */
    getAccountCount() {
        return this.accounts.filter(a =>
            this.accountStatus.get(a.username)?.status !== 'banned'
        ).length;
    }

    /**
     * Report error for an account
     */
    async reportError(username, error) {
        const status = this.accountStatus.get(username);
        if (!status) return;

        status.errorCount++;
        status.lastError = error;

        // SIMPLIFIED BAN LOGIC:
        // Only ban when Instagram has actually suspended the account
        // This is indicated by "accounts/suspended" in the URL/error
        // All other errors (2FA, timeout, network, etc.) do NOT ban the account
        const isReallyBanned = error.toLowerCase().includes('accounts/suspended');

        if (isReallyBanned) {
            status.status = 'banned';
            logger.warn(`[ACCOUNT] ⛔ Account ${username} BANNED BY INSTAGRAM: ${error}`);

            // Update database
            try {
                await this.supabase
                    .from('instagram_accounts')
                    .update({
                        is_banned: true,
                        fail_count: status.errorCount
                    })
                    .eq('id', status.dbId);
            } catch (e) {
                logger.debug('Failed to update account ban status in DB:', e.message);
            }
        } else {
            // Log error but DO NOT ban the account
            logger.info(`[ACCOUNT] Reported error for ${username}: ${error}. Fail count: ${status.errorCount} (account NOT banned)`);

            // Just update fail count in database
            try {
                await this.supabase
                    .from('instagram_accounts')
                    .update({ fail_count: status.errorCount })
                    .eq('id', status.dbId);
            } catch (e) {
                logger.debug('Failed to update account fail_count in DB:', e.message);
            }
        }
    }

    /**
     * Report success for an account
     */
    async reportSuccess(username) {
        const status = this.accountStatus.get(username);
        if (!status) return;

        status.errorCount = 0;
        status.lastError = null;
        status.status = 'active';

        // Update database
        try {
            await this.supabase
                .from('instagram_accounts')
                .update({
                    fail_count: 0,
                    last_login_at: new Date().toISOString()
                })
                .eq('id', status.dbId);
        } catch (e) {
            logger.debug('Failed to update account success in DB:', e.message);
        }
    }

    /**
     * Save session data to database
     */
    async saveSession(username, cookies) {
        const status = this.accountStatus.get(username);
        if (!status) {
            logger.warn(`Cannot save session: account ${username} not found in pool`);
            return;
        }

        try {
            await this.supabase
                .from('instagram_accounts')
                .update({ session_data: cookies })
                .eq('id', status.dbId);

            logger.info(`Session saved to database for ${username}`);
        } catch (error) {
            logger.error(`Failed to save session for ${username}:`, error.message);
        }
    }

    /**
     * Load session data from database
     */
    async loadSession(username) {
        const account = this.accounts.find(acc => acc.username === username);
        if (!account) {
            return null;
        }

        // Session is already loaded in account object
        if (account.sessionData && Array.isArray(account.sessionData)) {
            return account.sessionData;
        }

        // Reload from database if not present
        try {
            const { data, error } = await this.supabase
                .from('instagram_accounts')
                .select('session_data')
                .eq('username', username)
                .single();

            if (error || !data?.session_data) {
                return null;
            }

            return data.session_data;
        } catch (error) {
            logger.warn(`Error loading session for ${username}:`, error.message);
            return null;
        }
    }

    /**
     * Check if account has session data
     */
    hasSession(username) {
        const account = this.accounts.find(acc => acc.username === username);
        return account?.sessionData && Array.isArray(account.sessionData) && account.sessionData.length > 0;
    }

    /**
     * Get pool status summary
     */
    getStatus() {
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
     * Reset a banned account
     */
    async resetAccount(username) {
        const status = this.accountStatus.get(username);
        if (status) {
            status.status = 'active';
            status.errorCount = 0;
            status.lastError = null;

            // Update database
            try {
                await this.supabase
                    .from('instagram_accounts')
                    .update({
                        is_banned: false,
                        fail_count: 0
                    })
                    .eq('id', status.dbId);
            } catch (e) {
                logger.debug('Failed to reset account in DB:', e.message);
            }

            logger.info(`Account ${username} reset to active`);
        }
    }

    /**
     * Get count of active accounts
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
