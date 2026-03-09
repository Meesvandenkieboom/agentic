#!/bin/bash
set -e

# =============================================================================
# Agentic Installer - Production Grade (Source Install)
# =============================================================================
# Clones from source, builds, and installs with full error handling
# =============================================================================

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
REPO="Meesvandenkieboom/agentic"
APP_NAME="agentic"
BRANCH="main"
MIN_DISK_SPACE_MB=200
GITHUB_REPO_URL="https://github.com/${REPO}.git"

# Global state for cleanup
TEMP_DIRS=()
INSTALL_SUCCESS=false

# =============================================================================
# Utility Functions
# =============================================================================

log_info() {
  echo -e "${BLUE}ℹ${NC} $1"
}

log_success() {
  echo -e "${GREEN}✓${NC} $1"
}

log_warning() {
  echo -e "${YELLOW}⚠${NC} $1"
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

# Cleanup function - called on exit or error
cleanup() {
  if [[ "$INSTALL_SUCCESS" != "true" ]]; then
    log_warning "Installation interrupted or failed. Cleaning up..."
    for dir in "${TEMP_DIRS[@]}"; do
      if [[ -e "$dir" ]]; then
        rm -rf "$dir" 2>/dev/null || true
      fi
    done
  fi
}

# Register cleanup trap
trap cleanup EXIT INT TERM

# Fatal error handler
fatal_error() {
  log_error "$1"
  echo ""
  if [[ -n "${2:-}" ]]; then
    echo -e "${YELLOW}Suggestion:${NC} $2"
    echo ""
  fi
  exit 1
}

# =============================================================================
# Dependency Checks
# =============================================================================

check_dependencies() {
  log_section "Checking System Dependencies"

  local missing_deps=()
  local required_commands=("curl" "git")

  for cmd in "${required_commands[@]}"; do
    if ! command -v "$cmd" &> /dev/null; then
      missing_deps+=("$cmd")
    fi
  done

  if [[ ${#missing_deps[@]} -gt 0 ]]; then
    log_error "Missing required dependencies: ${missing_deps[*]}"
    echo ""
    echo "Please install the missing tools:"

    # Platform-specific installation instructions
    case "$(uname -s)" in
      Darwin)
        echo "  brew install ${missing_deps[*]}"
        ;;
      Linux)
        if command -v apt-get &> /dev/null; then
          echo "  sudo apt-get install ${missing_deps[*]}"
        elif command -v yum &> /dev/null; then
          echo "  sudo yum install ${missing_deps[*]}"
        else
          echo "  Use your system's package manager to install: ${missing_deps[*]}"
        fi
        ;;
    esac

    exit 1
  fi

  log_success "All dependencies found"
}

# =============================================================================
# Check Node.js and Bun
# =============================================================================

check_runtime() {
  log_section "Checking Runtime Environment"

  # Check for Node.js v18+ (required for Claude SDK)
  if ! command -v node &> /dev/null; then
    fatal_error "Node.js not found" \
      "Install Node.js v18+: https://nodejs.org"
  fi

  NODE_VERSION=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
  if [[ -z "$NODE_VERSION" ]] || [[ $NODE_VERSION -lt 18 ]]; then
    fatal_error "Node.js v18+ required (found: v${NODE_VERSION:-unknown})" \
      "Please upgrade Node.js: https://nodejs.org"
  fi

  log_success "Node.js v$NODE_VERSION found"

  # Check for Bun (will auto-install if missing)
  if ! command -v bun &> /dev/null; then
    log_warning "Bun not found - will auto-install during setup"
  else
    BUN_VERSION=$(bun --version 2>/dev/null || echo "unknown")
    log_success "Bun v$BUN_VERSION found"
  fi
}

# =============================================================================
# Network Connectivity Check
# =============================================================================

check_network() {
  log_section "Checking Network Connectivity"

  # Test GitHub availability
  if ! curl -s --connect-timeout 5 --max-time 10 https://github.com > /dev/null 2>&1; then
    fatal_error "Cannot reach GitHub" \
      "Check your network connection or GitHub status"
  fi

  log_success "Network connection verified"
}

# =============================================================================
# Platform Detection
# =============================================================================

detect_platform() {
  log_section "Detecting Platform"

  # Detect OS
  OS=$(uname -s)
  case $OS in
    Darwin)
      OS_NAME="macOS"
      OS_PREFIX="macos"
      INSTALL_DIR="$HOME/Applications/agentic-app"
      OLD_INSTALL_DIR="$HOME/Applications/agent-smith-app"
      ;;
    Linux)
      OS_NAME="Linux"
      OS_PREFIX="linux"
      INSTALL_DIR="$HOME/.local/share/agentic-app"
      OLD_INSTALL_DIR="$HOME/.local/share/agent-smith-app"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      OS_NAME="Windows (Git Bash)"
      OS_PREFIX="windows"
      if [[ -n "$LOCALAPPDATA" ]]; then
        INSTALL_DIR="$LOCALAPPDATA/Programs/agentic-app"
        OLD_INSTALL_DIR="$LOCALAPPDATA/Programs/agent-smith-app"
      else
        INSTALL_DIR="$USERPROFILE/AppData/Local/Programs/agentic-app"
        OLD_INSTALL_DIR="$USERPROFILE/AppData/Local/Programs/agent-smith-app"
      fi
      ;;
    *)
      fatal_error "Unsupported OS: $OS" \
        "This installer supports macOS, Linux, and Windows (Git Bash/WSL)"
      ;;
  esac

  log_success "OS: $OS_NAME"
  log_success "Install location: $INSTALL_DIR"
}

