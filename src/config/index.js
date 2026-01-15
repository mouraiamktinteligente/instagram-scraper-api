/**
 * Centralized Configuration
 * Loads and validates all environment variables
 */

require('dotenv').config();

/**
 * Parse proxies from environment variable
 * @returns {Array} Array of proxy configurations
 */
function parseProxies() {
  try {
    const proxiesJson = process.env.PROXIES || '[]';
    const proxies = JSON.parse(proxiesJson);
    
    if (!Array.isArray(proxies)) {
      throw new Error('PROXIES must be a JSON array');
    }
    
    return proxies.map((proxy, index) => {
      if (!proxy.server || !proxy.username || !proxy.password) {
        throw new Error(`Proxy at index ${index} is missing required fields (server, username, password)`);
      }
      return {
        server: `http://${proxy.server}`,
        username: proxy.username,
        password: proxy.password
      };
    });
  } catch (error) {
    console.error('Error parsing PROXIES:', error.message);
    return [];
  }
}

const config = {
  // Environment
  env: process.env.NODE_ENV || 'development',
  isDevelopment: process.env.NODE_ENV === 'development',
  isProduction: process.env.NODE_ENV === 'production',

  // API Server
  port: parseInt(process.env.PORT, 10) || 3000,

  // Supabase
  supabase: {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_KEY,
  },

  // Redis (Bull Queue)
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
  },

  // Proxies
  proxies: parseProxies(),

  // Rate Limiting
  rateLimit: {
    requestsPerMinute: parseInt(process.env.REQUESTS_PER_MINUTE, 10) || 30,
  },

  // Webhook (optional - for n8n notifications)
  webhookUrl: process.env.WEBHOOK_URL || null,

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',

  // CRON
  docIdCronSchedule: process.env.DOCID_CRON_SCHEDULE || '0 3 * * *',

  // Scraping settings
  scraping: {
    // Delay between requests (ms)
    minDelay: 2000,
    maxDelay: 5000,
    // Maximum scroll iterations per post
    maxScrolls: 50,
    // Timeout for page load (ms)
    pageTimeout: 60000,
    // Number of retry attempts
    maxRetries: 3,
  },

  // Bull Queue settings
  queue: {
    // Maximum concurrent jobs per queue
    concurrency: 1,
    // Retry settings
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
  },
};

/**
 * Validate required configuration
 * @throws {Error} If required config is missing
 */
function validateConfig() {
  const required = [
    { key: 'supabase.url', value: config.supabase.url },
    { key: 'supabase.key', value: config.supabase.key },
  ];

  const missing = required.filter(item => !item.value);

  if (missing.length > 0) {
    const missingKeys = missing.map(item => item.key).join(', ');
    console.warn(`Warning: Missing required configuration: ${missingKeys}`);
  }

  if (config.proxies.length === 0) {
    console.warn('Warning: No proxies configured. Scraping may fail.');
  }
}

// Validate on module load
validateConfig();

module.exports = config;
