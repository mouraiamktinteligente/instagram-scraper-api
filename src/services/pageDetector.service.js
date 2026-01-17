/**
 * Page Detector Service
 * Intelligently detects the type of Instagram page and its key elements
 * 
 * Purpose: Instagram has multiple layouts, A/B testing, and changes frequently.
 * This service analyzes each page to understand:
 * 1. WHAT type of page it is (login, post, profile, feed)
 * 2. WHAT layout variant (mobile, desktop, modal)  
 * 3. WHERE the key elements are located
 * 4. HOW to interact with them
 */

const logger = require('./logger');

class PageDetectorService {
    /**
     * Page types we can detect
     */
    static PAGE_TYPES = {
        LOGIN: 'login',
        TWO_FACTOR: 'two_factor',
        CHALLENGE: 'challenge',
        HOME_FEED: 'home_feed',
        POST: 'post',
        POST_MODAL: 'post_modal',
        PROFILE: 'profile',
        EXPLORE: 'explore',
        UNKNOWN: 'unknown'
    };

    /**
     * Analyze a page and return detailed information
     * @param {Page} page - Playwright page
     * @returns {Object} Page analysis result
     */
    async analyzePage(page) {
        const startTime = Date.now();

        try {
            const analysis = await page.evaluate(() => {
                const url = location.href;
                const title = document.title;
                const bodyText = document.body?.innerText?.substring(0, 2000) || '';
                const bodyTextLower = bodyText.toLowerCase();

                // Collect all interactive elements
                const allButtons = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"]'));
                const allInputs = Array.from(document.querySelectorAll('input'));
                const allLinks = Array.from(document.querySelectorAll('a[href]'));

                // Map buttons with their text
                const buttonMap = allButtons.map(btn => ({
                    text: btn.innerText?.trim().substring(0, 50) || '',
                    type: btn.tagName,
                    visible: btn.getBoundingClientRect().height > 0,
                    hasClick: typeof btn.onclick === 'function' || btn.getAttribute('role') === 'button'
                })).filter(b => b.text.length > 0);

                // Map inputs with their purpose
                const inputMap = allInputs.map(inp => ({
                    type: inp.type || 'text',
                    name: inp.name || '',
                    placeholder: inp.placeholder || '',
                    ariaLabel: inp.getAttribute('aria-label') || '',
                    visible: inp.getBoundingClientRect().height > 0
                }));

                // Detect specific indicators
                const hasLoginForm = inputMap.some(i =>
                    i.name === 'username' ||
                    i.placeholder?.toLowerCase().includes('usuário') ||
                    i.placeholder?.toLowerCase().includes('username') ||
                    i.placeholder?.toLowerCase().includes('email')
                );
                const hasPasswordField = inputMap.some(i => i.type === 'password');
                const has2FAField = inputMap.some(i =>
                    i.name === 'verificationCode' ||
                    i.placeholder?.includes('código') ||
                    i.ariaLabel?.includes('code')
                );
                const hasComments = bodyTextLower.includes('comentário') || bodyTextLower.includes('comment');
                const hasArticle = document.querySelector('article') !== null;
                const hasModal = document.querySelector('div[role="dialog"]') !== null;
                const hasPostImage = document.querySelector('article img') !== null;

                // Detect page type
                let pageType = 'unknown';
                let confidence = 0;

                if (url.includes('/accounts/login')) {
                    pageType = hasPasswordField ? 'login' : 'login_landing';
                    confidence = 0.95;
                } else if (url.includes('two_factor') || has2FAField) {
                    pageType = 'two_factor';
                    confidence = 0.9;
                } else if (url.includes('challenge') || url.includes('checkpoint')) {
                    pageType = 'challenge';
                    confidence = 0.9;
                } else if (url.match(/\/p\/[A-Za-z0-9_-]+/)) {
                    pageType = hasModal ? 'post_modal' : 'post';
                    confidence = 0.9;
                } else if (url.match(/\/[A-Za-z0-9_.]+\/?$/) && !url.includes('/accounts/')) {
                    pageType = 'profile';
                    confidence = 0.7;
                } else if (url === 'https://www.instagram.com/' || url.includes('/#')) {
                    pageType = 'home_feed';
                    confidence = 0.8;
                }

                return {
                    url,
                    title,
                    pageType,
                    confidence,
                    indicators: {
                        hasLoginForm,
                        hasPasswordField,
                        has2FAField,
                        hasComments,
                        hasArticle,
                        hasModal,
                        hasPostImage
                    },
                    elements: {
                        buttonCount: allButtons.length,
                        inputCount: allInputs.length,
                        buttons: buttonMap.slice(0, 10), // Top 10 buttons
                        inputs: inputMap
                    },
                    textPreview: bodyText.substring(0, 300)
                };
            });

            // Add timing
            analysis.analysisTime = Date.now() - startTime;

            logger.info(`[PAGE-DETECTOR] Detected: ${analysis.pageType} (${Math.round(analysis.confidence * 100)}% confidence)`);
            logger.debug(`[PAGE-DETECTOR] URL: ${analysis.url}`);
            logger.debug(`[PAGE-DETECTOR] Inputs: ${analysis.elements.inputCount}, Buttons: ${analysis.elements.buttonCount}`);

            return analysis;

        } catch (error) {
            logger.error('[PAGE-DETECTOR] Analysis failed:', error.message);
            return {
                pageType: PageDetectorService.PAGE_TYPES.UNKNOWN,
                confidence: 0,
                error: error.message
            };
        }
    }

