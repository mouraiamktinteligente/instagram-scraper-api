/**
 * Page State Handler Service
 * Intelligent detection and handling of Instagram page states
 * Uses AI when needed to understand unknown page states
 */

const logger = require('../utils/logger');
const config = require('../config');

// ================================================
// PAGE STATES DEFINITION
// ================================================
const PAGE_STATES = {
    // Account suspended - needs human verification
    SUSPENDED: {
        name: 'SUSPENDED',
        urlPatterns: ['/accounts/suspended'],
        textPatterns: [
            'Confirme que você é humano',
            'Confirm you are human',
            'conta foi suspensa',
            'account has been suspended',
            'verificar sua identidade',
            'verify your identity'
        ],
        severity: 'CRITICAL',
        action: 'MARK_ACCOUNT_SUSPENDED'
    },

    // Challenge/Checkpoint - security verification
    CHALLENGE: {
        name: 'CHALLENGE',
        urlPatterns: ['/challenge/', '/checkpoint/'],
        textPatterns: [
            'verificação de segurança',
            'security check',
            'unusual login',
            'atividade suspeita',
            'suspicious activity'
        ],
        severity: 'HIGH',
        action: 'HANDLE_CHALLENGE'
    },

    // Rate limited - too many requests
    RATE_LIMITED: {
        name: 'RATE_LIMITED',
        urlPatterns: [],
        textPatterns: [
            'Aguarde alguns minutos',
            'Please wait a few minutes',
            'tente novamente mais tarde',
            'try again later',
            'muitas solicitações',
            'too many requests'
        ],
        severity: 'MEDIUM',
        action: 'WAIT_AND_RETRY'
    },

    // Account disabled/banned
    BANNED: {
        name: 'BANNED',
        urlPatterns: ['/accounts/disabled', '/accounts/banned'],
        textPatterns: [
            'conta foi desativada',
            'account has been disabled',
            'violou nossas diretrizes',
            'violated our terms',
            'permanentemente removida',
            'permanently removed'
        ],
        severity: 'CRITICAL',
        action: 'MARK_ACCOUNT_BANNED'
    },

    // Needs email/phone verification
    VERIFICATION_REQUIRED: {
        name: 'VERIFICATION_REQUIRED',
        urlPatterns: ['/accounts/confirm_email', '/accounts/confirm_phone'],
        textPatterns: [
            'confirme seu email',
            'confirm your email',
            'código de verificação',
            'verification code',
            'enviamos um código',
            'we sent a code'
        ],
        severity: 'HIGH',
        action: 'MARK_NEEDS_VERIFICATION'
    },

    // Password change required
    PASSWORD_RESET: {
        name: 'PASSWORD_RESET',
        urlPatterns: ['/accounts/password/reset'],
        textPatterns: [
            'redefinir sua senha',
            'reset your password',
            'senha expirou',
            'password expired'
        ],
        severity: 'HIGH',
        action: 'MARK_NEEDS_PASSWORD_RESET'
    },

    // Success states
    LOGGED_IN: {
        name: 'LOGGED_IN',
        urlPatterns: [],
        indicators: {
            hasHomeIcon: true,
            hasProfileLink: true,
            notOnLoginPage: true
        },
        severity: 'SUCCESS',
        action: 'CONTINUE'
    },

    // Error states
    CREDENTIALS_INCORRECT: {
        name: 'CREDENTIALS_INCORRECT',
        textPatterns: [
            'senha incorreta',
            'password was incorrect',
            'informações de login incorretas',
            'login information was incorrect',
            'senha errada',
            'wrong password'
        ],
        severity: 'HIGH',
        action: 'MARK_CREDENTIALS_INVALID'
    },

    // Unknown state - use AI to analyze
    UNKNOWN: {
        name: 'UNKNOWN',
        severity: 'MEDIUM',
        action: 'ANALYZE_WITH_AI'
    }
};

// ================================================
// PAGE STATE HANDLER SERVICE
// ================================================
class PageStateHandlerService {
    constructor() {
        this.states = PAGE_STATES;
    }

