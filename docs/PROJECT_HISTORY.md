# Instagram Scraper - Histórico do Projeto

> **Última atualização**: 29/01/2026
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
| **Modo público (sem login)** | ✅ Novo 29/01 | Extrai comentários sem conta (estilo Apify) |

### Database (Supabase)
| Tabela | Status |
|--------|--------|
| `scrape_jobs` | ✅ Existe |
| `instagram_comments` | ✅ Existe |
| `instagram_accounts` | ✅ Existe |
| `instagram_proxies` | ✅ Existe |

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

### Login sem 2FA
| Problema | Status | Detalhes |
|----------|--------|----------|
| Botão submit não encontrado | 🟢 Corrigido 17/01 | Instagram mudou interface - adicionados 8 seletores alternativos |

### Chromium
| Problema | Status |
|----------|--------|
| Login não carrega | 🔴 Não funciona |
| Dados não encontrados | 🔴 Não funciona |

**Decisão**: Usar **Firefox** como browser padrão

---

## 📋 Configuração Técnica

### Browser
- **Preferido**: Firefox
- **Problema**: Chromium não funciona com login Instagram
- **Stealth**: Aplicado via `addInitScript` (não via plugin)

### Timezone
- **Horário**: Brasília (UTC-3)

---

## 🆕 Modo Público (Sem Login) - Implementado 29/01/2026

### Descrição
Novo modo de extração similar ao Apify Instagram Comment Scraper que não requer login.

### Como Usar

```bash
# Modo automático (padrão): tenta público primeiro, depois autenticado
curl -X POST http://localhost:3000/api/scrape \
  -H "Content-Type: application/json" \
  -d '{"postUrl": "https://instagram.com/p/ABC123/"}'

# Modo público forçado: nunca usa login
curl -X POST http://localhost:3000/api/scrape \
  -H "Content-Type: application/json" \
  -d '{"postUrl": "https://instagram.com/p/ABC123/", "mode": "public"}'

# Modo autenticado forçado: sempre usa login
curl -X POST http://localhost:3000/api/scrape \
  -H "Content-Type: application/json" \
  -d '{"postUrl": "https://instagram.com/p/ABC123/", "mode": "authenticated"}'
```

### Modos Disponíveis

| Modo | Descrição | Risco de Ban |
|------|-----------|--------------|
| `auto` | Tenta público primeiro, cai para autenticado se necessário | Baixo |
| `public` | Apenas extração pública, sem login | Zero |
| `authenticated` | Sempre usa conta para login | Médio |

### Benefícios do Modo Público
- Zero risco de ban de contas
- Funciona mesmo sem contas cadastradas
- Mais rápido (sem overhead de login)
- Ideal para posts públicos

### Limitações do Modo Público
- Extrai apenas comentários visíveis a usuários não autenticados
- Alguns posts podem exigir autenticação
- Pode retornar menos comentários que modo autenticado

---

## 🔧 Melhorias Implementadas 29/01/2026

### 1. Diagnóstico de Contas
- Logs detalhados quando nenhuma conta está disponível
- Instruções SQL para verificar/resetar contas no Supabase
- Arquivo: `accountPool.service.js`

### 2. Parâmetro `mode` na API
- API aceita `mode: "public" | "authenticated" | "auto"`
- Worker passa mode para o serviço de scraping
- Arquivos: `server.js`, `scraper.worker.js`

### 3. Método `scrapePublicComments()`
- Nova função para extração sem login
- Usa mesmas técnicas de stealth e interception
- Arquivo: `instagram.service.js`

### 4. Remoção do Sistema de Warming
- Removidos 5 arquivos (~2,715 linhas de código)
- Sistema não funcionou como esperado
- Funcionalidades de scraping mantidas intactas

---

## 📝 Pendências

- [ ] Resolver login 2FA (código TOTP não submete)
- [ ] Validar stealth com Firefox
- [x] Implementar modo público (Apify-style) - **Concluído 29/01**
- [x] Remover sistema de warming - **Concluído 29/01**
