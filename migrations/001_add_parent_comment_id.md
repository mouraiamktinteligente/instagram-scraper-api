# Database Migrations

Este documento registra todas as alterações no schema do banco de dados.

---

## Migration 001 - Suporte a Respostas de Comentários

**Data:** 2026-01-16  
**Autor:** Sistema  
**Versão:** 1.1.0

### Descrição
Adiciona suporte para identificar comentários que são respostas a outros comentários (replies/threads).

### SQL Executado

```sql
-- Adicionar campo para identificar comentários que são respostas
ALTER TABLE instagram_comments 
ADD COLUMN IF NOT EXISTS parent_comment_id TEXT;

-- Criar índice para buscar respostas
CREATE INDEX IF NOT EXISTS idx_comments_parent 
ON instagram_comments(parent_comment_id);
```

### Campos Afetados

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `parent_comment_id` | TEXT | ID do comentário pai (NULL se for comentário principal) |

### Impacto no Código

- `src/utils/helpers.js` - `parseComment()` atualizado para incluir `parent_comment_id`
- `src/services/instagram.service.js` - Extração de replies implementada

### Como Usar

**Comentário Principal:**
```json
{
  "comment_id": "123",
  "parent_comment_id": null,
  "text": "Ótimo post!"
}
```

**Resposta (Reply):**
```json
{
  "comment_id": "456",
  "parent_comment_id": "123",
  "text": "Concordo!"
}
```

### Query para Buscar Árvore de Comentários

```sql
-- Comentários principais (sem pai)
SELECT * FROM instagram_comments 
WHERE post_id = 'ABC123' AND parent_comment_id IS NULL;

-- Respostas de um comentário específico
SELECT * FROM instagram_comments 
WHERE parent_comment_id = '123';
```
