#!/bin/bash
set -e

# =============================================================================
# Agentic Update Script - Smart, Minimal Updates Only
# =============================================================================

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Configuration
REPO="Meesvandenkieboom/agentic"
BRANCH="main"
GITHUB_REPO_URL="https://github.com/${REPO}.git"

# Detect platform
OS=$(uname -s)
case $OS in
  Darwin)
    INSTALL_DIR="$HOME/Applications/agentic-app"
    OLD_INSTALL_DIR="$HOME/Applications/agent-smith-app"
    ;;
  Linux)
    INSTALL_DIR="$HOME/.local/share/agentic-app"
    OLD_INSTALL_DIR="$HOME/.local/share/agent-smith-app"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    if [[ -n "$LOCALAPPDATA" ]]; then
      INSTALL_DIR="$LOCALAPPDATA/Programs/agentic-app"
      OLD_INSTALL_DIR="$LOCALAPPDATA/Programs/agent-smith-app"
    else
      INSTALL_DIR="$USERPROFILE/AppData/Local/Programs/agentic-app"
      OLD_INSTALL_DIR="$USERPROFILE/AppData/Local/Programs/agent-smith-app"
    fi
    ;;
  *)
    echo -e "${RED}❌ Unsupported OS: $OS${NC}"
    exit 1
    ;;
esac

log_info() {
  echo -e "${BLUE}ℹ${NC} $1"
}

log_success() {
  echo -e "${GREEN}✓${NC} $1"
}

log_error() {
  echo -e "${RED}❌${NC} $1"
}

log_section() {
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${CYAN}   $1${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
}

# =============================================================================
# Check Installation and Migration
# =============================================================================

# Check if old Agent Smith installation needs migration
if [[ ! -d "$INSTALL_DIR" ]] && [[ -d "$OLD_INSTALL_DIR" ]]; then
  log_error "Agent Smith installation found, but not yet migrated to Agentic"
  echo ""
  log_info "Please run the installer to migrate: curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | bash"
  exit 1
fi

if [[ ! -d "$INSTALL_DIR" ]]; then
  log_error "Agentic is not installed at $INSTALL_DIR"
  echo ""
  log_info "Run the installer first: curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | bash"
  exit 1
fi

# =============================================================================
# Main Update
# =============================================================================

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}   Agentic - Smart Update${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Clone to temp directory
log_section "Downloading Latest Version"

CLONE_DIR="/tmp/agentic-update-$$"
log_info "Cloning from $BRANCH branch..."

if git clone --quiet --depth 1 --branch "$BRANCH" "$GITHUB_REPO_URL" "$CLONE_DIR" 2>&1; then
  log_success "Downloaded latest version"
else
  log_error "Failed to download update"
  rm -rf "$CLONE_DIR" 2>/dev/null || true
  exit 1
fi

# Install dependencies and build
log_section "Installing Dependencies"

cd "$CLONE_DIR"

if ! command -v bun &> /dev/null; then
  log_error "Bun not found in PATH"
  rm -rf "$CLONE_DIR"
  exit 1
fi

# Check if dependencies changed (just for informational message)
DEPS_MSG="Installing dependencies..."
if [[ -f "$INSTALL_DIR/package.json" ]]; then
  if ! diff -q "$CLONE_DIR/package.json" "$INSTALL_DIR/package.json" > /dev/null 2>&1; then
    DEPS_MSG="Dependencies changed - installing..."
  fi
fi

log_info "$DEPS_MSG"

INSTALL_OUTPUT=$(bun install 2>&1)
INSTALL_EXIT_CODE=$?

# Show summary
echo "$INSTALL_OUTPUT" | tail -3

if [ $INSTALL_EXIT_CODE -ne 0 ]; then
  log_error "Failed to install dependencies"
  rm -rf "$CLONE_DIR"
  exit 1
fi

log_success "Dependencies installed"

# Build application
log_section "Building Application"

# Build
log_info "Building..."

if BUILD_OUTPUT=$(bun run build 2>&1); then
  echo "$BUILD_OUTPUT" | grep -E "(✓|✅|built)" || echo "$BUILD_OUTPUT"
  log_success "Build complete"
else
  log_error "Build failed"
  echo "$BUILD_OUTPUT"
  rm -rf "$CLONE_DIR"
  exit 1
fi

# Install update
log_section "Installing Update"

# Backup critical files
ENV_BACKUP=""
SERVER_ENV_BACKUP=""
DATA_BACKUP=""
TOKENS_BACKUP=""
CLAUDE_DIR_BACKUP=""
GITHUB_TOKEN_BACKUP=""

log_info "Backing up user settings..."

if [[ -f "$INSTALL_DIR/.env" ]]; then
  ENV_BACKUP="/tmp/agentic-env-$$"
  cp "$INSTALL_DIR/.env" "$ENV_BACKUP"
  log_info "Backed up .env"
fi

if [[ -f "$INSTALL_DIR/server/.env" ]]; then
  SERVER_ENV_BACKUP="/tmp/agentic-server-env-$$"
  cp "$INSTALL_DIR/server/.env" "$SERVER_ENV_BACKUP"
  log_info "Backed up server/.env (GitHub credentials)"
fi

if [[ -d "$INSTALL_DIR/data" ]]; then
  DATA_BACKUP="/tmp/agentic-data-$$"
  cp -r "$INSTALL_DIR/data" "$DATA_BACKUP"
  log_info "Backed up data directory"
fi

if [[ -f "$INSTALL_DIR/.tokens" ]]; then
  TOKENS_BACKUP="/tmp/agentic-tokens-$$"
  cp "$INSTALL_DIR/.tokens" "$TOKENS_BACKUP"
  log_info "Backed up OAuth tokens"
fi

# Backup .claude directory (MCP configs, agents, settings)
if [[ -d "$INSTALL_DIR/.claude" ]]; then
  CLAUDE_DIR_BACKUP="/tmp/agentic-claude-$$"
  cp -r "$INSTALL_DIR/.claude" "$CLAUDE_DIR_BACKUP"
  log_info "Backed up .claude directory (MCP servers, agents, settings)"
fi

# Determine app data directories
case $OS in
  Darwin)
    APP_DATA_DIR="$HOME/Documents/agentic-app"
    OLD_APP_DATA_DIR="$HOME/Documents/agent-smith-app"
    ;;
  Linux)
    APP_DATA_DIR="$HOME/Documents/agentic-app"
    OLD_APP_DATA_DIR="$HOME/Documents/agent-smith-app"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    APP_DATA_DIR="$USERPROFILE/Documents/agentic-app"
    OLD_APP_DATA_DIR="$USERPROFILE/Documents/agent-smith-app"
    ;;
