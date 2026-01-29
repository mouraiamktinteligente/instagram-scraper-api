#!/usr/bin/env node
/**
 * Debug Login Script
 * 
 * Script para testar o login do Instagram com navegador VISÍVEL
 * para diagnosticar exatamente onde está falhando.
 * 
 * Uso:
 *   node scripts/debug-login.js
 *   node scripts/debug-login.js --username=minha_conta
 *   node scripts/debug-login.js --no-proxy  (sem proxy)
 * 
 * Requer:
 *   - .env configurado com SUPABASE_URL e SUPABASE_KEY
 *   - Contas no banco de dados (tabela instagram_accounts)
 */

require('dotenv').config();

const { firefox } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const speakeasy = require('speakeasy');
const https = require('https');
const readline = require('readline');

// ============================================
// CONFIGURAÇÃO
// ============================================
const CONFIG = {
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_KEY,
    slowMo: 100,  // Delay entre ações (ms) para visualização
    timeout: 60000,
    screenshotOnError: true,
};

// Parse CLI args
const args = process.argv.slice(2);
const cliOptions = {
    username: args.find(a => a.startsWith('--username='))?.split('=')[1],
    noProxy: args.includes('--no-proxy'),
    headless: args.includes('--headless'),
};

// Colors for console
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
    const timestamp = new Date().toLocaleTimeString('pt-BR');
    console.log(`${colors[color]}[${timestamp}] ${message}${colors.reset}`);
}

function logStep(step, message) {
    console.log(`\n${colors.cyan}${'═'.repeat(60)}${colors.reset}`);
    console.log(`${colors.bright}${colors.blue}  STEP ${step}: ${message}${colors.reset}`);
    console.log(`${colors.cyan}${'═'.repeat(60)}${colors.reset}\n`);
}

function logSuccess(message) {
    console.log(`${colors.green}✅ ${message}${colors.reset}`);
}

function logError(message) {
    console.log(`${colors.red}❌ ${message}${colors.reset}`);
}

function logWarning(message) {
    console.log(`${colors.yellow}⚠️  ${message}${colors.reset}`);
}

function logInfo(message) {
    console.log(`${colors.blue}ℹ️  ${message}${colors.reset}`);
}

// ============================================
// SUPABASE
// ============================================
const supabase = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);

async function getAccounts() {
    const { data, error } = await supabase
        .from('instagram_accounts')
        .select('*')
        .eq('is_active', true)
        .order('created_at', { ascending: true });

    if (error) throw error;
    return data || [];
}

async function getProxies() {
    const { data, error } = await supabase
        .from('proxies')
        .select('*')
        .eq('is_active', true)
        .limit(1);

    if (error) {
        logWarning('Não foi possível carregar proxies do banco');
        return [];
    }
    return data || [];
}

// ============================================
// TOTP GENERATION
// ============================================
async function generateTOTP(secret) {
    const sanitizedSecret = secret.replace(/\s+/g, '').toUpperCase();

    // Try 2fa.live API first
    try {
        const code = await new Promise((resolve, reject) => {
            const req = https.get(`https://2fa.live/tok/${sanitizedSecret}`, { timeout: 5000 }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        resolve(json.token);
                    } catch (e) {
                        reject(new Error('Invalid JSON'));
                    }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Timeout'));
            });
        });

        logInfo(`TOTP via 2fa.live: ${code}`);
        return code;
    } catch (e) {
        logWarning(`2fa.live falhou: ${e.message}, usando speakeasy...`);
    }

    // Fallback to speakeasy
    const code = speakeasy.totp({
        secret: sanitizedSecret,
        encoding: 'base32',
        step: 30
    });

    logInfo(`TOTP via speakeasy: ${code}`);
    return code;
}

// ============================================
// DELAY HELPERS
// ============================================
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(min = 1000, max = 2000) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return delay(ms);
}

