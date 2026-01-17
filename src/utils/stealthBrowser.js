/**
 * Stealth Browser Module
 * Configures Playwright with anti-detection measures
 * Used by both warming and scraping systems
 * 
 * NOTE: Firefox is used as primary browser because Chromium had issues
 * with Instagram login in this environment. Stealth techniques are applied
 * manually via addInitScript since stealth plugin has limited Firefox support.
 * 
 * Features:
 * - Firefox with manual stealth techniques
 * - WebDriver property masking
 * - Realistic browser fingerprinting
 * - Human-like context settings
 */

const { firefox, chromium } = require('playwright');
const logger = require('./logger');

// Configuration: Use Firefox as default (Chromium had login issues)
const DEFAULT_BROWSER = 'firefox';

/**
 * Random viewport sizes that look realistic
 */
const REALISTIC_VIEWPORTS = [
    { width: 1920, height: 1080 },  // Full HD
    { width: 1536, height: 864 },   // Common laptop
    { width: 1440, height: 900 },   // MacBook
    { width: 1366, height: 768 },   // Common laptop
    { width: 1280, height: 720 },   // HD
    { width: 1280, height: 800 },   // MacBook Air
];

/**
 * Mobile viewports for mobile user agents
 */
const MOBILE_VIEWPORTS = [
    { width: 390, height: 844 },    // iPhone 14
    { width: 393, height: 873 },    // Pixel 7
    { width: 428, height: 926 },    // iPhone 14 Plus
    { width: 360, height: 780 },    // Samsung Galaxy
    { width: 375, height: 812 },    // iPhone X/11/12
];

/**
 * User agents with matching viewport context
 */
const USER_AGENT_CONFIGS = [
    // Desktop Chrome
    {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        isMobile: false,
        platform: 'Win32',
        locale: 'en-US'
    },
    {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        viewport: { width: 1440, height: 900 },
        isMobile: false,
        platform: 'MacIntel',
        locale: 'en-US'
    },
    // Desktop Safari
    {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
        viewport: { width: 1440, height: 900 },
        isMobile: false,
        platform: 'MacIntel',
        locale: 'en-US'
    },
    // Mobile iOS
    {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
        viewport: { width: 390, height: 844 },
        isMobile: true,
        platform: 'iPhone',
        locale: 'pt-BR'
    },
    // Mobile Android
    {
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36',
        viewport: { width: 393, height: 873 },
        isMobile: true,
        platform: 'Linux armv81',
        locale: 'pt-BR'
    },
    // Brazilian Desktop
    {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        isMobile: false,
        platform: 'Win32',
        locale: 'pt-BR'
    }
];

/**
 * Get a random user agent configuration
 * @param {boolean} preferMobile - Prefer mobile user agents
 * @returns {Object} User agent config
 */
function getRandomUserAgentConfig(preferMobile = false) {
    let pool = USER_AGENT_CONFIGS;

    if (preferMobile) {
        pool = USER_AGENT_CONFIGS.filter(c => c.isMobile);
    }

    // 40% chance to use mobile by default (Instagram is mobile-first)
    if (!preferMobile && Math.random() < 0.4) {
        pool = USER_AGENT_CONFIGS.filter(c => c.isMobile);
    }

    if (pool.length === 0) {
        pool = USER_AGENT_CONFIGS;
    }

    return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Launch a stealth browser
 * @param {Object} options - Launch options
 * @returns {Promise<Browser>}
 */
async function launchStealthBrowser(options = {}) {
    const {
        proxy = null,
        headless = true,
        browserType = DEFAULT_BROWSER  // Uses Firefox by default (Chromium had login issues)
    } = options;

    const launchOptions = {
        headless,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--hide-scrollbars',
            '--mute-audio',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-breakpad',
            '--disable-component-extensions-with-background-pages',
            '--disable-component-update',
            '--disable-default-apps',
            '--disable-extensions',
            '--disable-hang-monitor',
            '--disable-ipc-flooding-protection',
            '--disable-popup-blocking',
            '--disable-prompt-on-repost',
            '--disable-renderer-backgrounding',
            '--disable-sync',
            '--enable-features=NetworkService,NetworkServiceInProcess',
            '--force-color-profile=srgb',
            '--metrics-recording-only',
        ]
    };

    if (proxy) {
        launchOptions.proxy = {
            server: `http://${proxy.host}:${proxy.port}`,
            username: proxy.username,
            password: proxy.password
        };
        logger.debug(`[STEALTH] Using proxy: ${proxy.host}:${proxy.port}`);
    }

    const browser = browserType === 'firefox'
        ? await firefox.launch(launchOptions)
        : await chromium.launch(launchOptions);

    logger.info(`[STEALTH] Launched ${browserType} browser with stealth mode`);
    return browser;
}

