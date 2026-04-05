# AgentForge — Contabo VPS Deployment Guide

## Prerequisites

- Contabo VPS with Ubuntu (22.04 or 24.04)
- SSH access to the server
- Domain name (optional but recommended for HTTPS)
- GitHub repo: `https://github.com/amtariksha/agentforge.git`

---

## Step 1: Initial Server Setup

SSH into your Contabo VPS:

```bash
ssh root@YOUR_CONTABO_IP
```

### Update system and install essentials

```bash
apt update && apt upgrade -y
apt install -y curl git ufw
```

### Create a non-root user (recommended)

```bash
adduser agentforge
usermod -aG sudo agentforge
su - agentforge
```

### Configure firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3000/tcp    # Fastify API (remove after setting up reverse proxy)
sudo ufw enable
```

---

## Step 2: Install Docker

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh

# Add your user to docker group (avoids needing sudo for docker)
sudo usermod -aG docker agentforge

# Log out and back in for group change to take effect
exit
ssh agentforge@YOUR_CONTABO_IP

# Verify
docker --version
docker compose version
```

---

## Step 3: Clone the Repository

```bash
mkdir -p ~/apps
cd ~/apps
git clone https://github.com/amtariksha/agentforge.git
cd agentforge
```

---

## Step 4: Configure Environment

```bash
cp .env.example .env
nano .env
```

Fill in your actual values:

```env
# Database (these match docker-compose.yml defaults — change password for production)
DATABASE_URL=postgresql://agentforge:CHANGE_THIS_PASSWORD@postgres:5432/agentforge

# Redis
REDIS_URL=redis://redis:6379

# Server
PORT=3000
HOST=0.0.0.0
NODE_ENV=production

# JWT — generate a strong secret
JWT_SECRET=GENERATE_WITH: openssl rand -hex 32
JWT_EXPIRES_IN=24h
JWT_REFRESH_EXPIRES_IN=7d

# Encryption key for tenant credentials — exactly 32 characters
ENCRYPTION_KEY=GENERATE_WITH: openssl rand -hex 16

# Anthropic API key
ANTHROPIC_API_KEY=sk-ant-your-key-here

# OpenAI (for embeddings, optional)
OPENAI_API_KEY=sk-your-key-here

# Swarg Food WhatsApp (fill when ready)
SWARG_WA_PHONE_ID=
SWARG_WA_WABA_ID=
SWARG_WA_ACCESS_TOKEN=
SWARG_WA_VERIFY_TOKEN=
SWARG_WA_APP_SECRET=

# Logging
LOG_LEVEL=info
```

Generate secrets:

```bash
echo "JWT_SECRET: $(openssl rand -hex 32)"
echo "ENCRYPTION_KEY: $(openssl rand -hex 16)"
```

### Update docker-compose.yml password

Edit `docker-compose.yml` to match the password you set in DATABASE_URL:

```bash
nano docker-compose.yml
```

Change `POSTGRES_PASSWORD: agentforge` to your chosen password.

---

## Step 5: Build and Start

```bash
# Build the app image and start all services
docker compose up -d --build

# Check all 3 containers are running
docker compose ps
```

Expected output:
```
NAME                  STATUS
agentforge-app-1      Up
agentforge-postgres-1 Up (healthy)
agentforge-redis-1    Up (healthy)
```

### Run database migration

```bash
# Push schema to database
docker compose exec app npx drizzle-kit push

# Apply pgvector extension and RLS policies
docker compose exec postgres psql -U agentforge -d agentforge -f /dev/stdin < drizzle/0000_init.sql
```

### Seed initial data

```bash
docker compose exec app node dist/scripts/seed.js
```

If seed fails (build artifact path), run it from source:

```bash
docker compose exec app npx tsx scripts/seed.ts
```

### Verify

```bash
# Health check
curl http://localhost:3000/health

# Expected: {"status":"ok","timestamp":"...","uptime":...}
```

---

## Step 6: Set Up Nginx Reverse Proxy + HTTPS

### Install Nginx and Certbot

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