    /**
     * Find a specific element type on the page
     * Uses multiple strategies and returns the best match
     * @param {Page} page - Playwright page
     * @param {string} elementType - What to find (login_button, username_input, etc.)
     * @returns {Object} Found element info or null
     */
    async findElement(page, elementType) {
        const analysis = await this.analyzePage(page);

        const strategies = {
            'login_button': [
                { selector: 'button[type="submit"]', priority: 1 },
                { text: /entrar/i, priority: 2 },
                { text: /log\s*in/i, priority: 2 },
                { selector: 'form button', priority: 3 },
                { selector: 'div[role="button"]:has-text("Entrar")', priority: 4 },
            ],
            'username_input': [
                { selector: 'input[name="username"]', priority: 1 },
                { selector: 'input[autocomplete="username"]', priority: 2 },
                { placeholder: /usuário|username|email/i, priority: 3 },
                { selector: 'input[type="text"]', priority: 4 },
            ],
            'password_input': [
                { selector: 'input[name="password"]', priority: 1 },
                { selector: 'input[type="password"]', priority: 2 },
            ],
            'expand_comments': [
                { text: /ver todos os \d+ comentários/i, priority: 1 },
                { text: /view all \d+ comments/i, priority: 1 },
                { text: /ver \d+ comentários/i, priority: 2 },
                { selector: 'span:has-text("comentário")', priority: 3 },
            ]
        };

        const elementStrategies = strategies[elementType];
        if (!elementStrategies) {
            logger.warn(`[PAGE-DETECTOR] Unknown element type: ${elementType}`);
            return null;
        }

        // Try each strategy in priority order
        for (const strategy of elementStrategies.sort((a, b) => a.priority - b.priority)) {
            try {
                let element = null;

                if (strategy.selector) {
                    element = await page.$(strategy.selector);
                } else if (strategy.text) {
                    element = await page.getByText(strategy.text).first();
                } else if (strategy.placeholder) {
                    element = await page.locator(`input[placeholder]`).filter({
                        hasText: strategy.placeholder
                    }).first();
                }

                if (element && await element.isVisible()) {
                    const text = await element.textContent().catch(() => '');
                    logger.info(`[PAGE-DETECTOR] Found ${elementType} with strategy: ${JSON.stringify(strategy)}`);
                    return {
                        element,
                        strategy,
                        text: text?.substring(0, 50)
                    };
                }
            } catch (e) {
                // Try next strategy
            }
        }

        logger.warn(`[PAGE-DETECTOR] Could not find element: ${elementType}`);
        return null;
    }

    /**
     * Get recommended action for current page
     */
    async getRecommendedAction(page) {
        const analysis = await this.analyzePage(page);

        const actions = {
            'login': {
                action: 'fill_credentials',
                steps: ['find_username', 'fill_username', 'find_password', 'fill_password', 'click_login']
            },
            'two_factor': {
                action: 'enter_2fa_code',
                steps: ['find_code_input', 'fill_code', 'submit']
            },
            'challenge': {
                action: 'handle_challenge',
                steps: ['identify_challenge_type', 'handle_accordingly']
            },
            'post': {
                action: 'scrape_comments',
                steps: ['check_comments_visible', 'expand_if_needed', 'scroll_and_load', 'extract']
            },
            'home_feed': {
                action: 'already_logged_in',
                steps: ['navigate_to_target']
            }
        };

        return {
            pageType: analysis.pageType,
            confidence: analysis.confidence,
            ...(actions[analysis.pageType] || { action: 'unknown', steps: [] })
        };
    }
}

module.exports = new PageDetectorService();
