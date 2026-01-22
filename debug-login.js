/**
 * Debug Login Script
 * Tests login with detailed diagnostics
 */

const { firefox } = require('playwright');

async function debugLogin() {
    const browser = await firefox.launch({
        headless: false,  // Visual mode
        args: [
            '--disable-blink-features=AutomationControlled'
        ]
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
        viewport: { width: 390, height: 844 },
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
        hasTouch: true,
        isMobile: true
    });

    // Anti-detection
    await context.addInitScript(() => {
        // Remove webdriver
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined
        });

        // Add realistic props
        window.chrome = {
            runtime: {}
        };

        Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5]
        });

        Object.defineProperty(navigator, 'languages', {
            get: () => ['pt-BR', 'pt', 'en-US', 'en']
        });
    });

    const page = await context.newPage();

    console.log('📱 Navegando para Instagram...');
    await page.goto('https://www.instagram.com/accounts/login/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
    });

    console.log('⏳ Aguardando 5 segundos...');
    await page.waitForTimeout(5000);

    // Check what Instagram sees
    const diagnostics = await page.evaluate(() => {
        return {
            webdriver: navigator.webdriver,
            platform: navigator.platform,
            userAgent: navigator.userAgent,
            languages: navigator.languages,
            hasChrome: !!window.chrome,
            pluginCount: navigator.plugins.length
        };
    });

    console.log('\n🔍 Instagram vê:', JSON.stringify(diagnostics, null, 2));

    console.log('\n📸 URL atual:', page.url());
    console.log('📄 Título:', await page.title());

    // Try to get page content
    const hasUsernameField = await page.locator('input[name="username"]').count() > 0;
    const hasPasswordField = await page.locator('input[name="password"]').count() > 0;

    console.log('\n🎯 Elementos encontrados:');
    console.log('  - Campo username:', hasUsernameField ? '✅' : '❌');
    console.log('  - Campo password:', hasPasswordField ? '✅' : '❌');

    console.log('\n⌛ Deixando navegador aberto para inspeção manual...');
    console.log('   Pressione Ctrl+C para fechar quando terminar.');

    // Keep browser open for inspection
    await new Promise(() => { });
}

debugLogin().catch(console.error);