esac

# Backup GitHub token from current app data directory
if [[ -f "$APP_DATA_DIR/github-token.json" ]]; then
  GITHUB_TOKEN_BACKUP="/tmp/agentic-github-token-$$"
  cp "$APP_DATA_DIR/github-token.json" "$GITHUB_TOKEN_BACKUP"
  log_info "Backed up GitHub token"
fi

# Migrate GitHub token from old Agent Smith directory if it exists
if [[ -z "$GITHUB_TOKEN_BACKUP" ]] && [[ -f "$OLD_APP_DATA_DIR/github-token.json" ]]; then
  GITHUB_TOKEN_BACKUP="/tmp/agentic-github-token-$$"
  cp "$OLD_APP_DATA_DIR/github-token.json" "$GITHUB_TOKEN_BACKUP"
  log_info "Migrated GitHub token from Agent Smith"
fi

# Remove old files (except user data)
log_info "Removing old files..."
find "$INSTALL_DIR" -mindepth 1 \
  ! -name '.env' \
  ! -name '.tokens' \
  ! -name 'data' \
  -delete 2>/dev/null || true

# Copy new files
log_info "Installing new files..."
cp -r "$CLONE_DIR"/* "$INSTALL_DIR/"

# Restore user data
log_info "Restoring user settings..."

if [[ -n "$ENV_BACKUP" ]] && [[ -f "$ENV_BACKUP" ]]; then
  cp "$ENV_BACKUP" "$INSTALL_DIR/.env"
  rm "$ENV_BACKUP"
  log_success "Restored .env"
fi

if [[ -n "$SERVER_ENV_BACKUP" ]] && [[ -f "$SERVER_ENV_BACKUP" ]]; then
  mkdir -p "$INSTALL_DIR/server"
  cp "$SERVER_ENV_BACKUP" "$INSTALL_DIR/server/.env"
  rm "$SERVER_ENV_BACKUP"
  log_success "Restored server/.env (GitHub credentials)"
fi

if [[ -n "$DATA_BACKUP" ]] && [[ -d "$DATA_BACKUP" ]]; then
  rm -rf "$INSTALL_DIR/data"
  mv "$DATA_BACKUP" "$INSTALL_DIR/data"
  log_success "Restored data directory"
fi

if [[ -n "$TOKENS_BACKUP" ]] && [[ -f "$TOKENS_BACKUP" ]]; then
  cp "$TOKENS_BACKUP" "$INSTALL_DIR/.tokens"
  rm "$TOKENS_BACKUP"
  log_success "Restored OAuth tokens"
fi

# Restore .claude directory (MCP configs, agents, settings)
if [[ -n "$CLAUDE_DIR_BACKUP" ]] && [[ -d "$CLAUDE_DIR_BACKUP" ]]; then
  rm -rf "$INSTALL_DIR/.claude"
  mv "$CLAUDE_DIR_BACKUP" "$INSTALL_DIR/.claude"
  log_success "Restored .claude directory (MCP servers, agents, settings)"
fi

# Restore GitHub token
if [[ -n "$GITHUB_TOKEN_BACKUP" ]] && [[ -f "$GITHUB_TOKEN_BACKUP" ]]; then
  mkdir -p "$APP_DATA_DIR"
  cp "$GITHUB_TOKEN_BACKUP" "$APP_DATA_DIR/github-token.json"
  rm "$GITHUB_TOKEN_BACKUP"
  log_success "Restored GitHub token"
fi

# Cleanup
rm -rf "$CLONE_DIR"

# Success
log_section "Update Complete! 🎉"

echo -e "${GREEN}Agentic has been updated successfully!${NC}"
echo ""
echo -e "${BLUE}📍 Installation:${NC} $INSTALL_DIR"
echo ""

# Check configuration status
if [[ -f "$INSTALL_DIR/.env" ]] && grep -q "^ANTHROPIC_API_KEY=sk-ant-" "$INSTALL_DIR/.env" 2>/dev/null; then
  echo -e "${GREEN}✓${NC} API keys configured"
elif [[ -f "$INSTALL_DIR/.tokens" ]]; then
  echo -e "${GREEN}✓${NC} OAuth authentication active"
else
  echo -e "${YELLOW}⚠${NC} No authentication configured"
  echo -e "  Run: ${GREEN}agentic --login${NC} or configure API keys in .env"
fi

echo ""
echo -e "${BLUE}🚀 Start Agentic:${NC}"

# Check if global command exists
if command -v agentic &> /dev/null; then
  echo -e "  → ${GREEN}agentic${NC}"
else
  echo -e "  → ${GREEN}cd $INSTALL_DIR && bun run server/server.ts${NC}"
fi

echo ""
