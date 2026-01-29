/**
 * Verification Script
 * Testa o InstagramService real com as credenciais fornecidas
 */

const instagramService = require('../src/services/instagram.service');
const logger = require('../src/utils/logger');

const TEST_ACCOUNT = {
    username: 'MagnificentTyson11266',
    password: 'yui678',
    totpSecret: 'ZQI7AMNNWRZYEZOZW5727RR4B6MWRVC2',
};

async function verify() {
    console.log('\n--- VERIFICAÇÃO DO SERVIÇO PRINCIPAL ---');

    let browser = null;
    let context = null;

    try {
        // 1. Launch browser (use headless for automated test, but we can set to false to see it)
        console.log('1. Iniciando navegador...');
        browser = await instagramService.launchBrowser(null); // No proxy for this test
        context = await instagramService.createBrowserContext(browser);

        // 2. Perform Login
        console.log('2. Tentando login com serviço principal...');
        const success = await instagramService.performLogin(context, TEST_ACCOUNT);

        if (success) {
            console.log('\n✅ SUCESSO! O serviço principal logou corretamente.');

            // Verificação final
            const page = await context.newPage();
            await page.goto('https://www.instagram.com/');
            const isLoggedIn = await instagramService.checkLoggedIn(page);
            console.log(`Status de login verificado: ${isLoggedIn ? 'LOGADO' : 'NÃO LOGADO'}`);
            await page.close();
        } else {
            console.log('\n❌ FALHA! O login não teve sucesso.');
        }

    } catch (error) {
        console.error('\n❌ ERRO FATAL:', error.message);
        console.error(error.stack);
    } finally {
        if (context) await context.close().catch(() => { });
        if (browser) await browser.close().catch(() => { });
        console.log('--- FIM DA VERIFICAÇÃO ---');
        process.exit(0);
    }
}

verify();
