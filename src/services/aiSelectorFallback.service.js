/**
 * AI Selector Fallback Service
 * Uses LLM to discover CSS selectors when traditional ones fail
 * 
 * Features:
 * - Caches discovered selectors in Supabase
 * - Supports multiple LLM providers (OpenAI, Gemini)
 * - Logs all AI analysis for debugging
 * - Tracks success/failure rates per selector
 */

const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');

class AISelectorFallbackService {
    constructor() {
        this.supabase = createClient(config.supabase.url, config.supabase.key);
        this.openaiApiKey = process.env.OPENAI_API_KEY;
        this.selectorCache = new Map(); // In-memory cache for fast access
        this.initialized = false;
    }

    /**
     * Initialize service and load cached selectors
     */
    async initialize() {
        if (this.initialized) return;

        try {
            // Load all selectors into memory cache
            const { data: selectors, error } = await this.supabase
                .from('selector_registry')
                .select('*');

            if (error) {
                logger.warn('[AI-FALLBACK] Could not load selector registry:', error.message);
            } else if (selectors) {
                selectors.forEach(s => {
                    const key = `${s.selector_context}:${s.selector_name}`;
                    this.selectorCache.set(key, s);
                });
                logger.info(`[AI-FALLBACK] Loaded ${selectors.length} selectors into cache`);
            }

            this.initialized = true;
        } catch (error) {
            logger.error('[AI-FALLBACK] Initialization error:', error.message);
        }
    }

    /**
     * Get selector from cache or database
     * @param {string} name - Selector name (e.g., 'comment_list')
     * @param {string} context - Page context (e.g., 'post_page')
     * @returns {Object|null} Selector data
     */
    async getSelector(name, context) {
        await this.initialize();

        const key = `${context}:${name}`;

        // Check memory cache first
        if (this.selectorCache.has(key)) {
            return this.selectorCache.get(key);
        }

        // Try database
        const { data, error } = await this.supabase
            .from('selector_registry')
            .select('*')
            .eq('selector_name', name)
            .eq('selector_context', context)
            .single();

        if (data) {
            this.selectorCache.set(key, data);
            return data;
        }

        return null;
    }

    /**
     * Get all selectors to try (primary + fallbacks)
     * @param {string} name - Selector name
     * @param {string} context - Page context
     * @returns {string[]} Array of selectors to try
     */
    async getAllSelectorsToTry(name, context) {
        const selectorData = await this.getSelector(name, context);

        if (!selectorData) {
            logger.warn(`[AI-FALLBACK] No selector found: ${context}:${name}`);
            return [];
        }

        const selectors = [selectorData.primary_selector];

        if (selectorData.fallback_selectors && Array.isArray(selectorData.fallback_selectors)) {
            selectors.push(...selectorData.fallback_selectors);
        }

        return selectors;
    }

    /**
     * Try to find element using registered selectors
     * @param {Page} page - Playwright page
     * @param {string} name - Selector name
     * @param {string} context - Page context
     * @returns {Object} { element, usedSelector, fromAI }
     */
    async findElement(page, name, context) {
        const selectors = await this.getAllSelectorsToTry(name, context);

        // Try each selector
        for (const selector of selectors) {
            try {
                const element = await page.$(selector);
                if (element && await element.isVisible()) {
                    logger.debug(`[AI-FALLBACK] Found ${name} with: ${selector}`);

                    // Record success
                    await this.recordSuccess(name, context, selector);

                    return {
                        element,
                        usedSelector: selector,
                        fromAI: false
                    };
                }
            } catch (e) {
                // Try next selector
            }
        }

        // All selectors failed - try AI discovery
        logger.info(`[AI-FALLBACK] All selectors failed for ${name}, trying AI discovery...`);
        return await this.discoverSelectorWithAI(page, name, context);
    }

