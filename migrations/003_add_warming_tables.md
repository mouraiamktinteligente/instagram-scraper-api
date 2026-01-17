# Database Migrations

Este documento registra alterações para o sistema de aquecimento de contas.

---

## Migration 003 - Tabelas de Aquecimento de Contas

**Data:** 2026-01-17  
**Autor:** Sistema  
**Versão:** 1.3.0

### Descrição

Cria tabelas para gerenciar o sistema de aquecimento de contas Instagram.
Contas novas passam por período de 5 dias de humanização antes de serem liberadas para scraping.

### SQL para Executar

```sql
-- ================================================
-- TABELA: warming_proxies
-- Proxies dedicados para aquecimento (separados dos de scraping)
-- ================================================
CREATE TABLE warming_proxies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT,
  password TEXT,
  is_active BOOLEAN DEFAULT true,
  assigned_account_id UUID,  -- cada proxy fica exclusivo para uma conta
  last_used_at TIMESTAMPTZ,
  fail_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_warming_proxies_active ON warming_proxies(is_active);
CREATE INDEX idx_warming_proxies_assigned ON warming_proxies(assigned_account_id);

-- ================================================
-- TABELA: warming_accounts
-- Contas em processo de aquecimento (5 dias de humanização)
-- ================================================
CREATE TABLE warming_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  totp_secret TEXT,
  proxy_id UUID REFERENCES warming_proxies(id),
  session_data JSONB,
  status TEXT DEFAULT 'pending',  -- pending, warming, ready, failed
  warming_started_at TIMESTAMPTZ,
  warming_progress INTEGER DEFAULT 0,  -- dias completados (0-5)
  last_warming_session_at TIMESTAMPTZ,
  total_sessions INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_warming_accounts_status ON warming_accounts(status);
CREATE INDEX idx_warming_accounts_progress ON warming_accounts(warming_progress);

-- ================================================
-- TABELA: warming_sessions
-- Registra cada sessão de aquecimento executada
-- ================================================
CREATE TABLE warming_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES warming_accounts(id) ON DELETE CASCADE,
  pattern_name TEXT NOT NULL,
  actions_performed JSONB,
  duration_seconds INTEGER,
  success BOOLEAN DEFAULT true,
  error_message TEXT,
  executed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_warming_sessions_account ON warming_sessions(account_id);
CREATE INDEX idx_warming_sessions_executed ON warming_sessions(executed_at DESC);

-- ================================================
-- Adicionar FK reversa na warming_proxies
-- ================================================
ALTER TABLE warming_proxies 
  ADD CONSTRAINT fk_warming_proxies_account 
  FOREIGN KEY (assigned_account_id) 
  REFERENCES warming_accounts(id) 
  ON DELETE SET NULL;
```

### Exemplo de Inserção

```sql
-- 1. Inserir proxy de aquecimento
INSERT INTO warming_proxies (host, port, username, password)
VALUES ('warming-proxy.example.com', 10001, 'user', 'pass');

-- 2. Inserir conta para aquecimento
INSERT INTO warming_accounts (username, password, totp_secret)
VALUES ('conta@email.com', 'senha123', 'TOTP_SECRET_BASE32');

-- 3. Associar proxy à conta
UPDATE warming_accounts 
SET proxy_id = (SELECT id FROM warming_proxies WHERE host = 'warming-proxy.example.com' LIMIT 1)
WHERE username = 'conta@email.com';

UPDATE warming_proxies 
SET assigned_account_id = (SELECT id FROM warming_accounts WHERE username = 'conta@email.com')
WHERE host = 'warming-proxy.example.com';
```

### Campos da Tabela `warming_accounts`

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `username` | TEXT | Email/usuário Instagram |
| `password` | TEXT | Senha Instagram |
| `totp_secret` | TEXT | Secret 2FA (base32) |
| `proxy_id` | UUID | Proxy dedicado para esta conta |
| `session_data` | JSONB | Cookies de sessão salvos |
| `status` | TEXT | pending, warming, ready, failed |
| `warming_progress` | INTEGER | Dias completados (0-5) |
| `total_sessions` | INTEGER | Total de sessões executadas |

### Campos da Tabela `warming_sessions`

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `pattern_name` | TEXT | Nome do padrão usado (ex: casual_explorer) |
| `actions_performed` | JSONB | Log detalhado das ações |
| `duration_seconds` | INTEGER | Duração da sessão em segundos |
| `success` | BOOLEAN | Se a sessão foi bem sucedida |
