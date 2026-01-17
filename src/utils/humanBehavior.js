/**
 * Human Behavior Simulation Module
 * Advanced techniques to simulate human-like browser interactions
 * Used by both warming system and scraping system
 * 
 * Techniques implemented:
 * - Bézier curve mouse movements
 * - Realistic typing with variable delays
 * - Natural scroll patterns
 * - Random micro-pauses and hesitations
 */

const logger = require('./logger');

// ================================================
// BÉZIER CURVE MOUSE MOVEMENT
// ================================================

/**
 * Generate a point on a cubic Bézier curve
 * @param {number} t - Progress (0 to 1)
 * @param {Object} p0 - Start point
 * @param {Object} p1 - Control point 1
 * @param {Object} p2 - Control point 2
 * @param {Object} p3 - End point
 * @returns {Object} Point {x, y}
 */
function bezierPoint(t, p0, p1, p2, p3) {
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;
    const t2 = t * t;
    const t3 = t2 * t;

    return {
        x: mt3 * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t3 * p3.x,
        y: mt3 * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t3 * p3.y
    };
}

/**
 * Generate random control points for natural-looking curves
 * @param {Object} start - Start point {x, y}
 * @param {Object} end - End point {x, y}
 * @returns {Object} Control points {cp1, cp2}
 */
function generateControlPoints(start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;

    // Add randomness to control points (30-70% of distance)
    const cp1 = {
        x: start.x + dx * (0.3 + Math.random() * 0.2) + (Math.random() - 0.5) * Math.abs(dy) * 0.3,
        y: start.y + dy * (0.3 + Math.random() * 0.2) + (Math.random() - 0.5) * Math.abs(dx) * 0.3
    };

    const cp2 = {
        x: start.x + dx * (0.5 + Math.random() * 0.2) + (Math.random() - 0.5) * Math.abs(dy) * 0.3,
        y: start.y + dy * (0.5 + Math.random() * 0.2) + (Math.random() - 0.5) * Math.abs(dx) * 0.3
    };

    return { cp1, cp2 };
}

/**
 * Move mouse along a Bézier curve path (human-like)
 * @param {Page} page - Playwright page
 * @param {number} endX - Target X coordinate
 * @param {number} endY - Target Y coordinate
 * @param {Object} options - Options
 */
async function humanMouseMove(page, endX, endY, options = {}) {
    const {
        steps = 20 + Math.floor(Math.random() * 15),  // 20-35 steps
        jitterAmount = 2,  // Pixel jitter
        pauseChance = 0.1  // 10% chance of micro-pause
    } = options;

    try {
        // Get current mouse position (default to center if unknown)
        const viewport = page.viewportSize() || { width: 1280, height: 720 };
        const currentPos = await page.evaluate(() => {
            return window.__mousePos || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        }).catch(() => ({ x: viewport.width / 2, y: viewport.height / 2 }));

        const start = { x: currentPos.x, y: currentPos.y };
        const end = { x: endX, y: endY };

        // Generate control points for curve
        const { cp1, cp2 } = generateControlPoints(start, end);

        // Move along curve
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;

            // Easing function (slow start, slow end)
            const easedT = t < 0.5
                ? 4 * t * t * t
                : 1 - Math.pow(-2 * t + 2, 3) / 2;

            const point = bezierPoint(easedT, start, cp1, cp2, end);

            // Add small jitter for natural movement
            const jitterX = (Math.random() - 0.5) * jitterAmount;
            const jitterY = (Math.random() - 0.5) * jitterAmount;

            await page.mouse.move(point.x + jitterX, point.y + jitterY);

            // Variable delay between movements (faster in middle, slower at ends)
            const baseDelay = 5 + Math.random() * 10;
            const speedMultiplier = 1 + Math.sin(Math.PI * t) * 0.5; // Faster in middle
            await sleep(baseDelay * speedMultiplier);

            // Random micro-pause (simulates hesitation)
            if (Math.random() < pauseChance && i > 2 && i < steps - 2) {
                await sleep(50 + Math.random() * 150);
            }
        }

        // Store position for next movement
        await page.evaluate((pos) => {
            window.__mousePos = pos;
        }, end);

    } catch (error) {
        // Fallback to simple movement
        logger.debug(`Bézier move fallback: ${error.message}`);
        await page.mouse.move(endX, endY, { steps: 10 });
    }
}