    /**
     * Find all elements matching a selector pattern
     * @param {Page} page - Playwright page
     * @param {string} name - Selector name
     * @param {string} context - Page context
     * @returns {Object} { elements, usedSelector, fromAI }
     */
    async findAllElements(page, name, context) {
        const selectors = await this.getAllSelectorsToTry(name, context);

        // Try each selector
        for (const selector of selectors) {
            try {
                const elements = await page.$$(selector);
                if (elements && elements.length > 0) {
                    logger.debug(`[AI-FALLBACK] Found ${elements.length} ${name} with: ${selector}`);

                    // Record success
                    await this.recordSuccess(name, context, selector);

                    return {
                        elements,
                        usedSelector: selector,
                        fromAI: false,
                        count: elements.length
                    };
                }
            } catch (e) {
                // Try next selector
            }
        }

        // All selectors failed - try AI discovery
        logger.info(`[AI-FALLBACK] All selectors failed for ${name}, trying AI discovery...`);
        return await this.discoverSelectorWithAI(page, name, context, true);
    }

    /**
     * Use AI to discover new selectors
     * @param {Page} page - Playwright page
     * @param {string} name - What we're looking for
     * @param {string} context - Page context
     * @param {boolean} findAll - Whether to find all or single element
     * @returns {Object} { element(s), usedSelector, fromAI }
     */
    async discoverSelectorWithAI(page, name, context, findAll = false) {
        if (!this.openaiApiKey) {
            logger.warn('[AI-FALLBACK] OpenAI API key not configured');
            return { element: null, elements: [], usedSelector: null, fromAI: false };
        }

        try {
            // Get relevant HTML snippet (limited to avoid token explosion)
            const html = await page.evaluate(() => {
                // Get body content, but limit size
                const body = document.body;
                if (!body) return '';

                // Try to get just the main content area
                const main = document.querySelector('main') ||
                    document.querySelector('article') ||
                    document.querySelector('[role="main"]') ||
                    body;

                return main.outerHTML.substring(0, 30000);
            });

            const pageUrl = page.url();

            // Build prompt based on what we're looking for
            const prompt = this.buildDiscoveryPrompt(name, context, html);

            // Call OpenAI
            const response = await this.callOpenAI(prompt);

            if (response && response.selectors && response.selectors.length > 0) {
                // Try the discovered selectors
                for (const selector of response.selectors) {
                    try {
                        if (findAll) {
                            const elements = await page.$$(selector);
                            if (elements && elements.length > 0) {
                                // Save to registry
                                await this.saveDiscoveredSelector(name, context, selector, response.selectors, response.confidence);

                                // Log the discovery
                                await this.logAIAnalysis(pageUrl, name, html.length, prompt, 'gpt-4o-mini', response, true);

                                return {
                                    elements,
                                    usedSelector: selector,
                                    fromAI: true,
                                    count: elements.length
                                };
                            }
                        } else {
                            const element = await page.$(selector);
                            if (element && await element.isVisible()) {
                                // Save to registry
                                await this.saveDiscoveredSelector(name, context, selector, response.selectors, response.confidence);

                                // Log the discovery
                                await this.logAIAnalysis(pageUrl, name, html.length, prompt, 'gpt-4o-mini', response, true);

                                return {
                                    element,
                                    usedSelector: selector,
                                    fromAI: true
                                };
                            }
                        }
                    } catch (e) {
                        // Try next AI-suggested selector
                    }
                }

                // AI selectors didn't work
                await this.logAIAnalysis(pageUrl, name, html.length, prompt, 'gpt-4o-mini', response, false, 'AI selectors did not match any elements');
            }

        } catch (error) {
            logger.error('[AI-FALLBACK] AI discovery error:', error.message);
        }

        return {
            element: null,
            elements: [],
            usedSelector: null,
            fromAI: false
        };
    }

    /**
     * Build prompt for selector discovery
     */
    buildDiscoveryPrompt(name, context, html) {
        const descriptions = {
            'comment_list': 'a list or container of user comments on an Instagram post',
            'comment_item': 'individual comment items within a comments section',
            'comment_username': 'the username/author of a comment',
            'comment_text': 'the actual text content of a comment',
            'login_button': 'the login/submit button on a login form',
            'username_field': 'the username/email input field',
            'password_field': 'the password input field',
            'post_author': 'the author/username of the Instagram post',
            'likes_count': 'the number of likes on a post',
            'view_more_comments': 'a button or link to load more comments'
        };

        const description = descriptions[name] || `elements named "${name}"`;

        return `You are an expert web scraper analyzing Instagram's HTML structure.

TASK: Find CSS selectors for "${description}" on a ${context}.

HTML SNIPPET (partial page):
\`\`\`html
${html}
\`\`\`

REQUIREMENTS:
1. Return 3-5 CSS selectors that could match ${description}
2. Order by specificity (most specific first)
3. Prefer semantic selectors (aria-labels, roles, data attributes)
4. Avoid very generic selectors that could match unrelated elements
5. Consider Instagram uses React, so classes may be obfuscated

RESPONSE FORMAT (JSON only):
{
  "selectors": ["selector1", "selector2", "selector3"],
  "confidence": 0.85,
  "reasoning": "Brief explanation"
}`;
    }

