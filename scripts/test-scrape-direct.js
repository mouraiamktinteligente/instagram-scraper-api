#!/usr/bin/env node
/**
 * Direct Scrape Test Script
 * Testa o fluxo completo de scrape com a nova lógica de fallback
 */

const path = require('path');

// Setup environment
process.env.NODE_ENV = 'development';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'placeholder';

// Import services
const instagramService = require('../src/services/instagram.service');
const accountPool = require('../src/services/accountPool.service');

// Inject test account directly into AccountPool
const TEST_ACCOUNT = {
    id: 'test-account-1',
    username: 'MagnificentTyson11266',
    password: 'yui678',
    totpSecret: 'ZQI7AMNNWRZYEZOZW5727RR4B6MWRVC2',  // camelCase!
    is_active: true,
    is_banned: false,
    created_at: new Date().toISOString()
};

// Inject account into pool
accountPool.accounts = [TEST_ACCOUNT];
accountPool.initialized = true;
accountPool.accountStatus.set(TEST_ACCOUNT.username, { status: 'active', errors: 0 });
console.log(`[SETUP] Injected test account: ${TEST_ACCOUNT.username}`);

const TEST_URL = 'https://www.instagram.com/p/DT3ydycD2Is/';

const c = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    bold: '\x1b[1m',
};

function log(msg, color = 'reset') {
    const time = new Date().toLocaleTimeString('pt-BR');
    console.log(`${c[color]}[${time}] ${msg}${c.reset}`);
}

async function main() {
    console.log(`\n${c.bold}${c.cyan}${'╔'.padEnd(50, '═')}╗${c.reset}`);
    console.log(`${c.bold}${c.cyan}║       INSTAGRAM SCRAPE TEST                  ║${c.reset}`);
    console.log(`${c.bold}${c.cyan}${'╚'.padEnd(50, '═')}╝${c.reset}\n`);

    log(`URL de teste: ${TEST_URL}`, 'blue');
    log(`Modo: auto (deve fazer fallback se login wall detectado)`, 'blue');

    try {
        log('Iniciando scrape...', 'yellow');

        const result = await instagramService.scrapeComments(
            TEST_URL,
            null,  // proxy
            null,  // jobId
            null,  // maxComments
            'auto' // mode
        );

        console.log(`\n${c.cyan}${'═'.repeat(50)}${c.reset}`);
        console.log(`${c.bold}${c.blue}  RESULTADO${c.reset}`);
        console.log(`${c.cyan}${'═'.repeat(50)}${c.reset}\n`);

        log(`Sucesso: ${result.success}`, result.success ? 'green' : 'red');
        log(`Modo usado: ${result.mode}`, 'blue');
        log(`Comentários encontrados: ${result.commentsCount}`, 'blue');
        log(`Comentários salvos: ${result.savedCount}`, 'blue');
        log(`Login wall detectado: ${result.loginWallDetected || false}`, 'yellow');
        log(`Conta usada: ${result.account || 'nenhuma (modo público)'}`, 'blue');

        if (result.commentsCount > 0) {
            console.log(`\n${c.green}${'█'.repeat(50)}${c.reset}`);
            console.log(`${c.green}█         ✅ SCRAPE SUCCESSFUL! ✅             █${c.reset}`);
            console.log(`${c.green}${'█'.repeat(50)}${c.reset}\n`);
        } else {
            console.log(`\n${c.yellow}${'█'.repeat(50)}${c.reset}`);
            console.log(`${c.yellow}█     ⚠️ SCRAPE COMPLETED (0 comments)         █${c.reset}`);
            console.log(`${c.yellow}${'█'.repeat(50)}${c.reset}\n`);
        }

    } catch (error) {
        console.log(`\n${c.red}❌ ERRO: ${error.message}${c.reset}`);
        console.error(error.stack);
    }
}

main().catch(console.error);
