/**
 * Warming Worker
 * Executes warming sessions for Instagram accounts
 * Simulates human-like navigation behavior using Playwright with Stealth
 */

const { createClient } = require('@supabase/supabase-js');
const speakeasy = require('speakeasy');
const config = require('../config');
const logger = require('../utils/logger');
const warmingPool = require('../services/warmingPool.service');
const {
    WarmingBehaviorService,
    ACTION_TYPES,
    CATEGORY_ACCOUNTS
} = require('../services/warmingBehavior.service');
const {
    randomDelay,
    sleep,
    humanMouseMove,
    humanClickAdvanced,
    humanScrollAdvanced,
    humanTypeAdvanced,
    maybeHesitate
} = require('../utils/helpers');
const {
    launchStealthBrowser,
    createStealthContext
} = require('../utils/stealthBrowser');

// Time constraints (Brasília timezone)
const WARMING_START_HOUR = 8;  // 08:00
const WARMING_END_HOUR = 23;   // 23:00

const behaviorService = new WarmingBehaviorService();

class WarmingWorker {
    constructor() {
        this.isRunning = false;
        this.currentAccount = null;
    }

    /**
     * Check if current time is within allowed warming hours
     * @returns {boolean}
     */
    isWithinAllowedHours() {
        const now = new Date();
        // Get hour in Brasília (UTC-3)
        const brasiliaOffset = -3;
        const utcHour = now.getUTCHours();
        const brasiliaHour = (utcHour + brasiliaOffset + 24) % 24;

        return brasiliaHour >= WARMING_START_HOUR && brasiliaHour < WARMING_END_HOUR;
    }

    /**
     * Launch browser with stealth settings
     * @param {Object} proxy - Proxy configuration
     * @returns {Promise<Browser>}
     */
    async launchBrowser(proxy = null) {
        return await launchStealthBrowser({
            proxy,
            headless: true,
            browserType: 'firefox'  // Firefox works better with Instagram login
        });
    }

    /**
     * Create browser context with stealth and human-like settings
     * @param {Browser} browser
     * @param {Object} account - Account with session_data
     * @returns {Promise<BrowserContext>}
     */
    async createBrowserContext(browser, account = null) {
        return await createStealthContext(browser, {
            preferMobile: Math.random() < 0.4,  // 40% mobile
            existingCookies: account?.session_data || null
        });
    }

    /**
     * Perform login for a warming account
     * @param {BrowserContext} context
     * @param {Object} account
     * @returns {Promise<boolean>}
     */
    async performLogin(context, account) {
        const page = await context.newPage();

        try {
            logger.info(`[WARMING] Starting login for ${account.username}`);

            // Check for existing session
            if (account.session_data && Array.isArray(account.session_data)) {
                await context.addCookies(account.session_data);
                logger.debug(`[WARMING] Loaded existing session for ${account.username}`);

                // Verify session
                await page.goto('https://www.instagram.com/', {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000
                });
                await randomDelay(3000, 5000);

                const isLoggedIn = await this.checkLoggedIn(page);
                if (isLoggedIn) {
                    logger.info(`[WARMING] Session valid for ${account.username}`);
                    await page.close();
                    return true;
                }
                logger.warn(`[WARMING] Session expired, re-logging...`);
            }

            // Fresh login
            await page.goto('https://www.instagram.com/accounts/login/', {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });

            await randomDelay(3000, 5000);

            // Handle cookie consent
            await this.handleCookieConsent(page);

            // Fill username
            const usernameInput = await page.waitForSelector('input[name="username"]', { timeout: 15000 });
            await usernameInput.fill(account.username);
            await randomDelay(500, 1000);

            // Fill password
            const passwordInput = await page.$('input[name="password"]');
            if (passwordInput) {
                await passwordInput.fill(account.password);
            }
            await randomDelay(500, 1000);

            // Click login
            await page.click('button[type="submit"]');
            await randomDelay(5000, 8000);

            // Check for 2FA
            const currentUrl = page.url();
            if (currentUrl.includes('two_factor') || currentUrl.includes('challenge')) {
                if (account.totp_secret) {
                    const success = await this.handle2FA(page, account);
                    if (!success) {
                        await page.close();
                        return false;
                    }
                } else {
                    logger.error(`[WARMING] 2FA required but no TOTP secret configured`);
                    await page.close();
                    return false;
                }
            }

            // Handle post-login popups
            await this.handlePostLoginPopups(page);

            // Verify login
            const isLoggedIn = await this.checkLoggedIn(page);

            if (isLoggedIn) {
                // Save session
                const cookies = await context.cookies();
                await warmingPool.saveSession(account.id, cookies);
                logger.info(`[WARMING] Login successful for ${account.username}`);
            }

            await page.close();
            return isLoggedIn;

        } catch (error) {
            logger.error(`[WARMING] Login error: ${error.message}`);
            try { await page.close(); } catch (e) { /* ignore */ }
            return false;
        }
    }