    /**
     * Call OpenAI API
     */
    async callOpenAI(prompt) {
        try {
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.openaiApiKey}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [
                        {
                            role: 'system',
                            content: 'You are an expert at analyzing HTML and finding CSS selectors. Always respond with valid JSON only.'
                        },
                        {
                            role: 'user',
                            content: prompt
                        }
                    ],
                    temperature: 0.3,
                    max_tokens: 500,
                    response_format: { type: 'json_object' }
                })
            });

            if (!response.ok) {
                throw new Error(`OpenAI API error: ${response.status}`);
            }

            const data = await response.json();
            const content = data.choices[0]?.message?.content;

            if (content) {
                const parsed = JSON.parse(content);
                logger.info(`[AI-FALLBACK] AI discovered ${parsed.selectors?.length || 0} selectors with confidence ${parsed.confidence}`);
                return parsed;
            }

        } catch (error) {
            logger.error('[AI-FALLBACK] OpenAI call failed:', error.message);
        }

        return null;
    }

    /**
     * Save discovered selector to database
     */
    async saveDiscoveredSelector(name, context, primarySelector, allSelectors, confidence) {
        try {
            const fallbacks = allSelectors.filter(s => s !== primarySelector);

            const { error } = await this.supabase
                .from('selector_registry')
                .upsert({
                    selector_name: name,
                    selector_context: context,
                    primary_selector: primarySelector,
                    fallback_selectors: fallbacks,
                    discovered_by: 'ai_gpt4',
                    confidence_score: confidence || 0.8,
                    success_count: 1,
                    last_success_at: new Date().toISOString()
                }, {
                    onConflict: 'selector_name,selector_context'
                });

            if (error) {
                logger.warn('[AI-FALLBACK] Could not save selector:', error.message);
            } else {
                logger.info(`[AI-FALLBACK] Saved new selector for ${context}:${name}`);

                // Update memory cache
                const key = `${context}:${name}`;
                this.selectorCache.set(key, {
                    selector_name: name,
                    selector_context: context,
                    primary_selector: primarySelector,
                    fallback_selectors: fallbacks
                });
            }

        } catch (error) {
            logger.error('[AI-FALLBACK] Error saving selector:', error.message);
        }
    }

    /**
     * Record successful selector use
     */
    async recordSuccess(name, context, usedSelector) {
        try {
            await this.supabase
                .from('selector_registry')
                .update({
                    success_count: this.supabase.rpc('increment', { x: 1 }),
                    last_success_at: new Date().toISOString()
                })
                .eq('selector_name', name)
                .eq('selector_context', context);
        } catch (error) {
            // Non-critical, just log
            logger.debug('[AI-FALLBACK] Could not record success:', error.message);
        }
    }

    /**
     * Record failed selector use
     */
    async recordFailure(name, context) {
        try {
            await this.supabase
                .from('selector_registry')
                .update({
                    failure_count: this.supabase.rpc('increment', { x: 1 }),
                    last_failure_at: new Date().toISOString()
                })
                .eq('selector_name', name)
                .eq('selector_context', context);
        } catch (error) {
            logger.debug('[AI-FALLBACK] Could not record failure:', error.message);
        }
    }

    /**
     * Log AI analysis for debugging
     */
    async logAIAnalysis(pageUrl, selectorName, htmlLength, prompt, model, response, wasSuccessful, errorMessage = null) {
        try {
            await this.supabase
                .from('ai_analysis_log')
                .insert({
                    page_url: pageUrl,
                    selector_name: selectorName,
                    html_snippet_length: htmlLength,
                    prompt_used: prompt.substring(0, 5000), // Limit prompt size
                    model_used: model,
                    selectors_found: response?.selectors || [],
                    confidence_score: response?.confidence || 0,
                    tokens_used: null, // Would need to extract from response
                    cost_usd: null,
                    was_successful: wasSuccessful,
                    error_message: errorMessage
                });
        } catch (error) {
            logger.debug('[AI-FALLBACK] Could not log analysis:', error.message);
        }
    }

    /**
     * Extract comments directly using AI (when selectors fail completely)
     * This is a more expensive but more reliable fallback
     * @param {Page} page - Playwright page
     * @param {string} postId - Post ID
     * @param {string} postUrl - Post URL
     * @returns {Array} Extracted comments
     */
    async extractCommentsDirectly(page, postId, postUrl) {
        if (!this.openaiApiKey) {
            logger.warn('[AI-FALLBACK] OpenAI API key not configured for direct extraction');
            return [];
        }

        try {
            logger.info('[AI-FALLBACK] 🤖 Attempting direct AI comment extraction...');

            // Get the full article/main content HTML
            const html = await page.evaluate(() => {
                const article = document.querySelector('article');
                if (article) return article.outerHTML;

                const main = document.querySelector('main');
                if (main) return main.outerHTML;

                return document.body.outerHTML.substring(0, 50000);
            });

            // Also get the visible text for context
            const visibleText = await page.evaluate(() => {
                const article = document.querySelector('article');
                return article ? article.innerText : document.body.innerText.substring(0, 10000);
            });

            const prompt = `You are an expert at extracting Instagram comments from HTML.

TASK: Extract ALL user comments from this Instagram post page.

VISIBLE TEXT ON PAGE:
"""
${visibleText.substring(0, 3000)}
"""

HTML STRUCTURE:
\`\`\`html
${html.substring(0, 25000)}
\`\`\`

INSTRUCTIONS:
1. Look for patterns like: username followed by comment text
2. Comments usually appear after the main post caption
3. Usernames are typically links to profiles
4. Ignore the post author's caption - only extract OTHER users' comments
5. Each comment has: username, text, possibly a timestamp

RESPONSE FORMAT (JSON only):
{
  "comments": [
    {"username": "user1", "text": "comment text here"},
    {"username": "user2", "text": "another comment"}
  ],
  "found_count": 2,
  "confidence": 0.9,
  "notes": "Any observations about the page structure"
}

If you cannot find any comments, return:
{
  "comments": [],
  "found_count": 0,
  "confidence": 0.5,
  "notes": "Explain why no comments were found"
}`;

            // Call OpenAI with larger token limit for extraction
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.openaiApiKey}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [
                        {
                            role: 'system',
                            content: 'You are an expert at extracting structured data from web pages. Always respond with valid JSON only.'
                        },
                        {
                            role: 'user',
                            content: prompt
                        }
                    ],
                    temperature: 0.2,
                    max_tokens: 2000,
                    response_format: { type: 'json_object' }
                })
            });

            if (!response.ok) {
                throw new Error(`OpenAI API error: ${response.status}`);
            }

            const data = await response.json();
            const content = data.choices[0]?.message?.content;

            if (content) {
                const parsed = JSON.parse(content);

                logger.info(`[AI-FALLBACK] 🤖 AI extracted ${parsed.found_count} comments with confidence ${parsed.confidence}`);

                if (parsed.notes) {
                    logger.info(`[AI-FALLBACK] AI notes: ${parsed.notes}`);
                }

                // Convert to our comment format
                const comments = (parsed.comments || []).map((c, index) => ({
                    post_id: postId,
                    post_url: postUrl,
                    comment_id: `ai_${Date.now()}_${index}`,
                    text: c.text,
                    username: c.username,
                    created_at: new Date().toISOString(),
                    user_id: '',
                    profile_pic_url: '',
                    like_count: 0,
                    extracted_by: 'ai_direct'
                }));

                // Log the extraction
                await this.supabase
                    .from('ai_analysis_log')
                    .insert({
                        page_url: postUrl,
                        selector_name: 'direct_extraction',
                        html_snippet_length: html.length,
                        prompt_used: prompt.substring(0, 5000),
                        model_used: 'gpt-4o-mini',
                        selectors_found: [],
                        confidence_score: parsed.confidence,
                        was_successful: comments.length > 0,
                        error_message: parsed.notes
                    }).catch(() => { });

                return comments;
            }

        } catch (error) {
            logger.error('[AI-FALLBACK] Direct extraction error:', error.message);
        }

        return [];
    }
}

// Export singleton instance
module.exports = new AISelectorFallbackService();
