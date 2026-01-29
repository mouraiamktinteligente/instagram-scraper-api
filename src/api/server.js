/**
 * Express API Server
 * REST API for Instagram comment scraping
 */

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');
const { validatePostUrl, extractPostId } = require('../utils/helpers');
const proxyService = require('../services/proxy.service');
const accountPool = require('../services/accountPool.service');
const worker = require('../workers/scraper.worker');

// Initialize Express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        logger.api(`${req.method} ${req.path}`, {
            status: res.statusCode,
            duration: `${duration}ms`,
        });
    });
    next();
});

// Supabase client
const supabase = createClient(config.supabase.url, config.supabase.key);

// ============================================
// ROUTES
// ============================================

/**
 * Health check endpoint
 * GET /api/health
 */
app.get('/api/health', async (req, res) => {
    try {
        let queueStats = { queues: [], totals: { waiting: 0, active: 0, completed: 0, failed: 0 } };

        try {
            queueStats = await worker.getQueueStats();
        } catch (e) {
            logger.warn('Queue stats not available:', e.message);
        }

        const proxyStats = proxyService.getStats();
        const accountStats = accountPool.getStatus();

        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            environment: config.env,
            workers: {
                queues: queueStats.queues.length,
                ...queueStats.totals,
            },
            proxies: proxyStats,
            accounts: {
                total: accountStats.total,
                active: accountStats.active,
                banned: accountStats.banned,
                withSession: accountStats.withSession
            }
        });
    } catch (error) {
        logger.error('Health check error:', error);
        res.status(500).json({
            status: 'error',
            error: error.message,
        });
    }
});

/**
 * Create a new scrape job
 * POST /api/scrape
 * Body: {
 *   postUrl: "https://instagram.com/p/ABC123",
 *   maxComments: 100 (optional),
 *   mode: "public" | "authenticated" | "auto" (optional, default: "auto")
 * }
 *
 * Mode options:
 * - "public": Extract only public comments (no login needed, zero account ban risk)
 * - "authenticated": Always use account login (more comments, but account ban risk)
 * - "auto": Try public first, fall back to authenticated if needed (default)
 */
app.post('/api/scrape', async (req, res) => {
    try {
        const { postUrl, maxComments, mode = 'auto' } = req.body;

        // Validate input
        if (!postUrl) {
            return res.status(400).json({
                error: 'Missing required field: postUrl',
            });
        }

        if (!validatePostUrl(postUrl)) {
            return res.status(400).json({
                error: 'Invalid Instagram post URL',
                hint: 'URL should be like: https://www.instagram.com/p/ABC123/',
            });
        }

        const postId = extractPostId(postUrl);

        // Validate maxComments if provided
        const commentLimit = maxComments ? Math.max(1, parseInt(maxComments)) : null;

        // Validate mode parameter
        const validModes = ['public', 'authenticated', 'auto'];
        const scrapeMode = validModes.includes(mode) ? mode : 'auto';

        // Create job in database
        const { data: jobData, error: jobError } = await supabase
            .from('scrape_jobs')
            .insert({
                post_url: postUrl,
                post_id: postId,
                status: 'pending',
                max_comments: commentLimit,  // Store limit in job
            })
            .select()
            .single();

        if (jobError) {
            logger.error('Error creating job in database:', jobError);
            return res.status(500).json({
                error: 'Failed to create job',
                details: jobError.message,
            });
        }

        // Add job to queue with optional maxComments and mode
        const queueResult = await worker.addJob(postUrl, jobData.id, commentLimit, scrapeMode);

        logger.api('Job created', {
            jobId: jobData.id,
            postUrl,
            postId,
            maxComments: commentLimit,
            mode: scrapeMode,
        });

        res.status(201).json({
            jobId: jobData.id,
            status: 'pending',
            postUrl,
            postId,
            maxComments: commentLimit,
            mode: scrapeMode,
            queue: queueResult.queueName,
            createdAt: jobData.created_at,
        });

    } catch (error) {
        logger.error('Error in POST /api/scrape:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message,
        });
    }
});

/**
 * Get job status
 * GET /api/job/:jobId
 */
app.get('/api/job/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;

        if (!jobId) {
            return res.status(400).json({
                error: 'Missing job ID',
            });
        }

        // Fetch job from database
        const { data: job, error } = await supabase
            .from('scrape_jobs')
            .select('*')
            .eq('id', jobId)
            .single();

        if (error || !job) {
            return res.status(404).json({
                error: 'Job not found',
                jobId,
            });
        }

        res.json({
            jobId: job.id,
            postUrl: job.post_url,
            postId: job.post_id,
            status: job.status,
            commentsCount: job.comments_count || 0,
            createdAt: job.created_at,
            startedAt: job.started_at,
            completedAt: job.completed_at,
            error: job.error,
            result: job.result,
        });

    } catch (error) {
        logger.error('Error in GET /api/job/:jobId:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message,
        });
    }
});

/**
 * Get comments for a post
 * GET /api/comments/:postId
 */