    /**
     * Detect the current state of the page
     * @param {Page} page - Playwright page
     * @returns {Promise<Object>} Detected state and details
     */
    async detectState(page) {
        const url = page.url();
        let pageText = '';

        try {
            pageText = await page.evaluate(() => document.body?.innerText || '');
        } catch (e) {
            logger.warn('[PAGE-STATE] Could not get page text');
        }

        logger.info(`[PAGE-STATE] 🔍 Analyzing page state...`);
        logger.debug(`[PAGE-STATE] URL: ${url}`);
        logger.debug(`[PAGE-STATE] Text preview: ${pageText.substring(0, 150)}...`);

        // Check each state in order of severity
        for (const [stateName, stateConfig] of Object.entries(this.states)) {
            if (stateName === 'UNKNOWN' || stateName === 'LOGGED_IN') continue;

            // Check URL patterns
            if (stateConfig.urlPatterns?.length > 0) {
                for (const pattern of stateConfig.urlPatterns) {
                    if (url.includes(pattern)) {
                        logger.info(`[PAGE-STATE] ✅ Detected: ${stateName} (URL match: ${pattern})`);
                        return {
                            state: stateName,
                            config: stateConfig,
                            matchedBy: 'url',
                            matchedPattern: pattern,
                            url,
                            pageTextPreview: pageText.substring(0, 200)
                        };
                    }
                }
            }

            // Check text patterns
            if (stateConfig.textPatterns?.length > 0) {
                const lowerText = pageText.toLowerCase();
                for (const pattern of stateConfig.textPatterns) {
                    if (lowerText.includes(pattern.toLowerCase())) {
                        logger.info(`[PAGE-STATE] ✅ Detected: ${stateName} (Text match: "${pattern}")`);
                        return {
                            state: stateName,
                            config: stateConfig,
                            matchedBy: 'text',
                            matchedPattern: pattern,
                            url,
                            pageTextPreview: pageText.substring(0, 200)
                        };
                    }
                }
            }
        }

        // Check if actually logged in
        if (await this.isActuallyLoggedIn(page, url)) {
            logger.info(`[PAGE-STATE] ✅ Detected: LOGGED_IN`);
            return {
                state: 'LOGGED_IN',
                config: this.states.LOGGED_IN,
                matchedBy: 'indicators',
                url
            };
        }

        // Unknown state
        logger.warn(`[PAGE-STATE] ⚠️ Unknown state detected`);
        return {
            state: 'UNKNOWN',
            config: this.states.UNKNOWN,
            url,
            pageTextPreview: pageText.substring(0, 500)
        };
    }

    /**
     * Check if user is actually logged in by looking for indicators
     */
    async isActuallyLoggedIn(page, url) {
        // Don't consider these URLs as logged in
        const badUrlPatterns = [
            '/accounts/login',
            '/accounts/suspended',
            '/accounts/disabled',
            '/challenge/',
            '/checkpoint/',
            'two_factor'
        ];

        for (const pattern of badUrlPatterns) {
            if (url.includes(pattern)) {
                return false;
            }
        }

        // Check for logged in indicators
        try {
            const indicators = [
                'svg[aria-label="Home"]',
                'svg[aria-label="Início"]',
                'a[href="/direct/inbox/"]',
                'svg[aria-label="New post"]',
                'svg[aria-label="Nova publicação"]'
            ];

            for (const selector of indicators) {
                const el = await page.$(selector);
                if (el) return true;
            }
        } catch (e) {
            // Ignore
        }

        // If URL is instagram.com/ without any /accounts/ path, consider logged in
        if (url.match(/instagram\.com\/?$/) || url.includes('/onetap')) {
            return true;
        }

        return false;
    }

    /**
     * Handle the detected state - returns action result
     * @param {Page} page - Playwright page
     * @param {Object} detectedState - Result from detectState
     * @param {Object} account - Account being used
     * @returns {Promise<Object>} Action result
     */
    async handleState(page, detectedState, account) {
        const { state, config } = detectedState;

        logger.info(`[PAGE-STATE] 🎯 Handling state: ${state} (action: ${config.action})`);

        switch (config.action) {
            case 'CONTINUE':
                return { success: true, message: 'Logged in successfully' };

            case 'MARK_ACCOUNT_SUSPENDED':
                logger.error(`[PAGE-STATE] ❌ Account ${account.username} is SUSPENDED`);
                return {
                    success: false,
                    error: 'ACCOUNT_SUSPENDED',
                    message: 'Account is suspended and requires human verification',
                    shouldMarkAccount: true,
                    markAs: 'suspended'
                };

            case 'MARK_ACCOUNT_BANNED':
                logger.error(`[PAGE-STATE] ❌ Account ${account.username} is BANNED`);
                return {
                    success: false,
                    error: 'ACCOUNT_BANNED',
                    message: 'Account has been permanently disabled',
                    shouldMarkAccount: true,
                    markAs: 'banned'
                };

            case 'MARK_CREDENTIALS_INVALID':
                logger.error(`[PAGE-STATE] ❌ Account ${account.username} has invalid credentials`);
                return {
                    success: false,
                    error: 'CREDENTIALS_INVALID',
                    message: 'Username or password is incorrect',
                    shouldMarkAccount: true,
                    markAs: 'credentials_invalid'
                };

            case 'MARK_NEEDS_VERIFICATION':
                logger.error(`[PAGE-STATE] ❌ Account ${account.username} needs email/phone verification`);
                return {
                    success: false,
                    error: 'NEEDS_VERIFICATION',
                    message: 'Account requires email or phone verification',
                    shouldMarkAccount: true,
                    markAs: 'needs_verification'
                };

            case 'MARK_NEEDS_PASSWORD_RESET':
                logger.error(`[PAGE-STATE] ❌ Account ${account.username} needs password reset`);
                return {
                    success: false,
                    error: 'NEEDS_PASSWORD_RESET',
                    message: 'Account requires password reset',
                    shouldMarkAccount: true,
                    markAs: 'needs_password_reset'
                };

            case 'HANDLE_CHALLENGE':
                // Try to handle simple challenges
                const challengeResult = await this.tryHandleChallenge(page);
                return challengeResult;

            case 'WAIT_AND_RETRY':
                logger.warn(`[PAGE-STATE] ⏳ Rate limited, should wait and retry`);
                return {
                    success: false,
                    error: 'RATE_LIMITED',
                    message: 'Too many requests, need to wait',
                    shouldRetry: true,
                    retryAfterMs: 60000 // 1 minute
                };

            case 'ANALYZE_WITH_AI':
                // Use AI to understand and possibly handle unknown state
                const aiResult = await this.analyzeWithAI(page, detectedState);
                return aiResult;

            default:
                return {
                    success: false,
                    error: 'UNKNOWN_ACTION',
                    message: `Unknown action: ${config.action}`
                };
        }
    }