    /**
     * Handle cookie consent dialog
     */
    async handleCookieConsent(page) {
        try {
            await randomDelay(1000, 2000);

            const cookieSelectors = [
                'button:has-text("Allow all cookies")',
                'button:has-text("Permitir todos os cookies")',
                'button:has-text("Accept All")',
                'button:has-text("Aceitar tudo")'
            ];

            for (const selector of cookieSelectors) {
                const btn = await page.$(selector);
                if (btn && await btn.isVisible()) {
                    await btn.click();
                    await randomDelay(1500, 2500);
                    break;
                }
            }
        } catch (e) {
            logger.debug('[WARMING] No cookie consent found');
        }
    }

    /**
     * Handle 2FA authentication
     * Uses 2fa.live API for TOTP generation (same as instagram.service.js)
     */
    async handle2FA(page, account) {
        try {
            logger.info(`[WARMING] 🔐 Handling 2FA for ${account.username}`);

            // Sanitize TOTP secret
            const sanitizedSecret = account.totp_secret.replace(/\s+/g, '').toUpperCase();
            logger.info(`[WARMING] 🔑 Secret length: ${sanitizedSecret.length} chars`);

            let totpCode = null;

            // ⭐ PRIMARY: Use 2fa.live API for TOTP generation
            try {
                logger.info(`[WARMING] 🌐 Fetching TOTP from 2fa.live API...`);

                const https = require('https');
                const fetch2faCode = () => {
                    return new Promise((resolve, reject) => {
                        const req = https.get(`https://2fa.live/tok/${sanitizedSecret}`, { timeout: 5000 }, (res) => {
                            let data = '';
                            res.on('data', chunk => data += chunk);
                            res.on('end', () => {
                                try {
                                    const json = JSON.parse(data);
                                    resolve(json.token);
                                } catch (e) {
                                    reject(new Error('Invalid JSON response'));
                                }
                            });
                        });
                        req.on('error', reject);
                        req.on('timeout', () => {
                            req.destroy();
                            reject(new Error('Request timeout'));
                        });
                    });
                };

                totpCode = await fetch2faCode();
                logger.info(`[WARMING] ✅ 2fa.live returned code: ${totpCode}`);

            } catch (apiError) {
                logger.warn(`[WARMING] ⚠️ 2fa.live API failed: ${apiError.message}`);
                logger.info(`[WARMING] 🔄 Falling back to local speakeasy generation...`);

                // FALLBACK: Use local speakeasy if API fails
                totpCode = speakeasy.totp({
                    secret: sanitizedSecret,
                    encoding: 'base32',
                    step: 30
                });
                logger.info(`[WARMING] ✅ Speakeasy fallback code: ${totpCode}`);
            }

            await randomDelay(2000, 3000);

            // Find and fill 2FA input
            const codeInputSelectors = [
                'input[name="verificationCode"]',
                'input[name="security_code"]',
                'input[type="text"][maxlength="6"]',
                'input[type="number"]'
            ];

            let codeInput = null;
            for (const selector of codeInputSelectors) {
                codeInput = await page.$(selector);
                if (codeInput && await codeInput.isVisible()) {
                    logger.info(`[WARMING] ✅ Found input: ${selector}`);
                    break;
                }
            }

            if (!codeInput) {
                logger.error('[WARMING] ❌ 2FA input not found');
                return false;
            }

            // Fill code with human-like typing
            await codeInput.fill('');
            await codeInput.type(totpCode, { delay: 150 });
            logger.info(`[WARMING] 📝 Typed code: ${totpCode}`);
            await randomDelay(1000, 1500);

            // Find and click submit button
            const submitSelectors = [
                'button:has-text("Confirmar")',
                'button:has-text("Confirm")',
                'button[type="submit"]'
            ];

            let submitBtn = null;
            for (const selector of submitSelectors) {
                submitBtn = await page.$(selector);
                if (submitBtn && await submitBtn.isVisible()) {
                    logger.info(`[WARMING] ✅ Found submit button: ${selector}`);
                    break;
                }
            }

            if (submitBtn) {
                await submitBtn.click();
                logger.info('[WARMING] 🖱️ Submit button clicked');
            } else {
                await page.keyboard.press('Enter');
                logger.info('[WARMING] ⌨️ Enter key pressed');
            }

            // Wait for navigation/response
            await randomDelay(5000, 7000);

            // Check if still on 2FA page
            const url = page.url();
            const success = !url.includes('two_factor') && !url.includes('challenge');

            if (success) {
                logger.info(`[WARMING] ✅ 2FA passed! New URL: ${url}`);
            } else {
                logger.error(`[WARMING] ❌ Still on 2FA page: ${url}`);
            }

            return success;

        } catch (error) {
            logger.error(`[WARMING] ❌ 2FA error: ${error.message}`);
            return false;
        }
    }

