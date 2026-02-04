/**
 * Vision Analyzer Service
 * Uses Claude Vision or GPT-4V to analyze screenshots and suggest selectors
 * Provides a second layer of analysis when DOM-based selector discovery fails
 */

const fs = require('fs').promises;
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');

class VisionAnalyzerService {
    constructor() {
        this.supabase = createClient(config.supabase.url, config.supabase.key);
        // Use same OpenAI API key as aiSelectorFallback service
        this.openaiApiKey = process.env.OPENAI_API_KEY;
        this.analysisCache = new Map();
        this.cacheTimeout = 5 * 60 * 1000; // 5 minutes cache
    }

    /**
     * Check if vision analysis is configured
     * Uses same OPENAI_API_KEY as aiSelectorFallback service
     * @returns {boolean}
     */
    isConfigured() {
        return !!this.openaiApiKey;
    }

    /**
     * Get the configured provider
     * Prioritizes OpenAI since that's what the system already uses
     * @returns {string|null}
     */
    getProvider() {
        if (this.openaiApiKey) return 'openai';
        return null;
    }

    /**
     * Analyze a screenshot to find a missing element
     * @param {string} screenshotPath - Path to the screenshot file
     * @param {string} elementName - Name of the element we're looking for
     * @param {string} context - Page context (login, post, 2fa, etc.)
     * @returns {Object} Analysis result with suggested selectors
     */
    async analyzeFailure(screenshotPath, elementName, context) {
        if (!this.isConfigured()) {
            logger.warn('[VISION] No vision API configured');
            return null;
        }

        // Check cache
        const cacheKey = `${context}:${elementName}`;
        const cached = this.analysisCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
            logger.debug(`[VISION] Using cached analysis for ${cacheKey}`);
            return cached.result;
        }