# =============================================================================
# Check Disk Space
# =============================================================================

check_disk_space() {
  log_section "Checking Disk Space"

  local available_space

  if [[ "$OS_PREFIX" == "macos" ]]; then
    available_space=$(df -m "$HOME" | tail -1 | awk '{print $4}')
  else
    available_space=$(df -m "$HOME" | tail -1 | awk '{print $4}')
  fi

  if [[ $available_space -lt $MIN_DISK_SPACE_MB ]]; then
    fatal_error "Insufficient disk space (${available_space}MB available, ${MIN_DISK_SPACE_MB}MB required)" \
      "Free up some disk space and try again"
  fi

  log_success "Sufficient disk space (${available_space}MB available)"
}

# =============================================================================
# Check for Existing Installation and Migration
# =============================================================================

check_existing_installation() {
  # Check if old Agent Smith installation exists
  if [[ -d "$OLD_INSTALL_DIR" ]] && [[ ! -d "$INSTALL_DIR" ]]; then
    log_section "Agent Smith Installation Detected"

    log_info "An Agent Smith installation was found"
    log_info "Old location: $OLD_INSTALL_DIR"
    echo ""
    read -p "Migrate data to Agentic? [Y/n]: " migrate_data < /dev/tty

    if [[ ! "$migrate_data" =~ ^[Nn]$ ]]; then
      MIGRATE_FROM_OLD=true
      log_success "Will migrate data during installation"
    else
      log_warning "Old installation will be preserved as backup"
    fi
    echo ""
  fi

  if [[ -d "$INSTALL_DIR" ]]; then
    log_section "Existing Installation Detected"

    # Check if there's a running process
    if [[ "$OS_PREFIX" == "macos" || "$OS_PREFIX" == "linux" ]]; then
      if lsof -ti:3001 > /dev/null 2>&1; then
        log_warning "Agentic appears to be running (port 3001 in use)"
        echo ""
        read -p "Stop the running instance and upgrade? [y/N]: " stop_running < /dev/tty

        if [[ "$stop_running" =~ ^[Yy]$ ]]; then
          lsof -ti:3001 | xargs kill -9 2>/dev/null || true
          sleep 1
          log_success "Stopped running instance"
        else
          fatal_error "Installation cancelled" \
            "Stop Agentic manually and try again"
        fi
      fi
    fi

    log_info "This will upgrade your existing installation"
    log_info "Your .env and data will be preserved automatically"
    echo ""
  else
    log_section "New Installation"
  fi
}

# =============================================================================
# Clone Repository
# =============================================================================