    /**
     * Handle post-login popups
     * Updated with Portuguese selectors (same as instagram.service.js)
     */
    async handlePostLoginPopups(page) {
        await randomDelay(2000, 3000);

        // Check page text for popup indicators
        try {
            const pageText = await page.evaluate(() => document.body?.innerText || '');

            // Check for "Save Login Info" popup
            const hasSaveInfoPopup =
                pageText.includes('Salvar suas informações de login') ||
                pageText.includes('Save your login info') ||
                pageText.includes('Salvar informações');

            if (hasSaveInfoPopup) {
                logger.info('[WARMING] ✅ Detected "Save Login Info" popup');
            }
        } catch (e) { /* ignore */ }

        // Dismiss "Save login info" popup (PT and EN)
        const saveInfoSelectors = [
            'button:has-text("Salvar informações")',
            'button:has-text("Salvar info")',
            'button:has-text("Save Info")',
            'button:has-text("Agora não")',
            'button:has-text("Not Now")',
            'div[role="button"]:has-text("Agora não")',
            'div[role="button"]:has-text("Not Now")'
        ];

        for (const selector of saveInfoSelectors) {
            try {
                const btn = await page.$(selector);
                if (btn && await btn.isVisible()) {
                    await btn.click();
                    logger.info(`[WARMING] ✅ Clicked popup button: ${selector}`);
                    await randomDelay(1500, 2500);
                    break;
                }
            } catch (e) { /* try next */ }
        }

        // Dismiss notifications popup
        await randomDelay(1000, 2000);
        const notificationSelectors = [
            'button:has-text("Agora não")',
            'button:has-text("Not Now")',
            'button:has-text("Ativar")',
            'button:has-text("Turn On")'
        ];

        for (const selector of notificationSelectors) {
            try {
                const btn = await page.$(selector);
                if (btn && await btn.isVisible()) {
                    // Click "Not Now" / "Agora não", not "Turn On"
                    if (!selector.includes('Ativar') && !selector.includes('Turn On')) {
                        await btn.click();
                        logger.info(`[WARMING] ✅ Dismissed notification popup: ${selector}`);
                        await randomDelay(1000, 2000);
                        break;
                    }
                }
            } catch (e) { /* try next */ }
        }
    }