/**
 * Click with human-like movement to element
 * @param {Page} page - Playwright page
 * @param {string} selector - Element selector
 * @param {Object} options - Click options
 */
async function humanClick(page, selector, options = {}) {
    const {
        preClickDelay = [100, 300],
        postClickDelay = [50, 150],
        hoverDuration = [200, 500]
    } = options;

    try {
        const element = await page.$(selector);
        if (!element) {
            logger.debug(`Element not found for human click: ${selector}`);
            return false;
        }

        // Get element bounding box
        const box = await element.boundingBox();
        if (!box) return false;

        // Random position within element (not exactly center)
        const targetX = box.x + box.width * (0.3 + Math.random() * 0.4);
        const targetY = box.y + box.height * (0.3 + Math.random() * 0.4);

        // Move to element with Bézier curve
        await humanMouseMove(page, targetX, targetY);

        // Hover duration (humans often pause before clicking)
        await sleep(randomInRange(hoverDuration));

        // Pre-click delay
        await sleep(randomInRange(preClickDelay));

        // Click
        await page.mouse.click(targetX, targetY);

        // Post-click delay
        await sleep(randomInRange(postClickDelay));

        return true;

    } catch (error) {
        logger.debug(`Human click error: ${error.message}`);
        // Fallback to regular click
        try {
            await page.click(selector);
            return true;
        } catch (e) {
            return false;
        }
    }
}

// ================================================
// REALISTIC TYPING
// ================================================

/**
 * Type text with human-like delays and occasional mistakes
 * @param {Page} page - Playwright page
 * @param {string} selector - Input selector
 * @param {string} text - Text to type
 * @param {Object} options - Typing options
 */
async function humanType(page, selector, text, options = {}) {
    const {
        minDelay = 50,
        maxDelay = 150,
        mistakeChance = 0.03,  // 3% chance of typo
        pauseChance = 0.05     // 5% chance of thinking pause
    } = options;

    try {
        // Click on input first
        await humanClick(page, selector);
        await sleep(100 + Math.random() * 200);

        for (let i = 0; i < text.length; i++) {
            const char = text[i];

            // Occasional thinking pause (longer pause between words)
            if ((char === ' ' || Math.random() < pauseChance) && i > 0) {
                await sleep(200 + Math.random() * 400);
            }

            // Simulate occasional typo (type wrong char, then backspace and correct)
            if (Math.random() < mistakeChance && i > 0 && i < text.length - 1) {
                const wrongChar = getAdjacentKey(char);
                if (wrongChar) {
                    await page.keyboard.type(wrongChar, { delay: 30 });
                    await sleep(100 + Math.random() * 200);
                    await page.keyboard.press('Backspace');
                    await sleep(50 + Math.random() * 100);
                }
            }

            // Type the character
            await page.keyboard.type(char, {
                delay: minDelay + Math.random() * (maxDelay - minDelay)
            });

            // Variable delay based on character type
            let extraDelay = 0;
            if (char === ' ' || char === '.' || char === ',') {
                extraDelay = 50 + Math.random() * 100; // Pause at word boundaries
            } else if (char.match(/[A-Z]/)) {
                extraDelay = 20 + Math.random() * 50; // Slightly longer for capitals
            }

            if (extraDelay > 0) {
                await sleep(extraDelay);
            }
        }

    } catch (error) {
        logger.debug(`Human type error: ${error.message}`);
        // Fallback to simple fill
        await page.fill(selector, text);
    }
}

/**
 * Get an adjacent key on QWERTY keyboard (for simulating typos)
 */
