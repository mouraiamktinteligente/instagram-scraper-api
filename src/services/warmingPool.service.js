/**
 * Warming Pool Service
 * Manages Instagram accounts in the warming phase
 * Handles account lifecycle from pending -> warming -> ready -> production
 */

const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');

// Daily action limits to avoid detection
const DAILY_LIMITS = {
    likes: 80,      // Instagram limit ~100-150, we use conservative
    follows: 40,    // Instagram limit ~50-100
    comments: 15,   // Instagram limit ~20-30
    stories: 100    // Stories have higher limits
};

class WarmingPoolService {
    constructor() {
        this.supabase = createClient(config.supabase.url, config.supabase.key);
        this.initialized = false;
    }

    /**
     * Add a new account for warming
     * @param {string} username - Instagram username/email
     * @param {string} password - Account password
     * @param {string} totpSecret - Optional 2FA TOTP secret
     * @param {string} proxyId - Optional specific proxy ID to use
     * @returns {Promise<Object>} Created account
     */
    async addAccount(username, password, totpSecret = null, proxyId = null) {
        try {
            // Check if account already exists
            const { data: existing } = await this.supabase
                .from('warming_accounts')
                .select('id, status')
                .eq('username', username)
                .single();

            if (existing) {
                throw new Error(`Account ${username} already exists in warming pool with status: ${existing.status}`);
            }

            // If no proxy specified, find an available one
            let assignedProxyId = proxyId;
            if (!assignedProxyId) {
                const { data: availableProxy } = await this.supabase
                    .from('warming_proxies')
                    .select('id')
                    .eq('is_active', true)
                    .is('assigned_account_id', null)
                    .limit(1)
                    .single();

                if (availableProxy) {
                    assignedProxyId = availableProxy.id;
                }
            }

            // Insert account
            const { data: account, error } = await this.supabase
                .from('warming_accounts')
                .insert({
                    username,
                    password,
                    totp_secret: totpSecret,
                    proxy_id: assignedProxyId,
                    status: 'pending'
                })
                .select()
                .single();

            if (error) throw error;

            // Assign proxy to this account
            if (assignedProxyId) {
                await this.supabase
                    .from('warming_proxies')
                    .update({ assigned_account_id: account.id })
                    .eq('id', assignedProxyId);

                logger.info(`Assigned proxy ${assignedProxyId} to account ${username}`);
            }

            logger.info(`Added account ${username} to warming pool`);
            return account;

        } catch (error) {
            logger.error(`Error adding account to warming pool: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get next account ready for warming session
     * @returns {Promise<Object|null>} Account or null
     */
    async getNextAccountForWarming() {
        try {
            // Get accounts that are in warming status and haven't been warmed recently
            const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

            const { data: account, error } = await this.supabase
                .from('warming_accounts')
                .select(`
                    *,
                    warming_proxies!proxy_id (
                        id, host, port, username, password
                    )
                `)
                .in('status', ['pending', 'warming'])
                .or(`last_warming_session_at.is.null,last_warming_session_at.lt.${twoHoursAgo}`)
                .order('last_warming_session_at', { ascending: true, nullsFirst: true })
                .limit(1)
                .single();

            if (error && error.code !== 'PGRST116') {
                throw error;
            }

            if (!account) {
                logger.debug('No accounts available for warming');
                return null;
            }

            // If status is pending, update to warming
            if (account.status === 'pending') {
                await this.supabase
                    .from('warming_accounts')
                    .update({
                        status: 'warming',
                        warming_started_at: new Date().toISOString()
                    })
                    .eq('id', account.id);

                account.status = 'warming';
                account.warming_started_at = new Date().toISOString();
            }

            return account;

        } catch (error) {
            logger.error(`Error getting next account for warming: ${error.message}`);
            return null;
        }
    }

    /**
     * Log a warming session result
     * @param {string} accountId - Account UUID
     * @param {string} patternName - Name of pattern used
     * @param {Array} actions - Actions performed
     * @param {number} durationSeconds - Session duration
     * @param {boolean} success - Whether session was successful
     * @param {string} errorMessage - Optional error message
     */
    async logWarmingSession(accountId, patternName, actions, durationSeconds, success, errorMessage = null) {
        try {
            // Insert session record
            const { error: sessionError } = await this.supabase
                .from('warming_sessions')
                .insert({
                    account_id: accountId,
                    pattern_name: patternName,
                    actions_performed: actions,
                    duration_seconds: durationSeconds,
                    success,
                    error_message: errorMessage
                });

            if (sessionError) throw sessionError;

            // Update account's last session time and total sessions
            const updates = {
                last_warming_session_at: new Date().toISOString()
            };

            if (success) {
                // Increment total sessions
                const { data: account } = await this.supabase
                    .from('warming_accounts')
                    .select('total_sessions, warming_started_at')
                    .eq('id', accountId)
                    .single();

                if (account) {
                    updates.total_sessions = (account.total_sessions || 0) + 1;

                    // Check if a day has passed since warming started
                    if (account.warming_started_at) {
                        const daysSinceStart = Math.floor(
                            (Date.now() - new Date(account.warming_started_at).getTime()) / (24 * 60 * 60 * 1000)
                        );
                        updates.warming_progress = Math.min(daysSinceStart, 5);
                    }
                }
            } else {
                updates.error_message = errorMessage;
            }

            await this.supabase
                .from('warming_accounts')
                .update(updates)
                .eq('id', accountId);

            logger.info(`Logged warming session for account ${accountId}: ${patternName} (${success ? 'success' : 'failed'})`);

        } catch (error) {
            logger.error(`Error logging warming session: ${error.message}`);
        }
    }

    /**
     * Save session cookies for an account
     * @param {string} accountId - Account UUID
     * @param {Array} cookies - Session cookies
     */
    async saveSession(accountId, cookies) {
        try {
            await this.supabase
                .from('warming_accounts')
                .update({ session_data: cookies })
                .eq('id', accountId);

            logger.debug(`Saved session for warming account ${accountId}`);
        } catch (error) {
            logger.error(`Error saving session: ${error.message}`);
        }
    }

    /**
     * Promote an account to production (move to instagram_accounts)
     * @param {string} accountId - Account UUID
     * @returns {Promise<boolean>} Success
     */
    async promoteToProduction(accountId) {
        try {
            // Get account data
            const { data: account, error: fetchError } = await this.supabase
                .from('warming_accounts')
                .select('*')
                .eq('id', accountId)
                .single();

            if (fetchError || !account) {
                throw new Error(`Account ${accountId} not found`);
            }

            if (account.warming_progress < 5) {
                logger.warn(`Account ${account.username} has only ${account.warming_progress} days of warming`);
            }

            // Insert into production accounts
            const { error: insertError } = await this.supabase
                .from('instagram_accounts')
                .insert({
                    username: account.username,
                    password: account.password,
                    totp_secret: account.totp_secret,
                    session_data: account.session_data,
                    is_active: true,
                    is_banned: false
                });

            if (insertError) {
                throw insertError;
            }

            // Update warming account status
            await this.supabase
                .from('warming_accounts')
                .update({ status: 'ready' })
                .eq('id', accountId);

            // Release the proxy
            if (account.proxy_id) {
                await this.supabase
                    .from('warming_proxies')
                    .update({ assigned_account_id: null })
                    .eq('id', account.proxy_id);
            }

            logger.info(`Account ${account.username} promoted to production!`);
            return true;

        } catch (error) {
            logger.error(`Error promoting account: ${error.message}`);
            return false;
        }
    }

    /**
     * Check and auto-promote accounts that have 5+ days of warming
     * @returns {Promise<Array>} Promoted accounts
     */
    async checkAndPromoteReadyAccounts() {
        try {
            // Find accounts with 5+ days of warming
            const { data: readyAccounts, error } = await this.supabase
                .from('warming_accounts')
                .select('id, username, warming_progress')
                .eq('status', 'warming')
                .gte('warming_progress', 5);

            if (error) throw error;

            const promoted = [];

            for (const account of readyAccounts || []) {
                const success = await this.promoteToProduction(account.id);
                if (success) {
                    promoted.push(account.username);
                }
            }

            if (promoted.length > 0) {
                logger.info(`Auto-promoted ${promoted.length} accounts: ${promoted.join(', ')}`);
            }

            return promoted;

        } catch (error) {
            logger.error(`Error checking ready accounts: ${error.message}`);
            return [];
        }
    }

    /**
     * Mark account as failed
     * @param {string} accountId - Account UUID
     * @param {string} reason - Failure reason
     */
    async markAsFailed(accountId, reason) {
        try {
            await this.supabase
                .from('warming_accounts')
                .update({
                    status: 'failed',
                    error_message: reason
                })
                .eq('id', accountId);

            logger.warn(`Account ${accountId} marked as failed: ${reason}`);
        } catch (error) {
            logger.error(`Error marking account as failed: ${error.message}`);
        }
    }

    /**
     * Get warming pool status
     * @returns {Promise<Object>} Status summary
     */
    async getStatus() {
        try {
            const { data: accounts, error } = await this.supabase
                .from('warming_accounts')
                .select('id, username, status, warming_progress, total_sessions, last_warming_session_at, created_at');

            if (error) throw error;

            const summary = {
                total: accounts.length,
                pending: 0,
                warming: 0,
                ready: 0,
                failed: 0,
                accounts: []
            };

            for (const acc of accounts) {
                summary[acc.status] = (summary[acc.status] || 0) + 1;
                summary.accounts.push({
                    username: acc.username,
                    status: acc.status,
                    progress: `${acc.warming_progress}/5 days`,
                    sessions: acc.total_sessions || 0,
                    lastSession: acc.last_warming_session_at
                });
            }

            return summary;

        } catch (error) {
            logger.error(`Error getting warming pool status: ${error.message}`);
            return { total: 0, error: error.message };
        }
    }

    /**
     * Get all warming proxies
     * @returns {Promise<Array>} Proxies
     */
    async getProxies() {
        try {
            const { data, error } = await this.supabase
                .from('warming_proxies')
                .select('*')
                .eq('is_active', true);

            if (error) throw error;
            return data || [];
        } catch (error) {
            logger.error(`Error getting warming proxies: ${error.message}`);
            return [];
        }
    }

    /**
     * Add a warming proxy
     * @param {string} host - Proxy host
     * @param {number} port - Proxy port
     * @param {string} username - Proxy username
     * @param {string} password - Proxy password
     */
    async addProxy(host, port, username, password) {
        try {
            const { data, error } = await this.supabase
                .from('warming_proxies')
                .insert({ host, port, username, password })
                .select()
                .single();

            if (error) throw error;

            logger.info(`Added warming proxy: ${host}:${port}`);
            return data;
        } catch (error) {
            logger.error(`Error adding warming proxy: ${error.message}`);
            throw error;
        }
    }
    /**
     * Get daily limits
     * @returns {Object} Limits
     */
    getDailyLimits() {
        return DAILY_LIMITS;
    }
}

// Export singleton instance and limits
const warmingPool = new WarmingPoolService();
warmingPool.DAILY_LIMITS = DAILY_LIMITS;
module.exports = warmingPool;
