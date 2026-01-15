# Instagram Comments Scraper API

API para scraping de comentários de posts públicos do Instagram. Substitui a Apify a um custo muito menor (~$100/mês vs $2,691/mês).

## 🚀 Funcionalidades

- ✅ Scraping de comentários de posts públicos do Instagram
- ✅ Sistema de fila com Bull Queue + Redis
- ✅ Paralelização com múltiplos proxies (1 worker por proxy)
- ✅ Rate limiting configurável
- ✅ Auto-discovery de doc_id do Instagram
- ✅ Integração com Supabase
- ✅ API REST para n8n
- ✅ Health checks e estatísticas
- ✅ Docker-ready para Easypanel

## 📋 Requisitos

- Node.js 18+
- Redis
- Supabase (PostgreSQL)
- Proxies residenciais (datacenter proxies são bloqueados)

## 🛠️ Instalação

### Local

```bash
# Clonar repositório
git clone <repo-url>
cd instagram-scraper

# Instalar dependências
npm install

# Instalar Playwright
npx playwright install chromium

# Configurar ambiente
cp .env.example .env
# Editar .env com suas credenciais

# Iniciar Redis (se não tiver)
docker run -d -p 6379:6379 redis:alpine

# Iniciar aplicação
npm start
```

### Docker

```bash
# Configurar ambiente
cp .env.example .env
# Editar .env com suas credenciais

# Iniciar com Docker Compose
docker-compose up -d

# Ver logs
docker-compose logs -f scraper
```

## ⚙️ Configuração

### Variáveis de Ambiente

| Variável | Descrição | Obrigatório |
|----------|-----------|-------------|
| `SUPABASE_URL` | URL do projeto Supabase | ✅ |
| `SUPABASE_KEY` | Chave anon do Supabase | ✅ |
| `REDIS_HOST` | Host do Redis | ✅ |
| `REDIS_PORT` | Porta do Redis | ✅ |
| `PROXIES` | JSON array de proxies | ✅ |
| `REQUESTS_PER_MINUTE` | Rate limit por worker | ❌ (default: 30) |
| `PORT` | Porta da API | ❌ (default: 3000) |
| `WEBHOOK_URL` | URL para notificações | ❌ |
| `LOG_LEVEL` | Nível de log | ❌ (default: info) |

### Formato dos Proxies

```json
[
  {"server":"proxy1.com:8080","username":"user1","password":"pass1"},
  {"server":"proxy2.com:8080","username":"user2","password":"pass2"}
]
```

## 📊 Schema do Banco de Dados

Execute no Supabase SQL Editor:

```sql
-- Configuração (doc_ids)
CREATE TABLE instagram_config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  doc_id_comments TEXT NOT NULL,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  method TEXT,
  is_valid BOOLEAN DEFAULT true,
  CONSTRAINT single_row CHECK (id = 1)
);

-- Jobs de scraping
CREATE TABLE scrape_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_url TEXT NOT NULL,
  post_id TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  comments_count INTEGER DEFAULT 0,
  error TEXT,
  result JSONB
);

CREATE INDEX idx_jobs_status ON scrape_jobs(status);
CREATE INDEX idx_jobs_created ON scrape_jobs(created_at DESC);

-- Comentários
CREATE TABLE instagram_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id TEXT NOT NULL,
  post_url TEXT NOT NULL,
  comment_id TEXT UNIQUE NOT NULL,
  text TEXT,
  created_at TIMESTAMPTZ,
  username TEXT,
  user_id TEXT,
  profile_pic_url TEXT,
  like_count INTEGER DEFAULT 0,
  scraped_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_comments_post_id ON instagram_comments(post_id);
CREATE INDEX idx_comments_comment_id ON instagram_comments(comment_id);
CREATE INDEX idx_comments_username ON instagram_comments(username);
```

## 🔌 API Endpoints

### Criar Job de Scraping

```http
POST /api/scrape
Content-Type: application/json

{
  "postUrl": "https://www.instagram.com/p/ABC123/"
}
```

**Resposta:**
```json
{
  "jobId": "uuid-aqui",
  "status": "pending",
  "postUrl": "https://www.instagram.com/p/ABC123/",
  "postId": "ABC123"
}
```

### Consultar Status do Job

```http
GET /api/job/{jobId}
```

**Resposta:**
```json
{
  "jobId": "uuid-aqui",
  "status": "completed",
  "commentsCount": 150,
  "startedAt": "2024-01-15T10:00:00Z",
  "completedAt": "2024-01-15T10:01:30Z"
}
```

### Health Check

```http
GET /api/health
```

### Estatísticas

```http
GET /api/stats
```

### Listar Comentários

```http
GET /api/comments/{postId}?limit=100&offset=0
```

## 🔄 Integração com n8n

1. **HTTP Request Node (POST)**
   - URL: `https://scraper.seudominio.com/api/scrape`
   - Body: `{ "postUrl": "{{$json.instagram_url}}" }`

2. **Wait Node** - Aguardar 30 segundos

3. **Supabase Node**
   - Operação: Get Many Rows
   - Tabela: `instagram_comments`
   - Filtro: `post_url = {{$json.postUrl}}`

## 🐳 Deploy no Easypanel

1. Criar novo App no Easypanel (tipo: Docker)
2. Configurar repositório Git ou upload da imagem
3. Adicionar variáveis de ambiente
4. Adicionar serviço Redis (se não existir)
5. Configurar domínio com SSL
6. Deploy!

## 🔧 Troubleshooting

### Erro: "No proxies configured"

Verifique se a variável `PROXIES` está configurada corretamente no formato JSON.

### Erro: "Connection refused" (Redis)

Verifique se o Redis está rodando e acessível.

### Erro: "Rate limited by Instagram"

- Reduza `REQUESTS_PER_MINUTE`
- Adicione mais proxies
- Verifique se os proxies são residenciais

### Erro: "doc_id inválido"

O sistema tenta auto-descobrir automaticamente. Se falhar:
1. Verifique os logs
2. Tente reiniciar o serviço
3. Verifique se os proxies estão funcionando

## 📁 Estrutura do Projeto

```
instagram-scraper/
├── src/
│   ├── api/
│   │   └── server.js           # Express API
│   ├── workers/
│   │   └── scraper.worker.js   # Bull Queue workers
│   ├── services/
│   │   ├── instagram.service.js # Lógica de scraping
│   │   ├── proxy.service.js     # Gestão de proxies
│   │   └── docid.service.js     # Auto-update doc_ids
│   ├── config/
│   │   └── index.js            # Configurações
│   └── utils/
│       ├── logger.js           # Winston logger
│       └── helpers.js          # Funções auxiliares
├── cron/
│   └── update-docids.cron.js   # CRON job diário
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── package.json
```

## 📄 Licença

MIT
