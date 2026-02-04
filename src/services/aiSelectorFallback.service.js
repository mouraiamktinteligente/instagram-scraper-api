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
            // ⭐ NEW: Filter out generic selectors even if they are in the registry
            if (this.isGenericSelector(selector)) {
                logger.debug(`[AI-FALLBACK] Skipping generic selector from registry: ${selector}`);
                continue;
            }

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
            // ⭐ NEW: Filter out generic selectors even if they are in the registry
            if (this.isGenericSelector(selector)) {
                logger.debug(`[AI-FALLBACK] Skipping generic selector from registry: ${selector}`);
                continue;
            }

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
     * Check if a selector is too generic and should be rejected
     * These selectors match too many elements and cause wrong clicks
     * @param {string} selector - CSS selector to check
     * @returns {boolean} true if too generic
     */
    isGenericSelector(selector) {
        // List of patterns that are too generic
        const genericPatterns = [
            /^\[role=['"]?button['"]?\]$/i,
            /^\[tabindex=['"]?0['"]?\]$/i,
            /^\[role=['"]?button['"]?\]\[tabindex/i,
            /^div$/i,
            /^span$/i,
            /^button$/i,
            /^a$/i,
            /^\[class\^=['"]?x['"]?\]/i,  // Instagram obfuscated classes alone
            /^\*$/,  // Universal selector
        ];

        // Check if selector is too short (likely generic)
        if (selector.length < 5) {
            logger.debug(`[AI-FALLBACK] Rejected selector (too short): ${selector}`);
            return true;
        }

        // Check against generic patterns
        for (const pattern of genericPatterns) {
            if (pattern.test(selector)) {
                logger.debug(`[AI-FALLBACK] Rejected generic selector: ${selector}`);
                return true;
            }
        }

        // Additional patterns for common obfuscated or generic selectors
        if (selector.includes('[tabindex="0"]') && selector.includes('[role="button"]') && selector.length < 35) {
            logger.debug(`[AI-FALLBACK] Rejected generic button with tabindex: ${selector}`);
            return true;
        }

        if (selector.match(/^\[aria-label=.*\]$/i) && selector.length < 15) {
            // Too short aria-label selectors are often generic
            return true;
        }

        // Instagram specific: obfuscated classes without enough context
        if (selector.match(/^(\.[a-z0-9_-]{3,10}){1,2}$/i)) {
            logger.debug(`[AI-FALLBACK] Rejected shallow obfuscated classes: ${selector}`);
            return true;
        }

        // Additional patterns for common obfuscated or generic selectors
        if (selector.includes('[tabindex="0"]') && selector.includes('[role="button"]') && selector.length < 30) {
            logger.debug(`[AI-FALLBACK] Rejected generic button with tabindex: ${selector}`);
            return true;
        }

        if (selector.match(/^\[aria-label=.*\]$/i) && selector.length < 15) {
            // Too short aria-label selectors are often generic
            return true;
        }

        // Check if it's a simple attribute selector without context
        const simpleAttrPattern = /^\[[a-z-]+=['"]?[a-z0-9]+['"]?\]$/i;
        if (simpleAttrPattern.test(selector) && !selector.includes(':')) {
            // Unless it's a very specific attribute like data-testid
            if (!selector.includes('data-testid') && !selector.includes('aria-label')) {
                logger.debug(`[AI-FALLBACK] Rejected simple attribute selector: ${selector}`);
                return true;
            }
        }

        return false;
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
                // Filter out generic selectors that could match wrong elements
                const validSelectors = response.selectors.filter(selector => {
                    return !this.isGenericSelector(selector);
                });

                if (validSelectors.length === 0) {
                    logger.warn(`[AI-FALLBACK] All AI selectors were too generic, rejecting`);
                    return {
                        element: null,
                        elements: [],
                        usedSelector: null,
                        fromAI: false,
                        rejected: 'all_too_generic'
                    };
                }

                // Try the validated selectors
                for (const selector of validSelectors) {
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
     * Build intelligent prompt for selector discovery
     * Provides detailed context about what to find, when to find it, and validation rules
     */
    buildDiscoveryPrompt(name, context, html) {
        // Detailed descriptions with validation criteria
        const elementSpecs = {
            'comment_list': {
                description: 'a container element holding all user comments',
                mustContain: 'Multiple usernames and comment texts',
                mustNot: 'Be a single comment or the post caption',
                hints: 'Usually a <ul> or <div> with multiple child elements',
                validateBy: 'Should contain at least 2+ different usernames'
            },
            'comment_item': {
                description: 'individual comment item (one comment)',
                mustContain: 'A username link and comment text',
                mustNot: 'Be the post caption or a reply container',
                hints: 'Usually <li> or <div> with a link to user profile',
                validateBy: 'Contains exactly one username and one comment text'
            },
            'comment_username': {
                description: 'the clickable username of a comment author',
                mustContain: 'A valid Instagram username (no spaces)',
                mustNot: 'Be the post author or a mention',
                hints: 'Usually an <a> tag with href containing the username',
                validateBy: 'href starts with / and is a valid username format'
            },
            'comment_text': {
                description: 'the actual text content of a comment',
                mustContain: 'User-written text (not system generated)',
                mustNot: 'Be a timestamp, like count, or button text',
                hints: 'Usually a <span> adjacent to username',
                validateBy: 'Content is not a number and not a date format'
            },
            'view_more_comments': {
                description: 'button/link to expand all comments',
                mustContain: 'Text with number + "comment" (e.g., "Ver todos os 26 comentários")',
                mustNot: 'Be a like button, share button, or generic button',
                hints: 'Usually <span> or <a> with text matching "Ver todos" or "View all"',
                validateBy: 'Text matches pattern: Ver/View + number + comentário/comment',
                rejectIfGeneric: true
            },
            'login_button': {
                description: 'the button to submit login form',
                mustContain: 'Text "Entrar", "Log in", or "Sign in"',
                mustNot: 'Be the signup button or any link',
                hints: 'Usually <button type="submit"> or div[role="button"]',
                validateBy: 'Is inside a form and has submit-like text'
            },
            'username_field': {
                description: 'input field for username/email on login',
                mustContain: 'input element with name or placeholder for username',
                mustNot: 'Be the password field or search box',
                hints: 'input[name="username"] or input with placeholder containing "user"',
                validateBy: 'Has type="text" or no type and is in a login form'
            },
            'password_field': {
                description: 'input field for password on login',
                mustContain: 'input element with type password',
                mustNot: 'Be any other input field',
                hints: 'input[type="password"]',
                validateBy: 'Has type="password"'
            }
        };

        const spec = elementSpecs[name] || {
            description: `element named "${name}"`,
            mustContain: 'Relevant content',
            mustNot: 'Be unrelated elements',
            hints: 'Standard web element',
            validateBy: 'Match expected content'
        };

        return `You are an EXPERT Instagram web scraper with deep understanding of HTML structures.

TASK: Find the CSS selector for "${spec.description}" on a ${context} page.

ELEMENT SPECIFICATION:
- MUST CONTAIN: ${spec.mustContain}
- MUST NOT BE: ${spec.mustNot}  
- HINTS: ${spec.hints}
- VALIDATE BY: ${spec.validateBy}

HTML SNIPPET (partial Instagram page):
\`\`\`html
${html}
\`\`\`

CRITICAL RULES (MUST FOLLOW):
1. ❌ NEVER return generic selectors like:
   - [role='button']
   - [tabindex='0']  
   - div or span without specificity
   - [class^='x'] (obfuscated classes alone)

2. ✅ PREFER selectors that include:
   - Text content matching (e.g., contains "comentário")
   - Structural context (e.g., article > div > ul > li)
   - Multiple conditions (e.g., span:has(a[href*="/"]))
   - Semantic attributes when available

3. 🎯 SPECIFICITY ORDER:
   - data-testid attributes (highest priority)
   - aria-label with specific text
   - Text content patterns
   - Structural path from known parent
   - Class combinations (last resort)

4. 🔍 FOR "${name}" SPECIFICALLY:
   - The selector MUST be unique enough to find ONLY the target element
   - If you can't find a good selector, return empty array
   - Better to return nothing than a wrong selector

RESPONSE FORMAT (JSON only):
{
  "selectors": ["most_specific_selector", "backup_selector"],
  "confidence": 0.0 to 1.0,
  "reasoning": "Why these selectors will work",
  "validation": "How to verify the selector is correct",
  "warning": "Any concerns about selector reliability"
}

If you cannot find a reliable selector, return:
{
  "selectors": [],
  "confidence": 0,
  "reasoning": "Could not find unique selector for ${name}",
  "validation": null,
  "warning": "Element may not exist or page structure unclear"
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

                logger.info(`[AI-FALLBACK] Converted ${comments.length} comments to standard format`);

                // Log the extraction (non-blocking)
                this.supabase
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
                    }).then(() => {
                        logger.debug('[AI-FALLBACK] Logged extraction to database');
                    }).catch((logErr) => {
                        logger.debug('[AI-FALLBACK] Could not log to database:', logErr.message);
                    });

                return comments;
            }

        } catch (error) {
            logger.error('[AI-FALLBACK] Direct extraction error:', error?.message || error || 'Unknown error');
            logger.error('[AI-FALLBACK] Error stack:', error?.stack);
        }

        return [];
    }

    /**
     * Detect total number of comments on the page
     * Looks for patterns like "Ver todos os 31 comentários" or "31 comments"
     * @param {Page} page
     * @returns {Promise<{total: number, expandButtonText: string|null}>}
     */
    async detectTotalComments(page) {
        try {
            const result = await page.evaluate(() => {
                // Patterns to find comment counts
                const patterns = [
                    /ver\s+todos?\s+os?\s+(\d+)\s+coment[áa]rios?/i,
                    /(\d+)\s+coment[áa]rios?/i,
                    /view\s+all\s+(\d+)\s+comments?/i,
                    /(\d+)\s+comments?/i,
                ];

                // Get all text from clickable elements
                const elements = document.querySelectorAll('a, span, button, div[role="button"]');

                for (const el of elements) {
                    const text = el.innerText?.trim() || '';

                    for (const pattern of patterns) {
                        const match = text.match(pattern);
                        if (match && match[1]) {
                            const count = parseInt(match[1], 10);
                            if (count > 0 && count < 10000) { // Sanity check
                                return {
                                    total: count,
                                    expandButtonText: text.substring(0, 100)
                                };
                            }
                        }
                    }
                }

                // Fallback: look in meta tags
                const description = document.querySelector('meta[property="og:description"]')?.content || '';
                const metaMatch = description.match(/(\d+)\s+comment/i);
                if (metaMatch) {
                    return {
                        total: parseInt(metaMatch[1], 10),
                        expandButtonText: null
                    };
                }

                return { total: 0, expandButtonText: null };
            });

            if (result.total > 0) {
                logger.info(`[AI-FALLBACK] Detected ${result.total} total comments`);
                if (result.expandButtonText) {
                    logger.info(`[AI-FALLBACK] Expand button: "${result.expandButtonText}"`);
                }
            }

            return result;

        } catch (error) {
            logger.error('[AI-FALLBACK] Error detecting comment count:', error.message);
            return { total: 0, expandButtonText: null };
        }
    }

    /**
     * Extract ALL comments from a post, using multiple strategies
     * ENHANCED: Iterative extraction with progressive loading
     * 1. First detects total count
     * 2. Expands all replies/threads
     * 3. Scrolls/clicks to load all with multiple iterations
     * 4. Extracts via AI with incremental merging
     * @param {Page} page
     * @param {string} postId
     * @param {string} postUrl
     * @param {Object} scrollContainer - Optional scroll container detected by InstagramService
     * @returns {Promise<{comments: Array, totalExpected: number}>}
     */
    async extractAllCommentsWithAI(page, postId, postUrl, scrollContainer = null) {
        logger.info('[AI-FALLBACK] 🔄 Starting intelligent full comment extraction (ENHANCED)...');

        const allComments = [];
        const seenTexts = new Set();

        // Step 1: Detect total comments
        const { total: totalExpected, expandButtonText } = await this.detectTotalComments(page);
        logger.info(`[AI-FALLBACK] Expected total: ${totalExpected} comments`);

        // Step 2: If we found an expand button, click it
        if (expandButtonText) {
            try {
                const clicked = await page.evaluate((buttonText) => {
                    const elements = document.querySelectorAll('a, span, button, div[role="button"]');
                    for (const el of elements) {
                        if (el.innerText?.includes(buttonText.substring(0, 20))) {
                            el.click();
                            return true;
                        }
                    }
                    return false;
                }, expandButtonText);

                if (clicked) {
                    logger.info('[AI-FALLBACK] ✅ Clicked expand button, waiting for comments...');
                    await new Promise(r => setTimeout(r, 3000));
                }
            } catch (e) {
                logger.warn('[AI-FALLBACK] Could not click expand button');
            }
        }

        // Step 3: ENHANCED - Find the correct scroll container
        const container = await page.evaluate(() => {
            // Priority 1: Modal dialog
            const dialog = document.querySelector('div[role="dialog"]');
            if (dialog) {
                // Find scrollable area within dialog
                const scrollables = Array.from(dialog.querySelectorAll('div, section')).filter(el => {
                    const s = window.getComputedStyle(el);
                    return (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
                           el.scrollHeight > el.clientHeight + 30;
                });
                if (scrollables.length > 0) {
                    return { type: 'modal-inner', found: true };
                }
                return { type: 'modal', found: true };
            }

            // Priority 2: Section with UL
            const sections = document.querySelectorAll('section');
            for (const section of sections) {
                if (section.querySelector('ul')) {
                    return { type: 'section', found: true };
                }
            }

            // Priority 3: Article
            const article = document.querySelector('article');
            if (article) return { type: 'article', found: true };

            return { type: 'window', found: false };
        });

        logger.info(`[AI-FALLBACK] Scroll container: ${container.type}`);

        // Step 4: ENHANCED - Iterative scroll + expand + extract cycle
        const MAX_ITERATIONS = 5;
        const MAX_SCROLLS_PER_ITERATION = 15;

        for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
            logger.info(`[AI-FALLBACK] 🔄 Iteration ${iteration + 1}/${MAX_ITERATIONS}`);

            // 4a: Expand all visible "View replies" buttons
            const expandedReplies = await page.evaluate(() => {
                const patterns = [
                    /ver\s+\d+\s*respostas?/i,
                    /view\s+\d+\s*repl/i,
                    /ver\s+respostas?/i,
                    /\d+\s*respostas?/i,
                    /\d+\s*replies?/i,
                    /mostrar\s+respostas/i,
                ];

                let clicked = 0;
                const elements = document.querySelectorAll('span, button, div[role="button"], a');

                for (const el of elements) {
                    const text = el.innerText || el.textContent || '';
                    for (const pattern of patterns) {
                        if (pattern.test(text) && text.length < 50) {
                            try {
                                el.click();
                                clicked++;
                            } catch (e) { /* ignore */ }
                            break;
                        }
                    }
                }
                return clicked;
            });

            if (expandedReplies > 0) {
                logger.info(`[AI-FALLBACK] ✅ Expanded ${expandedReplies} reply threads`);
                await new Promise(r => setTimeout(r, 2000));
            }

            // 4b: Scroll to load more
            let previousHeight = 0;
            let noChangeCount = 0;

            for (let scroll = 0; scroll < MAX_SCROLLS_PER_ITERATION; scroll++) {
                const currentHeight = await page.evaluate((containerType) => {
                    let scrollTarget = null;

                    if (containerType === 'modal' || containerType === 'modal-inner') {
                        const dialog = document.querySelector('div[role="dialog"]');
                        if (dialog) {
                            // Find innermost scrollable
                            const inner = Array.from(dialog.querySelectorAll('div')).find(el => {
                                const s = window.getComputedStyle(el);
                                return (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
                                       el.scrollHeight > el.clientHeight + 30;
                            });
                            scrollTarget = inner || dialog;
                        }
                    } else if (containerType === 'section') {
                        const sections = document.querySelectorAll('section');
                        for (const section of sections) {
                            if (section.querySelector('ul')) {
                                scrollTarget = section;
                                break;
                            }
                        }
                    } else if (containerType === 'article') {
                        scrollTarget = document.querySelector('article');
                    }

                    if (scrollTarget) {
                        scrollTarget.scrollTop = scrollTarget.scrollHeight;
                        return scrollTarget.scrollHeight;
                    }

                    window.scrollTo(0, document.body.scrollHeight);
                    return document.body.scrollHeight;
                }, container.type);

                if (currentHeight === previousHeight) {
                    noChangeCount++;
                    if (noChangeCount >= 3) break;

                    // Try clicking load more
                    await page.evaluate(() => {
                        const loadMorePatterns = [/carregar\s*mais/i, /load\s*more/i, /mais\s*coment/i, /\+/];
                        const elements = document.querySelectorAll('button, span, div[role="button"], a');
                        for (const el of elements) {
                            const text = el.innerText || '';
                            for (const p of loadMorePatterns) {
                                if (p.test(text) && text.length < 30) {
                                    el.click();
                                    return;
                                }
                            }
                        }
                    });
                } else {
                    noChangeCount = 0;
                }

                previousHeight = currentHeight;
                await new Promise(r => setTimeout(r, 800));
            }

            // 4c: Extract comments after this iteration
            const iterationComments = await this.extractCommentsDirectly(page, postId, postUrl);

            // Merge with existing, avoiding duplicates
            let newCount = 0;
            for (const comment of iterationComments) {
                const key = `${comment.username}:${(comment.text || '').substring(0, 50)}`;
                if (!seenTexts.has(key)) {
                    seenTexts.add(key);
                    allComments.push(comment);
                    newCount++;
                }
            }

            logger.info(`[AI-FALLBACK] Iteration ${iteration + 1}: Found ${newCount} new comments (total: ${allComments.length})`);

            // Check if we've reached our target or no new comments
            if (allComments.length >= totalExpected * 0.9) {
                logger.info('[AI-FALLBACK] ✅ Reached ~90% of expected comments, stopping');
                break;
            }

            if (newCount === 0 && iteration > 0) {
                logger.info('[AI-FALLBACK] No new comments found, trying one more scroll cycle');
                // Do one more aggressive scroll
                await page.evaluate(() => {
                    const dialog = document.querySelector('div[role="dialog"]');
                    if (dialog) {
                        dialog.scrollTop = dialog.scrollHeight;
                    }
                    window.scrollTo(0, document.body.scrollHeight);
                });
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        logger.info(`[AI-FALLBACK] ✅ Final extraction: ${allComments.length}/${totalExpected} comments`);

        return {
            comments: allComments,
            totalExpected,
            coverage: totalExpected > 0 ? Math.round((allComments.length / totalExpected) * 100) : 100
        };
    }

    // ========================================
    // Self-Healing System Methods
    // ========================================

    /**
     * Force rediscovery of a selector (used by self-healing system)
     * Clears cache and triggers fresh AI discovery on next use
     * @param {string} name - Selector name
     * @param {string} context - Page context
     */
    async forceRediscovery(name, context) {
        const key = `${context}:${name}`;
        logger.info(`[AI-FALLBACK] Force rediscovery triggered for: ${key}`);

        // Clear from memory cache
        this.selectorCache.delete(key);

        // Mark as needing rediscovery in database (set low confidence)
        try {
            await this.supabase
                .from('selector_registry')
                .update({
                    confidence_score: 0.1,
                    needs_rediscovery: true,
                    last_failure_at: new Date().toISOString()
                })
                .eq('selector_name', name)
                .eq('selector_context', context);

            logger.info(`[AI-FALLBACK] Marked ${key} for rediscovery`);
        } catch (e) {
            logger.debug('[AI-FALLBACK] Could not mark for rediscovery:', e.message);
        }
    }

    /**
     * Invalidate all selectors for a specific page context
     * Used when page structure change is detected
     * @param {string} context - Page context to invalidate
     */
    async invalidateContext(context) {
        logger.warn(`[AI-FALLBACK] Invalidating all selectors for context: ${context}`);

        // Clear from memory cache
        for (const key of this.selectorCache.keys()) {
            if (key.startsWith(`${context}:`)) {
                this.selectorCache.delete(key);
            }
        }

        // Mark all in database as needing rediscovery
        try {
            await this.supabase
                .from('selector_registry')
                .update({
                    confidence_score: 0.1,
                    needs_rediscovery: true,
                    invalidated_at: new Date().toISOString()
                })
                .eq('selector_context', context);

            logger.info(`[AI-FALLBACK] Invalidated all selectors for ${context}`);
        } catch (e) {
            logger.debug('[AI-FALLBACK] Could not invalidate context:', e.message);
        }
    }

    /**
     * Clear cache for a specific selector or all selectors
     * @param {string|null} name - Selector name (null for all)
     * @param {string|null} context - Page context (null for all)
     */
    clearCache(name = null, context = null) {
        if (name && context) {
            const key = `${context}:${name}`;
            this.selectorCache.delete(key);
            logger.debug(`[AI-FALLBACK] Cleared cache for: ${key}`);
        } else if (context) {
            for (const key of this.selectorCache.keys()) {
                if (key.startsWith(`${context}:`)) {
                    this.selectorCache.delete(key);
                }
            }
            logger.debug(`[AI-FALLBACK] Cleared cache for context: ${context}`);
        } else {
            this.selectorCache.clear();
            logger.debug('[AI-FALLBACK] Cleared all cache');
        }
    }

    /**
     * Get all selectors that need rediscovery
     * @returns {Promise<Array>} Selectors needing rediscovery
     */
    async getSelectorsNeedingRediscovery() {
        try {
            const { data, error } = await this.supabase
                .from('selector_registry')
                .select('*')
                .eq('needs_rediscovery', true)
                .order('last_failure_at', { ascending: false });

            if (error) throw error;
            return data || [];
        } catch (e) {
            logger.error('[AI-FALLBACK] Error getting selectors needing rediscovery:', e.message);
            return [];
        }
    }

    /**
     * Get selector statistics for monitoring
     * @returns {Object} Statistics
     */
    getStats() {
        return {
            cacheSize: this.selectorCache.size,
            cachedSelectors: Array.from(this.selectorCache.keys()),
            initialized: this.initialized
        };
    }
}

// Export singleton instance
module.exports = new AISelectorFallbackService();
