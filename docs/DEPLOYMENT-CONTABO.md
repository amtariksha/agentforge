# AgentForge — Contabo VPS Deployment Guide

## Architecture Options

AgentForge supports two deployment architectures:

```
OPTION A: All-in-One (single VPS)       OPTION B: Split (recommended)
┌────────────────────┐                  ┌─── App VPS ───┐    ┌─── DB VPS ────┐
│ Fastify app        │                  │ Fastify app    │    │ PostgreSQL 16 │
│ PostgreSQL+pgvector│                  │ Redis 7        │───→│ + pgvector    │
│ Redis 7            │                  │ Nginx          │    │ Auto backups  │
│ Nginx              │                  └────────────────┘    └───────────────┘
└────────────────────┘
```

**Option B is recommended** when you have a dedicated DB VPS — better isolation, independent scaling, tuned Postgres settings for your 8GB RAM DB server.

## Prerequisites

- One or two Contabo VPS with Ubuntu (22.04 or 24.04)
- SSH access
- Domain name (optional but recommended for HTTPS)

---

## Option B: Split Setup (Dedicated DB Server)

### Step 1: Set up the Database VPS first

```bash
ssh root@DB_SERVER_IP

curl -fsSL https://raw.githubusercontent.com/amtariksha/agentforge/main/scripts/setup-db-server.sh | bash -s -- --app-ip APP_SERVER_IP
```

Replace `APP_SERVER_IP` with your app server's IP. The script:
- Installs Docker, starts PostgreSQL 16 + pgvector
- Opens port 5432 **only** to your app server (firewall)
- Tunes Postgres for 8GB RAM (2GB shared_buffers, 6GB cache)
- Sets up daily backups at 2 AM (14-day retention)
- Prints a `DATABASE_URL` — **copy it**

### Step 2: Set up the App VPS

```bash
ssh root@APP_SERVER_IP

curl -fsSL https://raw.githubusercontent.com/amtariksha/agentforge/main/scripts/setup-server.sh | bash
```

Then edit `.env` to set the remote DATABASE_URL:

```bash
nano /home/agentforge/apps/agentforge/.env
# Replace the DATABASE_URL line with what the DB setup script printed:
# DATABASE_URL=postgresql://agentforge:PASSWORD@DB_SERVER_IP:5432/agentforge
```

Then redeploy:

```bash
cd /home/agentforge/apps/agentforge && ./deploy.sh --seed
```

The setup script auto-detects the remote DB and uses `docker-compose.app.yml` (no local Postgres).

---

## Option A: All-in-One (Single VPS)

```bash
ssh root@YOUR_VPS_IP

curl -fsSL https://raw.githubusercontent.com/amtariksha/agentforge/main/scripts/setup-server.sh | bash
```

This runs everything on one server using `docker-compose.prod.yml`.

### What the setup script does

1. Updates Ubuntu and installs `curl git ufw nginx certbot`
2. Creates `agentforge` user with Docker access
3. Installs Docker + Docker Compose
4. Configures firewall (SSH + HTTP + HTTPS only — no exposed DB ports)
5. Clones the repo to `~/apps/agentforge`
6. Generates random secrets and creates `.env` (JWT, encryption, Postgres password, Redis password)
7. Builds and starts all Docker containers (app + Postgres + Redis)
8. Runs database migrations (Drizzle push + pgvector + RLS)
9. Seeds the database with Swarg Food tenant config
10. Configures Nginx reverse proxy with WebSocket + SSE support

### After setup completes

The script prints next steps. You need to:

```bash
# 1. Add your API keys
nano ~/apps/agentforge/.env
#    Set ANTHROPIC_API_KEY=sk-ant-...
#    Set WhatsApp credentials (if ready)
#    Save and exit

# 2. Restart with new env
cd ~/apps/agentforge && ./deploy.sh

# 3. Point your domain DNS (A record) to this server's IP

# 4. Update Nginx with your domain
sudo nano /etc/nginx/sites-available/agentforge
#    Change: server_name _;
#    To:     server_name api.yourdomain.com;
sudo nginx -t && sudo systemctl reload nginx

# 5. Get HTTPS
sudo certbot --nginx -d api.yourdomain.com
```

### Verify

```bash
curl http://localhost:3000/health
# {"status":"ok","timestamp":"...","uptime":...}

# Or from outside (after Nginx setup):
curl https://api.yourdomain.com/health
```

---

## Deploying Updates

