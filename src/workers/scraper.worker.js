/**
 * Scraper Worker
 * Bull Queue workers for distributed scraping with proxy parallelization
 * Workers are initialized lazily to allow graceful startup
 */

const Queue = require('bull');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const proxyService = require('../services/proxy.service');
const instagramService = require('../services/instagram.service');

// Supabase client
const supabase = createClient(config.supabase.url, config.supabase.key);

// Redis connection options
const redisOptions = {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password || undefined,
    maxRetriesPerRequest: 3,
    retryDelayOnFailover: 100,
    enableReadyCheck: false,
    connectTimeout: 10000,
};

// Queues array (lazily initialized)
let queues = null;
let initialized = false;

/**
 * Initialize queues (lazy initialization)
 * Now async to load proxies from database
 */
async function initializeQueues() {
    if (initialized) return queues;

    logger.info('Initializing Bull queues...');
    queues = [];

    // Initialize proxy service from database
    await proxyService.initialize();
    const proxies = proxyService.getAllProxies();

    if (proxies.length === 0) {
        logger.warn('No proxies configured, creating single queue without proxy');
        const queue = createQueue('scraper-default', null, 0);
        queues.push(queue);
    } else {
        proxies.forEach((proxy, index) => {
            const queue = createQueue(`scraper-${index}`, proxy, index);
            queues.push(queue);
        });
    }

    initialized = true;
    logger.info(`${queues.length} queue(s) initialized`);

    return queues;
}

/**
 * Create a Bull queue with rate limiting
 * @param {string} name - Queue name
 * @param {Object} proxy - Proxy configuration
 * @param {number} index - Proxy/queue index
 * @returns {Queue} Bull queue instance
 */
function createQueue(name, proxy, index) {
    const queue = new Queue(name, {
        redis: redisOptions,
        limiter: {
            max: config.rateLimit.requestsPerMinute,
            duration: 60000,
        },
        defaultJobOptions: {
            attempts: config.queue.attempts,
            backoff: config.queue.backoff,
            removeOnComplete: 100,
            removeOnFail: 50,
        },
    });

    // Process jobs
    queue.process(config.queue.concurrency, async (job) => {
        const { postUrl, jobId, maxComments, mode = 'auto' } = job.data;

        logger.queue(`Processing job`, {
            jobId,
            postUrl,
            queueName: name,
            proxyIndex: index,
            attempt: job.attemptsMade + 1,
            maxComments,
            mode,
        });

        try {
            // Update job status to processing
            await updateJobStatus(jobId, 'processing', {
                started_at: new Date().toISOString()
            });

            // Perform scraping with optional comment limit and mode
            const result = await instagramService.scrapeComments(postUrl, proxy, jobId, maxComments, mode);

            // Report proxy success
            if (proxy) {
                proxyService.reportSuccess(index);
            }

            // Update job status to completed
            await updateJobStatus(jobId, 'completed', {
                completed_at: new Date().toISOString(),
                comments_count: result.commentsCount || 0,
                result: {
                    duration: result.duration || 0,
                    saved: result.savedCount || 0,
                    errors: 0,
                },
            });

            // Send webhook notification if configured
            await sendWebhook(jobId, 'completed', result);

            logger.queue(`Job completed`, {
                jobId,
                commentsCount: result.commentsCount || 0,
                savedCount: result.savedCount || 0,
            });

            return result;

        } catch (error) {
            logger.error(`Job failed`, {
                jobId,
                postUrl,
                error: error.message,
                attempt: job.attemptsMade + 1,
                maxAttempts: config.queue.attempts,
            });

            // Report proxy failure
            if (proxy) {
                proxyService.reportFailure(index, error.message);
            }

            // Update job status on final failure
            if (job.attemptsMade + 1 >= config.queue.attempts) {
                await updateJobStatus(jobId, 'failed', {
                    completed_at: new Date().toISOString(),
                    error: error.message,
                });

                await sendWebhook(jobId, 'failed', { error: error.message });
            }

            throw error;
        }
    });

    // Event handlers
    queue.on('error', (error) => {
        logger.error(`Queue ${name} error:`, error.message);
    });

    queue.on('failed', (job, error) => {
        logger.warn(`Job ${job.id} failed in queue ${name}:`, error.message);
    });

    queue.on('stalled', (job) => {
        logger.warn(`Job ${job.id} stalled in queue ${name}`);
    });

    logger.info(`Queue ${name} created`, {
        proxy: proxy ? proxy.server : 'none',
        rateLimit: `${config.rateLimit.requestsPerMinute}/min`,
    });

    return queue;
}

