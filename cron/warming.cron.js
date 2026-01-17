/**
 * Warming CRON Job
 * Executes warming sessions automatically for accounts in warming phase
 * Runs only between 08:00-23:00 Brasília time
 */

const cron = require('node-cron');
const warmingPool = require('../src/services/warmingPool.service');
const warmingWorker = require('../src/workers/warmingWorker');
const logger = require('../src/utils/logger');

// Configuration
const WARMING_START_HOUR = 8;
const WARMING_END_HOUR = 23;
const TIMEZONE = 'America/Sao_Paulo';

/**
 * Check if current time is within warming hours (Brasília)
 */
function isWithinWarmingHours() {
    const now = new Date();
    const brasiliaOffset = -3;
    const utcHour = now.getUTCHours();
    const brasiliaHour = (utcHour + brasiliaOffset + 24) % 24;

    return brasiliaHour >= WARMING_START_HOUR && brasiliaHour < WARMING_END_HOUR;
}

/**
 * Execute warming for next available account
 */
async function executeWarmingCycle() {
    logger.info('[CRON:WARMING] Starting warming cycle...');

    // Check time restriction
    if (!isWithinWarmingHours()) {
        logger.info('[CRON:WARMING] Outside warming hours (08:00-23:00 Brasília). Skipping.');
        return;
    }

    // Check if worker is already running
    if (warmingWorker.isRunning) {
        logger.info('[CRON:WARMING] Worker is already running. Skipping.');
        return;
    }

    try {
        // Get next account for warming
        const account = await warmingPool.getNextAccountForWarming();

        if (!account) {
            logger.info('[CRON:WARMING] No accounts available for warming.');
            return;
        }

        logger.info(`[CRON:WARMING] Starting session for ${account.username}`);

        // Execute warming session
        const result = await warmingWorker.executeWarmingSession(account);

        if (result.success) {
            logger.info(`[CRON:WARMING] Session completed: ${result.pattern} (${result.actions} actions)`);
        } else {
            logger.warn(`[CRON:WARMING] Session failed: ${result.reason}`);
        }

    } catch (error) {
        logger.error(`[CRON:WARMING] Error in warming cycle: ${error.message}`);
    }
}

/**
 * Check and promote accounts that have completed 5 days
 */
async function checkAndPromoteAccounts() {
    logger.info('[CRON:WARMING] Checking for ready accounts to promote...');

    try {
        const promoted = await warmingPool.checkAndPromoteReadyAccounts();

        if (promoted.length > 0) {
            logger.info(`[CRON:WARMING] Promoted ${promoted.length} accounts to production: ${promoted.join(', ')}`);
        } else {
            logger.info('[CRON:WARMING] No accounts ready for promotion.');
        }
    } catch (error) {
        logger.error(`[CRON:WARMING] Error checking for promotion: ${error.message}`);
    }
}

/**
 * Schedule warming jobs
 */
function scheduleWarmingJobs() {
    // Warming cycle - every 2 hours between 08:00-22:00 (last run at 22h)
    // CRON: minute hour day month weekday
    // '0 8-22/2 * * *' = At minute 0, every 2 hours from 8 to 22
    cron.schedule('0 8-22/2 * * *', async () => {
        await executeWarmingCycle();
    }, {
        scheduled: true,
        timezone: TIMEZONE
    });

    logger.info('[CRON:WARMING] Warming cycle scheduled: every 2 hours (08:00-22:00 Brasília)');

    // Promotion check - daily at midnight
    cron.schedule('0 0 * * *', async () => {
        await checkAndPromoteAccounts();
    }, {
        scheduled: true,
        timezone: TIMEZONE
    });

    logger.info('[CRON:WARMING] Promotion check scheduled: daily at 00:00 Brasília');

    // Also run promotion check at startup (delayed by 30 seconds)
    setTimeout(async () => {
        logger.info('[CRON:WARMING] Running initial promotion check...');
        await checkAndPromoteAccounts();
    }, 30000);
}

/**
 * Manual trigger for testing
 */
async function triggerManualWarm(accountId = null) {
    if (accountId) {
        // Warm specific account
        const { data: account } = await warmingPool.supabase
            .from('warming_accounts')
            .select('*, warming_proxies (*)')
            .eq('id', accountId)
            .single();

        if (account) {
            return await warmingWorker.executeWarmingSession(account);
        }
        return { success: false, reason: 'account_not_found' };
    }

    // Warm next available account
    return await executeWarmingCycle();
}

module.exports = {
    scheduleWarmingJobs,
    executeWarmingCycle,
    checkAndPromoteAccounts,
    triggerManualWarm,
    isWithinWarmingHours
};
