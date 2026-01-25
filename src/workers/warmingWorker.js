/**
 * Warming Worker
 * Executes warming sessions for Instagram accounts
 * Simulates human-like navigation behavior using Playwright with Stealth
 */

const { createClient } = require('@supabase/supabase-js');
const speakeasy = require('speakeasy');
const config = require('../config');
const logger = require('../utils/logger');
// Initialize Supabase client
const supabase = createClient(config.supabase.url, config.supabase.key);
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
    humanScroll,         // Added missing simple scroll
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
        this.supabase = supabase;
    }

    /**
     * Upload debug screenshot to Supabase Storage
     * @param {Page} page 
     * @param {string} stepName 
     * @returns {Promise<string|null>} Public URL or null
     */
    async uploadDebugScreenshot(page, stepName) {
        try {
            const timestamp = Date.now();
            const screenshotBuffer = await page.screenshot({ fullPage: false });

            // Generate filename with step and timestamp
            const fileName = `debug/warming/${stepName}-${timestamp}.png`;

            const { data: uploadData, error: uploadError } = await this.supabase.storage
                .from('screenshot')
                .upload(fileName, screenshotBuffer, {
                    contentType: 'image/png',
                    upsert: true
                });

            if (uploadError) {
                logger.warn(`[WARMING:DEBUG] Screenshot upload error: ${uploadError.message}`);
                return null;
            }

            // Get public URL
            const { data: urlData } = this.supabase.storage
                .from('screenshot')
                .getPublicUrl(fileName);

            logger.info(`[WARMING:DEBUG] 📸 Screenshot [${stepName}]: ${urlData.publicUrl}`);
            return urlData.publicUrl;
        } catch (error) {
            logger.warn(`[WARMING:DEBUG] Screenshot capture failed: ${error.message}`);
            return null;
        }
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
     * ⭐ PORTED FROM instagram.service.js - Full robust login logic
     * @param {BrowserContext} context
     * @param {Object} account
     * @returns {Promise<boolean>}
     */
    async performLogin(context, account) {
        const page = await context.newPage();

        try {
            logger.info(`[WARMING] ========================================`);
            logger.info(`[WARMING] 🔐 Starting login for ${account.username}`);
            logger.info(`[WARMING] ========================================`);

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
                    logger.info(`[WARMING] ✅ Session valid for ${account.username}`);
                    await page.close();
                    return true;
                }
                logger.warn(`[WARMING] Session expired, re-logging...`);
            }

            // Step 1: Navigate to login page
            logger.info('[WARMING] Step 1: Navigating to login page...');
            await page.goto('https://www.instagram.com/accounts/login/', {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });

            // ⭐ CRITICAL: Wait for JavaScript to fully execute (Instagram is a React SPA)
            logger.info('[WARMING] Step 1: Waiting for JavaScript to render...');
            try {
                // Wait for any input or button to appear (React hydration)
                await page.waitForFunction(() => {
                    return document.querySelectorAll('input').length > 0 ||
                        document.querySelectorAll('button').length > 0 ||
                        document.body.innerText.length > 100;
                }, { timeout: 30000 });
                logger.info('[WARMING] Step 1: ✅ JavaScript rendered content');
            } catch (e) {
                logger.warn('[WARMING] Step 1: Timeout waiting for JS render, continuing...');
            }

            // Additional wait for full page load
            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
            logger.info('[WARMING] Step 1: ✅ Login page loaded');

            await randomDelay(3000, 5000);  // Longer delay to let React fully hydrate

            // Step 2: Handle cookie consent
            logger.info('[WARMING] Step 2: Handling cookie consent...');
            await this.handleCookieConsent(page);
            await randomDelay(2000, 3000); // Longer wait after cookie consent

            // Step 3: Wait for page to load and find username field
            logger.info('[WARMING] Step 3: Waiting for username field...');
            const usernameSelectors = [
                'input[name="username"]',
                'input[aria-label="Phone number, username, or email"]',
                'input[aria-label="Telefone, nome de usuário ou email"]',
                'input[type="text"]',
                'form input:first-of-type'
            ];

            let usernameInput = null;
            for (const selector of usernameSelectors) {
                try {
                    await page.waitForSelector(selector, { timeout: 5000 });
                    usernameInput = await page.$(selector);
                    if (usernameInput) {
                        logger.info(`[WARMING] Found username field: ${selector}`);
                        break;
                    }
                } catch (e) {
                    // Try next selector
                }
            }

            if (!usernameInput) {
                logger.error('[WARMING] ❌ Could not find username input field!');
                await this.uploadDebugScreenshot(page, 'error-no-username');
                await page.close();
                return false;
            }

            await usernameInput.fill(account.username);
            logger.info('[WARMING] Step 3: ✅ Username filled');
            await randomDelay(1000, 2500); // More human-like delay

            // Step 4: Fill password - try multiple selectors
            logger.info('[WARMING] Step 4: Filling password...');
            const passwordSelectors = [
                'input[name="password"]',
                'input[type="password"]',
                'input[aria-label*="password"]',
                'input[aria-label*="Senha"]',
            ];

            let passwordFilled = false;
            for (const selector of passwordSelectors) {
                try {
                    const pwdField = await page.$(selector);
                    if (pwdField) {
                        await pwdField.fill(account.password);
                        passwordFilled = true;
                        logger.info(`[WARMING] Step 4: ✅ Password filled using ${selector}`);
                        break;
                    }
                } catch (e) {
                    // Try next selector
                }
            }

            if (!passwordFilled) {
                logger.error('[WARMING] ❌ Could not find password field');
                await this.uploadDebugScreenshot(page, 'error-no-password');
                await page.close();
                return false;
            }

            await randomDelay(1500, 3000); // Longer delay after password (more human)

            // Step 5: Click login button - try multiple selectors
            logger.info('[WARMING] Step 5: Clicking login button...');
            const loginButtonSelectors = [
                'button[type="submit"]',
                'button:has-text("Log in")',
                'button:has-text("Log In")',
                'button:has-text("Entrar")',
                'div[role="button"]:has-text("Log in")',
                'div[role="button"]:has-text("Entrar")',
                'button._acan._acap._acas._aj1-._ap30',
                'form button',
            ];

            let loginClicked = false;
            for (const selector of loginButtonSelectors) {
                try {
                    const btn = await page.$(selector);
                    if (btn && await btn.isVisible()) {
                        await btn.click({ force: true });
                        loginClicked = true;
                        logger.info(`[WARMING] Step 5: ✅ Clicked login button: ${selector}`);
                        break;
                    }
                } catch (e) {
                    // Try next selector
                }
            }

            // ALWAYS try Enter key as redundancy (most reliable)
            logger.info('[WARMING] Step 5: Pressing Enter key as redundancy...');
            await page.keyboard.press('Enter');
            await randomDelay(1000, 1500);

            // Try clicking with JavaScript fallback
            if (!loginClicked) {
                try {
                    await page.evaluate(() => {
                        const btns = document.querySelectorAll('button, div[role="button"]');
                        for (const btn of btns) {
                            const text = btn.innerText?.toLowerCase() || '';
                            if (text.includes('entrar') || text.includes('log in')) {
                                btn.click();
                                break;
                            }
                        }
                    });
                    logger.info('[WARMING] Step 5: ✅ JavaScript click executed');
                } catch (e) { /* ignore */ }
            }

            // Wait for response
            logger.info('[WARMING] Step 5: Waiting for response...');
            await randomDelay(12000, 15000);

            let currentUrl = page.url();
            logger.info(`[WARMING] Step 6: Current URL after login: ${currentUrl}`);

            // Step 6: Check for error messages
            const errorMessage = await page.$('p[data-testid="login-error-message"]');
            if (errorMessage) {
                const errorText = await errorMessage.textContent();
                logger.error(`[WARMING] ❌ Error message: ${errorText}`);
                await this.uploadDebugScreenshot(page, 'login-error-msg');
                await page.close();
                return false;
            }

            // Step 7: Check for 2FA (by URL or content)
            if (currentUrl.includes('challenge') || currentUrl.includes('checkpoint') || currentUrl.includes('two_factor')) {
                logger.info('[WARMING] 🔐 2FA/Challenge detected by URL');
                if (account.totp_secret) {
                    const success = await this.handle2FA(page, account);
                    if (!success) {
                        await page.close();
                        return false;
                    }
                    // Update URL after 2FA
                    currentUrl = page.url();
                    logger.info(`[WARMING] Updated URL after 2FA: ${currentUrl}`);
                } else {
                    logger.error('[WARMING] ❌ 2FA required but no TOTP secret configured');
                    await this.uploadDebugScreenshot(page, '2fa-missing-secret');
                    await page.close();
                    return false;
                }
            }

            // Also check for 2FA by page content (URL may still show /login/#)
            if (currentUrl.includes('/accounts/login')) {
                const pageText = await page.evaluate(() => document.body?.innerText || '');

                const is2FAByContent =
                    pageText.includes('código de 6 dígitos') ||
                    pageText.includes('6-digit code') ||
                    pageText.includes('Código de segurança') ||
                    pageText.includes('Security code') ||
                    pageText.includes('app de autenticação') ||
                    pageText.includes('authentication app');

                if (is2FAByContent && account.totp_secret) {
                    logger.info('[WARMING] 🔐 2FA detected by page content');
                    const success = await this.handle2FA(page, account);
                    if (!success) {
                        await page.close();
                        return false;
                    }
                    currentUrl = page.url();
                } else if (currentUrl.includes('/accounts/login')) {
                    // Check for specific errors
                    if (pageText.includes('senha incorreta') || pageText.includes('password was incorrect')) {
                        logger.error('[WARMING] ❌ Password incorrect');
                    } else if (pageText.includes('Aguarde alguns minutos') || pageText.includes('Please wait')) {
                        logger.error('[WARMING] ❌ Rate limited - too many attempts');
                    } else if (pageText.includes('suspeita') || pageText.includes('suspicious')) {
                        logger.error('[WARMING] ❌ Suspicious activity detected');
                    } else {
                        // ⭐ FIX: Detect "stuck" state and retry before failing
                        if (currentUrl.includes('/accounts/login/#') || currentUrl === 'https://www.instagram.com/accounts/login/') {
                            logger.warn('[WARMING] 🔄 Detected stuck state on login page, attempting retry...');

                            // Try clicking login button again
                            try {
                                const retryLoginBtn = await page.$('button[type="submit"], div[role="button"]:has-text("Entrar"), div[role="button"]:has-text("Log in")');
                                if (retryLoginBtn && await retryLoginBtn.isVisible()) {
                                    await retryLoginBtn.click({ force: true });
                                    logger.info('[WARMING] 🔄 Retry: Clicked login button again');
                                }
                            } catch (e) { /* ignore */ }

                            // Press Enter as fallback
                            await page.keyboard.press('Enter');
                            logger.info('[WARMING] 🔄 Retry: Pressed Enter key');

                            // Wait for response
                            await randomDelay(8000, 10000);

                            // Check URL again
                            const retryUrl = page.url();
                            logger.info(`[WARMING] 🔄 Retry: URL after second attempt: ${retryUrl}`);

                            // If still on login, check for 2FA content again
                            if (retryUrl.includes('/accounts/login')) {
                                const retryPageText = await page.evaluate(() => document.body?.innerText || '');
                                const is2FAByRetry = retryPageText.includes('código') || retryPageText.includes('code') ||
                                    retryPageText.includes('6-digit') || retryPageText.includes('6 dígitos');

                                if (is2FAByRetry && account.totp_secret) {
                                    logger.info('[WARMING] 🔐 2FA detected on retry, handling...');
                                    const success = await this.handle2FA(page, account);
                                    if (success) {
                                        currentUrl = page.url();
                                    } else {
                                        await page.close();
                                        return false;
                                    }
                                }
                            } else if (!retryUrl.includes('/accounts/')) {
                                // Success! URL changed to non-login page
                                logger.info('[WARMING] ✅ Retry successful, login completed');
                                currentUrl = retryUrl;
                            }
                        }

                        if (currentUrl.includes('/accounts/login')) {
                            logger.error('[WARMING] ❌ Still on login page - unknown error');
                            await this.uploadDebugScreenshot(page, 'login-stuck-fail');
                            await page.close();
                            return false;
                        }
                    }
                }
            }

            // Step 8: Handle post-login popups
            logger.info('[WARMING] Step 8: Handling post-login popups...');
            await this.handlePostLoginPopups(page);

            // Step 9: Verify login
            logger.info('[WARMING] Step 9: Verifying login success...');
            const isLoggedIn = await this.checkLoggedIn(page);

            if (isLoggedIn) {
                // Save session
                const cookies = await context.cookies();
                await warmingPool.saveSession(account.id, cookies);
                logger.info(`[WARMING] ✅ Login successful for ${account.username}`);
            } else {
                logger.error(`[WARMING] ❌ Login verification failed for ${account.username}`);
                logger.error(`[WARMING] Final URL: ${page.url()}`);
                await this.uploadDebugScreenshot(page, 'login-verify-failed');
            }

            await page.close();
            return isLoggedIn;

        } catch (error) {
            logger.error(`[WARMING] ❌ Login error: ${error.message}`);
            try {
                const url = page.url();
                logger.error(`[WARMING] URL at error: ${url}`);
                await this.uploadDebugScreenshot(page, 'login-exception');
            } catch (e) { /* ignore */ }
            try { await page.close(); } catch (e) { /* ignore */ }
            return false;
        }
    }

    /**
     * Handle cookie consent dialog
     * ⭐ PORTED FROM instagram.service.js - Full robust version
     */
    async handleCookieConsent(page) {
        try {
            await randomDelay(1000, 2000);

            // Multiple possible selectors for cookie consent
            const cookieSelectors = [
                // English variants
                'button:has-text("Allow all cookies")',
                'button:has-text("Allow essential and optional cookies")',
                'button:has-text("Accept All")',
                'button:has-text("Accept")',
                'button:has-text("Only allow essential cookies")',
                // Portuguese variants
                'button:has-text("Permitir todos os cookies")',
                'button:has-text("Permitir cookies essenciais e opcionais")',
                'button:has-text("Aceitar tudo")',
                'button:has-text("Aceitar")',
                'button:has-text("Permitir somente cookies essenciais")',
                // Generic patterns
                '[role="dialog"] button:first-of-type',
                'div[role="dialog"] button',
                'button._a9--._a9_1',
            ];

            let clicked = false;
            for (const selector of cookieSelectors) {
                try {
                    const btn = await page.$(selector);
                    if (btn) {
                        const isVisible = await btn.isVisible();
                        if (isVisible) {
                            await btn.click();
                            logger.info(`[WARMING] ✅ Cookie consent clicked: ${selector}`);
                            clicked = true;
                            await randomDelay(2000, 3000);
                            break;
                        }
                    }
                } catch (e) {
                    // Try next selector
                }
            }

            if (!clicked) {
                // Try clicking any visible button in a dialog
                const dialogButtons = await page.$$('[role="dialog"] button, [role="presentation"] button');
                for (const btn of dialogButtons) {
                    try {
                        const isVisible = await btn.isVisible();
                        if (isVisible) {
                            const text = await btn.textContent();
                            if (text && (text.toLowerCase().includes('allow') ||
                                text.toLowerCase().includes('accept') ||
                                text.toLowerCase().includes('permitir') ||
                                text.toLowerCase().includes('aceitar'))) {
                                await btn.click();
                                logger.info('[WARMING] ✅ Clicked cookie button by text match');
                                clicked = true;
                                await randomDelay(2000, 3000);
                                break;
                            }
                        }
                    } catch (e) {
                        continue;
                    }
                }
            }

            if (!clicked) {
                logger.warn('[WARMING] No cookie consent button found - continuing anyway');
            }
        } catch (e) {
            logger.warn(`[WARMING] Cookie consent handling error: ${e.message}`);
        }
    }

    /**
     * Handle 2FA authentication
     * ⭐ FULLY PORTED FROM instagram.service.js - Complete robust version
     * Features: time sync, 11 input selectors, 7 submit selectors, retry logic, bad state detection
     * @param {Page} page
     * @param {Object} account
     * @param {number} retryCount - Current retry attempt (max 3)
     * @returns {Promise<boolean>}
     */
    async handle2FA(page, account, retryCount = 0) {
        const MAX_2FA_RETRIES = 3;

        // Check if account has TOTP secret
        if (!account.totp_secret) {
            logger.warn('[WARMING:2FA] Account does not have TOTP secret configured');
            return false;
        }

        try {
            logger.info('[WARMING:2FA] ========================================');
            logger.info(`[WARMING:2FA] 🔐 2FA ATTEMPT ${retryCount + 1}/${MAX_2FA_RETRIES}`);
            logger.info('[WARMING:2FA] ========================================');
            logger.info(`[WARMING:2FA] Account: ${account.username}`);
            logger.info(`[WARMING:2FA] TOTP Secret (first 8 chars): ${account.totp_secret.substring(0, 8)}...`);
            logger.info(`[WARMING:2FA] Current URL: ${page.url()}`);

            // ⭐ TIME SYNC CHECK: Log server time for debugging
            const serverTime = new Date();
            logger.info(`[WARMING:2FA] ⏱️ Server time: ${serverTime.toISOString()}`);

            // Wait for the 2FA page to fully load
            logger.info('[WARMING:2FA] Waiting for 2FA page to stabilize...');
            await randomDelay(2000, 3000);

            // Wait for network idle
            try {
                await page.waitForLoadState('networkidle', { timeout: 5000 });
            } catch (e) { /* ignore timeout */ }

            // ⭐ IMPROVEMENT 1: Generate TOTP with time tolerance
            // Wait until we're at least 5 seconds into a new period to avoid expiration during submission
            const currentTime = Math.floor(Date.now() / 1000);
            const timeInPeriod = currentTime % 30;

            if (timeInPeriod > 25) {
                // Too close to next period, wait for new code
                const waitTime = (30 - timeInPeriod + 2) * 1000;
                logger.info(`[WARMING:2FA] ⏳ Waiting ${waitTime}ms for fresh TOTP code (current position: ${timeInPeriod}s)`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }

            // ⭐ Sanitize TOTP secret: remove spaces and convert to uppercase
            const sanitizedSecret = account.totp_secret.replace(/\s+/g, '').toUpperCase();
            logger.info(`[WARMING:2FA] 🔑 Secret length: ${sanitizedSecret.length} chars`);

            let totpCode = null;

            // ⭐ PRIMARY: Use 2fa.live API for TOTP generation
            try {
                logger.info(`[WARMING:2FA] 🌐 Fetching TOTP from 2fa.live API...`);

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
                logger.info(`[WARMING:2FA] ✅ 2fa.live returned code: ${totpCode}`);

            } catch (apiError) {
                logger.warn(`[WARMING:2FA] ⚠️ 2fa.live API failed: ${apiError.message}`);
                logger.info(`[WARMING:2FA] 🔄 Falling back to local speakeasy generation...`);

                // FALLBACK: Use local speakeasy if API fails
                const totpWindow = retryCount === 0 ? 1 : 2;
                totpCode = speakeasy.totp({
                    secret: sanitizedSecret,
                    encoding: 'base32',
                    window: totpWindow,
                    step: 30
                });
                logger.info(`[WARMING:2FA] ✅ Speakeasy fallback code: ${totpCode}`);
            }

            // Log timing info
            const currentTimeInPeriod = Math.floor(Date.now() / 1000) % 30;
            logger.info(`[WARMING:2FA] ⏰ Time in period: ${currentTimeInPeriod}s (code valid for ~${30 - currentTimeInPeriod}s)`);

            // Look for 2FA code input field (11 selectors like instagram.service.js)
            const codeInputSelectors = [
                'input[name="verificationCode"]',
                'input[name="security_code"]',
                'input[aria-label*="Security code"]',
                'input[aria-label*="código"]',
                'input[aria-label*="Código"]',
                'input[aria-label*="Código de segurança"]',
                'input[placeholder*="code"]',
                'input[placeholder*="código"]',
                'input[type="text"][maxlength="6"]',
                'input[type="number"]',
                'input[type="tel"]',
            ];

            let codeInput = null;
            for (const selector of codeInputSelectors) {
                try {
                    codeInput = await page.waitForSelector(selector, { timeout: 2000 });
                    if (codeInput) {
                        const isVisible = await codeInput.isVisible().catch(() => false);
                        if (isVisible) {
                            logger.info(`[WARMING:2FA] ✅ Found input: ${selector}`);
                            break;
                        }
                        codeInput = null;
                    }
                } catch (e) { /* try next */ }
            }

            if (!codeInput) {
                logger.error('[WARMING:2FA] ❌ Could not find 2FA code input field');
                await this.uploadDebugScreenshot(page, '2fa-error-no-input');
                return false;
            }

            // ⭐ Clear and type the code with human-like delay (digit by digit)
            logger.info('[WARMING:2FA] 📝 Filling code input...');
            await codeInput.click();
            await randomDelay(200, 400);
            await codeInput.fill('');
            await randomDelay(100, 200);

            // Type code one digit at a time for more human-like behavior
            for (const digit of totpCode) {
                await codeInput.type(digit, { delay: 100 + Math.random() * 100 });
            }

            // ⭐ Verify what was typed
            const typedValue = await codeInput.inputValue();
            logger.info(`[WARMING:2FA] Typed value: ${typedValue} (match: ${typedValue === totpCode})`);

            if (typedValue !== totpCode) {
                logger.error('[WARMING:2FA] ❌ Code mismatch! Retrying...');
                await codeInput.fill('');
                await codeInput.type(totpCode, { delay: 150 });
            }

            // Wait before submitting
            await randomDelay(800, 1200);

            // ⭐ Submit button with extended selectors (12 total)
            const submitSelectors = [
                'button[type="submit"]',
                'button:has-text("Confirmar")',
                'button:has-text("Confirm")',
                'button:has-text("Verificar")',
                'button:has-text("Verify")',
                'button:has-text("Enviar")',
                'button:has-text("Submit")',
                'button:has-text("Avançar")',
                'button:has-text("Next")',
                'div[role="button"]:has-text("Confirmar")',
                'div[role="button"]:has-text("Confirm")',
                'form button',
            ];

            let submitBtn = null;
            for (const selector of submitSelectors) {
                try {
                    submitBtn = await page.$(selector);
                    if (submitBtn) {
                        const isVisible = await submitBtn.isVisible().catch(() => false);
                        if (isVisible) {
                            logger.info(`[WARMING:2FA] ✅ Found submit button: ${selector}`);
                            break;
                        }
                        submitBtn = null;
                    }
                } catch (e) { /* try next */ }
            }

            if (!submitBtn) {
                logger.warn('[WARMING:2FA] No submit button found, trying Enter key...');
                await codeInput.focus();
                await randomDelay(200, 300);
                await page.keyboard.press('Enter');
            } else {
                // ⭐ Click with waitForNavigation (critical!)
                logger.info('[WARMING:2FA] 🖱️ Clicking submit button...');

                try {
                    await submitBtn.hover();
                    await randomDelay(100, 200);

                    // Click and wait for potential navigation
                    await Promise.all([
                        submitBtn.click(),
                        page.waitForNavigation({ timeout: 10000, waitUntil: 'domcontentloaded' }).catch(() => { })
                    ]);

                    logger.info('[WARMING:2FA] ✅ Submit button clicked');
                } catch (clickError) {
                    logger.warn(`[WARMING:2FA] Click error: ${clickError.message}, trying Enter key...`);
                    try {
                        await codeInput.focus();
                        await page.keyboard.press('Enter');
                        logger.info('[WARMING:2FA] ✅ Fallback: Enter key pressed');
                    } catch (e) { }
                }
            }

            // Wait for Instagram to fully process the code
            logger.info('[WARMING:2FA] ⏳ Waiting for Instagram to process code...');
            await randomDelay(5000, 6000);

            // Wait for network to settle
            try {
                await page.waitForLoadState('networkidle', { timeout: 8000 });
            } catch (e) { /* ignore timeout */ }

            // ⭐ Check for error messages (PT + EN)
            const urlAfterSubmit = page.url();
            logger.info(`[WARMING:2FA] After submit - URL: ${urlAfterSubmit}`);

            const errorMessages = await page.evaluate(() => {
                const errorSelectors = [
                    '[role="alert"]',
                    '.error',
                    '[class*="error"]',
                    '[class*="Error"]',
                ];

                const errors = [];
                for (const sel of errorSelectors) {
                    const elements = document.querySelectorAll(sel);
                    elements.forEach(el => {
                        const text = el.textContent?.trim();
                        if (text && text.length > 5) errors.push(text);
                    });
                }

                // Also check page text for common error phrases
                const pageText = document.body?.innerText || '';
                const errorPhrases = [
                    'código incorreto', 'incorrect code',
                    'código inválido', 'invalid code',
                    'tente novamente', 'try again',
                    'expirou', 'expired',
                ];

                for (const phrase of errorPhrases) {
                    if (pageText.toLowerCase().includes(phrase.toLowerCase())) {
                        errors.push(`Found phrase: "${phrase}"`);
                    }
                }

                return errors;
            });

            if (errorMessages.length > 0) {
                logger.error(`[WARMING:2FA] ❌ Error messages detected: ${errorMessages.join(' | ')}`);
                await this.uploadDebugScreenshot(page, '2fa-error-messages');
            }

            // ⭐ Check for BAD states (suspended, banned, checkpoint)
            const badStatePatterns = [
                '/accounts/suspended',
                '/accounts/disabled',
                '/accounts/banned',
                '/checkpoint/',
                'confirm_email',
                'confirm_phone'
            ];
            const isInBadState = badStatePatterns.some(pattern => urlAfterSubmit.includes(pattern));

            if (isInBadState) {
                logger.error(`[WARMING:2FA] ❌ Account is in a bad state: ${urlAfterSubmit}`);
                await this.uploadDebugScreenshot(page, '2fa-bad-state');

                if (urlAfterSubmit.includes('suspended')) {
                    logger.error('[WARMING:2FA] ❌ Account is SUSPENDED - requires human verification');
                } else if (urlAfterSubmit.includes('disabled') || urlAfterSubmit.includes('banned')) {
                    logger.error('[WARMING:2FA] ❌ Account is BANNED/DISABLED');
                } else if (urlAfterSubmit.includes('checkpoint')) {
                    logger.error('[WARMING:2FA] ❌ Account requires checkpoint verification');
                } else if (urlAfterSubmit.includes('confirm_')) {
                    logger.error('[WARMING:2FA] ❌ Account requires email/phone verification');
                }

                return false;
            }

            // Check success indicators
            const successIndicators = ['onetap', 'instagram.com/$', 'instagram.com/?'];
            const isSuccess = successIndicators.some(indicator => {
                if (indicator.includes('$')) {
                    return urlAfterSubmit === 'https://www.instagram.com/' ||
                        urlAfterSubmit.endsWith('instagram.com/');
                }
                return urlAfterSubmit.includes(indicator);
            });

            const stillOnChallenge = urlAfterSubmit.includes('two_factor') ||
                urlAfterSubmit.includes('challenge');

            // ⭐ FIX: Also check if we're still on the login page (false positive fix)
            const stillOnLogin = urlAfterSubmit.includes('/accounts/login');

            // Success ONLY if: (explicit success indicator) OR (not on challenge AND not on login)
            if (isSuccess || (!stillOnChallenge && !stillOnLogin)) {
                logger.info('[WARMING:2FA] ✅ Successfully passed 2FA challenge!');
                logger.info(`[WARMING:2FA] New URL: ${urlAfterSubmit}`);
                return true;
            }

            // ⭐ FIX: If still on login page after 2FA, this is a failure
            if (stillOnLogin) {
                logger.error('[WARMING:2FA] ❌ Still on login page after 2FA - code may have been rejected silently');
                await this.uploadDebugScreenshot(page, '2fa-rejected');
                return false;
            }

            // ⭐ RETRY with new code
            logger.warn('[WARMING:2FA] ⚠️ Still on 2FA/challenge page after submit');

            if (retryCount < MAX_2FA_RETRIES - 1) {
                logger.info(`[WARMING:2FA] 🔄 Retrying with fresh TOTP code (attempt ${retryCount + 2}/${MAX_2FA_RETRIES})...`);

                const waitForRetry = 5000;
                logger.info(`[WARMING:2FA] ⏳ Waiting ${waitForRetry / 1000}s before retry...`);
                await new Promise(resolve => setTimeout(resolve, waitForRetry));

                // Clear input and retry
                try {
                    const retryInput = await page.$('input[name="verificationCode"]') ||
                        await page.$('input[type="text"][maxlength="6"]');
                    if (retryInput) {
                        await retryInput.fill('');
                    }
                } catch (e) { /* ignore */ }

                return await this.handle2FA(page, account, retryCount + 1);
            }

            logger.error(`[WARMING:2FA] ❌ All ${MAX_2FA_RETRIES} attempts failed`);
            return false;

        } catch (error) {
            logger.error('[WARMING:2FA] ❌ Exception in 2FA handler:', error.message);
            await this.uploadDebugScreenshot(page, '2fa-exception');

            // ⭐ Check if we actually succeeded despite the exception
            try {
                const currentUrl = page.url();
                logger.info(`[WARMING:2FA] Exception occurred, but checking URL: ${currentUrl}`);

                if (currentUrl.includes('onetap') ||
                    (currentUrl.includes('instagram.com') && !currentUrl.includes('two_factor') && !currentUrl.includes('challenge'))) {
                    logger.info('[WARMING:2FA] ✅ Exception occurred but 2FA actually succeeded!');
                    return true;
                }
            } catch (urlError) {
                logger.info('[WARMING:2FA] Could not check URL, waiting...');
                await randomDelay(2000, 3000);
                try {
                    const newUrl = page.url();
                    if (!newUrl.includes('two_factor') && !newUrl.includes('challenge')) {
                        logger.info('[WARMING:2FA] ✅ 2FA succeeded after exception!');
                        return true;
                    }
                } catch (e) { /* ignore */ }
            }

            // Retry on exception
            if (retryCount < MAX_2FA_RETRIES - 1) {
                logger.info(`[WARMING:2FA] 🔄 Retrying after exception (attempt ${retryCount + 2}/${MAX_2FA_RETRIES})...`);
                await randomDelay(5000, 8000);
                return await this.handle2FA(page, account, retryCount + 1);
            }

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
            const currentUrl = page.url();

            // 🚩 NEW: Explicitly check for "BAD" pages that are NOT logged in states
            const badUrls = [
                '/accounts/login',
                '/accounts/suspended',
                '/accounts/disabled',
                '/accounts/banned',
                '/checkpoint/',
                'confirm_email',
                'confirm_phone'
            ];

            if (badUrls.some(url => currentUrl.includes(url))) {
                logger.warn(`[WARMING] 🚩 Page state is not a valid login: ${currentUrl}`);
                return false;
            }

            const indicators = [
                'svg[aria-label="Home"]',
                'svg[aria-label="Início"]',
                'svg[aria-label="Feed"]',
                'a[href="/direct/inbox/"]',
                'section[role="main"]'
            ];

            for (const selector of indicators) {
                const el = await page.$(selector);
                if (el && await el.isVisible()) return true;
            }

            // Success indicators if URL looks good
            const isAtHome = currentUrl === 'https://www.instagram.com/' ||
                currentUrl.includes('instagram.com/direct/inbox') ||
                currentUrl.includes('instagram.com/reels/');

            return isAtHome;
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
            context = await this.createBrowserContext(browser, account); // Pass account for cookies

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
        } catch (error) {
            return { viewed: 0, error: error.message };
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
