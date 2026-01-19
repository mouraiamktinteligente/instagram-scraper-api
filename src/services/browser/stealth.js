/**
 * Stealth patches para Playwright - Remove detecção de automação
 * Baseado em pesquisas de anti-detection 2025
 */

const logger = require('../../utils/logger');

class StealthService {
    /**
     * Aplica todos os patches anti-detecção em um contexto de navegador
     */
    async applyStealthPatches(context) {
        logger.info('[STEALTH] Applying anti-detection patches to context...');

        // Aplicar patches em todas as páginas do contexto
        context.on('page', async (page) => {
            await this.patchPage(page);
        });

        logger.info('[STEALTH] ✅ Context patched, will apply to all new pages');
    }

    /**
     * Aplica patches em uma página específica
     */
    async patchPage(page) {
        try {
            // Patch 1: Remover navigator.webdriver
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined,
                });
            });

            // Patch 2: Sobrescrever Permissions API
            await page.addInitScript(() => {
                if (window.navigator.permissions) {
                    const originalQuery = window.navigator.permissions.query;
                    window.navigator.permissions.query = (parameters) => (
                        parameters.name === 'notifications' ?
                            Promise.resolve({ state: Notification.permission }) :
                            originalQuery(parameters)
                    );
                }
            });

            // Patch 3: Adicionar plugins realistas
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [
                        {
                            0: { type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format" },
                            description: "Portable Document Format",
                            filename: "internal-pdf-viewer",
                            length: 1,
                            name: "Chrome PDF Plugin"
                        },
                        {
                            0: { type: "application/pdf", suffixes: "pdf", description: "" },
                            description: "",
                            filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai",
                            length: 1,
                            name: "Chrome PDF Viewer"
                        }
                    ],
                });
            });

            // Patch 4: Chrome runtime
            await page.addInitScript(() => {
                window.chrome = {
                    runtime: {},
                    loadTimes: function () { },
                    csi: function () { },
                };
            });

            // Patch 5: User-Agent consistente com headers
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'platform', {
                    get: () => 'Linux x86_64',
                });
            });

            // Patch 6: Languages
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['pt-BR', 'pt', 'en-US', 'en'],
                });
            });

            // Patch 7: Hardware Concurrency
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'hardwareConcurrency', {
                    get: () => 8,
                });
            });

            // Patch 8: Device Memory
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'deviceMemory', {
                    get: () => 8,
                });
            });

            // Patch 9: Screen properties realistas
            await page.addInitScript(() => {
                Object.defineProperty(screen, 'availWidth', { get: () => 1920 });
                Object.defineProperty(screen, 'availHeight', { get: () => 1080 });
                Object.defineProperty(screen, 'width', { get: () => 1920 });
                Object.defineProperty(screen, 'height', { get: () => 1080 });
                Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
                Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
            });

            // Patch 10: Battery API
            await page.addInitScript(() => {
                if (navigator.getBattery) {
                    const originalGetBattery = navigator.getBattery.bind(navigator);
                    navigator.getBattery = () => originalGetBattery().then(battery => {
                        Object.defineProperty(battery, 'charging', { get: () => true });
                        Object.defineProperty(battery, 'chargingTime', { get: () => 0 });
                        Object.defineProperty(battery, 'dischargingTime', { get: () => Infinity });
                        Object.defineProperty(battery, 'level', { get: () => 1 });
                        return battery;
                    });
                }
            });

            // Patch 11: WebGL Vendor
            await page.addInitScript(() => {
                const getParameter = WebGLRenderingContext.prototype.getParameter;
                WebGLRenderingContext.prototype.getParameter = function (parameter) {
                    if (parameter === 37445) {
                        return 'Intel Inc.';
                    }
                    if (parameter === 37446) {
                        return 'Intel(R) HD Graphics 620';
                    }
                    return getParameter.call(this, parameter);
                };
            });

            // Patch 12: Timezone Brasil
            await page.addInitScript(() => {
                Date.prototype.getTimezoneOffset = function () { return 180; }; // Brasília UTC-3
            });

            logger.info('[STEALTH] ✅ Applied 12 anti-detection patches to page');
        } catch (error) {
            logger.error('[STEALTH] Error applying patches:', error.message);
        }
    }

    /**
     * Retorna headers extras para parecer mais humano
     */
    getExtraHTTPHeaders() {
        return {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Cache-Control': 'max-age=0'
        };
    }

    /**
     * Retorna headers específicos para Instagram GraphQL
     */
    getInstagramHeaders() {
        return {
            'X-IG-App-ID': '936619743392459',
            'X-ASBD-ID': '129477',
            'X-IG-WWW-Claim': '0',
            'X-Requested-With': 'XMLHttpRequest',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin'
        };
    }
}

module.exports = new StealthService();
