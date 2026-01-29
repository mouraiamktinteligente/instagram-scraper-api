#!/usr/bin/env node
/**
 * Direct Login Test Script v2
 * CORRIGIDO para o novo layout do Instagram 2026
 */

const { firefox } = require('playwright');
const speakeasy = require('speakeasy');
const https = require('https');

// ============================================
// CREDENCIAIS DE TESTE
// ============================================
const TEST_ACCOUNT = {
    username: 'MagnificentTyson11266',
    password: 'yui678',
    totpSecret: 'ZQI7AMNNWRZYEZOZW5727RR4B6MWRVC2',
};

// Colors
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

function step(n, msg) {
    console.log(`\n${c.cyan}${'═'.repeat(50)}${c.reset}`);
    console.log(`${c.bold}${c.blue}  STEP ${n}: ${msg}${c.reset}`);
    console.log(`${c.cyan}${'═'.repeat(50)}${c.reset}\n`);
}

// Generate TOTP
async function generateTOTP(secret) {
    const sanitized = secret.replace(/\s+/g, '').toUpperCase();
    try {
        const code = await new Promise((resolve, reject) => {
            const req = https.get(`https://2fa.live/tok/${sanitized}`, { timeout: 5000 }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(data).token); }
                    catch (e) { reject(new Error('Invalid JSON')); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        });
        log(`✅ TOTP via 2fa.live: ${code}`, 'green');
        return code;
    } catch (e) {
        log(`⚠️ 2fa.live falhou, usando speakeasy...`, 'yellow');
    }
    const code = speakeasy.totp({ secret: sanitized, encoding: 'base32', step: 30 });
    log(`✅ TOTP via speakeasy: ${code}`, 'green');
    return code;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    console.log(`\n${c.bold}${c.cyan}${'╔'.padEnd(50, '═')}╗${c.reset}`);
    console.log(`${c.bold}${c.cyan}║       INSTAGRAM LOGIN TEST v2               ║${c.reset}`);
    console.log(`${c.bold}${c.cyan}${'╚'.padEnd(50, '═')}╝${c.reset}\n`);

    log(`Conta: ${TEST_ACCOUNT.username}`, 'blue');

    // 1. Launch browser
    step(1, 'Iniciando Firefox (VISÍVEL)');
    const browser = await firefox.launch({ headless: false, slowMo: 50 });
    log('✅ Firefox iniciado', 'green');

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
        viewport: { width: 1280, height: 720 },
    });

    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();

    try {
        // 2. Navigate
        step(2, 'Navegando para Instagram Login');
        await page.goto('https://www.instagram.com/accounts/login/', {
            waitUntil: 'networkidle',
            timeout: 60000,
        });
        log(`✅ Página: ${page.url()}`, 'green');

        // Wait for page to fully render
        log('⏳ Aguardando renderização completa...', 'yellow');
        await delay(5000);

        // 3. Debug: List all inputs on page
        step(3, 'Analisando elementos da página');

        const inputs = await page.$$eval('input', els =>
            els.map(i => ({
                name: i.name,
                type: i.type,
                placeholder: i.placeholder,
                ariaLabel: i.getAttribute('aria-label'),
            }))
        );
        console.log('Inputs encontrados:');
        inputs.forEach((inp, i) => {
            console.log(`  ${i + 1}. name="${inp.name}" type="${inp.type}" placeholder="${inp.placeholder}" aria-label="${inp.ariaLabel}"`);
        });

        // 4. Find username field using multiple strategies
        step(4, 'Procurando campo de username');

        // New Instagram layout uses aria-label or placeholder instead of name
        const usernameSelectors = [
            'input[name="username"]',
            'input[aria-label*="usuário"]',
            'input[aria-label*="username"]',
            'input[aria-label*="email"]',
            'input[aria-label*="celular"]',
            'input[aria-label*="phone"]',
            'input[placeholder*="usuário"]',
            'input[placeholder*="email"]',
            'input[placeholder*="celular"]',
            'input[type="text"]:first-of-type',
            'form input:first-of-type',
        ];

        let usernameInput = null;
        for (const sel of usernameSelectors) {
            try {
                usernameInput = await page.$(sel);
                if (usernameInput) {
                    const visible = await usernameInput.isVisible();
                    if (visible) {
                        log(`✅ Campo encontrado: ${sel}`, 'green');
                        break;
                    }
                    usernameInput = null;
                }
            } catch (e) { /* continue */ }
        }

        if (!usernameInput) {
            // Last resort: get first visible input
            log('⚠️ Tentando primeiro input visível...', 'yellow');
            const allInputs = await page.$$('input');
            for (const inp of allInputs) {
                if (await inp.isVisible()) {
                    usernameInput = inp;
                    log('✅ Usando primeiro input visível', 'green');
                    break;
                }
            }
        }

        if (!usernameInput) {
            throw new Error('Campo de username não encontrado em nenhum seletor!');
        }

        // Fill username
        await usernameInput.click();
        await delay(300);
        await usernameInput.fill(TEST_ACCOUNT.username);
        log(`✅ Username preenchido: ${TEST_ACCOUNT.username}`, 'green');

        // 5. Find password field
        step(5, 'Procurando campo de senha');

        const passwordSelectors = [
            'input[name="password"]',
            'input[type="password"]',
            'input[aria-label*="Senha"]',
            'input[aria-label*="password"]',
            'input[placeholder*="Senha"]',
        ];

        let passwordInput = null;
        for (const sel of passwordSelectors) {
            try {
                passwordInput = await page.$(sel);
                if (passwordInput && await passwordInput.isVisible()) {
                    log(`✅ Campo senha: ${sel}`, 'green');
                    break;
                }
                passwordInput = null;
            } catch (e) { /* continue */ }
        }

        if (!passwordInput) {
            throw new Error('Campo de senha não encontrado!');
        }

        await passwordInput.click();
        await delay(300);
        await passwordInput.fill(TEST_ACCOUNT.password);
        log('✅ Senha preenchida', 'green');

        await delay(1000);

        // 6. Find and click login button
        step(6, 'Clicando no botão de login');

        const loginSelectors = [
            'button[type="submit"]',
            'button:has-text("Entrar")',
            'button:has-text("Log in")',
            'div[role="button"]:has-text("Entrar")',
        ];

        let loginBtn = null;
        for (const sel of loginSelectors) {
            try {
                loginBtn = await page.$(sel);
                if (loginBtn && await loginBtn.isVisible()) {
                    log(`✅ Botão encontrado: ${sel}`, 'green');
                    break;
                }
                loginBtn = null;
            } catch (e) { /* continue */ }
        }

        if (loginBtn) {
            await loginBtn.click();
            log('✅ Botão clicado', 'green');
        } else {
            log('⚠️ Botão não encontrado, usando Enter', 'yellow');
            await page.keyboard.press('Enter');
        }

        log('⏳ Aguardando resposta do Instagram...', 'yellow');
        await delay(8000);

        // 7. Check result
        step(7, 'Verificando resultado');

        const url = page.url();
        log(`URL: ${url}`, 'blue');

        const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 800) || '');
        log(`Conteúdo: ${bodyText.replace(/\n/g, ' ').substring(0, 300)}...`, 'blue');

        // Check for errors first
        if (bodyText.toLowerCase().includes('incorreta') || bodyText.toLowerCase().includes('incorrect')) {
            log('❌ ERRO: Senha incorreta!', 'red');
        }

        if (bodyText.toLowerCase().includes('aguarde') || bodyText.toLowerCase().includes('wait')) {
            log('❌ ERRO: Rate limited!', 'red');
        }

        // Check 2FA
        const needs2FA = url.includes('challenge') ||
            url.includes('two_factor') ||
            bodyText.includes('código') ||
            bodyText.includes('code') ||
            bodyText.includes('autenticação') ||
            bodyText.includes('authentication') ||
            bodyText.includes('verificação');

        if (needs2FA) {
            step('7.1', '🔐 2FA Detectado!');

            await delay(3000);

            // Find 2FA input
            const codeSelectors = [
                'input[name="verificationCode"]',
                'input[name="security_code"]',
                'input[type="text"][maxlength="6"]',
                'input[type="number"]',
                'input[type="tel"]',
                'input[aria-label*="código"]',
                'input[aria-label*="code"]',
                'input[placeholder*="código"]',
            ];

            let codeInput = null;
            for (const sel of codeSelectors) {
                try {
                    codeInput = await page.$(sel);
                    if (codeInput && await codeInput.isVisible()) {
                        log(`✅ Campo 2FA: ${sel}`, 'green');
                        break;
                    }
                    codeInput = null;
                } catch (e) { /* continue */ }
            }

            if (codeInput) {
                const totpCode = await generateTOTP(TEST_ACCOUNT.totpSecret);

                await codeInput.click();
                await delay(300);
                await codeInput.fill('');

                for (const digit of totpCode) {
                    await codeInput.type(digit, { delay: 100 });
                }

                log(`✅ Código: ${totpCode}`, 'green');
                await delay(1000);

                // Submit
                const confirmBtn = await page.$('button[type="submit"]') ||
                    await page.$('button:has-text("Confirmar")');

                if (confirmBtn && await confirmBtn.isVisible()) {
                    await confirmBtn.click();
                    log('✅ Submetido via botão', 'green');
                } else {
                    await page.keyboard.press('Enter');
                    log('✅ Submetido via Enter', 'green');
                }

                await delay(8000);
            } else {
                log('❌ Campo 2FA não encontrado!', 'red');

                // Debug: list inputs
                const allInputs = await page.$$eval('input', els =>
                    els.map(i => `${i.name || i.type || 'unknown'}[${i.placeholder || i.getAttribute('aria-label') || ''}]`)
                );
                log(`Inputs: ${allInputs.join(', ')}`, 'yellow');
            }
        }

        // 8. Final
        step(8, 'Resultado Final');

        const finalUrl = page.url();
        log(`URL final: ${finalUrl}`, 'blue');

        // Take screenshot
        await page.screenshot({ path: './logs/test-login-final.png', fullPage: true });
        log('📸 Screenshot: logs/test-login-final.png', 'cyan');

        const isLoggedIn = await page.evaluate(() => {
            return document.querySelector('svg[aria-label="Home"]') !== null ||
                document.querySelector('svg[aria-label="Início"]') !== null ||
                document.querySelector('a[href="/direct/inbox/"]') !== null ||
                document.querySelector('[aria-label="Nova publicação"]') !== null;
        });

        if (isLoggedIn ||
            (!finalUrl.includes('login') &&
                !finalUrl.includes('challenge') &&
                !finalUrl.includes('error'))) {
            console.log(`\n${c.green}${'█'.repeat(50)}${c.reset}`);
            console.log(`${c.green}█         ✅ LOGIN SUCCESSFUL! ✅              █${c.reset}`);
            console.log(`${c.green}${'█'.repeat(50)}${c.reset}\n`);
        } else {
            console.log(`\n${c.red}${'█'.repeat(50)}${c.reset}`);
            console.log(`${c.red}█            ❌ LOGIN FAILED ❌                █${c.reset}`);
            console.log(`${c.red}${'█'.repeat(50)}${c.reset}\n`);
        }

        // Keep open
        log('\n⏸️ Navegador aberto. Aguardando 5min ou feche manualmente.', 'cyan');
        await delay(300000);

    } catch (error) {
        console.log(`\n${c.red}❌ ERRO: ${error.message}${c.reset}`);
        console.error(error.stack);

        await page.screenshot({ path: './logs/test-login-error.png', fullPage: true });
        log('📸 Screenshot: logs/test-login-error.png', 'yellow');

        await delay(60000);
    } finally {
        await browser.close();
    }
}

main().catch(console.error);
