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
     * 1. First detects total count
     * 2. Scrolls/clicks to load all
     * 3. Extracts via AI if needed
     * @param {Page} page
     * @param {string} postId
     * @param {string} postUrl
     * @param {Object} scrollContainer - Optional scroll container detected by InstagramService
     * @returns {Promise<{comments: Array, totalExpected: number}>}
     */
    async extractAllCommentsWithAI(page, postId, postUrl, scrollContainer = null) {
        logger.info('[AI-FALLBACK] 🔄 Starting intelligent full comment extraction...');

        // Step 1: Detect total comments
        const { total: totalExpected, expandButtonText } = await this.detectTotalComments(page);
        logger.info(`[AI-FALLBACK] Expected total: ${totalExpected} comments`);

        // Step 2: If we found an expand button, click it
        if (expandButtonText) {
            try {
                // Find and click the expand button
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

        // Step 3: Scroll to load more comments
        let previousHeight = 0;
        let scrollAttempts = 0;
        const maxScrollAttempts = 20; // Max 20 scroll attempts

        while (scrollAttempts < maxScrollAttempts) {
            try {
                const currentHeight = await page.evaluate((containerInfo) => {
                    if (containerInfo && containerInfo.selector) {
                        const container = document.querySelector(containerInfo.selector);
                        if (container) {
                            container.scrollBy(0, 500);
                            return container.scrollHeight;
                        }
                    } else if (containerInfo && containerInfo.useModal) {
                        const dialog = document.querySelector('div[role="dialog"]');
                        if (dialog) {
                            dialog.scrollBy(0, 500);
                            return dialog.scrollHeight;
                        }
                    }

                    window.scrollBy(0, 500);
                    return document.body.scrollHeight;
                }, scrollContainer);

                if (currentHeight === previousHeight) {
                    // Try clicking "load more" buttons using JavaScript text matching
                    await page.evaluate(() => {
                        const buttons = document.querySelectorAll('button, span, div[role="button"], a');
                        for (const btn of buttons) {
                            const text = btn.innerText?.toLowerCase() || '';
                            if (text.includes('mais') || text.includes('carregar') || text === '+') {
                                btn.click();
                                break;
                            }
                        }
                    });
                    scrollAttempts++;
                } else {
                    scrollAttempts = 0; // Reset if new content loaded
                }

                previousHeight = currentHeight;
                await new Promise(r => setTimeout(r, 500));

                // Check if we've likely loaded all
                if (scrollAttempts >= 3) break;
            } catch (scrollError) {
                logger.warn('[AI-FALLBACK] Scroll error:', scrollError.message);
                break;
            }
        }

        // Step 4: Extract comments using AI
        logger.info('[AI-FALLBACK] Extracting all visible comments with AI...');
        const comments = await this.extractCommentsDirectly(page, postId, postUrl);

        logger.info(`[AI-FALLBACK] Extracted ${comments.length}/${totalExpected} comments`);

        return {
            comments,
            totalExpected,
            coverage: totalExpected > 0 ? Math.round((comments.length / totalExpected) * 100) : 100
        };
    }
}

// Export singleton instance
module.exports = new AISelectorFallbackService();
