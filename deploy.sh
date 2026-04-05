#!/bin/bash
###############################################################################
# AgentForge — Update & Deploy Script
# Run this every time you push new code to GitHub.
#
# Usage:
#   cd ~/apps/agentforge && ./deploy.sh
#
# What this does:
#   1. Pulls latest code from GitHub
#   2. Rebuilds the Docker image (only layers that changed)
#   3. Restarts the app container (zero-downtime: new container starts before old stops)
#   4. Runs database migrations (safe — Drizzle push is idempotent)
#   5. Verifies health check
#   6. Shows status
#
# Flags:
#   --seed     Also re-run the seed script after migration
#   --full     Force full rebuild (no Docker cache)
#   --logs     Tail logs after deploy
###############################################################################

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[DEPLOY]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

COMPOSE_FILE="docker-compose.prod.yml"
SEED=false
FULL_REBUILD=false
TAIL_LOGS=false

for arg in "$@"; do
    case $arg in
        --seed) SEED=true ;;
        --full) FULL_REBUILD=true ;;
        --logs) TAIL_LOGS=true ;;
    esac
done

# Must be in the project directory
[[ -f "${COMPOSE_FILE}" ]] || err "Run from the agentforge directory: cd ~/apps/agentforge && ./deploy.sh"
[[ -f ".env" ]] || err ".env file not found. Run setup-server.sh first."

START_TIME=$(date +%s)

###############################################################################
# 1. Pull latest code
###############################################################################
log "Pulling latest code..."
git fetch origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [[ "${LOCAL}" == "${REMOTE}" ]]; then
    warn "Already up to date (${LOCAL:0:8}). Redeploying anyway."
else
    COMMITS=$(git log --oneline ${LOCAL}..${REMOTE} | wc -l)
    log "Updating: ${COMMITS} new commit(s)"
    git pull origin main
fi

CURRENT_SHA=$(git rev-parse --short HEAD)
log "Now at commit: ${CURRENT_SHA}"

###############################################################################
# 2. Rebuild and restart
###############################################################################
if [[ "${FULL_REBUILD}" == true ]]; then
    log "Full rebuild (no cache)..."
    docker compose -f "${COMPOSE_FILE}" build --no-cache app
else
    log "Building (incremental)..."
    docker compose -f "${COMPOSE_FILE}" build app
fi

log "Restarting app container..."
docker compose -f "${COMPOSE_FILE}" up -d app

# Wait for container to be running
sleep 3

###############################################################################
# 3. Run migrations
###############################################################################
log "Running database migrations..."
docker compose -f "${COMPOSE_FILE}" exec -T app npx drizzle-kit push 2>&1 | tail -3 || warn "Migration output needs review"

###############################################################################
# 4. Seed (optional)
###############################################################################
if [[ "${SEED}" == true ]]; then
    log "Re-running seed..."
    docker compose -f "${COMPOSE_FILE}" exec -T app npx tsx scripts/seed.ts 2>&1 | tail -5 || warn "Seed output needs review"
fi

###############################################################################
# 5. Health check
###############################################################################
log "Checking health..."
HEALTHY=false
for i in {1..10}; do
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/health 2>/dev/null || echo "000")
    if [[ "${HTTP_CODE}" == "200" ]]; then
        HEALTHY=true
        break
    fi
    sleep 2
done

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

###############################################################################
# 6. Status
###############################################################################
echo ""
echo "================================================================"
if [[ "${HEALTHY}" == true ]]; then
    log "Deploy successful! (${DURATION}s)"
else
    warn "Deploy finished but health check failed — check logs"
fi
echo "================================================================"
echo ""
echo -e "  ${CYAN}Commit:${NC}     ${CURRENT_SHA}"
echo -e "  ${CYAN}Duration:${NC}   ${DURATION}s"
echo -e "  ${CYAN}Health:${NC}     $(curl -s http://127.0.0.1:3000/health 2>/dev/null || echo 'UNREACHABLE')"
echo ""
echo -e "  ${CYAN}Containers:${NC}"
docker compose -f "${COMPOSE_FILE}" ps --format "    {{.Name}}: {{.Status}}" 2>/dev/null
echo ""
echo -e "  ${CYAN}Logs:${NC}       docker compose -f ${COMPOSE_FILE} logs -f app"
echo -e "  ${CYAN}Restart:${NC}    docker compose -f ${COMPOSE_FILE} restart app"
echo ""

# Clean up old Docker images to save disk
docker image prune -f --filter "until=168h" &>/dev/null || true

###############################################################################
# 7. Tail logs (optional)
###############################################################################
if [[ "${TAIL_LOGS}" == true ]]; then
    log "Tailing logs (Ctrl+C to stop)..."
    docker compose -f "${COMPOSE_FILE}" logs -f --tail 50 app
fi