// ============================================
// MAIN DEBUG FUNCTION
// ============================================
async function debugLogin() {
    console.log('\n');
    console.log(`${colors.bright}${colors.magenta}${'╔'.padEnd(60, '═')}╗${colors.reset}`);
    console.log(`${colors.bright}${colors.magenta}║${' '.repeat(15)}INSTAGRAM LOGIN DEBUGGER${' '.repeat(20)}║${colors.reset}`);
    console.log(`${colors.bright}${colors.magenta}${'╚'.padEnd(60, '═')}╝${colors.reset}`);
    console.log('\n');

    // 1. Load accounts
    logStep(1, 'Carregando contas do banco de dados');

    const accounts = await getAccounts();

    if (accounts.length === 0) {
        logError('Nenhuma conta encontrada no banco de dados!');
        logInfo('Verifique a tabela instagram_accounts no Supabase');
        process.exit(1);
    }

    logSuccess(`${accounts.length} conta(s) encontrada(s)`);

    accounts.forEach((acc, i) => {
        const status = acc.is_banned ? '🚫 BANIDA' : '✅ ATIVA';
        const has2FA = acc.totp_secret ? '🔐 2FA' : '🔓 Sem 2FA';
        console.log(`  ${i + 1}. ${acc.username} - ${status} - ${has2FA}`);
    });

    // Select account
    let account;
    if (cliOptions.username) {
        account = accounts.find(a => a.username === cliOptions.username);
        if (!account) {
            logError(`Conta "${cliOptions.username}" não encontrada`);
            process.exit(1);
        }
    } else {
        // Use first non-banned account
        account = accounts.find(a => !a.is_banned) || accounts[0];
    }

    logInfo(`Usando conta: ${colors.bright}${account.username}${colors.reset}`);

    // 2. Load proxy (optional)
    logStep(2, 'Configurando proxy');

    let proxy = null;
    if (!cliOptions.noProxy) {
        const proxies = await getProxies();
        if (proxies.length > 0) {
            const p = proxies[0];
            proxy = {
                server: `http://${p.host}:${p.port}`,
                username: p.username,
                password: p.password,
            };
            logSuccess(`Proxy configurado: ${proxy.server}`);
        } else {
            logWarning('Nenhum proxy disponível, rodando sem proxy');
        }
    } else {
        logInfo('Modo --no-proxy: rodando sem proxy');
    }

    // 3. Launch browser
    logStep(3, 'Iniciando navegador Firefox (VISÍVEL)');

    const launchOptions = {
        headless: cliOptions.headless || false,
        slowMo: CONFIG.slowMo,
    };

    if (proxy) {
        launchOptions.proxy = {
            server: proxy.server,
            username: proxy.username,
            password: proxy.password,
        };
    }

    const browser = await firefox.launch(launchOptions);
    logSuccess('Firefox iniciado');

    // 4. Create context with stealth
    logStep(4, 'Criando contexto com anti-detecção');

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
        viewport: { width: 1280, height: 720 },
        hasTouch: false,
        javaScriptEnabled: true,
    });

    // Apply stealth patches
    await context.addInitScript(() => {
        // Remove webdriver
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

        // Add languages
        Object.defineProperty(navigator, 'languages', {
            get: () => ['pt-BR', 'pt', 'en-US', 'en'],
        });

        // Platform - consistent!
        Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

        // Hardware
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    });

    logSuccess('Stealth patches aplicados');

    const page = await context.newPage();

    // Event listeners for debugging
    page.on('console', msg => {
        if (msg.type() === 'error') {
            console.log(`${colors.red}[CONSOLE ERROR] ${msg.text()}${colors.reset}`);
        }
    });

    page.on('pageerror', error => {
        console.log(`${colors.red}[PAGE ERROR] ${error.message}${colors.reset}`);
    });

    try {
        // 5. Navigate to login
        logStep(5, 'Navegando para página de login');

        await page.goto('https://www.instagram.com/accounts/login/', {
            waitUntil: 'domcontentloaded',
            timeout: CONFIG.timeout,
        });

        logSuccess('Página carregada');
        logInfo(`URL: ${page.url()}`);

        // Wait for JS to render
        await page.waitForFunction(() => {
            return document.querySelectorAll('input').length > 0 ||
                document.querySelectorAll('button').length > 0;
        }, { timeout: 30000 });

        await randomDelay(2000, 3000);

        // 6. Handle cookie consent
        logStep(6, 'Verificando popup de cookies');

        const cookieSelectors = [
            'button:has-text("Permitir todos os cookies")',
            'button:has-text("Permitir cookies essenciais e opcionais")',
            'button:has-text("Allow all cookies")',
            'button:has-text("Allow essential and optional cookies")',
        ];

        for (const selector of cookieSelectors) {
            try {
                const btn = await page.$(selector);
                if (btn && await btn.isVisible()) {
                    await btn.click();
                    logSuccess('Cookie popup dismissed');
                    await randomDelay(1500, 2500);
                    break;
                }
            } catch (e) { /* continue */ }
        }

        // 7. Find and fill username
        logStep(7, 'Preenchendo username');

        const usernameInput = await page.waitForSelector('input[name="username"]', { timeout: 10000 });
        if (!usernameInput) {
            throw new Error('Campo de username não encontrado!');
        }

        await usernameInput.click();
        await randomDelay(300, 500);
        await usernameInput.fill(account.username);
        logSuccess(`Username preenchido: ${account.username}`);

        // 8. Fill password
        logStep(8, 'Preenchendo password');

        const passwordInput = await page.waitForSelector('input[name="password"]', { timeout: 5000 });
        if (!passwordInput) {
            throw new Error('Campo de password não encontrado!');
        }

        await passwordInput.click();
        await randomDelay(300, 500);
        await passwordInput.fill(account.password);
        logSuccess('Password preenchido');

        await randomDelay(500, 1000);

        // 9. Click login button
        logStep(9, 'Clicando no botão de login');

        const loginButton = await page.$('button[type="submit"]');
        if (loginButton) {
            await loginButton.click();
            logSuccess('Botão de login clicado');
        } else {
            logWarning('Botão não encontrado, usando Enter');
            await page.keyboard.press('Enter');
        }

        // Wait for response
        logInfo('Aguardando resposta do Instagram...');
        await randomDelay(5000, 7000);

        // 10. Check result
        logStep(10, 'Verificando resultado do login');

        const currentUrl = page.url();
        logInfo(`URL atual: ${currentUrl}`);

        // Get page content for analysis
        const pageText = await page.evaluate(() => document.body?.innerText || '');
        const pageTextPreview = pageText.substring(0, 300).replace(/\n/g, ' ');
        logInfo(`Conteúdo da página: ${pageTextPreview}...`);

        // Check for various states
        if (currentUrl.includes('challenge') || currentUrl.includes('two_factor')) {
            logWarning('🔐 2FA/Challenge detectado!');

            if (account.totp_secret) {
                logStep('10.1', 'Tentando resolver 2FA');

                // Wait for 2FA input
                await randomDelay(2000, 3000);

                const codeInput = await page.$('input[name="verificationCode"]') ||
                    await page.$('input[name="security_code"]') ||
                    await page.$('input[type="text"][maxlength="6"]') ||
                    await page.$('input[type="number"]');

                if (codeInput) {
                    const totpCode = await generateTOTP(account.totp_secret);

                    await codeInput.click();
                    await randomDelay(200, 400);
                    await codeInput.fill(totpCode);
                    logSuccess(`Código 2FA inserido: ${totpCode}`);

                    // Submit
                    const confirmBtn = await page.$('button[type="submit"]') ||
                        await page.$('button:has-text("Confirmar")') ||
                        await page.$('button:has-text("Confirm")');

                    if (confirmBtn) {
                        await confirmBtn.click();
                        logSuccess('Código 2FA submetido');
                    } else {
                        await page.keyboard.press('Enter');
                    }

                    await randomDelay(5000, 7000);
                } else {
                    logError('Campo de código 2FA não encontrado');

                    // List available inputs
                    const inputs = await page.$$eval('input', inputs =>
                        inputs.map(i => `${i.name || i.type || 'unknown'}[${i.placeholder || ''}]`)
                    );
                    logInfo(`Inputs disponíveis: ${inputs.join(', ')}`);
                }
            } else {
                logError('Conta não tem TOTP secret configurado!');
            }
        }

        // Check for error messages
        if (pageText.includes('senha incorreta') || pageText.includes('password was incorrect')) {
            logError('❌ SENHA INCORRETA!');
        } else if (pageText.includes('Aguarde alguns minutos') || pageText.includes('Please wait')) {
            logError('❌ RATE LIMITED - Muitas tentativas');
        } else if (pageText.includes('suspeita') || pageText.includes('suspicious')) {
            logError('❌ ATIVIDADE SUSPEITA detectada');
        }

        // Check if logged in
        const isLoggedIn = await page.evaluate(() => {
            // Look for logged-in indicators
            const selectors = [
                'svg[aria-label="Home"]',
                'svg[aria-label="Início"]',
                'a[href="/direct/inbox/"]',
            ];
            return selectors.some(s => document.querySelector(s) !== null);
        });

        // 11. Final result
        logStep(11, 'Resultado final');

        if (isLoggedIn) {
            console.log('\n');
            console.log(`${colors.green}${'█'.repeat(60)}${colors.reset}`);
            console.log(`${colors.green}█${' '.repeat(18)}LOGIN SUCCESSFUL!${' '.repeat(22)}█${colors.reset}`);
            console.log(`${colors.green}${'█'.repeat(60)}${colors.reset}`);
            console.log('\n');
        } else {
            console.log('\n');
            console.log(`${colors.red}${'█'.repeat(60)}${colors.reset}`);
            console.log(`${colors.red}█${' '.repeat(20)}LOGIN FAILED!${' '.repeat(25)}█${colors.reset}`);
            console.log(`${colors.red}${'█'.repeat(60)}${colors.reset}`);
            console.log('\n');

            // Take screenshot
            if (CONFIG.screenshotOnError) {
                const screenshotPath = `./logs/login-debug-${Date.now()}.png`;
                await page.screenshot({ path: screenshotPath, fullPage: true });
                logInfo(`Screenshot salvo: ${screenshotPath}`);
            }
        }

        // Keep browser open for inspection
        console.log('\n');
        logInfo('Navegador aberto para inspeção manual.');
        logInfo('Pressione Enter para fechar...');

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        await new Promise(resolve => {
            rl.question('', () => {
                rl.close();
                resolve();
            });
        });

    } catch (error) {
        logError(`Erro durante login: ${error.message}`);
        console.error(error.stack);

        // Take screenshot on error
        if (CONFIG.screenshotOnError) {
            try {
                const screenshotPath = `./logs/login-error-${Date.now()}.png`;
                await page.screenshot({ path: screenshotPath, fullPage: true });
                logInfo(`Screenshot de erro salvo: ${screenshotPath}`);
            } catch (e) { /* ignore */ }
        }

        logInfo('Navegador aberto para inspeção manual.');
        logInfo('Pressione Enter para fechar...');

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        await new Promise(resolve => {
            rl.question('', () => {
                rl.close();
                resolve();
            });
        });

    } finally {
        await browser.close();
        logInfo('Navegador fechado');
    }
}

// ============================================
// RUN
// ============================================
debugLogin().catch(err => {
    console.error(`${colors.red}Fatal error: ${err.message}${colors.reset}`);
    process.exit(1);
});
