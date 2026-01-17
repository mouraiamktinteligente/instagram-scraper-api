/**
 * Warming Behavior Service
 * Defines 20+ humanized navigation patterns for Instagram account warming
 * Each pattern simulates different types of user behavior
 */

const logger = require('../utils/logger');
const { randomDelay, sleep } = require('../utils/helpers');

// ================================================
// CELEBRITY ACCOUNTS LIST (International + Brazilian)
// ================================================
const CELEBRITY_ACCOUNTS = [
    // Internacionais
    'therock', 'cristiano', 'kyliejenner', 'selenagomez',
    'kimkardashian', 'arianagrande', 'beyonce', 'justinbieber',
    'shakira', 'taylorswift', 'leomessi', 'nike', 'natgeo',
    // Brasileiros
    'neymarjr', 'anitta', 'maaborges', 'juloite',
    'virginia', 'whinderssonnunes', 'cfrges', 'cauareymond',
    'brunamarquezine', 'tatawerneck', 'ivetefrango',
    'larisssamanoela', 'gabigol', 'zsacrugbi',
    'glofrancesconi', 'carlinhos', 'hugogloss', 'lucasranthon'
];

// ================================================
// GENERIC COMMENTS FOR POSTS
// ================================================
const GENERIC_COMMENTS = [
    // Emojis
    '🔥', '❤️', '😍', '👏', '💪', '🙌', '✨', '💯', '👑', '🌟',
    // Emojis combo
    '🔥🔥🔥', '❤️❤️', '👏👏👏', '💪💪', '😍😍😍',
    // Simple phrases in PT-BR
    'Top demais!', 'Arrasou!', 'Incrível!', 'Lindoo!', 'Perfeito!',
    'Maravilhoso!', 'Que foto linda!', 'Simplesmente top!',
    // Simple phrases in English
    'Amazing!', 'Love it!', 'So beautiful!', 'Perfect!', 'Goals!',
    // Phrase + emoji
    'Top! 🔥', 'Incrível! ❤️', 'Arrasou! 👏', 'Lindoo! 😍',
    'Amazing! ✨', 'Perfect! 💯', 'Love this! ❤️'
];

// ================================================
// ACTION TYPES
// ================================================
const ACTION_TYPES = {
    VISIT_HOME: 'visit_home',
    SCROLL_FEED: 'scroll_feed',
    VISIT_EXPLORE: 'visit_explore',
    SEARCH_USER: 'search_user',
    VISIT_PROFILE: 'visit_profile',
    SCROLL_PROFILE: 'scroll_profile',
    FOLLOW_USER: 'follow_user',
    LIKE_POST: 'like_post',
    COMMENT_POST: 'comment_post',
    VIEW_STORIES: 'view_stories',
    WATCH_REEL: 'watch_reel',
    VISIT_OWN_PROFILE: 'visit_own_profile',
    RANDOM_PAUSE: 'random_pause'
};

