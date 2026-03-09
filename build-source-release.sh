#!/bin/bash
set -e

echo "🔨 Building Agentic (Source Distribution)"
echo

# Detect platform
ARCH=$(uname -m)
case $ARCH in
  x86_64)
    PLATFORM="macos-intel"
    ;;
  arm64)
    PLATFORM="macos-arm64"
    ;;
  *)
    echo "❌ Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

echo "📦 Platform: $PLATFORM"

# Clean and create release directory
rm -rf release
mkdir -p release/agentic-$PLATFORM

# Build client bundle
echo "🏗️  Building client..."
bun run build

# Copy source files
echo "📂 Copying source files..."
cp -r server release/agentic-$PLATFORM/
cp -r client release/agentic-$PLATFORM/
cp -r dist release/agentic-$PLATFORM/
cp cli.ts release/agentic-$PLATFORM/
cp package.json release/agentic-$PLATFORM/
cp bun.lockb release/agentic-$PLATFORM/ 2>/dev/null || true
cp LICENSE release/agentic-$PLATFORM/
cp credits.mp3 release/agentic-$PLATFORM/ 2>/dev/null || true
cp tailwind.config.js release/agentic-$PLATFORM/ 2>/dev/null || true
cp postcss.config.mjs release/agentic-$PLATFORM/ 2>/dev/null || true
cp tsconfig.json release/agentic-$PLATFORM/ 2>/dev/null || true

# Install dependencies
echo "📦 Installing dependencies..."
cd release/agentic-$PLATFORM
bun install --production
cd ../..

# Create .env template
cat > release/agentic-$PLATFORM/.env << 'EOF'
# Anthropic Configuration (Claude Models)
ANTHROPIC_API_KEY=sk-ant-your-key-here

# OpenAI Codex: Uses ChatGPT subscription via CLI auth
# Run: bun run login → select Codex
EOF

# Create launcher script
cat > release/agentic-$PLATFORM/agentic << 'EOF'
#!/bin/bash
set -e

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# =============================================================================
# Runtime Validation (runs every time to catch environment changes)
# =============================================================================

# 1. Check Node.js availability and version
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found!"
    echo ""
    echo "Agentic requires Node.js v18+ for the Claude SDK."
    echo "Install from: https://nodejs.org"
    echo ""
    exit 1
fi

NODE_VERSION=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [[ -z "$NODE_VERSION" ]] || [[ $NODE_VERSION -lt 18 ]]; then
    echo "❌ Node.js v18+ required (found: v${NODE_VERSION:-unknown})"
    echo "Please upgrade: https://nodejs.org"
    exit 1
fi

# 2. Detect WSL environment and check for Windows Node.js
NODE_PATH=$(which node)
if grep -qi microsoft /proc/version 2>/dev/null; then
    # We're in WSL
    if [[ "$NODE_PATH" == *"/mnt/c/"* ]] || [[ "$NODE_PATH" == *.exe ]]; then
        echo "❌ Windows Node.js detected in WSL!"
        echo ""
        echo "You have Windows Node in your PATH, but Agentic needs native WSL Node."
        echo "Please install Node.js for WSL:"
        echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
        echo "  sudo apt-get install -y nodejs"
        echo ""
        echo "Then prepend /usr/bin to your PATH in ~/.bashrc:"
        echo "  export PATH=\"/usr/bin:\$PATH\""
        exit 1
    fi
fi

# 3. Check Bun availability (with WSL detection)
BUN_PATH=$(command -v bun 2>/dev/null || echo "")
NEED_INSTALL=false

if [ -z "$BUN_PATH" ]; then
    NEED_INSTALL=true
elif [[ "$BUN_PATH" == *.exe ]] || [[ "$BUN_PATH" == *"/mnt/c/"* ]] || [[ "$BUN_PATH" == *"\\wsl"* ]]; then
    echo "⚠️  Windows Bun detected in WSL - installing native version..."
    NEED_INSTALL=true
fi

if [ "$NEED_INSTALL" = true ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  🔧 Installing Bun..."
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
    echo "✅ Bun installed!"
    echo
fi

# 4. Verify dependencies are installed and correct for this platform
if [ ! -d "node_modules" ]; then
    echo "📦 First run - installing dependencies..."
    bun install --production
    echo "✅ Dependencies installed!"
fi

# 5. Quick sanity check - verify SDK exists
if [ ! -f "node_modules/@anthropic-ai/claude-agent-sdk/cli.js" ]; then
    echo "⚠️  Claude SDK missing - reinstalling dependencies..."
    rm -rf node_modules
    bun install --production
fi

# Start the server
echo "🚀 Starting Agentic..."
echo
exec bun run server/server.ts "$@"
EOF

chmod +x release/agentic-$PLATFORM/agentic

# Create README
cat > release/agentic-$PLATFORM/README.txt << 'EOF'
Agentic Application - macOS
==============================

Authentication Setup (Choose ONE):

OPTION 1: Claude Pro/Max Subscription (Recommended - $0 API costs)
1. Run: agentic --login
2. Your browser will open for authentication
3. Copy the authorization code and paste it in terminal
4. Done! Your subscription will be used instead of API credits

OPTION 2: API Key
1. Open the .env file in a text editor
2. Add your Anthropic API key (get from https://console.anthropic.com/)
   Replace: ANTHROPIC_API_KEY=sk-ant-your-key-here
   With: ANTHROPIC_API_KEY=sk-ant-your-actual-key

To Run:
- Run from terminal: agentic
- Or double-click the 'agentic' file
- The app will start at http://localhost:3001
- Your browser should open automatically

OAuth Commands:
- agentic --login      # Login with Claude Pro/Max
- agentic --logout     # Logout from OAuth
- agentic --status     # Check authentication status

First Run:
- On first launch, Bun runtime will be auto-installed (takes ~5 seconds)
- Subsequent launches are instant

Data Storage:
- Sessions stored in ~/Documents/agentic-app/
- OAuth tokens stored in ~/.agentic/ (secure)
- All your conversations are saved locally

Requirements:
- macOS 11+ (Big Sur or later)
- Claude Pro/Max subscription OR Anthropic API key
- Internet connection (for first-time Bun install)

Troubleshooting:
- If port 3001 is busy, kill the process: lsof -ti:3001 | xargs kill -9
- If OAuth login fails, use API key method instead
- Check auth status: agentic --status

Enjoy!
EOF

# Create zip
cd release
zip -r agentic-$PLATFORM.zip agentic-$PLATFORM/
cd ..

echo
echo "✅ Build complete!"
echo "📦 Package: release/agentic-$PLATFORM.zip"
echo "📁 Size: $(du -sh release/agentic-$PLATFORM.zip | cut -f1)"
