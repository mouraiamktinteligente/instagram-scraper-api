/**
 * CRON Job: Update Doc IDs
 * Runs daily to validate and update Instagram doc_ids
 */

const cron = require('node-cron');
const config = require('../src/config');
const logger = require('../src/utils/logger');
const docIdService = require('../src/services/docid.service');
const proxyService = require('../src/services/proxy.service');

logger.info('Doc ID CRON job initializing...');
logger.info(`Schedule: ${config.docIdCronSchedule}`);

/**
 * Main CRON task
 * Validates current doc_id and discovers new one if needed
 */
async function updateDocIds() {
    logger.info('Starting doc_id update check...');

    try {
        // Get current doc_id
        const currentDocId = await docIdService.getDocId();
        logger.info(`Current doc_id: ${currentDocId || 'none'}`);

        // Validate current doc_id
        const isValid = await docIdService.validateDocId();

        if (isValid) {
            logger.info('Current doc_id is valid, no update needed');
            return;
        }

        // Doc_id is invalid, discover new one
        logger.warn('Doc_id is invalid or expired, discovering new one...');

        // Get a working proxy for discovery
        const proxy = proxyService.getNextProxy();

        // Attempt discovery
        const newDocId = await docIdService.discoverDocId(proxy);

        if (newDocId) {
            logger.info(`New doc_id discovered: ${newDocId}`);
        } else {
            logger.error('Failed to discover new doc_id');

            // Mark current as invalid
            await docIdService.invalidateDocId();
        }

    } catch (error) {
        logger.error('Error in doc_id update job:', error);
    }
}

// Schedule the CRON job
cron.schedule(config.docIdCronSchedule, updateDocIds, {
    timezone: 'America/Sao_Paulo',
});

logger.info('Doc ID CRON job scheduled');

// Also run once on startup (after a short delay)
setTimeout(async () => {
    logger.info('Running initial doc_id check...');
    try {
        const docId = await docIdService.getDocId();
        logger.info(`Initial doc_id loaded: ${docId || 'none'}`);
    } catch (error) {
        logger.error('Error in initial doc_id check:', error);
    }
}, 5000);

// Keep process alive if running standalone
if (require.main === module) {
    logger.info('Running in standalone mode');

    // Handle shutdown
    process.on('SIGTERM', () => {
        logger.info('SIGTERM received, shutting down CRON...');
        process.exit(0);
    });

    process.on('SIGINT', () => {
        logger.info('SIGINT received, shutting down CRON...');
        process.exit(0);
    });
}

module.exports = { updateDocIds };