    /**
     * Check if logged in
     */
    async checkLoggedIn(page) {
        try {
            const indicators = [
                'svg[aria-label="Home"]',
                'svg[aria-label="Início"]',
                'a[href="/direct/inbox/"]'
            ];

            for (const selector of indicators) {
                const el = await page.$(selector);
                if (el) return true;
            }

            return !page.url().includes('/accounts/login');
        } catch (e) {
            return false;
        }
    }

    /**
     * Execute a warming session
     * @param {Object} account - Account to warm
     * @returns {Promise<Object>} Session result
     */
    async executeWarmingSession(account) {
        if (!this.isWithinAllowedHours()) {
            logger.info('[WARMING] Outside allowed hours (08:00-23:00 Brasília)');
            return { success: false, reason: 'outside_hours' };
        }

        const startTime = Date.now();
        const actions = [];
        let browser = null;
        let context = null;

        try {
            this.isRunning = true;
            this.currentAccount = account.username;

            // Get proxy from account
            const proxy = account.warming_proxies || null;

            // Launch browser
            browser = await this.launchBrowser(proxy);
            context = await this.createBrowserContext(browser);

            // Login
            const loggedIn = await this.performLogin(context, account);
            if (!loggedIn) {
                await warmingPool.markAsFailed(account.id, 'Login failed');
                return { success: false, reason: 'login_failed' };
            }

            // Get random pattern
            const pattern = behaviorService.getRandomPattern();
            logger.info(`[WARMING] Executing pattern: ${pattern.name} for ${account.username}`);

            // Create main page
            const page = await context.newPage();
            await page.goto('https://www.instagram.com/', {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
            await randomDelay(3000, 5000);

            // Execute each action in the pattern
            for (const action of pattern.actions) {
                try {
                    const result = await this.executeAction(page, action);
                    actions.push({
                        type: action.type,
                        success: true,
                        details: result
                    });
                    await randomDelay(2000, 4000);
                } catch (error) {
                    logger.warn(`[WARMING] Action ${action.type} failed: ${error.message}`);
                    actions.push({
                        type: action.type,
                        success: false,
                        error: error.message
                    });
                }
            }

            const duration = Math.floor((Date.now() - startTime) / 1000);

            // Save updated session
            const cookies = await context.cookies();
            await warmingPool.saveSession(account.id, cookies);

            // Log session
            await warmingPool.logWarmingSession(
                account.id,
                pattern.name,
                actions,
                duration,
                true
            );

            logger.info(`[WARMING] Session completed for ${account.username}: ${actions.length} actions in ${duration}s`);

            return {
                success: true,
                pattern: pattern.name,
                actions: actions.length,
                duration
            };

        } catch (error) {
            logger.error(`[WARMING] Session error: ${error.message}`);

            await warmingPool.logWarmingSession(
                account.id,
                'unknown',
                actions,
                Math.floor((Date.now() - startTime) / 1000),
                false,
                error.message
            );

            return { success: false, reason: error.message };

        } finally {
            this.isRunning = false;
            this.currentAccount = null;

            if (context) try { await context.close(); } catch (e) { /* ignore */ }
            if (browser) try { await browser.close(); } catch (e) { /* ignore */ }
        }
    }

    /**
     * Execute a single action
     * @param {Page} page
     * @param {Object} action
     * @returns {Promise<Object>}
     */
    async executeAction(page, action) {
        switch (action.type) {
            case ACTION_TYPES.VISIT_HOME:
                return await this.visitHome(page, action.durationRange);

            case ACTION_TYPES.SCROLL_FEED:
                return await this.scrollFeed(page, action.scrollRange);

            case ACTION_TYPES.VISIT_EXPLORE:
                return await this.visitExplore(page, action.durationRange);

            case ACTION_TYPES.SEARCH_USER:
                const target = action.target === 'random_celebrity'
                    ? behaviorService.getRandomCelebrity()
                    : action.target === 'sports_celebrity'
                        ? behaviorService.getRandomCelebrity('sports')
                        : action.target === 'music_celebrity'
                            ? behaviorService.getRandomCelebrity('music')
                            : behaviorService.getRandomCelebrity();
                return await this.searchUser(page, target);

            case ACTION_TYPES.VISIT_PROFILE:
                return await this.visitProfile(page);

            case ACTION_TYPES.SCROLL_PROFILE:
                return await this.scrollProfile(page, action.scrollRange);

            case ACTION_TYPES.FOLLOW_USER:
                return await this.followUser(page);

            case ACTION_TYPES.LIKE_POST:
                return await this.likePosts(page, action.countRange);

            case ACTION_TYPES.COMMENT_POST:
                const comment = action.message === 'random'
                    ? behaviorService.getRandomComment()
                    : action.message;
                return await this.commentPost(page, comment);

            case ACTION_TYPES.VIEW_STORIES:
                return await this.viewStories(page, action.countRange);

            case ACTION_TYPES.WATCH_REEL:
                return await this.watchReel(page, action.durationRange);

            case ACTION_TYPES.VISIT_OWN_PROFILE:
                return await this.visitOwnProfile(page);

            case ACTION_TYPES.RANDOM_PAUSE:
                const pauseDuration = behaviorService.getRandomInRange(action.durationRange);
                await sleep(pauseDuration * 1000);
                return { paused: pauseDuration };

            default:
                logger.warn(`[WARMING] Unknown action type: ${action.type}`);
                return { skipped: true };
        }
    }

    /**
     * Visit home feed
     */
    async visitHome(page, durationRange) {
        await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
        const duration = behaviorService.getRandomInRange(durationRange);
        await sleep(duration * 1000);
        return { duration };
    }

    /**
     * Scroll feed
     */
    async scrollFeed(page, scrollRange) {
        const scrolls = behaviorService.getRandomInRange(scrollRange);
        for (let i = 0; i < scrolls; i++) {
            await humanScroll(page, 300 + Math.random() * 400);
            await randomDelay(1500, 3000);
        }
        return { scrolls };
    }

    /**
     * Visit explore page
     */
    async visitExplore(page, durationRange) {
        await page.goto('https://www.instagram.com/explore/', { waitUntil: 'domcontentloaded' });
        const duration = behaviorService.getRandomInRange(durationRange);
        await sleep(duration * 1000);
        return { duration };
    }

    /**
     * Search for a user
     */
    async searchUser(page, username) {
        try {
            // Click search icon
            const searchIcon = await page.$('svg[aria-label="Search"], svg[aria-label="Pesquisar"]');
            if (searchIcon) {
                await searchIcon.click();
                await randomDelay(1000, 2000);
            }

            // Type username
            const searchInput = await page.$('input[placeholder*="Search"], input[placeholder*="Pesquisar"]');
            if (searchInput) {
                await searchInput.fill(username);
                await randomDelay(1500, 2500);

                // Click first result
                const firstResult = await page.$(`a[href="/${username}/"]`);
                if (firstResult) {
                    await firstResult.click();
                    await randomDelay(2000, 3000);
                }
            }

            return { username };
        } catch (e) {
            // Fallback: direct navigation
            await page.goto(`https://www.instagram.com/${username}/`, { waitUntil: 'domcontentloaded' });
            await randomDelay(2000, 4000);
            return { username, fallback: true };
        }
    }

    /**
     * Visit current profile (after search)
     */
    async visitProfile(page) {
        await randomDelay(2000, 4000);
        return { visited: true };
    }

    /**
     * Scroll profile page
     */
    async scrollProfile(page, scrollRange) {
        const scrolls = behaviorService.getRandomInRange(scrollRange);
        for (let i = 0; i < scrolls; i++) {
            await humanScroll(page, 250 + Math.random() * 300);
            await randomDelay(1000, 2000);
        }
        return { scrolls };
    }

    /**
     * Follow current user
     */
    async followUser(page) {
        try {
            const followBtn = await page.$('button:has-text("Follow"), button:has-text("Seguir")');
            if (followBtn && await followBtn.isVisible()) {
                await followBtn.click();
                await randomDelay(1500, 2500);
                return { followed: true };
            }
            return { followed: false, reason: 'button_not_found' };
        } catch (e) {
            return { followed: false, error: e.message };
        }
    }

    /**
     * Like posts in feed or profile
     */
    async likePosts(page, countRange) {
        const count = behaviorService.getRandomInRange(countRange);
        let liked = 0;

        for (let i = 0; i < count; i++) {
            try {
                // Find like button (heart icon)
                const likeButtons = await page.$$('svg[aria-label="Like"], svg[aria-label="Curtir"]');
                if (likeButtons.length > liked) {
                    const parent = await likeButtons[liked].evaluateHandle(el => el.closest('button') || el.parentElement);
                    if (parent) {
                        await parent.click();
                        liked++;
                        await randomDelay(1000, 2000);
                    }
                }
            } catch (e) {
                logger.debug(`[WARMING] Like attempt ${i + 1} failed`);
            }
        }

        return { requested: count, liked };
    }

    /**
     * Comment on a post
     */
    async commentPost(page, comment) {
        try {
            // Find comment input
            const commentInputs = await page.$$('textarea[placeholder*="comment"], textarea[placeholder*="comentário"]');
            if (commentInputs.length > 0) {
                const input = commentInputs[0];
                await input.click();
                await randomDelay(500, 1000);
                await input.fill(comment);
                await randomDelay(500, 1000);

                // Submit
                const postBtn = await page.$('button:has-text("Post"), button:has-text("Publicar")');
                if (postBtn) {
                    await postBtn.click();
                    await randomDelay(1500, 2500);
                    return { commented: true, text: comment };
                }
            }
            return { commented: false, reason: 'input_not_found' };
        } catch (e) {
            return { commented: false, error: e.message };
        }
    }

    /**
     * View stories
     */
    async viewStories(page, countRange) {
        try {
            // Click on first story
            const storyButtons = await page.$$('canvas, img[alt*="Story"], button[aria-label*="Story"]');
            if (storyButtons.length === 0) {
                return { viewed: 0, reason: 'no_stories_found' };
            }

            await storyButtons[0].click();
            await randomDelay(2000, 3000);

            const count = behaviorService.getRandomInRange(countRange);
            let viewed = 0;

            for (let i = 0; i < count; i++) {
                await randomDelay(3000, 6000); // Watch story
                viewed++;

                // Click to next story
                try {
                    await page.click('button[aria-label*="Next"], button[aria-label*="Próximo"]');
                } catch (e) {
                    break; // No more stories
                }
            }

            // Close stories
            try {
                await page.keyboard.press('Escape');
            } catch (e) { /* ignore */ }

            return { viewed };
        } catch (e) {
            return { viewed: 0, error: e.message };
        }
    }

    /**
     * Watch reels
     */
    async watchReel(page, durationRange) {
        try {
            // Navigate to reels
            await page.goto('https://www.instagram.com/reels/', { waitUntil: 'domcontentloaded' });
            await randomDelay(2000, 3000);

            const duration = behaviorService.getRandomInRange(durationRange);
            await sleep(duration * 1000);

            return { duration };
        } catch (e) {
            return { watched: false, error: e.message };
        }
    }

    /**
     * Visit own profile
     */
    async visitOwnProfile(page) {
        try {
            const profileLink = await page.$('a[href*="/"][role="link"]:has(img)');
            if (profileLink) {
                await profileLink.click();
                await randomDelay(2000, 4000);
            }
            return { visited: true };
        } catch (e) {
            return { visited: false, error: e.message };
        }
    }

    /**
     * Get worker status
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            currentAccount: this.currentAccount,
            withinAllowedHours: this.isWithinAllowedHours()
        };
    }
}

module.exports = new WarmingWorker();