function getAdjacentKey(char) {
    const keyboard = {
        'q': ['w', 'a'], 'w': ['q', 'e', 's'], 'e': ['w', 'r', 'd'],
        'r': ['e', 't', 'f'], 't': ['r', 'y', 'g'], 'y': ['t', 'u', 'h'],
        'a': ['q', 's', 'z'], 's': ['a', 'd', 'w', 'x'], 'd': ['s', 'f', 'e', 'c'],
        'f': ['d', 'g', 'r', 'v'], 'g': ['f', 'h', 't', 'b'], 'h': ['g', 'j', 'y', 'n'],
        'z': ['a', 'x'], 'x': ['z', 'c', 's'], 'c': ['x', 'v', 'd'],
        'v': ['c', 'b', 'f'], 'b': ['v', 'n', 'g'], 'n': ['b', 'm', 'h']
    };

    const key = char.toLowerCase();
    const adjacent = keyboard[key];

    if (adjacent && adjacent.length > 0) {
        return adjacent[Math.floor(Math.random() * adjacent.length)];
    }
    return null;
}

// ================================================
// NATURAL SCROLLING
// ================================================

/**
 * Scroll with human-like patterns
 * @param {Page} page - Playwright page
 * @param {number} distance - Total distance to scroll
 * @param {Object} options - Scroll options
 */
async function humanScroll(page, distance = 500, options = {}) {
    const {
        direction = 'down',
        steps = 3 + Math.floor(Math.random() * 4),  // 3-7 steps
        pauseChance = 0.2  // 20% chance to pause mid-scroll
    } = options;

    const actualDistance = direction === 'down' ? distance : -distance;
    const stepDistance = actualDistance / steps;

    for (let i = 0; i < steps; i++) {
        // Variable step size (not uniform)
        const variance = 0.7 + Math.random() * 0.6; // 70%-130% of step
        const scrollAmount = stepDistance * variance;

        await page.mouse.wheel(0, scrollAmount);

        // Variable delay between scroll steps
        await sleep(100 + Math.random() * 200);

        // Random pause (simulates reading/looking at content)
        if (Math.random() < pauseChance) {
            await sleep(500 + Math.random() * 1500);
        }
    }
}

/**
 * Natural scroll to read content (slower, with pauses)
 * @param {Page} page - Playwright page
 * @param {number} scrollCount - Number of scroll actions
 */
async function readingScroll(page, scrollCount = 5) {
    for (let i = 0; i < scrollCount; i++) {
        // Scroll variable amount
        const scrollDistance = 200 + Math.random() * 300;
        await humanScroll(page, scrollDistance);

        // Reading pause (longer)
        await sleep(1500 + Math.random() * 3000);

        // Occasionally scroll back up slightly
        if (Math.random() < 0.15) {
            await humanScroll(page, 50 + Math.random() * 100, { direction: 'up' });
            await sleep(500 + Math.random() * 1000);
        }
    }
}

// ================================================
// UTILITY FUNCTIONS
// ================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomInRange(range) {
    if (Array.isArray(range)) {
        return range[0] + Math.random() * (range[1] - range[0]);
    }
    return range;
}

/**
 * Random delay with variance
 * @param {number} min - Minimum ms
 * @param {number} max - Maximum ms
 */
async function randomDelay(min = 1000, max = 3000) {
    const delay = min + Math.random() * (max - min);
    await sleep(delay);
    return delay;
}

/**
 * Add random micro-pauses throughout an action sequence
 * Simulates human hesitation and thinking
 */
async function maybeHesitate(probability = 0.1, minMs = 100, maxMs = 500) {
    if (Math.random() < probability) {
        await sleep(minMs + Math.random() * (maxMs - minMs));
        return true;
    }
    return false;
}

// ================================================
// EXPORTS
// ================================================

module.exports = {
    // Mouse
    humanMouseMove,
    humanClick,
    bezierPoint,
    generateControlPoints,

    // Typing
    humanType,
    getAdjacentKey,

    // Scrolling
    humanScroll,
    readingScroll,

    // Utilities
    sleep,
    randomDelay,
    randomInRange,
    maybeHesitate
};