    /**
     * Try to handle simple challenges (like clicking "Continue")
     */
    async tryHandleChallenge(page) {
        try {
            // Look for "Continue" button
            const continueSelectors = [
                'button:has-text("Continuar")',
                'button:has-text("Continue")',
                'button[type="submit"]'
            ];

            for (const selector of continueSelectors) {
                const btn = await page.$(selector);
                if (btn && await btn.isVisible()) {
                    logger.info(`[PAGE-STATE] 🖱️ Clicking challenge button: ${selector}`);
                    await btn.click();
                    await page.waitForTimeout(3000);

                    // Check if we passed the challenge
                    const newState = await this.detectState(page);
                    if (newState.state === 'LOGGED_IN') {
                        return { success: true, message: 'Challenge passed' };
                    }
                }
            }

            // Could not handle challenge automatically
            return {
                success: false,
                error: 'CHALLENGE_FAILED',
                message: 'Challenge requires manual intervention (possibly CAPTCHA)',
                shouldMarkAccount: true,
                markAs: 'challenge_failed'
            };

        } catch (error) {
            return {
                success: false,
                error: 'CHALLENGE_ERROR',
                message: error.message
            };
        }
    }

    /**
     * Use AI to analyze unknown page state
     */
    async analyzeWithAI(page, detectedState) {
        try {
            // Get page content for AI analysis
            const pageText = await page.evaluate(() => {
                const body = document.body;
                if (!body) return '';

                // Get all visible text
                const texts = [];
                const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null, false);
                while (walker.nextNode()) {
                    const text = walker.currentNode.textContent.trim();
                    if (text) texts.push(text);
                }
                return texts.join(' ').substring(0, 2000);
            });

            // Get buttons and actions available
            const buttons = await page.evaluate(() => {
                const btns = document.querySelectorAll('button, [role="button"], a[href]');
                return Array.from(btns).slice(0, 10).map(b => ({
                    text: b.innerText?.trim(),
                    tag: b.tagName,
                    href: b.href || null
                }));
            });

            logger.info(`[PAGE-STATE] 🤖 AI Analysis:`);
            logger.info(`[PAGE-STATE] URL: ${detectedState.url}`);
            logger.info(`[PAGE-STATE] Text: ${pageText.substring(0, 200)}...`);
            logger.info(`[PAGE-STATE] Buttons: ${JSON.stringify(buttons.slice(0, 5))}`);

            // Determine action based on content
            const lowerText = pageText.toLowerCase();

            // Check for common patterns
            if (lowerText.includes('captcha') || lowerText.includes('robot') || lowerText.includes('humano')) {
                return {
                    success: false,
                    error: 'CAPTCHA_REQUIRED',
                    message: 'Page requires CAPTCHA verification',
                    shouldMarkAccount: true,
                    markAs: 'captcha_required'
                };
            }

            if (lowerText.includes('erro') || lowerText.includes('error') || lowerText.includes('problema')) {
                return {
                    success: false,
                    error: 'PAGE_ERROR',
                    message: 'Page shows an error',
                    pageText: pageText.substring(0, 500)
                };
            }

            // Try clicking any "Continue" type button
            const continueButton = buttons.find(b =>
                b.text?.toLowerCase().includes('continu') ||
                b.text?.toLowerCase().includes('próximo') ||
                b.text?.toLowerCase().includes('next')
            );

            if (continueButton) {
                logger.info(`[PAGE-STATE] 🤖 Found action button: "${continueButton.text}"`);
                // Don't actually click - just report it
                return {
                    success: false,
                    error: 'NEEDS_INTERACTION',
                    message: `Page needs interaction: "${continueButton.text}" button found`,
                    suggestedAction: 'click_continue'
                };
            }

            return {
                success: false,
                error: 'AI_COULD_NOT_DETERMINE',
                message: 'AI could not determine page state',
                pageText: pageText.substring(0, 500),
                buttons
            };

        } catch (error) {
            logger.error(`[PAGE-STATE] AI analysis error: ${error.message}`);
            return {
                success: false,
                error: 'AI_ERROR',
                message: error.message
            };
        }
    }

    /**
     * Quick check if page is in a failed state
     */
    async isFailedState(page) {
        const state = await this.detectState(page);
        return !['LOGGED_IN', 'UNKNOWN'].includes(state.state);
    }
}

module.exports = new PageStateHandlerService();
module.exports.PAGE_STATES = PAGE_STATES;