/**
 * Add a scrape job to the queue
 * @param {string} postUrl - Instagram post URL
 * @param {string} jobId - Job ID from database
 * @returns {Promise<Object>} Queue job info
 */
let currentQueueIndex = 0;

async function addJob(postUrl, jobId, maxComments = null, mode = 'auto') {
    // Ensure queues are initialized (loads proxies from database)
    const activeQueues = await initializeQueues();

    // Select queue (round-robin across available proxies)
    const queue = activeQueues[currentQueueIndex];
    currentQueueIndex = (currentQueueIndex + 1) % activeQueues.length;

    const job = await queue.add({
        postUrl,
        jobId,
        maxComments,  // Optional limit for comments
        mode,         // Scraping mode: 'public', 'authenticated', 'auto'
        createdAt: new Date().toISOString(),
    });

    logger.queue(`Job added to queue`, {
        jobId,
        queueName: queue.name,
        bullJobId: job.id,
        maxComments,
        mode,
    });

    return {
        jobId,
        bullJobId: job.id,
        queueName: queue.name,
    };
}

/**
 * Update job status in Supabase
 */
async function updateJobStatus(jobId, status, data = {}) {
    try {
        const { error } = await supabase
            .from('scrape_jobs')
            .update({
                status,
                ...data,
            })
            .eq('id', jobId);

        if (error) {
            logger.error('Error updating job status:', error);
        }
    } catch (e) {
        logger.error('Error in updateJobStatus:', e);
    }
}

/**
 * Send webhook notification
 */
async function sendWebhook(jobId, status, data = {}) {
    if (!config.webhookUrl) return;

    try {
        await axios.post(config.webhookUrl, {
            jobId,
            status,
            timestamp: new Date().toISOString(),
            ...data,
        }, {
            timeout: 5000,
            headers: { 'Content-Type': 'application/json' },
        });
        logger.debug(`Webhook sent for job ${jobId}`);
    } catch (e) {
        logger.warn(`Webhook failed for job ${jobId}:`, e.message);
    }
}

/**
 * Get queue statistics
 */
async function getQueueStats() {
    const activeQueues = queues || [];

    const stats = {
        queues: [],
        totals: {
            waiting: 0,
            active: 0,
            completed: 0,
            failed: 0,
            delayed: 0,
        },
    };

    for (const queue of activeQueues) {
        try {
            const counts = await queue.getJobCounts();
            stats.queues.push({
                name: queue.name,
                ...counts,
            });

            stats.totals.waiting += counts.waiting || 0;
            stats.totals.active += counts.active || 0;
            stats.totals.completed += counts.completed || 0;
            stats.totals.failed += counts.failed || 0;
            stats.totals.delayed += counts.delayed || 0;
        } catch (e) {
            logger.warn(`Error getting stats for queue ${queue.name}:`, e.message);
        }
    }

    return stats;
}

/**
 * Pause all queues
 */
async function pauseAll() {
    const activeQueues = queues || [];
    for (const queue of activeQueues) {
        await queue.pause();
    }
    logger.info('All queues paused');
}

/**
 * Resume all queues
 */
async function resumeAll() {
    const activeQueues = queues || [];
    for (const queue of activeQueues) {
        await queue.resume();
    }
    logger.info('All queues resumed');
}

/**
 * Close all queues (cleanup)
 */
async function closeAll() {
    const activeQueues = queues || [];
    for (const queue of activeQueues) {
        try {
            await queue.close();
        } catch (e) {
            logger.warn(`Error closing queue:`, e.message);
        }
    }
    logger.info('All queues closed');
}

// Graceful shutdown handlers
process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down workers...');
    await closeAll();
    await instagramService.cleanup();
});

process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down workers...');
    await closeAll();
    await instagramService.cleanup();
});

module.exports = {
    initializeQueues,
    addJob,
    getQueueStats,
    pauseAll,
    resumeAll,
    closeAll,
};