Every time you push new code to GitHub:

```bash
ssh agentforge@YOUR_CONTABO_IP
cd ~/apps/agentforge
./deploy.sh
```

### What the deploy script does

1. Pulls latest code from GitHub
2. Rebuilds the Docker image (only changed layers — fast)
3. Restarts the app container
4. Runs database migrations (idempotent)
5. Verifies health check
6. Cleans up old Docker images

### Deploy flags

```bash
./deploy.sh              # Standard deploy
./deploy.sh --seed       # Also re-run seed script (after adding new tenants)
./deploy.sh --full       # Force full Docker rebuild (no cache)
./deploy.sh --logs       # Tail app logs after deploy
./deploy.sh --seed --logs  # Combine flags
```

---

## WhatsApp Webhook Setup

After HTTPS is working:

1. Go to [Meta Developer Console](https://developers.facebook.com)
2. Configure webhook:
   ```
   Webhook URL:    https://api.yourdomain.com/webhooks/whatsapp/swarg-food
   Verify Token:   (value from SWARG_WA_VERIFY_TOKEN in .env)
   ```
3. Subscribe to the `messages` field

---

## Connect Vercel Dashboard

The Next.js admin dashboard deploys on Vercel:

1. Import repo at [vercel.com/new](https://vercel.com/new) → `amtariksha/agentforge`
2. Set **Root Directory** to `dashboard`
3. Add environment variable: `API_URL` = `https://api.yourdomain.com`
4. Deploy

---

## Day-to-Day Operations

### View logs

```bash
cd ~/apps/agentforge

# All services
docker compose -f docker-compose.prod.yml logs -f

# Just the app (most useful)
docker compose -f docker-compose.prod.yml logs -f --tail 100 app

# Just errors
docker compose -f docker-compose.prod.yml logs -f app 2>&1 | grep -i error
```

### Restart services

```bash
# Restart app only (keeps DB and Redis running)
docker compose -f docker-compose.prod.yml restart app

# Restart everything
docker compose -f docker-compose.prod.yml restart
```

### Database backup

```bash
# Backup
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U agentforge agentforge > backup_$(date +%Y%m%d_%H%M).sql

# Restore
cat backup_YYYYMMDD_HHMM.sql | docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U agentforge agentforge
```

### Check resource usage

```bash
docker stats --no-stream
```

### Shell into containers

```bash
# App container
docker compose -f docker-compose.prod.yml exec app sh

# Postgres
docker compose -f docker-compose.prod.yml exec postgres psql -U agentforge agentforge

# Redis
docker compose -f docker-compose.prod.yml exec redis redis-cli -a YOUR_REDIS_PASSWORD
```

---

## Security Notes

The production setup (`docker-compose.prod.yml`) is hardened:

| Item | How |
|------|-----|
| Postgres | Not exposed externally — Docker internal network only |
| Redis | Not exposed externally — password required |
| App | Bound to `127.0.0.1:3000` — only Nginx can reach it |
| Firewall | Only SSH + HTTP + HTTPS open |
| Secrets | Auto-generated random passwords, stored in `.env` with `chmod 600` |
| Nginx | Security headers (X-Frame-Options, X-Content-Type-Options, X-XSS-Protection) |
| HTTPS | Certbot auto-renewal |

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `health` returns nothing | `docker compose -f docker-compose.prod.yml logs --tail 50 app` — check for startup errors |
| `POSTGRES_PASSWORD not set` | Check `.env` exists and has `POSTGRES_PASSWORD` |
| WebSocket not connecting | Verify Nginx has `proxy_set_header Upgrade` and `Connection "upgrade"` |
| SSE streaming hangs | Verify Nginx has `proxy_buffering off` |
| WhatsApp webhook 403 | Verify token in `.env` matches Meta dashboard |
| Disk full | `docker system prune -a` to clean old images |
| High memory | `docker stats` — Postgres may need `shared_buffers` tuning |
| Can't SSH | Check UFW: `sudo ufw status` — OpenSSH should be allowed |

---

## Resource Usage

| Service | RAM | Notes |
|---------|-----|-------|
| Fastify app | ~100-200 MB | Grows with concurrent connections |
| PostgreSQL | ~200-500 MB | Grows with data + pgvector indexes |
| Redis | ~50-100 MB | BullMQ queues + session cache |
| Nginx | ~10 MB | Reverse proxy |
| **Total** | **~400-800 MB** | 4 GB VPS handles this comfortably |
