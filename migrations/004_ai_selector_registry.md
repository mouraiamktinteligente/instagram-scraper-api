# Migration 004: AI Selector Registry

Esta migration cria a tabela para cachear seletores descobertos pela IA.

## Objetivo

Armazenar seletores CSS/XPath descobertos automaticamente pela IA quando os seletores tradicionais falham. Isso evita chamadas repetidas ao LLM e mantém histórico de mudanças do Instagram.

## SQL

```sql
-- =====================================================
-- TABELA: selector_registry
-- Armazena seletores CSS descobertos pela IA
-- =====================================================

CREATE TABLE IF NOT EXISTS selector_registry (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    
    -- Identificação do seletor
    selector_name VARCHAR(100) NOT NULL,           -- Ex: 'comment_list', 'login_button', 'username_field'
    selector_context VARCHAR(50) NOT NULL,          -- Ex: 'post_page', 'login_page', 'profile_page'
    
    -- Seletores (podem ter múltiplos fallbacks)
    primary_selector TEXT NOT NULL,                 -- Seletor CSS principal
    fallback_selectors JSONB DEFAULT '[]',          -- Array de seletores alternativos
    
    -- Metadados
    discovered_by VARCHAR(20) DEFAULT 'manual',     -- 'manual', 'ai_gpt4', 'ai_gemini'
    confidence_score DECIMAL(3,2) DEFAULT 1.00,     -- 0.00 a 1.00
    success_count INTEGER DEFAULT 0,                -- Quantas vezes funcionou
    failure_count INTEGER DEFAULT 0,                -- Quantas vezes falhou
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_success_at TIMESTAMPTZ,
    last_failure_at TIMESTAMPTZ,
    
    -- Constraints
    UNIQUE(selector_name, selector_context)
);

-- Índices para busca rápida
CREATE INDEX idx_selector_registry_name ON selector_registry(selector_name);
CREATE INDEX idx_selector_registry_context ON selector_registry(selector_context);

-- Trigger para atualizar updated_at
CREATE OR REPLACE FUNCTION update_selector_registry_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_selector_registry_updated
    BEFORE UPDATE ON selector_registry
    FOR EACH ROW
    EXECUTE FUNCTION update_selector_registry_timestamp();

-- =====================================================
-- DADOS INICIAIS: Seletores conhecidos
-- =====================================================

INSERT INTO selector_registry (selector_name, selector_context, primary_selector, fallback_selectors, discovered_by)
VALUES 
    -- Login Page
    ('username_field', 'login_page', 'input[name="username"]', 
     '["input[aria-label*=\"username\"]", "input[type=\"text\"]"]'::jsonb, 'manual'),
    
    ('password_field', 'login_page', 'input[name="password"]', 
     '["input[type=\"password\"]", "input[aria-label*=\"password\"]"]'::jsonb, 'manual'),
    
    ('login_button', 'login_page', 'button[type="submit"]', 
     '["button:has-text(\"Entrar\")", "button:has-text(\"Log in\")", "div[role=\"button\"]:has-text(\"Entrar\")"]'::jsonb, 'manual'),
    
    -- Post Page
    ('comment_section', 'post_page', 'article div > ul', 
     '["ul[class*=\"comment\"]", "div[class*=\"comment\"] ul"]'::jsonb, 'manual'),
    
    ('comment_item', 'post_page', 'ul > div[role="button"]', 
     '["li[class*=\"comment\"]", "div[class*=\"_a9zs\"]"]'::jsonb, 'manual'),
    
    ('comment_username', 'post_page', 'a[href^=\"/\"] > span', 
     '["span._ap3a", "a[role=\"link\"] span"]'::jsonb, 'manual'),
    
    ('comment_text', 'post_page', 'span[dir=\"auto\"]', 
     '["span._ap3a", "div[class*=\"comment-text\"]"]'::jsonb, 'manual'),
    
    -- Profile/Home indicators
    ('logged_in_indicator', 'any_page', 'svg[aria-label="Home"]', 
     '["svg[aria-label=\"Início\"]", "a[href=\"/direct/inbox/\"]"]'::jsonb, 'manual')

ON CONFLICT (selector_name, selector_context) DO NOTHING;

-- =====================================================
-- TABELA: ai_analysis_log
-- Log de análises feitas pela IA (para debug/auditoria)
-- =====================================================

CREATE TABLE IF NOT EXISTS ai_analysis_log (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    
    -- Contexto
    page_url TEXT,
    selector_name VARCHAR(100),
    
    -- Requisição
    html_snippet_length INTEGER,
    prompt_used TEXT,
    model_used VARCHAR(50),
    
    -- Resposta
    selectors_found JSONB,
    confidence_score DECIMAL(3,2),
    tokens_used INTEGER,
    cost_usd DECIMAL(10,6),
    
    -- Resultado
    was_successful BOOLEAN,
    error_message TEXT,
    
    -- Timestamp
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índice para buscar por data
CREATE INDEX idx_ai_analysis_log_date ON ai_analysis_log(created_at DESC);
```

## RLS Policies (se necessário)

```sql
-- Permitir leitura para authenticated users
ALTER TABLE selector_registry ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read selector_registry" ON selector_registry
    FOR SELECT USING (true);

CREATE POLICY "Allow insert selector_registry" ON selector_registry
    FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow update selector_registry" ON selector_registry
    FOR UPDATE USING (true);

-- Log pode ser apenas insert (append-only)
ALTER TABLE ai_analysis_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow insert ai_analysis_log" ON ai_analysis_log
    FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow read ai_analysis_log" ON ai_analysis_log
    FOR SELECT USING (true);
```

## Rollback

```sql
DROP TABLE IF EXISTS ai_analysis_log;
DROP TABLE IF EXISTS selector_registry;
DROP FUNCTION IF EXISTS update_selector_registry_timestamp();
```