// ================================================
// WARMING PATTERNS (20+ different patterns)
// ================================================
const WARMING_PATTERNS = [
    {
        name: 'casual_explorer',
        description: 'Usuário casual explorando conteúdo',
        actions: [
            { type: ACTION_TYPES.VISIT_HOME, durationRange: [5, 10] },
            { type: ACTION_TYPES.SCROLL_FEED, scrollRange: [3, 7] },
            { type: ACTION_TYPES.VISIT_EXPLORE, durationRange: [10, 20] },
            { type: ACTION_TYPES.LIKE_POST, countRange: [1, 3] },
            { type: ACTION_TYPES.VISIT_PROFILE, target: 'random_celebrity' },
            { type: ACTION_TYPES.VIEW_STORIES, countRange: [2, 4] }
        ]
    },
    {
        name: 'follower_builder',
        description: 'Buscando novos perfis para seguir',
        actions: [
            { type: ACTION_TYPES.SEARCH_USER, target: 'random_celebrity' },
            { type: ACTION_TYPES.VISIT_PROFILE },
            { type: ACTION_TYPES.SCROLL_PROFILE, scrollRange: [2, 4] },
            { type: ACTION_TYPES.FOLLOW_USER },
            { type: ACTION_TYPES.LIKE_POST, countRange: [2, 4] },
            { type: ACTION_TYPES.COMMENT_POST, message: 'random' }
        ]
    },
    {
        name: 'story_watcher',
        description: 'Assistindo stories de vários perfis',
        actions: [
            { type: ACTION_TYPES.VISIT_HOME, durationRange: [3, 5] },
            { type: ACTION_TYPES.VIEW_STORIES, countRange: [5, 10] },
            { type: ACTION_TYPES.SCROLL_FEED, scrollRange: [2, 4] },
            { type: ACTION_TYPES.LIKE_POST, countRange: [1, 2] },
            { type: ACTION_TYPES.VIEW_STORIES, countRange: [3, 5] }
        ]
    },
    {
        name: 'feed_scroller',
        description: 'Rolando feed principal extensivamente',
        actions: [
            { type: ACTION_TYPES.VISIT_HOME, durationRange: [3, 5] },
            { type: ACTION_TYPES.SCROLL_FEED, scrollRange: [10, 20] },
            { type: ACTION_TYPES.LIKE_POST, countRange: [3, 6] },
            { type: ACTION_TYPES.RANDOM_PAUSE, durationRange: [5, 10] },
            { type: ACTION_TYPES.SCROLL_FEED, scrollRange: [5, 10] }
        ]
    },
    {
        name: 'explore_lover',
        description: 'Passando tempo no Explore',
        actions: [
            { type: ACTION_TYPES.VISIT_EXPLORE, durationRange: [5, 10] },
            { type: ACTION_TYPES.SCROLL_FEED, scrollRange: [5, 10] },
            { type: ACTION_TYPES.LIKE_POST, countRange: [2, 4] },
            { type: ACTION_TYPES.WATCH_REEL, durationRange: [10, 30] },
            { type: ACTION_TYPES.VISIT_EXPLORE, durationRange: [5, 10] }
        ]
    },
    {
        name: 'engager',
        description: 'Alto engajamento com curtidas e comentários',
        actions: [
            { type: ACTION_TYPES.VISIT_HOME, durationRange: [3, 5] },
            { type: ACTION_TYPES.SCROLL_FEED, scrollRange: [3, 5] },
            { type: ACTION_TYPES.LIKE_POST, countRange: [4, 7] },
            { type: ACTION_TYPES.COMMENT_POST, message: 'random' },
            { type: ACTION_TYPES.LIKE_POST, countRange: [2, 4] },
            { type: ACTION_TYPES.COMMENT_POST, message: 'random' }
        ]
    },
    {
        name: 'celebrity_stalker',
        description: 'Visitando perfis de celebridades',
        actions: [
            { type: ACTION_TYPES.SEARCH_USER, target: 'random_celebrity' },
            { type: ACTION_TYPES.VISIT_PROFILE },
            { type: ACTION_TYPES.SCROLL_PROFILE, scrollRange: [5, 10] },
            { type: ACTION_TYPES.LIKE_POST, countRange: [3, 5] },
            { type: ACTION_TYPES.FOLLOW_USER },
            { type: ACTION_TYPES.VIEW_STORIES, countRange: [1, 3] }
        ]
    },
    {
        name: 'reel_watcher',
        description: 'Assistindo reels',
        actions: [
            { type: ACTION_TYPES.VISIT_EXPLORE, durationRange: [3, 5] },
            { type: ACTION_TYPES.WATCH_REEL, durationRange: [15, 30] },
            { type: ACTION_TYPES.LIKE_POST, countRange: [1, 2] },
            { type: ACTION_TYPES.WATCH_REEL, durationRange: [20, 40] },
            { type: ACTION_TYPES.LIKE_POST, countRange: [1, 3] }
        ]
    },
    {
        name: 'profile_hopper',
        description: 'Saltando entre vários perfis',
        actions: [
            { type: ACTION_TYPES.SEARCH_USER, target: 'random_celebrity' },
            { type: ACTION_TYPES.VISIT_PROFILE },
            { type: ACTION_TYPES.LIKE_POST, countRange: [1, 2] },
            { type: ACTION_TYPES.SEARCH_USER, target: 'random_celebrity' },
            { type: ACTION_TYPES.VISIT_PROFILE },
            { type: ACTION_TYPES.FOLLOW_USER },
            { type: ACTION_TYPES.LIKE_POST, countRange: [1, 2] }
        ]
    },
    {
        name: 'morning_scroll',
        description: 'Scroll matinal rápido',
        actions: [
            { type: ACTION_TYPES.VISIT_HOME, durationRange: [2, 4] },
            { type: ACTION_TYPES.VIEW_STORIES, countRange: [3, 6] },
            { type: ACTION_TYPES.SCROLL_FEED, scrollRange: [5, 8] },
            { type: ACTION_TYPES.LIKE_POST, countRange: [2, 4] }
        ]
    },
    {
        name: 'evening_browse',
        description: 'Navegação noturna relaxada',
        actions: [
            { type: ACTION_TYPES.VISIT_HOME, durationRange: [5, 10] },
            { type: ACTION_TYPES.SCROLL_FEED, scrollRange: [8, 15] },
            { type: ACTION_TYPES.LIKE_POST, countRange: [3, 5] },
            { type: ACTION_TYPES.VISIT_EXPLORE, durationRange: [10, 15] },
            { type: ACTION_TYPES.WATCH_REEL, durationRange: [10, 20] }
        ]
    },
    {
        name: 'social_butterfly',
        description: 'Interação social intensa',
        actions: [
            { type: ACTION_TYPES.VISIT_HOME, durationRange: [3, 5] },
            { type: ACTION_TYPES.VIEW_STORIES, countRange: [4, 8] },
            { type: ACTION_TYPES.COMMENT_POST, message: 'random' },
            { type: ACTION_TYPES.SCROLL_FEED, scrollRange: [3, 5] },
            { type: ACTION_TYPES.LIKE_POST, countRange: [3, 5] },
            { type: ACTION_TYPES.COMMENT_POST, message: 'random' }
        ]
    },
    {
        name: 'minimalist',
        description: 'Sessão curta e simples',
        actions: [
            { type: ACTION_TYPES.VISIT_HOME, durationRange: [3, 5] },
            { type: ACTION_TYPES.SCROLL_FEED, scrollRange: [2, 4] },
            { type: ACTION_TYPES.LIKE_POST, countRange: [1, 2] }
        ]
    },
    {
        name: 'sports_fan',
        description: 'Foco em perfis de esportes',
        actions: [
            { type: ACTION_TYPES.SEARCH_USER, target: 'sports_celebrity' },
            { type: ACTION_TYPES.VISIT_PROFILE },
            { type: ACTION_TYPES.SCROLL_PROFILE, scrollRange: [4, 8] },
            { type: ACTION_TYPES.LIKE_POST, countRange: [3, 5] },
            { type: ACTION_TYPES.FOLLOW_USER },
            { type: ACTION_TYPES.COMMENT_POST, message: 'random' }
        ]
    },
    {
        name: 'music_lover',
        description: 'Foco em perfis de música',
        actions: [
            { type: ACTION_TYPES.SEARCH_USER, target: 'music_celebrity' },
            { type: ACTION_TYPES.VISIT_PROFILE },
            { type: ACTION_TYPES.VIEW_STORIES, countRange: [2, 4] },
            { type: ACTION_TYPES.SCROLL_PROFILE, scrollRange: [3, 6] },
            { type: ACTION_TYPES.LIKE_POST, countRange: [2, 4] },
            { type: ACTION_TYPES.FOLLOW_USER }
        ]
    },
    {
        name: 'brand_follower',
        description: 'Seguindo marcas e empresas',
        actions: [
            { type: ACTION_TYPES.SEARCH_USER, target: 'brand' },
            { type: ACTION_TYPES.VISIT_PROFILE },
            { type: ACTION_TYPES.SCROLL_PROFILE, scrollRange: [3, 5] },
            { type: ACTION_TYPES.FOLLOW_USER },
            { type: ACTION_TYPES.LIKE_POST, countRange: [2, 3] }
        ]
    },
    {
        name: 'deep_dive',
        description: 'Exploração profunda de um perfil',
        actions: [
            { type: ACTION_TYPES.SEARCH_USER, target: 'random_celebrity' },
            { type: ACTION_TYPES.VISIT_PROFILE },
            { type: ACTION_TYPES.SCROLL_PROFILE, scrollRange: [10, 20] },
            { type: ACTION_TYPES.LIKE_POST, countRange: [5, 8] },
            { type: ACTION_TYPES.VIEW_STORIES, countRange: [1, 3] },
            { type: ACTION_TYPES.COMMENT_POST, message: 'random' }
        ]
    },
    {
        name: 'self_check',
        description: 'Verificando próprio perfil',
        actions: [
            { type: ACTION_TYPES.VISIT_OWN_PROFILE },
            { type: ACTION_TYPES.RANDOM_PAUSE, durationRange: [5, 10] },
            { type: ACTION_TYPES.SCROLL_FEED, scrollRange: [3, 5] },
            { type: ACTION_TYPES.LIKE_POST, countRange: [1, 3] },
            { type: ACTION_TYPES.VISIT_EXPLORE, durationRange: [5, 10] }
        ]
    },
    {
        name: 'quick_break',
        description: 'Pausa rápida para ver notificações',
        actions: [
            { type: ACTION_TYPES.VISIT_HOME, durationRange: [2, 3] },
            { type: ACTION_TYPES.VIEW_STORIES, countRange: [2, 4] },
            { type: ACTION_TYPES.LIKE_POST, countRange: [1, 2] },
            { type: ACTION_TYPES.RANDOM_PAUSE, durationRange: [3, 5] }
        ]
    },
    {
        name: 'content_discovery',
        description: 'Descobrindo novo conteúdo',
        actions: [
            { type: ACTION_TYPES.VISIT_EXPLORE, durationRange: [10, 15] },
            { type: ACTION_TYPES.SCROLL_FEED, scrollRange: [8, 12] },
            { type: ACTION_TYPES.WATCH_REEL, durationRange: [10, 20] },
            { type: ACTION_TYPES.LIKE_POST, countRange: [3, 5] },
            { type: ACTION_TYPES.VISIT_PROFILE, target: 'random_celebrity' },
            { type: ACTION_TYPES.FOLLOW_USER }
        ]
    },
    {
        name: 'late_night_scroll',
        description: 'Scroll noturno demorado',
        actions: [
            { type: ACTION_TYPES.VISIT_HOME, durationRange: [5, 8] },
            { type: ACTION_TYPES.SCROLL_FEED, scrollRange: [15, 25] },
            { type: ACTION_TYPES.LIKE_POST, countRange: [4, 7] },
            { type: ACTION_TYPES.WATCH_REEL, durationRange: [20, 40] },
            { type: ACTION_TYPES.VIEW_STORIES, countRange: [3, 6] }
        ]
    },
    {
        name: 'weekend_chill',
        description: 'Navegação relaxada de fim de semana',
        actions: [
            { type: ACTION_TYPES.VISIT_HOME, durationRange: [5, 10] },
            { type: ACTION_TYPES.VIEW_STORIES, countRange: [5, 10] },
            { type: ACTION_TYPES.SCROLL_FEED, scrollRange: [10, 15] },
            { type: ACTION_TYPES.LIKE_POST, countRange: [4, 6] },
            { type: ACTION_TYPES.VISIT_EXPLORE, durationRange: [10, 15] },
            { type: ACTION_TYPES.COMMENT_POST, message: 'random' }
        ]
    }
];

