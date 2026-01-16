# Database Migrations

Este documento registra todas as alterações no schema do banco de dados.

---

## Migration 002 - Tabelas de Proxies e Contas Instagram

**Data:** 2026-01-16  
**Autor:** Sistema  
**Versão:** 1.2.0

### Descrição
Move configurações de proxies e contas Instagram de variáveis de ambiente para tabelas no Supabase.

### SQL para Executar

```sql
-- Tabela de Proxies
CREATE TABLE instagram_proxies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host TEXT NOT NULL,             -- Ex: gate.decodo.com
  port INTEGER NOT NULL,          -- Ex: 10001
  username TEXT,
  password TEXT,
  is_active BOOLEAN DEFAULT true,
  last_used_at TIMESTAMPTZ,
  fail_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tabela de Contas Instagram  
CREATE TABLE instagram_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  is_banned BOOLEAN DEFAULT false,
  last_login_at TIMESTAMPTZ,
  session_data JSONB,
  fail_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_proxies_active ON instagram_proxies(is_active);
CREATE INDEX idx_accounts_active ON instagram_accounts(is_active, is_banned);
```

### Exemplo de Inserção

```sql
-- Inserir proxy (host e port separados)
INSERT INTO instagram_proxies (host, port, username, password)
VALUES ('gate.decodo.com', 10001, 'seu_usuario', 'sua_senha');

-- Inserir conta Instagram
INSERT INTO instagram_accounts (username, password)
VALUES ('email@exemplo.com', 'senha123');
```

### Campos da Tabela `instagram_proxies`

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `host` | TEXT | Hostname do proxy |
| `port` | INTEGER | Porta do proxy |
| `username` | TEXT | Usuário do proxy |
| `password` | TEXT | Senha do proxy |
| `is_active` | BOOLEAN | Se proxy está ativo |

### Campos da Tabela `instagram_accounts`

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `username` | TEXT | Email/usuário Instagram |
| `password` | TEXT | Senha Instagram |
| `session_data` | JSONB | Cookies de sessão |
| `is_banned` | BOOLEAN | Se conta está banida |