        try {
            // Read screenshot
            const imageBuffer = await fs.readFile(screenshotPath);
            const imageBase64 = imageBuffer.toString('base64');
            const mimeType = this.getMimeType(screenshotPath);

            // Build the analysis prompt
            const prompt = this.buildAnalysisPrompt(elementName, context);

            // Call OpenAI GPT-4 Vision API (same provider as aiSelectorFallback)
            const result = await this.callGPT4Vision(imageBase64, mimeType, prompt);

            if (result) {
                // Cache the result
                this.analysisCache.set(cacheKey, {
                    timestamp: Date.now(),
                    result
                });

                // Log the analysis
                await this.logAnalysis(screenshotPath, elementName, context, result);
            }

            return result;

        } catch (error) {
            logger.error('[VISION] Analysis failed:', error.message);
            return null;
        }
    }

    /**
     * Build the analysis prompt for the vision model
     */
    buildAnalysisPrompt(elementName, context) {
        const elementDescriptions = {
            'login_button': 'the login/sign-in button to submit credentials',
            'username_field': 'the username or email input field',
            'password_field': 'the password input field',
            '2fa_input': 'the 2FA/verification code input field (usually 6-8 digits)',
            'view_more_comments': 'the "View all X comments" button/link',
            'comment_list': 'the container holding all comment items',
            'comment_item': 'an individual comment (username + text)',
            'next_page': 'the button to load more comments or next page',
            'close_modal': 'the button to close a dialog/modal',
            'save_login_dismiss': 'the button to dismiss "Save Login Info" popup'
        };

        const description = elementDescriptions[elementName] || `the element named "${elementName}"`;

        return `You are analyzing an Instagram ${context} page screenshot.

TASK: Find ${description}

I need you to:
1. Determine if the element is visible on the page
2. Describe its exact visual location (top/bottom, left/right/center)
3. Describe what it looks like (color, text, icon)
4. Suggest CSS selectors that might work to find it

IMPORTANT CONTEXT:
- This is Instagram's web interface (not mobile app)
- Instagram uses obfuscated class names that change frequently
- Prefer selectors based on: aria-labels, data-testid, text content, structure

RESPOND IN JSON FORMAT ONLY:
{
  "elementFound": true/false,
  "confidence": 0.0-1.0,
  "location": {
    "description": "e.g., center-right of the page, below the post image",
    "approximate": {
      "top": "percentage from top",
      "left": "percentage from left"
    }
  },
  "visualDescription": "what the element looks like",
  "textContent": "any visible text on or near the element",
  "suggestedSelectors": [
    "most specific selector",
    "backup selector"
  ],
  "selectorReasoning": "why these selectors should work",
  "layoutChanged": true/false,
  "changeDescription": "if layout seems different from typical Instagram",
  "alternativeAction": "if element not found, what else could be tried"
}`;
    }

    /**
     * Call GPT-4 Vision API
     * Uses the same OpenAI API key as aiSelectorFallback service
     */
    async callGPT4Vision(imageBase64, mimeType, prompt) {
        try {
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.openaiApiKey}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    messages: [{
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: prompt
                            },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:${mimeType};base64,${imageBase64}`
                                }
                            }
                        ]
                    }],
                    max_tokens: 1024,
                    response_format: { type: 'json_object' }
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();
            const content = data.choices?.[0]?.message?.content;

            if (content) {
                const parsed = JSON.parse(content);
                logger.info(`[VISION] GPT-4V found element: ${parsed.elementFound} (confidence: ${parsed.confidence})`);
                return parsed;
            }

            return null;

        } catch (error) {
            logger.error('[VISION] GPT-4V API call failed:', error.message);
            throw error;
        }
    }

    /**
     * Get MIME type from file path
     */
    getMimeType(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.webp': 'image/webp'
        };
        return mimeTypes[ext] || 'image/png';
    }

    /**
     * Log analysis to database for debugging
     */
    async logAnalysis(screenshotPath, elementName, context, result) {
        try {
            await this.supabase
                .from('vision_analysis_logs')
                .insert({
                    element_name: elementName,
                    page_context: context,
                    screenshot_path: screenshotPath,
                    provider: this.getProvider(),
                    element_found: result.elementFound,
                    confidence: result.confidence,
                    suggested_selectors: result.suggestedSelectors,
                    analysis_result: result,
                    created_at: new Date().toISOString()
                });
        } catch (e) {
            logger.debug('[VISION] Could not log analysis:', e.message);
        }
    }

    /**
     * Analyze multiple pages to detect layout pattern changes
     * @param {Array<string>} screenshotPaths - Paths to screenshots
     * @param {string} pageType - Type of page
     * @returns {Object} Pattern analysis
     */
    async analyzeLayoutPatterns(screenshotPaths, pageType) {
        if (!this.isConfigured() || screenshotPaths.length < 2) {
            return null;
        }

        try {
            const analyses = [];
            for (const screenshotPath of screenshotPaths.slice(0, 3)) { // Max 3
                const analysis = await this.analyzeFailure(screenshotPath, 'page_layout', pageType);
                if (analysis) analyses.push(analysis);
            }

            // Compare analyses to detect consistent patterns
            if (analyses.length >= 2) {
                const consistent = analyses.every(a => a.layoutChanged === analyses[0].layoutChanged);
                return {
                    samplesAnalyzed: analyses.length,
                    layoutChanged: analyses[0].layoutChanged,
                    consistent,
                    analyses
                };
            }

            return null;

        } catch (error) {
            logger.error('[VISION] Pattern analysis failed:', error.message);
            return null;
        }
    }

    /**
     * Validate that a selector matches the expected visual element
     * @param {Page} page - Playwright page
     * @param {string} selector - CSS selector to validate
     * @param {string} elementName - Expected element type
     * @returns {boolean} Whether selector matches expected element
     */
    async validateSelector(page, selector, elementName) {
        if (!this.isConfigured()) {
            return true; // Can't validate, assume correct
        }

        try {
            // Find the element
            const element = await page.$(selector);
            if (!element) return false;

            // Take screenshot of just that element
            const screenshotBuffer = await element.screenshot();
            const tempPath = `/tmp/validate_${Date.now()}.png`;
            await fs.writeFile(tempPath, screenshotBuffer);

            // Analyze
            const prompt = `Does this screenshot show ${elementName}?
Answer only: {"matches": true/false, "confidence": 0.0-1.0, "reason": "why"}`;

            // Use OpenAI GPT-4 Vision
            const result = await this.callGPT4Vision(
                screenshotBuffer.toString('base64'),
                'image/png',
                prompt
            );

            // Cleanup
            await fs.unlink(tempPath).catch(() => {});

            return result?.matches && result?.confidence > 0.7;

        } catch (error) {
            logger.error('[VISION] Validation failed:', error.message);
            return true; // Assume correct on error
        }
    }

    /**
     * Clear the analysis cache
     */
    clearCache() {
        this.analysisCache.clear();
        logger.info('[VISION] Cache cleared');
    }
}

module.exports = new VisionAnalyzerService();
