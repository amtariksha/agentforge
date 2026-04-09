#!/bin/bash
###############################################################################
# AgentForge — Database Server Setup (run on the DEDICATED DB VPS)
#
# Usage:
#   ssh root@DB_SERVER_IP
#   curl -fsSL https://raw.githubusercontent.com/amtariksha/agentforge/main/scripts/setup-db-server.sh | bash -s -- --app-ip APP_SERVER_IP
#
#   OR:
#   chmod +x setup-db-server.sh
#   sudo ./setup-db-server.sh --app-ip 123.45.67.89
#
# What this does:
#   1. Installs Docker
#   2. Configures firewall (allow Postgres ONLY from app server IP)
#   3. Generates Postgres password, creates .env
#   4. Starts PostgreSQL 16 + pgvector with tuned settings for 8GB RAM
#   5. Runs initial migrations (pgvector extension + RLS)
#   6. Sets up automated daily backups
#
# After running:
#   - Copy the DATABASE_URL printed at the end
#   - Paste it into the .env on your APP server
#   - Then run setup-server.sh on the APP server (or update existing .env)
###############################################################################

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[DB-SETUP]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

[[ $EUID -eq 0 ]] || err "Run as root: sudo ./setup-db-server.sh --app-ip APP_SERVER_IP"

# Parse arguments
APP_IP=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --app-ip) APP_IP="$2"; shift 2 ;;
        *) shift ;;
    esac
done

[[ -n "${APP_IP}" ]] || err "Usage: ./setup-db-server.sh --app-ip APP_SERVER_IP"

DB_DIR="/opt/agentforge-db"
BACKUP_DIR="/opt/agentforge-backups"

###############################################################################
# 1. System update + Docker
###############################################################################
log "Updating system..."
apt update && apt upgrade -y
apt install -y curl git ufw

if command -v docker &>/dev/null; then
    log "Docker already installed"
else
    log "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
fi

systemctl enable docker
systemctl start docker

###############################################################################
# 2. Firewall — ONLY allow Postgres from app server
###############################################################################
log "Configuring firewall..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
# Allow Postgres ONLY from the app server IP
ufw allow from "${APP_IP}" to any port 5432 proto tcp comment "AgentForge app server"
ufw --force enable

log "Firewall: Postgres port 5432 open ONLY to ${APP_IP}"

###############################################################################
# 3. Clone repo (for compose file + migration SQL)
###############################################################################
log "Setting up database directory..."
mkdir -p "${DB_DIR}" "${BACKUP_DIR}"

if [[ -d "${DB_DIR}/.git" ]]; then
    git -C "${DB_DIR}" pull origin main 2>/dev/null || true
else
    git clone https://github.com/amtariksha/agentforge.git "${DB_DIR}"
fi

###############################################################################
# 4. Generate secrets + .env
###############################################################################
ENV_FILE="${DB_DIR}/.env"

if [[ -f "${ENV_FILE}" ]]; then
    warn ".env already exists — loading existing password"
    source "${ENV_FILE}"
else
    POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')

    cat > "${ENV_FILE}" << ENVEOF
POSTGRES_USER=agentforge
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=agentforge
ENVEOF

    chmod 600 "${ENV_FILE}"
    log "Generated Postgres password"
fi

# Load vars
source "${ENV_FILE}"

###############################################################################
# 5. Configure Postgres to accept remote connections
###############################################################################
# The pgvector Docker image handles pg_hba.conf automatically
# The docker-compose.db.yml passes listen_addresses='*' via command

###############################################################################
# 6. Start PostgreSQL
###############################################################################
log "Starting PostgreSQL..."
cd "${DB_DIR}"
docker compose -f docker-compose.db.yml up -d

# Wait for Postgres to be ready
log "Waiting for PostgreSQL..."
for i in {1..30}; do
    if docker compose -f docker-compose.db.yml exec -T postgres pg_isready -U "${POSTGRES_USER}" &>/dev/null; then
        log "PostgreSQL is ready"
        break
    fi
    sleep 2
done

###############################################################################
# 7. Verify pgvector + RLS (init.sql runs automatically via docker-entrypoint)
###############################################################################
log "Verifying pgvector extension..."
docker compose -f docker-compose.db.yml exec -T postgres \
    psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>&1 || true

###############################################################################
# 8. Automated daily backups
###############################################################################
log "Setting up automated daily backups..."

cat > /usr/local/bin/agentforge-backup.sh << 'BACKUPEOF'
#!/bin/bash
set -euo pipefail
BACKUP_DIR="/opt/agentforge-backups"
DB_DIR="/opt/agentforge-db"
TIMESTAMP=$(date +%Y%m%d_%H%M)

cd "${DB_DIR}"
docker compose -f docker-compose.db.yml exec -T postgres \
    pg_dump -U agentforge --format=custom agentforge > "${BACKUP_DIR}/agentforge_${TIMESTAMP}.dump"

# Keep last 14 days of backups
find "${BACKUP_DIR}" -name "*.dump" -mtime +14 -delete

echo "[$(date -Iseconds)] Backup complete: agentforge_${TIMESTAMP}.dump ($(du -h "${BACKUP_DIR}/agentforge_${TIMESTAMP}.dump" | cut -f1))"
BACKUPEOF

chmod +x /usr/local/bin/agentforge-backup.sh

# Run daily at 2 AM
(crontab -l 2>/dev/null | grep -v agentforge-backup; echo "0 2 * * * /usr/local/bin/agentforge-backup.sh >> /var/log/agentforge-backup.log 2>&1") | crontab -

log "Daily backups scheduled at 2 AM (14-day retention)"

###############################################################################
# 9. Create update script
###############################################################################
cat > "${DB_DIR}/update-db.sh" << 'UPDATEEOF'
#!/bin/bash
set -euo pipefail
cd /opt/agentforge-db
echo "[DB] Pulling latest..."
git pull origin main
echo "[DB] Restarting PostgreSQL..."
docker compose -f docker-compose.db.yml up -d
echo "[DB] Done."
docker compose -f docker-compose.db.yml ps
UPDATEEOF
chmod +x "${DB_DIR}/update-db.sh"

###############################################################################
# Done
###############################################################################
DB_SERVER_IP=$(hostname -I | awk '{print $1}')

echo ""
echo "================================================================"
log "Database server setup complete!"
echo "================================================================"
echo ""
echo -e "  ${CYAN}PostgreSQL:${NC}  Running on port 5432"
echo -e "  ${CYAN}Firewall:${NC}    Port 5432 open ONLY to ${APP_IP}"
echo -e "  ${CYAN}Backups:${NC}     Daily at 2 AM → ${BACKUP_DIR}/ (14-day retention)"
echo -e "  ${CYAN}Update:${NC}      ${DB_DIR}/update-db.sh"
echo ""
echo "================================================================"
echo -e "  ${GREEN}COPY THIS to your APP server's .env:${NC}"
echo ""
echo -e "  ${CYAN}DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${DB_SERVER_IP}:5432/${POSTGRES_DB}${NC}"
echo ""
echo "================================================================"
echo ""
echo "  NEXT: On your APP server, set DATABASE_URL in .env and run:"
echo "    cd ~/apps/agentforge && ./deploy.sh"
echo ""
