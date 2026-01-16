# Database Migrations

Este documento registra todas as alterações no schema do banco de dados.

---

## Migration 002 - Tabelas de Proxies e Contas Instagram

**Data:** 2026-01-16  
**Autor:** Sistema  
**Versão:** 1.2.0

### Descrição
Move configurações de proxies e contas Instagram de variáveis de ambiente para tabelas no Supabase, permitindo adicionar/remover credenciais via interface web sem necessidade de redeploy.

### SQL para Executar

```sql
-- Tabela de Proxies
CREATE TABLE instagram_proxies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server TEXT NOT NULL,           -- Ex: gate.decodo.com:10001
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
  username TEXT NOT NULL UNIQUE,  -- Email ou username
  password TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  is_banned BOOLEAN DEFAULT false,
  last_login_at TIMESTAMPTZ,
  session_data JSONB,             -- Cookies da sessão
  fail_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX idx_proxies_active ON instagram_proxies(is_active);
CREATE INDEX idx_accounts_active ON instagram_accounts(is_active, is_banned);
```

### Migração de Dados Existentes

Se você tinha proxies e contas nas variáveis de ambiente, insira manualmente:

```sql
-- Inserir proxy
INSERT INTO instagram_proxies (server, username, password)
VALUES ('gate.decodo.com:10001', 'seu_usuario', 'sua_senha');

-- Inserir conta Instagram
INSERT INTO instagram_accounts (username, password)
VALUES ('email@exemplo.com', 'senha123');
```

### Campos da Tabela `instagram_proxies`

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | UUID | ID único |
| `server` | TEXT | Host:porta do proxy |
| `username` | TEXT | Usuário do proxy |
| `password` | TEXT | Senha do proxy |
| `is_active` | BOOLEAN | Se proxy está ativo |
| `last_used_at` | TIMESTAMPTZ | Última vez usado |
| `fail_count` | INTEGER | Contador de erros |

### Campos da Tabela `instagram_accounts`

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | UUID | ID único |
| `username` | TEXT | Email/usuário Instagram |
| `password` | TEXT | Senha Instagram |
| `is_active` | BOOLEAN | Se conta está ativa |
| `is_banned` | BOOLEAN | Se conta está banida |
| `last_login_at` | TIMESTAMPTZ | Último login |
| `session_data` | JSONB | Cookies de sessão |
| `fail_count` | INTEGER | Contador de erros |

### Variáveis de Ambiente Removidas

- `PROXIES` - Agora via Supabase
- `INSTAGRAM_ACCOUNTS` - Agora via Supabase