clone_repository() {
  log_section "Cloning Agentic from GitHub"

  CLONE_DIR="/tmp/agentic-clone-$$"
  TEMP_DIRS+=("$CLONE_DIR")

  log_info "Cloning repository..."
  echo -e "   ${BLUE}${GITHUB_REPO_URL}${NC}"
  echo -e "   ${BLUE}Branch: ${BRANCH}${NC}"
  echo ""

  # Clone with full error output for debugging
  if git clone --depth 1 --branch "$BRANCH" "$GITHUB_REPO_URL" "$CLONE_DIR" 2>&1; then
    log_success "Repository cloned successfully"
  else
    echo ""
    fatal_error "Failed to clone repository" \
      "Check your network connection and repository access"
  fi
}

# =============================================================================
# Install Bun (if needed)
# =============================================================================

install_bun() {
  if ! command -v bun &> /dev/null; then
    log_section "Installing Bun"

    log_info "Downloading Bun installer..."

    if curl -fsSL https://bun.sh/install | bash; then
      # Add Bun to PATH for this session
      export BUN_INSTALL="$HOME/.bun"
      export PATH="$BUN_INSTALL/bin:$PATH"

      # Verify Bun is now available
      if command -v bun &> /dev/null; then
        BUN_VERSION=$(bun --version 2>/dev/null || echo "unknown")
        log_success "Bun v$BUN_VERSION installed successfully"
      else
        fatal_error "Bun was installed but is not available in PATH" \
          "Try: export PATH=\"\$HOME/.bun/bin:\$PATH\" then run the installer again"
      fi
    else
      fatal_error "Failed to install Bun" \
        "Install manually: https://bun.sh"
    fi
  fi
}

# =============================================================================
# Build Application
# =============================================================================

build_application() {
  log_section "Building Agentic"

  cd "$CLONE_DIR"

  # Verify Bun is available
  if ! command -v bun &> /dev/null; then
    fatal_error "Bun is not available in PATH" \
      "The installation may have failed. Try: export PATH=\"\$HOME/.bun/bin:\$PATH\""
  fi

  log_info "Using Bun: $(which bun)"

  # Install dependencies
  log_info "Installing dependencies (this may take a minute)..."

  INSTALL_OUTPUT=$(bun install 2>&1)
  INSTALL_EXIT_CODE=$?

  # Show last few lines
  echo "$INSTALL_OUTPUT" | tail -5

  if [ $INSTALL_EXIT_CODE -ne 0 ]; then
    fatal_error "Failed to install dependencies" \
      "Check the error messages above"
  fi

  log_success "Dependencies installed"

  # Build CSS and JS
  log_info "Building application..."
  log_info "Running: bun run build"

  # Run build and capture all output
  if BUILD_OUTPUT=$(bun run build 2>&1); then
    # Build succeeded - show output
    echo "$BUILD_OUTPUT" | grep -E "(✓|✅|built)" || echo "$BUILD_OUTPUT"
    log_success "Build completed successfully"
  else
    # Build failed - show full output for debugging
    echo ""
    log_error "Build command output:"
    echo "$BUILD_OUTPUT"
    echo ""
    fatal_error "Build failed (exit code: $?)" \
      "Check the error messages above. You can try running 'bun run build' manually in $CLONE_DIR"
  fi
}

# =============================================================================
# Install Application
# =============================================================================