// Category-based celebrities for targeted patterns
const CATEGORY_ACCOUNTS = {
    sports: ['cristiano', 'leomessi', 'neymarjr', 'gabigol', 'nike'],
    music: ['anitta', 'shakira', 'taylorswift', 'arianagrande', 'beyonce'],
    brands: ['nike', 'natgeo', 'instagram']
};

/**
 * WarmingBehaviorService
 * Manages navigation patterns and provides randomized human-like behavior
 */
class WarmingBehaviorService {
    constructor() {
        this.patterns = WARMING_PATTERNS;
        this.celebrities = CELEBRITY_ACCOUNTS;
        this.comments = GENERIC_COMMENTS;
    }

    /**
     * Get a random navigation pattern
     * @returns {Object} Pattern object
     */
    getRandomPattern() {
        const index = Math.floor(Math.random() * this.patterns.length);
        return this.patterns[index];
    }

    /**
     * Get a specific pattern by name
     * @param {string} name - Pattern name
     * @returns {Object|null} Pattern object or null
     */
    getPatternByName(name) {
        return this.patterns.find(p => p.name === name) || null;
    }

    /**
     * Get a random celebrity account
     * @param {string} category - Optional category filter (sports, music, brands)
     * @returns {string} Celebrity username
     */
    getRandomCelebrity(category = null) {
        let pool = this.celebrities;

        if (category && CATEGORY_ACCOUNTS[category]) {
            pool = CATEGORY_ACCOUNTS[category];
        }

        const index = Math.floor(Math.random() * pool.length);
        return pool[index];
    }

    /**
     * Get a random generic comment
     * @returns {string} Comment text
     */
    getRandomComment() {
        const index = Math.floor(Math.random() * this.comments.length);
        return this.comments[index];
    }

    /**
     * Generate a random value within a range
     * @param {Array<number>} range - [min, max]
     * @returns {number} Random value
     */
    getRandomInRange(range) {
        if (!range || range.length !== 2) return 1;
        const [min, max] = range;
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    /**
     * Get all available pattern names
     * @returns {Array<string>} Pattern names
     */
    getPatternNames() {
        return this.patterns.map(p => p.name);
    }

    /**
     * Get pattern statistics
     * @returns {Object} Stats object
     */
    getStats() {
        return {
            totalPatterns: this.patterns.length,
            totalCelebrities: this.celebrities.length,
            totalComments: this.comments.length,
            patternNames: this.getPatternNames()
        };
    }
}

module.exports = {
    WarmingBehaviorService,
    WARMING_PATTERNS,
    CELEBRITY_ACCOUNTS,
    GENERIC_COMMENTS,
    ACTION_TYPES,
    CATEGORY_ACCOUNTS
};
