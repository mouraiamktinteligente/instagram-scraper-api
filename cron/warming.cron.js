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
 * Generate random delay in milliseconds
 * @param {number} minMs - Minimum delay
 * @param {number} maxMs - Maximum delay
 */
function randomDelay(minMs, maxMs) {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

/**
 * Get random hour offset (0-45 minutes)
 */
function getRandomMinuteOffset() {
    return Math.floor(Math.random() * 46); // 0-45 minutes
}

/**
 * ⭐ HUMANIZED WARMING SCHEDULER
 * Instead of fixed times, uses randomized intervals:
 * - Base interval: 1.5-3 hours
 * - Random minute offset: 0-45 min
 * - Different pattern each day
 */
async function scheduleNextWarmingCycle() {
    // Random interval between 1.5 to 3 hours (in ms)
    const minInterval = 90 * 60 * 1000;   // 1.5 hours
    const maxInterval = 180 * 60 * 1000;  // 3 hours
    const nextInterval = randomDelay(minInterval, maxInterval);

    const nextRunTime = new Date(Date.now() + nextInterval);
    const hours = Math.floor(nextInterval / 1000 / 60 / 60);
    const minutes = Math.floor((nextInterval / 1000 / 60) % 60);

    logger.info(`[CRON:WARMING] 🎲 Next warming cycle in ${hours}h ${minutes}min (at ~${nextRunTime.toLocaleTimeString('pt-BR', { timeZone: TIMEZONE })})`);

    setTimeout(async () => {
        await executeWarmingCycle();
        // Schedule next cycle recursively
        scheduleNextWarmingCycle();
    }, nextInterval);
}

/**
 * Schedule warming jobs with humanized timing
 */
function scheduleWarmingJobs() {
    // ⭐ HUMANIZED: Check every 30 minutes, but only execute with random probability
    // This creates unpredictable but frequent enough warming sessions
    cron.schedule('*/30 * * * *', async () => {
        // Only run during allowed hours (08:00-23:00 Brasília)
        if (!isWithinWarmingHours()) {
            return;
        }

        // Random chance to execute (30% per check = avg 1 session per 1.5 hours)
        const shouldRun = Math.random() < 0.30;

        if (shouldRun) {
            // Add random delay 0-10 minutes for extra randomness
            const delay = randomDelay(0, 10 * 60 * 1000);
            logger.info(`[CRON:WARMING] 🎲 Session triggered! Starting in ${Math.floor(delay / 1000 / 60)} minutes...`);

            setTimeout(async () => {
                await executeWarmingCycle();
            }, delay);
        }
    }, {
        scheduled: true,
        timezone: TIMEZONE
    });

    logger.info('[CRON:WARMING] 🎲 Humanized warming scheduled: random intervals (avg 1.5-2h)');

    // Promotion check - daily at random time between 00:00-06:00
    const promotionHour = Math.floor(Math.random() * 6); // 0-5
    const promotionMinute = Math.floor(Math.random() * 60);

    cron.schedule(`${promotionMinute} ${promotionHour} * * *`, async () => {
        await checkAndPromoteAccounts();
    }, {
        scheduled: true,
        timezone: TIMEZONE
    });

    logger.info(`[CRON:WARMING] 📅 Promotion check scheduled: daily at ~${promotionHour}:${promotionMinute.toString().padStart(2, '0')} Brasília`);

    // Initial warming cycle at startup (with random delay 1-5 minutes)
    const startupDelay = randomDelay(60000, 300000);
    logger.info(`[CRON:WARMING] 🚀 Initial warming in ${Math.floor(startupDelay / 1000)} seconds...`);

    setTimeout(async () => {
        logger.info('[CRON:WARMING] Running initial warming cycle...');
        await executeWarmingCycle();
    }, startupDelay);

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
            .select('*, warming_proxies!proxy_id (*)')
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