app.get('/api/comments/:postId', async (req, res) => {
    try {
        const { postId } = req.params;
        const { limit = 100, offset = 0 } = req.query;

        if (!postId) {
            return res.status(400).json({
                error: 'Missing post ID',
            });
        }

        // Fetch comments from database
        const { data: comments, error, count } = await supabase
            .from('instagram_comments')
            .select('*', { count: 'exact' })
            .eq('post_id', postId)
            .order('created_at', { ascending: false })
            .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

        if (error) {
            logger.error('Error fetching comments:', error);
            return res.status(500).json({
                error: 'Failed to fetch comments',
                details: error.message,
            });
        }

        res.json({
            postId,
            total: count,
            limit: parseInt(limit),
            offset: parseInt(offset),
            comments: comments || [],
        });

    } catch (error) {
        logger.error('Error in GET /api/comments/:postId:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message,
        });
    }
});

/**
 * Get statistics
 * GET /api/stats
 */
app.get('/api/stats', async (req, res) => {
    try {
        // Get queue stats
        const queueStats = await worker.getQueueStats();
        const proxyStats = proxyService.getStats();

        // Get job counts from database
        const { data: jobStats, error: jobError } = await supabase
            .rpc('get_job_stats');

        // Fallback if RPC doesn't exist
        let jobCounts = {
            total: 0,
            pending: 0,
            processing: 0,
            completed: 0,
            failed: 0,
        };

        if (!jobError && jobStats) {
            jobCounts = jobStats;
        } else {
            // Manual count
            const { count: total } = await supabase
                .from('scrape_jobs')
                .select('*', { count: 'exact', head: true });

            const { count: completed } = await supabase
                .from('scrape_jobs')
                .select('*', { count: 'exact', head: true })
                .eq('status', 'completed');

            const { count: failed } = await supabase
                .from('scrape_jobs')
                .select('*', { count: 'exact', head: true })
                .eq('status', 'failed');

            jobCounts = {
                total: total || 0,
                completed: completed || 0,
                failed: failed || 0,
                pending: (total || 0) - (completed || 0) - (failed || 0),
            };
        }

        // Get total comments count
        const { count: totalComments } = await supabase
            .from('instagram_comments')
            .select('*', { count: 'exact', head: true });

        res.json({
            timestamp: new Date().toISOString(),
            jobs: jobCounts,
            queue: queueStats.totals,
            proxies: proxyStats,
            comments: {
                total: totalComments || 0,
            },
        });

    } catch (error) {
        logger.error('Error in GET /api/stats:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message,
        });
    }
});

/**
 * List recent jobs
 * GET /api/jobs
 */
app.get('/api/jobs', async (req, res) => {
    try {
        const { limit = 20, status } = req.query;

        let query = supabase
            .from('scrape_jobs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(parseInt(limit));

        if (status) {
            query = query.eq('status', status);
        }

        const { data: jobs, error } = await query;

        if (error) {
            logger.error('Error fetching jobs:', error);
            return res.status(500).json({
                error: 'Failed to fetch jobs',
                details: error.message,
            });
        }

        res.json({
            jobs: jobs || [],
            count: jobs?.length || 0,
        });

    } catch (error) {
        logger.error('Error in GET /api/jobs:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message,
        });
    }
});

/**
 * Pause all queues (admin)
 * POST /api/admin/pause
 */
app.post('/api/admin/pause', async (req, res) => {
    try {
        await worker.pauseAll();
        res.json({ message: 'All queues paused' });
    } catch (error) {
        logger.error('Error pausing queues:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Resume all queues (admin)
 * POST /api/admin/resume
 */
app.post('/api/admin/resume', async (req, res) => {
    try {
        await worker.resumeAll();
        res.json({ message: 'All queues resumed' });
    } catch (error) {
        logger.error('Error resuming queues:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Reset proxy stats (admin)
 * POST /api/admin/proxies/reset
 */
app.post('/api/admin/proxies/reset', (req, res) => {
    proxyService.resetAllProxies();
    res.json({
        message: 'Proxy stats reset',
        stats: proxyService.getStats(),
    });
});

/**
 * Get account pool status (admin)
 * GET /api/admin/accounts
 */
app.get('/api/admin/accounts', (req, res) => {
    const status = accountPool.getStatus();
    res.json(status);
});

/**
 * Reset a banned account (admin)
 * POST /api/admin/accounts/:username/reset
 */
app.post('/api/admin/accounts/:username/reset', (req, res) => {
    const { username } = req.params;
    accountPool.resetAccount(username);
    res.json({
        message: `Account ${username} reset to active`,
        status: accountPool.getStatus()
    });
});

// ============================================
// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Not found',
        path: req.path,
    });
});

// Error handler
app.use((err, req, res, next) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: config.isDevelopment ? err.message : 'Something went wrong',
    });
});

// ============================================
// SERVER STARTUP
// ============================================

const PORT = config.port;

const server = app.listen(PORT, () => {
    logger.info(`API server started on port ${PORT}`);
    logger.info(`Environment: ${config.env}`);
    logger.info(`Proxies configured: ${proxyService.getProxyCount()}`);

    // Initialize workers after server is running (async for database loading)
    setTimeout(async () => {
        try {
            await worker.initializeQueues();
            logger.info('Workers initialized successfully');
        } catch (e) {
            logger.error('Error initializing workers:', e.message);
        }
    }, 2000);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down server...');
    server.close(async () => {
        await worker.closeAll();
        logger.info('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down server...');
    server.close(async () => {
        await worker.closeAll();
        logger.info('Server closed');
        process.exit(0);
    });
});

module.exports = app;
