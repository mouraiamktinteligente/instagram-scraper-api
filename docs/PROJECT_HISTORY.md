# Instagram Scraper - Histórico do Projeto

> **Última atualização**: 17/01/2026  
> **Objetivo**: Documentar o que funciona, problemas conhecidos, e pendências

---

## ✅ O Que Funciona

### Sistema de Scraping Principal
| Componente | Status | Notas |
|------------|--------|-------|
| Login Instagram (sem 2FA) | ✅ Funciona | Testado e confirmado |
| Extração de comentários | ✅ Funciona | Scraping realizado com sucesso |
| Pool de contas | ✅ Funciona | Rotação entre múltiplas contas |
| Sistema de proxies | ✅ Funciona | Proxies configurados e operacionais |
| Salvamento de sessão (cookies) | ✅ Funciona | Sessões persistem entre execuções |
| Bull Queue | ✅ Funciona | Jobs processados corretamente |
| API REST | ✅ Funciona | Endpoints operacionais |
| Firefox como browser | ✅ Funciona | **Preferido sobre Chromium** |

### Database (Supabase)
| Tabela | Status |
|--------|--------|
| `scrape_jobs` | ✅ Existe |
| `instagram_comments` | ✅ Existe |
| `instagram_accounts` | ✅ Existe |
| `instagram_proxies` | ✅ Existe |
| `warming_accounts` | ✅ Criado 17/01 |
| `warming_sessions` | ✅ Criado 17/01 |
| `warming_proxies` | ✅ Criado 17/01 |

---

## ❌ O Que NÃO Funciona

### Login com 2FA (TOTP)
| Problema | Status | Detalhes |
|----------|--------|----------|
| 2FA não submete código | 🔴 Não resolvido | Código TOTP gerado mas não submetido |
| Sessão expira com 2FA | 🔴 Não resolvido | Contas com 2FA não mantêm sessão |

**Investigações realizadas:**
- Múltiplos seletores para botão de submit
- `page.keyboard.press('Enter')`
- Código TOTP gerado corretamente via `speakeasy`

### Chromium
| Problema | Status |
|----------|--------|
| Login não carrega | 🔴 Não funciona |
| Dados não encontrados | 🔴 Não funciona |

**Decisão**: Usar **Firefox** como browser padrão

---

## 🆕 Sistema de Warming (Não Testado)

Implementado em 17/01/2026.

| Componente | Arquivo | Status |
|------------|---------|--------|
| Padrões de navegação | `warmingBehavior.service.js` | 🟡 Não testado |
| Pool de warming | `warmingPool.service.js` | 🟡 Não testado |
| Worker | `warmingWorker.js` | 🟡 Não testado |
| CRON | `warming.cron.js` | 🟡 Não testado |
| Stealth browser | `stealthBrowser.js` | 🟡 Não testado |
| Comportamento humano | `humanBehavior.js` | 🟡 Não testado |

---

## 📋 Configuração Técnica

### Browser
- **Preferido**: Firefox
- **Problema**: Chromium não funciona com login Instagram
- **Stealth**: Aplicado via `addInitScript` (não via plugin)

### Limites de Ação (Warming)
```javascript
DAILY_LIMITS = {
  likes: 80,
  follows: 40,
  comments: 15,
  stories: 100
}
```

### Timezone
- **Horário**: Brasília (UTC-3)
- **Warming**: 08:00-23:00

---

## 📝 Pendências

- [ ] Resolver login 2FA
- [ ] Testar sistema de warming
- [ ] Validar stealth com Firefox
- [ ] Testar CRON automático