/**
 * Create a stealth browser context with realistic settings
 * @param {Browser} browser - Playwright browser
 * @param {Object} options - Context options
 * @returns {Promise<BrowserContext>}
 */
async function createStealthContext(browser, options = {}) {
    const {
        preferMobile = false,
        existingCookies = null
    } = options;

    const config = getRandomUserAgentConfig(preferMobile);

    // Add small random variation to viewport
    const viewport = {
        width: config.viewport.width + Math.floor(Math.random() * 20) - 10,
        height: config.viewport.height + Math.floor(Math.random() * 20) - 10
    };

    const contextOptions = {
        userAgent: config.userAgent,
        viewport,
        locale: config.locale,
        timezoneId: 'America/Sao_Paulo',
        deviceScaleFactor: config.isMobile ? 3 : 1,
        hasTouch: config.isMobile,
        isMobile: config.isMobile,
        permissions: ['geolocation'],

        // Realistic color scheme
        colorScheme: Math.random() > 0.7 ? 'dark' : 'light',

        // Disable obvious automation markers
        javaScriptEnabled: true,

        // Extra HTTP headers to look more legitimate
        extraHTTPHeaders: {
            'Accept-Language': `${config.locale},en;q=0.9`,
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
        }
    };

    const context = await browser.newContext(contextOptions);

    // Add script to mask automation markers
    await context.addInitScript(() => {
        // Hide webdriver
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
        });

        // Mock plugins
        Object.defineProperty(navigator, 'plugins', {
            get: () => [
                { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
                { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
                { name: 'Native Client', filename: 'internal-nacl-plugin' },
            ],
        });

        // Mock languages
        Object.defineProperty(navigator, 'languages', {
            get: () => ['pt-BR', 'pt', 'en-US', 'en'],
        });

        // Mock platform (if needed)
        // Already set via context options

        // Mock hardware concurrency
        Object.defineProperty(navigator, 'hardwareConcurrency', {
            get: () => 4 + Math.floor(Math.random() * 4), // 4-8 cores
        });

        // Mock device memory
        Object.defineProperty(navigator, 'deviceMemory', {
            get: () => 8, // 8GB RAM
        });

        // Mock max touch points for mobile
        if (navigator.userAgent.includes('Mobile')) {
            Object.defineProperty(navigator, 'maxTouchPoints', {
                get: () => 5,
            });
        }

        // Fix Chrome app
        window.chrome = {
            runtime: {},
        };

        // Fix permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => (
            parameters.name === 'notifications'
                ? Promise.resolve({ state: Notification.permission })
                : originalQuery(parameters)
        );
    });

    // Load existing cookies if provided
    if (existingCookies && Array.isArray(existingCookies)) {
        await context.addCookies(existingCookies);
        logger.debug('[STEALTH] Loaded existing session cookies');
    }

    logger.info(`[STEALTH] Context created: ${config.isMobile ? 'Mobile' : 'Desktop'} / ${config.locale}`);
    return context;
}

/**
 * Get browser and context in one call (convenience method)
 * @param {Object} options - Options
 * @returns {Promise<{browser, context}>}
 */
async function getStealthBrowserAndContext(options = {}) {
    const browser = await launchStealthBrowser(options);
    const context = await createStealthContext(browser, options);
    return { browser, context };
}

module.exports = {
    launchStealthBrowser,
    createStealthContext,
    getStealthBrowserAndContext,
    getRandomUserAgentConfig,
    USER_AGENT_CONFIGS,
    REALISTIC_VIEWPORTS,
    MOBILE_VIEWPORTS,

    // Re-export playwright-extra instances for direct use
    chromium,
    firefox
};
