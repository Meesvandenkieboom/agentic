#!/bin/bash
set -e

# =============================================================================
# Agent Mees Installer - Production Grade (Source Install)
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
REPO="Meesvandenkieboom/agent-mees"
APP_NAME="agent-mees"
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
      INSTALL_DIR="$HOME/Applications/agent-mees-app"
      ;;
    Linux)
      OS_NAME="Linux"
      OS_PREFIX="linux"
      INSTALL_DIR="$HOME/.local/share/agent-mees-app"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      OS_NAME="Windows (Git Bash)"
      OS_PREFIX="windows"
      if [[ -n "$LOCALAPPDATA" ]]; then
        INSTALL_DIR="$LOCALAPPDATA/Programs/agent-mees-app"
      else
        INSTALL_DIR="$USERPROFILE/AppData/Local/Programs/agent-mees-app"
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
# Check for Existing Installation
# =============================================================================

check_existing_installation() {
  if [[ -d "$INSTALL_DIR" ]]; then
    log_section "Existing Installation Detected"

    # Check if there's a running process
    if [[ "$OS_PREFIX" == "macos" || "$OS_PREFIX" == "linux" ]]; then
      if lsof -ti:3001 > /dev/null 2>&1; then
        log_warning "Agent Mees appears to be running (port 3001 in use)"
        echo ""
        read -p "Stop the running instance and upgrade? [y/N]: " stop_running < /dev/tty

        if [[ "$stop_running" =~ ^[Yy]$ ]]; then
          lsof -ti:3001 | xargs kill -9 2>/dev/null || true
          sleep 1
          log_success "Stopped running instance"
        else
          fatal_error "Installation cancelled" \
            "Stop Agent Mees manually and try again"
        fi
      fi
    fi

    # Backup existing .env if present
    if [[ -f "$INSTALL_DIR/.env" ]]; then
      log_info "Backing up existing .env configuration..."
      cp "$INSTALL_DIR/.env" "$INSTALL_DIR/.env.backup"
      ENV_BACKUP_CREATED=true
    fi

    # Backup existing data directory
    if [[ -d "$INSTALL_DIR/data" ]]; then
      log_info "Backing up user data..."
      cp -r "$INSTALL_DIR/data" "$INSTALL_DIR/data.backup"
      DATA_BACKUP_CREATED=true
    fi

    log_info "This will upgrade your existing installation"
    echo ""
  else
    log_section "New Installation"
  fi
}

# =============================================================================
# Clone Repository
# =============================================================================