install_application() {
  log_section "Installing Agentic"

  # Create install directory
  log_info "Creating installation directory..."
  mkdir -p "$INSTALL_DIR" || fatal_error "Failed to create install directory" \
    "Check that you have write permissions to $(dirname "$INSTALL_DIR")"

  # Backup ALL user settings BEFORE removing anything (extra safety)
  local ENV_FILE="$INSTALL_DIR/.env"
  local SERVER_ENV_FILE="$INSTALL_DIR/server/.env"
  local DATA_DIR="$INSTALL_DIR/data"
  local TOKENS_FILE="$INSTALL_DIR/.tokens"
  local CLAUDE_DIR="$INSTALL_DIR/.claude"
  local ENV_BACKUP=""
  local SERVER_ENV_BACKUP=""
  local DATA_BACKUP=""
  local TOKENS_BACKUP=""
  local CLAUDE_DIR_BACKUP=""
  local GITHUB_TOKEN_BACKUP=""

  # Determine app data directory for GitHub token
  local APP_DATA_DIR=""
  local OLD_APP_DATA_DIR=""
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

  log_info "Backing up user settings..."

  # Migrate from old Agent Smith installation if requested
  if [[ "$MIGRATE_FROM_OLD" == "true" ]] && [[ -d "$OLD_INSTALL_DIR" ]]; then
    log_section "Migrating from Agent Smith"

    # Migrate .env
    if [[ -f "$OLD_INSTALL_DIR/.env" ]]; then
      ENV_BACKUP="/tmp/agentic-env-backup-$$"
      cp "$OLD_INSTALL_DIR/.env" "$ENV_BACKUP"
      log_info "Migrated .env"
    fi

    # Migrate server/.env
    if [[ -f "$OLD_INSTALL_DIR/server/.env" ]]; then
      SERVER_ENV_BACKUP="/tmp/agentic-server-env-backup-$$"
      cp "$OLD_INSTALL_DIR/server/.env" "$SERVER_ENV_BACKUP"
      log_info "Migrated server/.env (GitHub credentials)"
    fi

    # Migrate data directory
    if [[ -d "$OLD_INSTALL_DIR/data" ]]; then
      DATA_BACKUP="/tmp/agentic-data-backup-$$"
      cp -r "$OLD_INSTALL_DIR/data" "$DATA_BACKUP"
      log_info "Migrated data directory (sessions)"
    fi

    # Migrate OAuth tokens
    if [[ -f "$OLD_INSTALL_DIR/.tokens" ]]; then
      TOKENS_BACKUP="/tmp/agentic-tokens-backup-$$"
      cp "$OLD_INSTALL_DIR/.tokens" "$TOKENS_BACKUP"
      log_info "Migrated OAuth tokens"
    fi

    # Migrate .claude directory
    if [[ -d "$OLD_INSTALL_DIR/.claude" ]]; then
      CLAUDE_DIR_BACKUP="/tmp/agentic-claude-backup-$$"
      cp -r "$OLD_INSTALL_DIR/.claude" "$CLAUDE_DIR_BACKUP"
      log_info "Migrated .claude directory (MCP servers, agents)"
    fi

    # Migrate GitHub token from old app data directory
    if [[ -n "$OLD_APP_DATA_DIR" ]] && [[ -f "$OLD_APP_DATA_DIR/github-token.json" ]]; then
      GITHUB_TOKEN_BACKUP="/tmp/agentic-github-token-backup-$$"
      cp "$OLD_APP_DATA_DIR/github-token.json" "$GITHUB_TOKEN_BACKUP"
      log_info "Migrated GitHub token"
    fi

    # Rename old installation as backup
    if [[ -d "$OLD_INSTALL_DIR" ]]; then
      mv "$OLD_INSTALL_DIR" "${OLD_INSTALL_DIR}.backup.$(date +%Y%m%d-%H%M%S)"
      log_success "Old installation preserved as backup"
    fi

    log_success "Migration complete"
  fi

  # Only backup from current installation if not migrating
  if [[ "$MIGRATE_FROM_OLD" != "true" ]]; then
    if [[ -f "$ENV_FILE" ]]; then
      ENV_BACKUP="/tmp/agentic-env-backup-$$"
      cp "$ENV_FILE" "$ENV_BACKUP"
      log_info "Backed up .env"
    fi

    if [[ -f "$SERVER_ENV_FILE" ]]; then
      SERVER_ENV_BACKUP="/tmp/agentic-server-env-backup-$$"
      cp "$SERVER_ENV_FILE" "$SERVER_ENV_BACKUP"
      log_info "Backed up server/.env (GitHub credentials)"
    fi

    if [[ -d "$DATA_DIR" ]]; then
      DATA_BACKUP="/tmp/agentic-data-backup-$$"
      cp -r "$DATA_DIR" "$DATA_BACKUP"
      log_info "Backed up data directory"
    fi

    if [[ -f "$TOKENS_FILE" ]]; then
      TOKENS_BACKUP="/tmp/agentic-tokens-backup-$$"
      cp "$TOKENS_FILE" "$TOKENS_BACKUP"
      log_info "Backed up OAuth tokens"
    fi

    # Backup .claude directory (MCP configs, agents, settings)
    if [[ -d "$CLAUDE_DIR" ]]; then
      CLAUDE_DIR_BACKUP="/tmp/agentic-claude-backup-$$"
      cp -r "$CLAUDE_DIR" "$CLAUDE_DIR_BACKUP"
      log_info "Backed up .claude directory (MCP servers, agents, settings)"
    fi

    # Backup GitHub token from app data directory
    if [[ -n "$APP_DATA_DIR" ]] && [[ -f "$APP_DATA_DIR/github-token.json" ]]; then
      GITHUB_TOKEN_BACKUP="/tmp/agentic-github-token-backup-$$"
      cp "$APP_DATA_DIR/github-token.json" "$GITHUB_TOKEN_BACKUP"
      log_info "Backed up GitHub token"
    fi
  fi

  # Remove old files but preserve critical directories
  if [[ -d "$INSTALL_DIR" ]]; then
    log_info "Removing old files..."
    find "$INSTALL_DIR" -mindepth 1 ! -name '.env' ! -name '.tokens' ! -name '.env.backup' ! -name 'data' ! -name 'data.backup' ! -name '.claude' -delete 2>/dev/null || true
  fi

  # Copy new files
  log_info "Installing files to $INSTALL_DIR..."

  cp -r "$CLONE_DIR"/* "$INSTALL_DIR/" || \
    fatal_error "Failed to install files" \
      "Check disk space and permissions"

  log_info "Restoring user settings..."

  # Restore .env from temporary backup (this overwrites any .env from the clone)
  if [[ -n "$ENV_BACKUP" ]] && [[ -f "$ENV_BACKUP" ]]; then
    cp "$ENV_BACKUP" "$ENV_FILE"
    rm "$ENV_BACKUP"
    log_success "Restored API keys"
  fi

  # Restore server/.env from temporary backup
  if [[ -n "$SERVER_ENV_BACKUP" ]] && [[ -f "$SERVER_ENV_BACKUP" ]]; then
    mkdir -p "$INSTALL_DIR/server"
    cp "$SERVER_ENV_BACKUP" "$SERVER_ENV_FILE"
    rm "$SERVER_ENV_BACKUP"
    log_success "Restored GitHub credentials"
  fi

  # Restore data from temporary backup
  if [[ -n "$DATA_BACKUP" ]] && [[ -d "$DATA_BACKUP" ]]; then
    rm -rf "$DATA_DIR"
    mv "$DATA_BACKUP" "$DATA_DIR"
    log_success "Restored user data"
  fi

  # Restore OAuth tokens from temporary backup
  if [[ -n "$TOKENS_BACKUP" ]] && [[ -f "$TOKENS_BACKUP" ]]; then
    cp "$TOKENS_BACKUP" "$TOKENS_FILE"
    rm "$TOKENS_BACKUP"
    log_success "Restored OAuth tokens"
  fi

  # Restore .claude directory (MCP configs, agents, settings)
  if [[ -n "$CLAUDE_DIR_BACKUP" ]] && [[ -d "$CLAUDE_DIR_BACKUP" ]]; then
    rm -rf "$CLAUDE_DIR"
    mv "$CLAUDE_DIR_BACKUP" "$CLAUDE_DIR"
    log_success "Restored .claude directory (MCP servers, agents, settings)"
  fi

  # Restore GitHub token
  if [[ -n "$GITHUB_TOKEN_BACKUP" ]] && [[ -f "$GITHUB_TOKEN_BACKUP" ]]; then
    mkdir -p "$APP_DATA_DIR"
    cp "$GITHUB_TOKEN_BACKUP" "$APP_DATA_DIR/github-token.json"
    rm "$GITHUB_TOKEN_BACKUP"
    log_success "Restored GitHub token"
  fi

  # Clean up old backup files from previous approach (if they exist)
  rm -f "$INSTALL_DIR/.env.backup" 2>/dev/null || true
  rm -rf "$INSTALL_DIR/data.backup" 2>/dev/null || true

  log_success "Installation complete"
}

# =============================================================================
# API Key Configuration
# =============================================================================

configure_api_keys() {
  # Skip silently if .env already exists with valid keys OR OAuth tokens exist
  if [[ -f "$INSTALL_DIR/.env" ]]; then
    if grep -q "^ANTHROPIC_API_KEY=sk-ant-" "$INSTALL_DIR/.env" 2>/dev/null; then
      return
    fi
  fi

  # Also skip if OAuth tokens exist
  if [[ -f "$INSTALL_DIR/.tokens" ]]; then
    return
  fi

  log_section "Authentication Setup"

  echo "Authentication setup:"
  echo ""
  echo "  1) Anthropic API key (Claude models)"
  echo "  2) Claude OAuth login (subscription-based, recommended)"
  echo "  3) Skip (configure later)"
  echo ""
  read -p "Enter choice [1-3]: " api_choice < /dev/tty
  echo ""

  case $api_choice in
    1)
      # Anthropic API key
      echo -e "${BLUE}Get your API key from:${NC} ${CYAN}https://console.anthropic.com/${NC}"
      echo ""
      read -p "Enter your Anthropic API key: " anthropic_key < /dev/tty

      if [[ -n "$anthropic_key" ]]; then
        cat > "$INSTALL_DIR/.env" << EOF
# Anthropic API Configuration
ANTHROPIC_API_KEY=$anthropic_key

# OpenAI Codex: Uses ChatGPT subscription via CLI auth
# Run: bun run login → select Codex
EOF
        echo ""
        log_success "Anthropic API key configured"
      else
        # Create skeleton .env if no key provided
        cat > "$INSTALL_DIR/.env" << EOF
# Anthropic API Configuration
# ANTHROPIC_API_KEY=your-anthropic-key-here

# OpenAI Codex: Uses ChatGPT subscription via CLI auth
# Run: bun run login → select Codex
EOF
      fi
      ;;

    2)
      # Claude OAuth login
      log_info "Setting up Claude OAuth login..."
      echo ""

      # Create skeleton .env
      cat > "$INSTALL_DIR/.env" << EOF
# Anthropic API Configuration
# ANTHROPIC_API_KEY=your-anthropic-key-here

# OpenAI Codex: Uses ChatGPT subscription via CLI auth
# Run: bun run login → select Codex
EOF

      # Run bun run login
      cd "$INSTALL_DIR"
      if bun run login; then
        echo ""
        log_success "Claude OAuth login configured"
      else
        echo ""
        log_warning "OAuth login failed or was skipped"
        log_info "You can run ${YELLOW}bun run login${NC} later to authenticate"
      fi
      ;;

    3|*)
      # Skip
      log_warning "Skipping authentication setup"
      echo "You can configure authentication later:"
      echo "  - API key: edit ${YELLOW}$INSTALL_DIR/.env${NC}"
      echo "  - OAuth: run ${YELLOW}bun run login${NC}"
      echo "  - Codex: run ${YELLOW}bun run login${NC} → select Codex"

      # Create skeleton .env
      cat > "$INSTALL_DIR/.env" << EOF
# Anthropic API Configuration
# ANTHROPIC_API_KEY=your-anthropic-key-here

# OpenAI Codex: Uses ChatGPT subscription via CLI auth
# Run: bun run login → select Codex
EOF
      ;;
  esac
}

# =============================================================================
# Personalization Setup
# =============================================================================

configure_personalization() {
  # Skip silently if user-config.json already exists
  if [[ -f "$INSTALL_DIR/data/user-config.json" ]]; then
    return
  fi

  log_section "Personalization (Optional)"

  echo "Agentic can personalize your experience with your name."
  echo ""
  read -p "Enter your name (or press Enter to skip): " user_name < /dev/tty

  if [[ -n "$user_name" ]]; then
    # Parse name into firstName and lastName
    local name_parts=($user_name)
    local first_name="${name_parts[0]}"
    local last_name="${name_parts[@]:1}"

    # Create data directory and user-config.json
    mkdir -p "$INSTALL_DIR/data"

    if [[ -n "$last_name" ]]; then
      cat > "$INSTALL_DIR/data/user-config.json" << EOF
{
  "firstName": "$first_name",
  "lastName": "$last_name"
}
EOF
    else
      cat > "$INSTALL_DIR/data/user-config.json" << EOF
{
  "firstName": "$first_name"
}
EOF
    fi

    echo ""
    log_success "Personalization configured"
    log_info "Your name will appear in the interface as: ${YELLOW}$user_name${NC}"
  else
    log_info "Skipped personalization"
  fi
}

# =============================================================================
# Create Global Launcher
# =============================================================================

create_global_launcher() {
  local LAUNCHER_PATH=""
  local NEEDS_SHELL_RESTART=false

  # Check if global launcher already exists
  local GLOBAL_LAUNCHER_EXISTS=false
  if [[ "$OS_PREFIX" == "windows" ]] && [[ -f "$HOME/bin/$APP_NAME" ]]; then
    GLOBAL_LAUNCHER_EXISTS=true
  elif [[ ("$OS_PREFIX" == "macos" || "$OS_PREFIX" == "linux") ]] && [[ -f "/usr/local/bin/$APP_NAME" ]]; then
    GLOBAL_LAUNCHER_EXISTS=true
  fi

  # Remove old Agent Smith launcher if it exists
  if [[ "$OS_PREFIX" == "windows" ]] && [[ -f "$HOME/bin/agent-smith" ]]; then
    rm -f "$HOME/bin/agent-smith"
    log_info "Removed old Agent Smith launcher"
  elif [[ ("$OS_PREFIX" == "macos" || "$OS_PREFIX" == "linux") ]] && [[ -f "/usr/local/bin/agent-smith" ]]; then
    sudo rm -f "/usr/local/bin/agent-smith" 2>/dev/null || rm -f "/usr/local/bin/agent-smith" 2>/dev/null || true
    log_info "Removed old Agent Smith launcher"
  fi

  if [[ "$GLOBAL_LAUNCHER_EXISTS" == "true" ]]; then
    # Silently skip if already exists
    return
  fi

  log_section "Setting Up Global Command"

  # Create launcher script content with explicit bun path
  local BUN_PATH
  if command -v bun &> /dev/null; then
    BUN_PATH=$(command -v bun)
  else
    # Default to common installation location
    BUN_PATH="$HOME/.bun/bin/bun"
  fi

  LAUNCHER_SCRIPT="#!/bin/bash
# Add bun to PATH if not already present
export BUN_INSTALL=\"\$HOME/.bun\"
export PATH=\"\$BUN_INSTALL/bin:\$PATH\"

cd \"$INSTALL_DIR\" && \"$BUN_PATH\" run server/server.ts \"\$@\"
"

  if [[ "$OS_PREFIX" == "windows" ]]; then
    # Windows Git Bash
    local git_bash_bin="$HOME/bin"
    mkdir -p "$git_bash_bin"
    LAUNCHER_PATH="$git_bash_bin/$APP_NAME"

    echo "$LAUNCHER_SCRIPT" > "$LAUNCHER_PATH"
    chmod +x "$LAUNCHER_PATH"

    # Check if ~/bin is in PATH
    if [[ ":$PATH:" != *":$git_bash_bin:"* ]]; then
      local bash_rc="$HOME/.bashrc"
      [[ -f "$HOME/.bash_profile" ]] && bash_rc="$HOME/.bash_profile"

      if ! grep -q "export PATH=\"\$HOME/bin:\$PATH\"" "$bash_rc" 2>/dev/null; then
        echo 'export PATH="$HOME/bin:$PATH"' >> "$bash_rc"
        log_success "Added ~/bin to PATH in $bash_rc"
        NEEDS_SHELL_RESTART=true
      fi
    fi

    log_success "Launcher created at $LAUNCHER_PATH"

  elif [[ "$OS_PREFIX" == "macos" || "$OS_PREFIX" == "linux" ]]; then
    LAUNCHER_PATH="/usr/local/bin/$APP_NAME"

    # Try to create without sudo
    if echo "$LAUNCHER_SCRIPT" > "$LAUNCHER_PATH" 2>/dev/null && chmod +x "$LAUNCHER_PATH" 2>/dev/null; then
      log_success "Global launcher created"
    else
      # Needs sudo
      log_warning "Creating global command requires admin permissions"
      echo ""
      read -p "Create global launcher with sudo? [y/N]: " use_sudo < /dev/tty

      if [[ "$use_sudo" =~ ^[Yy]$ ]]; then
        echo "$LAUNCHER_SCRIPT" | sudo tee "$LAUNCHER_PATH" > /dev/null
        sudo chmod +x "$LAUNCHER_PATH"
        log_success "Global launcher created"
      else
        log_warning "Skipped global launcher"
        log_info "You can run: ${YELLOW}cd $INSTALL_DIR && bun run server/server.ts${NC}"
        LAUNCHER_PATH=""
      fi
    fi
  fi

  # Store for success message
  export LAUNCHER_PATH
  export NEEDS_SHELL_RESTART
}

# =============================================================================
# Success Message
# =============================================================================

show_success_message() {
  log_section "Installation Successful! 🎉"

  echo -e "${GREEN}Agentic has been installed successfully!${NC}"
  echo ""
  echo -e "${BLUE}📍 Installation Location:${NC}"
  echo -e "   $INSTALL_DIR"
  echo ""

  # Platform-specific launch instructions
  echo -e "${BLUE}🚀 How to Start Agentic:${NC}"
  echo ""

  if [[ "$OS_PREFIX" == "windows" ]]; then
    if [[ -n "$LAUNCHER_PATH" ]]; then
      if [[ "$NEEDS_SHELL_RESTART" == "true" ]]; then
        echo -e "  ${YELLOW}1. Restart your terminal (or run:${NC} exec bash${YELLOW})${NC}"
        echo -e "  ${YELLOW}2. Type:${NC} ${GREEN}$APP_NAME${NC}"
      else
        echo -e "  ${YELLOW}→ Type:${NC} ${GREEN}$APP_NAME${NC}"
      fi
    else
      echo -e "  ${YELLOW}→ Run:${NC} ${GREEN}cd $INSTALL_DIR && bun run server/server.ts${NC}"
    fi

  elif [[ -n "$LAUNCHER_PATH" ]]; then
    if [[ "$NEEDS_SHELL_RESTART" == "true" ]]; then
      echo -e "  ${YELLOW}→ Restart your terminal (or run:${NC} exec \$SHELL${YELLOW})${NC}"
      echo -e "  ${YELLOW}→ Then type:${NC} ${GREEN}$APP_NAME${NC}"
      echo ""
      echo -e "  ${BLUE}ℹ${NC}  Or start immediately: ${GREEN}cd $INSTALL_DIR && bun run server/server.ts${NC}"
    else
      echo -e "  ${YELLOW}→ Just type:${NC} ${GREEN}$APP_NAME${NC}"
    fi
  else
    echo -e "  ${YELLOW}→ Run:${NC} ${GREEN}cd $INSTALL_DIR && bun run server/server.ts${NC}"
  fi

  echo ""
  echo -e "${BLUE}🌐 The app will start at:${NC} ${CYAN}http://localhost:3001${NC}"
  echo ""

  # Additional commands
  echo -e "${BLUE}📚 Other Commands:${NC}"
  echo -e "  ${GREEN}$APP_NAME --setup${NC}   Setup wizard"
  echo -e "  ${GREEN}$APP_NAME --login${NC}   OAuth login"
  echo -e "  ${GREEN}$APP_NAME --status${NC}  Check auth status"
  echo ""

  # License info
  echo -e "${BLUE}📄 License:${NC} GNU AGPL-3.0 (Free & Open Source)"
  echo ""

  # Mark installation as successful (prevents cleanup)
  INSTALL_SUCCESS=true
}

# =============================================================================
# Main Installation Flow
# =============================================================================

main() {
  # Print banner
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${CYAN}   Agentic Installer${NC}"
  echo -e "${CYAN}   Production-Grade Installation from Source${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  # Initialize migration flag
  MIGRATE_FROM_OLD=false

  # Run all checks and installation steps
  check_dependencies
  check_runtime
  check_network
  detect_platform
  check_disk_space
  check_existing_installation
  clone_repository
  install_bun
  build_application
  install_application
  configure_api_keys
  configure_personalization
  create_global_launcher
  show_success_message
}

# Run main installation
main