### Create Nginx config

```bash
sudo nano /etc/nginx/sites-available/agentforge
```

```nginx
# API backend
server {
    listen 80;
    server_name api.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE support
        proxy_buffering off;
        proxy_cache off;

        # WebSocket support (for live chat + web widget)
        proxy_read_timeout 86400;
    }
}
```

Enable and test:

```bash
sudo ln -s /etc/nginx/sites-available/agentforge /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### Get SSL certificate (requires domain pointing to this IP)

```bash
sudo certbot --nginx -d api.yourdomain.com
```

Certbot auto-configures Nginx for HTTPS and sets up auto-renewal.

### Remove direct port 3000 access

```bash
sudo ufw delete allow 3000/tcp
```

---

## Step 7: Auto-Start on Reboot

Docker Compose services are already configured to restart. Ensure Docker starts on boot:

```bash
sudo systemctl enable docker
```

---

## Step 8: Deploy Updates

When you push new code to GitHub:

```bash
cd ~/apps/agentforge
git pull origin main
docker compose up -d --build
```

### Quick deploy script

Create `~/apps/agentforge/deploy.sh`:

```bash
#!/bin/bash
set -e
cd ~/apps/agentforge
echo "Pulling latest code..."
git pull origin main
echo "Rebuilding and restarting..."
docker compose up -d --build
echo "Running migrations..."
docker compose exec app npx drizzle-kit push 2>/dev/null || true
echo "Deploy complete!"
docker compose ps
```

```bash
chmod +x deploy.sh
```

Run: `./deploy.sh`

---

## Step 9: WhatsApp Webhook Configuration

Once HTTPS is set up, configure Meta's webhook to point to:

```
Webhook URL:    https://api.yourdomain.com/webhooks/whatsapp/swarg-food
Verify Token:   (value from SWARG_WA_VERIFY_TOKEN in .env)
```

Subscribe to the `messages` field.

---

## Step 10: Connect Vercel Dashboard

In your Vercel project (dashboard/):

1. Go to **Settings → Environment Variables**
2. Add: `API_URL` = `https://api.yourdomain.com`
3. Redeploy the dashboard

---

## Monitoring

### View logs

```bash
# All services
docker compose logs -f

# Just the app
docker compose logs -f app

# Last 100 lines
docker compose logs --tail 100 app
```

### Check resource usage

```bash
docker stats
```

### Database backup

```bash
# Backup
docker compose exec postgres pg_dump -U agentforge agentforge > backup_$(date +%Y%m%d).sql

# Restore
cat backup_YYYYMMDD.sql | docker compose exec -T postgres psql -U agentforge agentforge
```

### Restart a single service

```bash
docker compose restart app
docker compose restart postgres
docker compose restart redis
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| App can't connect to Postgres | Check `DATABASE_URL` uses `postgres` (not `localhost`) as host — Docker networking |
| App can't connect to Redis | Check `REDIS_URL` uses `redis` (not `localhost`) as host |
| WebSocket not working | Ensure Nginx has `proxy_set_header Upgrade` and `Connection "upgrade"` |
| SSE streaming hangs | Ensure `proxy_buffering off` in Nginx |
| WhatsApp webhook fails verification | Check `SWARG_WA_VERIFY_TOKEN` matches what you entered in Meta dashboard |
| Permission denied on Docker | Run `sudo usermod -aG docker $USER` and re-login |
| Out of disk space | `docker system prune -a` to clean old images |
| High memory usage | Check `docker stats` — Postgres may need `shared_buffers` tuning |

---

## Estimated Resource Usage

| Service | RAM | CPU | Disk |
|---------|-----|-----|------|
| Fastify app | ~100-200 MB | Low | ~200 MB (image) |
| PostgreSQL 16 | ~200-500 MB | Low-Med | Grows with data |
| Redis 7 | ~50-100 MB | Low | Minimal |
| **Total** | **~400-800 MB** | **1-2 cores** | **~1 GB base** |

A Contabo VPS with 4 GB RAM and 2 cores handles this comfortably with room for growth.