clone_repository() {
  log_section "Cloning Agent Mees from GitHub"

  CLONE_DIR="/tmp/agent-mees-clone-$$"
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
  log_section "Building Agent Mees"

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
  log_section "Installing Agent Mees"

  # Create install directory
  log_info "Creating installation directory..."
  mkdir -p "$INSTALL_DIR" || fatal_error "Failed to create install directory" \
    "Check that you have write permissions to $(dirname "$INSTALL_DIR")"

  # Remove old files but preserve .env and data
  if [[ -d "$INSTALL_DIR" ]]; then
    log_info "Removing old files..."
    find "$INSTALL_DIR" -mindepth 1 ! -name '.env' ! -name '.env.backup' ! -name 'data' ! -name 'data.backup' -delete 2>/dev/null || true
  fi

  # Copy new files
  log_info "Installing files to $INSTALL_DIR..."

  cp -r "$CLONE_DIR"/* "$INSTALL_DIR/" || \
    fatal_error "Failed to install files" \
      "Check disk space and permissions"

  # Restore .env if we backed it up
  if [[ "${ENV_BACKUP_CREATED:-false}" == "true" ]] && [[ -f "$INSTALL_DIR/.env.backup" ]]; then
    log_info "Restoring your API key configuration..."
    mv "$INSTALL_DIR/.env.backup" "$INSTALL_DIR/.env"
  fi

  # Restore data if we backed it up
  if [[ "${DATA_BACKUP_CREATED:-false}" == "true" ]] && [[ -d "$INSTALL_DIR/data.backup" ]]; then
    log_info "Restoring your user data..."
    rm -rf "$INSTALL_DIR/data"
    mv "$INSTALL_DIR/data.backup" "$INSTALL_DIR/data"
  fi

  log_success "Installation complete"
}

# =============================================================================
# API Key Configuration
# =============================================================================

configure_api_keys() {
  log_section "API Key Setup"

  # Skip if .env already exists with valid keys
  if [[ -f "$INSTALL_DIR/.env" ]]; then
    if grep -q "^ANTHROPIC_API_KEY=sk-ant-\|^ZAI_API_KEY=\|^MOONSHOT_API_KEY=" "$INSTALL_DIR/.env" 2>/dev/null; then
      log_success "API key already configured"
      return
    fi
  fi

  echo "Which API provider(s) do you want to use?"
  echo ""
  echo "  1) Anthropic API only (Claude models)"
  echo "  2) Z.AI API only (GLM models)"
  echo "  3) Moonshot AI only (Kimi models)"
  echo "  4) All APIs (full model access)"
  echo "  5) Skip (configure later)"
  echo ""
  read -p "Enter choice [1-5]: " api_choice < /dev/tty
  echo ""

  case $api_choice in
    1)
      # Anthropic only
      echo -e "${BLUE}Get your API key from:${NC} ${CYAN}https://console.anthropic.com/${NC}"
      echo ""
      read -p "Enter your Anthropic API key: " anthropic_key < /dev/tty

      if [[ -n "$anthropic_key" ]]; then
        cat > "$INSTALL_DIR/.env" << EOF
# Anthropic API Configuration
ANTHROPIC_API_KEY=$anthropic_key

# Optional: Z.AI API (GLM Models)
# Get from: https://z.ai
# ZAI_API_KEY=your-zai-key-here

# Optional: Moonshot AI (Kimi Models)
# Get from: https://platform.moonshot.ai/
# MOONSHOT_API_KEY=your-moonshot-key-here
EOF
        echo ""
        log_success "Anthropic API key configured"
      fi
      ;;

    2)
      # Z.AI only
      echo -e "${BLUE}Get your API key from:${NC} ${CYAN}https://z.ai${NC}"
      echo ""
      read -p "Enter your Z.AI API key: " zai_key < /dev/tty

      if [[ -n "$zai_key" ]]; then
        cat > "$INSTALL_DIR/.env" << EOF
# Z.AI API Configuration
ZAI_API_KEY=$zai_key

# Optional: Anthropic API (Claude Models)
# Get from: https://console.anthropic.com/
# ANTHROPIC_API_KEY=your-anthropic-key-here

# Optional: Moonshot AI (Kimi Models)
# Get from: https://platform.moonshot.ai/
# MOONSHOT_API_KEY=your-moonshot-key-here
EOF
        echo ""
        log_success "Z.AI API key configured"
      fi
      ;;

    3)
      # Moonshot only
      echo -e "${BLUE}Get your API key from:${NC} ${CYAN}https://platform.moonshot.ai/${NC}"
      echo ""
      read -p "Enter your Moonshot API key: " moonshot_key < /dev/tty

      if [[ -n "$moonshot_key" ]]; then
        cat > "$INSTALL_DIR/.env" << EOF
# Moonshot AI Configuration
MOONSHOT_API_KEY=$moonshot_key

# Optional: Anthropic API (Claude Models)
# Get from: https://console.anthropic.com/
# ANTHROPIC_API_KEY=your-anthropic-key-here

# Optional: Z.AI API (GLM Models)
# Get from: https://z.ai
# ZAI_API_KEY=your-zai-key-here
EOF
        echo ""
        log_success "Moonshot API key configured"
      fi
      ;;

    4)
      # All APIs
      echo -e "${BLUE}Anthropic API:${NC} ${CYAN}https://console.anthropic.com/${NC}"
      read -p "Enter your Anthropic API key (or press Enter to skip): " anthropic_key < /dev/tty
      echo ""

      echo -e "${BLUE}Z.AI API:${NC} ${CYAN}https://z.ai${NC}"
      read -p "Enter your Z.AI API key (or press Enter to skip): " zai_key < /dev/tty
      echo ""

      echo -e "${BLUE}Moonshot AI:${NC} ${CYAN}https://platform.moonshot.ai/${NC}"
      read -p "Enter your Moonshot API key (or press Enter to skip): " moonshot_key < /dev/tty

      cat > "$INSTALL_DIR/.env" << EOF
# Multi-Provider API Configuration

# Anthropic API (Claude Models)
${anthropic_key:+ANTHROPIC_API_KEY=$anthropic_key}
${anthropic_key:-# ANTHROPIC_API_KEY=your-anthropic-key-here}

# Z.AI API (GLM Models)
${zai_key:+ZAI_API_KEY=$zai_key}
${zai_key:-# ZAI_API_KEY=your-zai-key-here}

# Moonshot AI (Kimi Models)
${moonshot_key:+MOONSHOT_API_KEY=$moonshot_key}
${moonshot_key:-# MOONSHOT_API_KEY=your-moonshot-key-here}
EOF
      echo ""
      log_success "Multi-provider API keys configured"
      ;;

    5|*)
      # Skip
      log_warning "Skipping API configuration"
      echo "You'll need to edit ${YELLOW}$INSTALL_DIR/.env${NC} before running Agent Mees"

      # Create template .env
      cat > "$INSTALL_DIR/.env" << EOF
# API Configuration - Add your keys below

# Anthropic API (Claude Models)
# Get from: https://console.anthropic.com/
# ANTHROPIC_API_KEY=your-anthropic-key-here

# Z.AI API (GLM Models)
# Get from: https://z.ai
# ZAI_API_KEY=your-zai-key-here

# Moonshot AI (Kimi Models)
# Get from: https://platform.moonshot.ai/
# MOONSHOT_API_KEY=your-moonshot-key-here
EOF
      ;;
  esac
}

# =============================================================================
# Personalization Setup
# =============================================================================

configure_personalization() {
  # Skip if user-config.json already exists
  if [[ -f "$INSTALL_DIR/data/user-config.json" ]]; then
    log_section "Personalization"
    log_success "Existing personalization preserved"
    return
  fi

  log_section "Personalization (Optional)"

  echo "Agent Mees can personalize your experience with your name."
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
  log_section "Setting Up Global Command"

  local LAUNCHER_PATH=""
  local NEEDS_SHELL_RESTART=false

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

  echo -e "${GREEN}Agent Mees has been installed successfully!${NC}"
  echo ""
  echo -e "${BLUE}📍 Installation Location:${NC}"
  echo -e "   $INSTALL_DIR"
  echo ""

  # Platform-specific launch instructions
  echo -e "${BLUE}🚀 How to Start Agent Mees:${NC}"
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
  echo -e "${CYAN}   Agent Mees Installer${NC}"
  echo -e "${CYAN}   Production-Grade Installation from Source${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

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
