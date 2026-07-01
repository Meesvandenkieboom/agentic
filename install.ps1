# =============================================================================
# Agentic Windows Installer - Production Grade
# =============================================================================
# Run with: iwr -useb https://raw.githubusercontent.com/Meesvandenkieboom/agentic/main/install.ps1 | iex
#
# Handles all edge cases, validates dependencies, verifies downloads,
# and provides comprehensive error handling with rollback support.
# =============================================================================

$ErrorActionPreference = "Stop"

# Configuration
$REPO = "Meesvandenkieboom/agentic"
$APP_NAME = "agentic"
$MIN_DISK_SPACE_GB = 0.1
$INSTALL_DIR = "$env:LOCALAPPDATA\Programs\agentic-app"

# Legacy directories (for migration)
$OLD_INSTALL_DIR = "$env:LOCALAPPDATA\Programs\agent-smith-app"
$OLD_APP_NAME = "agent-smith"

# Global state for cleanup
$script:TempFiles = @()
$script:InstallSuccess = $false

# =============================================================================
# Utility Functions
# =============================================================================

function Write-ColorMessage {
    param(
        [string]$Message,
        [string]$Color = "White",
        [switch]$NoNewline
    )
    if ($NoNewline) {
        Write-Host $Message -ForegroundColor $Color -NoNewline
    } else {
        Write-Host $Message -ForegroundColor $Color
    }
}

function Write-Info { Write-ColorMessage "ℹ $args" "Cyan" }
function Write-Success { Write-ColorMessage "✓ $args" "Green" }
function Write-Warning { Write-ColorMessage "⚠ $args" "Yellow" }
function Write-Error { Write-ColorMessage "❌ $args" "Red" }

function Write-Section {
    param([string]$Title)
    Write-Host ""
    Write-ColorMessage "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" "Cyan"
    Write-ColorMessage "   $Title" "Cyan"
    Write-ColorMessage "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" "Cyan"
    Write-Host ""
}

function Invoke-Cleanup {
    if (-not $script:InstallSuccess) {
        Write-Warning "Installation interrupted or failed. Cleaning up..."
        foreach ($file in $script:TempFiles) {
            if (Test-Path $file) {
                Remove-Item $file -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

function Invoke-FatalError {
    param(
        [string]$Message,
        [string]$Suggestion = ""
    )
    Write-Error $Message
    Write-Host ""
    if ($Suggestion) {
        Write-ColorMessage "Suggestion: " "Yellow" -NoNewline
        Write-Host $Suggestion
        Write-Host ""
    }
    Invoke-Cleanup
    exit 1
}

# Register cleanup on exit
$null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action { Invoke-Cleanup }

# =============================================================================
# Dependency Checks
# =============================================================================

function Test-Dependencies {
    Write-Section "Checking System Dependencies"

    # Check PowerShell version
    $psVersion = $PSVersionTable.PSVersion
    if ($psVersion.Major -lt 5) {
        Invoke-FatalError "PowerShell 5.0 or later is required (found $psVersion)" `
            "Upgrade PowerShell: https://docs.microsoft.com/powershell/"
    }
    Write-Success "PowerShell $psVersion"

    # Check .NET for Invoke-WebRequest
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Write-Success ".NET framework compatible"
    } catch {
        Invoke-FatalError "Failed to enable TLS 1.2" `
            "Your .NET framework may be outdated"
    }

    # Check Expand-Archive cmdlet
    if (-not (Get-Command Expand-Archive -ErrorAction SilentlyContinue)) {
        Invoke-FatalError "Expand-Archive cmdlet not available" `
            "Upgrade PowerShell to version 5.0 or later"
    }
    Write-Success "Archive extraction available"
}

# =============================================================================
# Network Connectivity Check
# =============================================================================

function Test-NetworkConnectivity {
    Write-Section "Checking Network Connectivity"

    # Test basic internet connectivity
    try {
        $null = Invoke-WebRequest -Uri "https://www.google.com" -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
        Write-Success "Internet connection verified"
    } catch {
        Invoke-FatalError "No internet connection detected" `
            "Please check your network connection and try again"
    }

    # Test GitHub API availability
    try {
        $null = Invoke-WebRequest -Uri "https://api.github.com" -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
        Write-Success "GitHub API accessible"
    } catch {
        Invoke-FatalError "Cannot reach GitHub API" `
            "GitHub may be down. Check https://www.githubstatus.com/"
    }
}

# =============================================================================
# Platform Detection
# =============================================================================

function Get-PlatformInfo {
    Write-Section "Detecting Platform"

    # Detect architecture
    $arch = $env:PROCESSOR_ARCHITECTURE
    switch ($arch) {
        "AMD64" {
            $script:Platform = "windows-x64"
            $script:ArchName = "x64"
        }
        "ARM64" {
            $script:Platform = "windows-arm64"
            $script:ArchName = "ARM64"
        }
        default {
            Invoke-FatalError "Unsupported architecture: $arch" `
                "This installer supports x64 and ARM64 Windows only"
        }
    }

    # Check Windows version
    $osInfo = Get-CimInstance Win32_OperatingSystem
    $osVersion = $osInfo.Version
    Write-Success "Windows $osVersion ($script:ArchName)"
    Write-Success "Install location: $INSTALL_DIR"
}

# =============================================================================
# Check Disk Space
# =============================================================================

function Test-DiskSpace {
    Write-Section "Checking Disk Space"

    try {
        $drive = (Get-Item $env:LOCALAPPDATA).PSDrive.Name + ":"
        $disk = Get-PSDrive -Name $drive.TrimEnd(':')
        $availableGB = [math]::Round($disk.Free / 1GB, 2)

        if ($availableGB -lt $MIN_DISK_SPACE_GB) {
            Invoke-FatalError "Insufficient disk space (${availableGB}GB available, ${MIN_DISK_SPACE_GB}GB required)" `
                "Free up some disk space and try again"
        }

        Write-Success "Sufficient disk space (${availableGB}GB available)"
    } catch {
        Write-Warning "Could not check disk space, proceeding anyway..."
    }
}

# =============================================================================
# Check for Existing Installation and Migration
# =============================================================================

function Test-ExistingInstallation {
    # Check for legacy installation first
    $script:MigrationNeeded = $false
    if ((Test-Path $OLD_INSTALL_DIR) -and -not (Test-Path $INSTALL_DIR)) {
        Write-Section "Legacy Installation Detected"
        Write-Info "Found existing Agent Smith installation at:"
        Write-Host "   $OLD_INSTALL_DIR"
        Write-Host ""
        Write-ColorMessage "This will be migrated to the new Agentic installation." "Cyan"
        Write-Host ""
        $script:MigrationNeeded = $true
    }

    if (Test-Path $INSTALL_DIR) {
        Write-Section "Existing Installation Detected"

        # Check if application is running on port 3001
        try {
            $connection = Test-NetConnection -ComputerName localhost -Port 3001 -InformationLevel Quiet -WarningAction SilentlyContinue
            if ($connection) {
                Write-Warning "Agentic appears to be running (port 3001 in use)"
                Write-Host ""
                $stopRunning = Read-Host "Stop the running instance and upgrade? [y/N]"

                if ($stopRunning -match '^[Yy]$') {
                    # Try to kill processes on port 3001
                    try {
                        $processes = Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue |
                            Select-Object -ExpandProperty OwningProcess -Unique |
                            ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }

                        foreach ($proc in $processes) {
                            Stop-Process -Id $proc.Id -Force
                        }

                        Start-Sleep -Seconds 1
                        Write-Success "Stopped running instance"
                    } catch {
                        Write-Warning "Could not automatically stop the process. Please close Agentic manually."
                    }
                } else {
                    Invoke-FatalError "Installation cancelled" `
                        "Stop Agentic manually and try again"
                }
            }
        } catch {
            # Port check failed, continue anyway
        }

        # Backup existing .env if present
        if (Test-Path "$INSTALL_DIR\.env") {
            Write-Info "Backing up existing .env configuration..."
            Copy-Item "$INSTALL_DIR\.env" "$INSTALL_DIR\.env.backup" -Force
            $script:EnvBackupCreated = $true
        }

        Write-Info "This will upgrade your existing installation"
        Write-Host ""
    } elseif ($script:MigrationNeeded) {
        # Migration scenario
        Write-Info "Preparing to migrate data..."
        Write-Host ""
    } else {
        Write-Section "New Installation"
    }
}

# =============================================================================
# Fetch Latest Release
# =============================================================================

function Get-LatestRelease {
    Write-Section "Fetching Latest Release"

    Write-Info "Querying GitHub API..."

    # Fetch with retry logic
    $maxRetries = 3
    $retryCount = 0
    $release = $null

    while ($retryCount -lt $maxRetries) {
        try {
            $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$REPO/releases/latest" `
                -TimeoutSec 30 -ErrorAction Stop
            break
        } catch {
            $retryCount++
            if ($retryCount -lt $maxRetries) {
                Write-Warning "Failed to fetch release info. Retrying ($retryCount/$maxRetries)..."
                Start-Sleep -Seconds 2
            }
        }
    }

    if (-not $release) {
        Invoke-FatalError "Failed to fetch release information after $maxRetries attempts" `
            "Check your internet connection or try again later"
    }

    # Extract version and download URL
    $script:Version = $release.tag_name
    $asset = $release.assets | Where-Object { $_.name -like "*$script:Platform.zip" }
    $script:DownloadUrl = $asset.browser_download_url

    # Get checksum file if available
    $checksumAsset = $release.assets | Where-Object { $_.name -like "*checksums.txt" }
    $script:ChecksumUrl = $checksumAsset.browser_download_url

    if (-not $script:DownloadUrl) {
        Invoke-FatalError "No release found for platform: $script:Platform" `
            "This platform may not be supported yet. Check https://github.com/$REPO/releases"
    }

    Write-Success "Latest version: $script:Version"
    Write-Success "Release found for $script:Platform"
}

# =============================================================================
# Download Release
# =============================================================================

function Get-ReleasePackage {
    Write-Section "Downloading Agentic $script:Version"

    $script:DownloadPath = "$env:TEMP\$APP_NAME-$script:Platform-$PID.zip"
    $script:TempFiles += $script:DownloadPath

    Write-Info "Downloading from GitHub..."
    Write-ColorMessage "   $script:DownloadUrl" "Blue"
    Write-Host ""

    try {
        # Download with progress
        $ProgressPreference = 'SilentlyContinue'  # Faster download
        Invoke-WebRequest -Uri $script:DownloadUrl -OutFile $script:DownloadPath -TimeoutSec 300 -ErrorAction Stop
        $ProgressPreference = 'Continue'

        # Verify download size
        $fileInfo = Get-Item $script:DownloadPath
        if ($fileInfo.Length -lt 1000000) {  # Less than 1MB is suspicious
            Invoke-FatalError "Downloaded file is suspiciously small ($($fileInfo.Length) bytes)" `
                "The download may be corrupted. Try again"
        }

        $sizeText = "{0:N2} MB" -f ($fileInfo.Length / 1MB)
        Write-Host ""
        Write-Success "Download complete ($sizeText)"

        # Download and verify checksum if available
        if ($script:ChecksumUrl) {
            Write-Info "Verifying download integrity..."

            $checksumPath = "$env:TEMP\$APP_NAME-checksums-$PID.txt"
            $script:TempFiles += $checksumPath

            try {
                Invoke-WebRequest -Uri $script:ChecksumUrl -OutFile $checksumPath -TimeoutSec 30 -ErrorAction Stop

                # Extract expected checksum for our platform
                $checksumContent = Get-Content $checksumPath
                $expectedChecksum = ($checksumContent | Select-String "$APP_NAME-$script:Platform.zip").Line.Split(' ')[0]

                if ($expectedChecksum) {
                    # Calculate actual checksum
                    $actualChecksum = (Get-FileHash -Path $script:DownloadPath -Algorithm SHA256).Hash.ToLower()

                    if ($actualChecksum -eq $expectedChecksum.ToLower()) {
                        Write-Success "Checksum verified"
                    } else {
                        Invoke-FatalError "Checksum mismatch! Downloaded file may be corrupted or tampered with" `
                            "Try downloading again or report this issue"
                    }
                } else {
                    Write-Warning "Checksum not found for $script:Platform, skipping verification"
                }
            } catch {
                Write-Warning "Could not download checksums, skipping verification"
            }
        }
    } catch {
        Invoke-FatalError "Download failed: $($_.Exception.Message)" `
            "Check your internet connection and try again"
    }
}

# =============================================================================
# Migrate Legacy Data
# =============================================================================

function Invoke-DataMigration {
    if (-not $script:MigrationNeeded) {
        return
    }

    Write-Section "Migrating Data from Agent Smith"

    try {
        # Stop any old instances
        Write-Info "Checking for running Agent Smith instances..."
        try {
            $processes = Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty OwningProcess -Unique |
                ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }

            foreach ($proc in $processes) {
                Stop-Process -Id $proc.Id -Force
            }

            if ($processes) {
                Start-Sleep -Seconds 2
                Write-Success "Stopped legacy instances"
            }
        } catch {
            # No running instances
        }

        # Create new installation directory
        New-Item -ItemType Directory -Force -Path $INSTALL_DIR | Out-Null

        # Migrate important data files
        $dataItems = @(
            @{ Path = ".env"; Description = "API configuration" }
            @{ Path = "data\sessions.db"; Description = "Chat sessions" }
            @{ Path = "data\user-config.json"; Description = "User preferences" }
        )

        $migratedCount = 0
        foreach ($item in $dataItems) {
            $oldPath = Join-Path $OLD_INSTALL_DIR $item.Path
            $newPath = Join-Path $INSTALL_DIR $item.Path

            if (Test-Path $oldPath) {
                $parentDir = Split-Path $newPath -Parent
                if (-not (Test-Path $parentDir)) {
                    New-Item -ItemType Directory -Force -Path $parentDir | Out-Null
                }

                Copy-Item $oldPath $newPath -Force
                Write-Info "Migrated: $($item.Description)"
                $migratedCount++
            }
        }

        if ($migratedCount -gt 0) {
            Write-Host ""
            Write-Success "Migrated $migratedCount item(s) successfully"
            Write-Host ""
        }

        # Backup the old directory
        $backupDir = "$OLD_INSTALL_DIR.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Write-Info "Creating backup of old installation..."
        Rename-Item $OLD_INSTALL_DIR $backupDir -Force
        Write-Success "Backup created at:"
        Write-Host "   $backupDir"
        Write-Host ""
        Write-ColorMessage "You can safely delete this backup after verifying Agentic works correctly." "Yellow"
        Write-Host ""

    } catch {
        Write-Warning "Migration completed with some errors: $($_.Exception.Message)"
        Write-Info "Your old installation at $OLD_INSTALL_DIR was preserved"
        Write-Host ""
    }
}

# =============================================================================
# Extract and Install
# =============================================================================

function Install-Application {
    Write-Section "Installing Agentic"

    # Perform migration if needed
    Invoke-DataMigration

    # Create install directory
    Write-Info "Creating installation directory..."
    try {
        New-Item -ItemType Directory -Force -Path $INSTALL_DIR | Out-Null
    } catch {
        Invoke-FatalError "Failed to create install directory" `
            "Check that you have write permissions to $INSTALL_DIR"
    }

    # Extract archive
    Write-Info "Extracting files..."

    # The zip contains a directory named agentic-{platform}
    $extractPath = "$env:TEMP\$APP_NAME-$script:Platform"
    $script:TempFiles += $extractPath

    try {
        Expand-Archive -Path $script:DownloadPath -DestinationPath $env:TEMP -Force -ErrorAction Stop
    } catch {
        Invoke-FatalError "Extraction failed: $($_.Exception.Message)" `
            "The downloaded file may be corrupted. Try again"
    }

    # Verify extraction
    if (-not (Test-Path $extractPath)) {
        Invoke-FatalError "Extraction produced unexpected structure" `
            "This may be a packaging issue. Please report it"
    }

    # Move files to installation directory
    Write-Info "Installing files to $INSTALL_DIR..."

    try {
        # Remove old files but preserve .env and data directory
        Get-ChildItem -Path $INSTALL_DIR -Exclude '.env', '.env.backup', 'data' -ErrorAction SilentlyContinue |
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

        # Move new files
        Get-ChildItem -Path $extractPath | Move-Item -Destination $INSTALL_DIR -Force
    } catch {
        Invoke-FatalError "Failed to install files: $($_.Exception.Message)" `
            "Check disk space and permissions"
    }

    # Restore .env if we backed it up
    if ($script:EnvBackupCreated -and (Test-Path "$INSTALL_DIR\.env.backup")) {
        Write-Info "Restoring your API key configuration..."
        Move-Item "$INSTALL_DIR\.env.backup" "$INSTALL_DIR\.env" -Force
    }

    Write-Success "Installation complete"
}

# =============================================================================
# API Key Configuration
# =============================================================================

function Set-ApiConfiguration {
    Write-Section "API Key Setup"

    # Check for existing real key (not placeholder)
    $existingAnthropic = ""

    if (Test-Path "$INSTALL_DIR\.env") {
        $envLines = Get-Content "$INSTALL_DIR\.env"
        $anthroLine = $envLines | Where-Object { $_ -match "^ANTHROPIC_API_KEY=" -and $_ -notmatch "sk-ant-your-key-here" }

        if ($anthroLine) {
            $existingAnthropic = ($anthroLine -split '=', 2)[1]
            Write-Success "Anthropic API key already configured"
            Write-Host ""
            Write-Info "Models available:"
            Write-ColorMessage "  • " "Green" -NoNewline; Write-Host "Claude Sonnet 5, Claude Opus 4.5"
            Write-ColorMessage "  • " "Green" -NoNewline; Write-Host "OpenAI Codex (via 'bun run login' CLI auth)"
            Write-Host ""
            return
        }
    }

    # Use existing key as default
    $anthropicKey = $existingAnthropic

    # Show simple menu
    Write-Host "Configure Anthropic API key?"
    Write-Host ""
    Write-ColorMessage "  1) " "Yellow" -NoNewline; Write-Host "Enter Anthropic API key (Claude models)"
    Write-ColorMessage "  2) " "Yellow" -NoNewline; Write-Host "Skip (configure later or use Codex only)"
    Write-Host ""
    Write-Info "Note: OpenAI Codex can be configured after install via 'bun run login'"
    Write-Host ""

    $apiChoice = Read-Host "Enter choice [1-2]"

    switch ($apiChoice) {
        "1" {
            Write-Host ""
            Write-ColorMessage "📝 Anthropic API Setup" "Cyan"
            Write-Host "Get your API key from: https://console.anthropic.com/"
            Write-Host ""
            $anthropicKey = Read-Host "Enter your Anthropic API key"
        }
        "2" {
            Write-Host ""
            Write-Warning "Skipping API configuration"
            Write-Info "You can configure Anthropic API later by editing $INSTALL_DIR\.env"
            Write-Info "For OpenAI Codex, run 'bun run login' after installation"
            Write-Host ""
            $anthropicKey = "sk-ant-your-key-here"
        }
        default {
            Write-Host ""
            Write-Warning "Invalid choice. Skipping API configuration."
            $anthropicKey = "sk-ant-your-key-here"
        }
    }

    # Create .env file
    $envContent = @"
# =============================================================================
# Anthropic Configuration (Claude Models)
# =============================================================================
# Get your API key from: https://console.anthropic.com/
ANTHROPIC_API_KEY=$anthropicKey

# =============================================================================
# OpenAI Codex: Uses ChatGPT subscription via CLI auth
# =============================================================================
# Run: bun run login → select Codex
"@

    $envContent | Out-File -FilePath "$INSTALL_DIR\.env" -Encoding UTF8 -Force

    Write-Host ""
    Write-Success "API configuration complete"
}

# =============================================================================
# Personalization Setup
# =============================================================================

function Set-Personalization {
    # Skip if user-config.json already exists
    if (Test-Path "$INSTALL_DIR\data\user-config.json") {
        Write-Section "Personalization"
        Write-Success "Existing personalization preserved"
        return
    }

    Write-Section "Personalization (Optional)"

    Write-Host "Agentic can personalize your experience with your name."
    Write-Host ""
    $userName = Read-Host "Enter your name (or press Enter to skip)"

    if ($userName) {
        # Parse name into firstName and lastName
        $nameParts = $userName.Trim() -split '\s+' | Where-Object { $_ }
        $firstName = $nameParts[0]
        $lastName = if ($nameParts.Length -gt 1) { $nameParts[1..($nameParts.Length-1)] -join ' ' } else { $null }

        # Create data directory
        New-Item -ItemType Directory -Force -Path "$INSTALL_DIR\data" | Out-Null

        # Create user-config.json
        if ($lastName) {
            $userConfig = @{
                firstName = $firstName
                lastName = $lastName
            } | ConvertTo-Json
        } else {
            $userConfig = @{
                firstName = $firstName
            } | ConvertTo-Json
        }

        $userConfig | Out-File -FilePath "$INSTALL_DIR\data\user-config.json" -Encoding UTF8 -Force

        Write-Host ""
        Write-Success "Personalization configured"
        Write-Info "Your name will appear in the interface as: $userName"
    } else {
        Write-Info "Skipped personalization (you can run 'agentic --setup' later)"
    }
}

# =============================================================================
# Add to PATH
# =============================================================================

function Add-ToPath {
    Write-Section "Setting Up Global Command"

    $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")

    if ($currentPath -notlike "*$INSTALL_DIR*") {
        try {
            [Environment]::SetEnvironmentVariable("Path", "$currentPath;$INSTALL_DIR", "User")
            Write-Success "Added to PATH"
            $script:NeedsRestart = $true
        } catch {
            Write-Warning "Could not add to PATH automatically"
            Write-Info "You can run: $INSTALL_DIR\$APP_NAME.exe"
            $script:NeedsRestart = $false
        }
    } else {
        Write-Success "Already in PATH"
        $script:NeedsRestart = $false
    }
}

# =============================================================================
# Success Message
# =============================================================================

function Show-SuccessMessage {
    Write-Section "Installation Successful!"

    Write-ColorMessage "Agentic $script:Version has been installed successfully!" "Green"
    Write-Host ""
    Write-ColorMessage "Installation Location:" "Cyan"
    Write-Host "   $INSTALL_DIR"
    Write-Host ""

    Write-ColorMessage "How to Start Agentic:" "Cyan"
    Write-Host ""

    if ($script:NeedsRestart) {
        Write-ColorMessage "  1. Restart PowerShell (or open a new window)" "Yellow"
        Write-ColorMessage "  2. Type: " "Yellow" -NoNewline
        Write-ColorMessage "$APP_NAME" "Green"
        Write-Host ""
        Write-ColorMessage "  Or start immediately: " "Cyan" -NoNewline
        Write-ColorMessage "$INSTALL_DIR\$APP_NAME.exe" "Green"
    } else {
        Write-ColorMessage "  Just type: " "Yellow" -NoNewline
        Write-ColorMessage "$APP_NAME" "Green"
        Write-Host ""
        Write-ColorMessage "  Or double-click: " "Yellow" -NoNewline
        Write-Host "$INSTALL_DIR\$APP_NAME.exe"
    }

    Write-Host ""
    Write-ColorMessage "The app will start at: " "Cyan" -NoNewline
    Write-ColorMessage "http://localhost:3001" "Blue"
    Write-Host ""

    Write-ColorMessage "License: " "Cyan" -NoNewline
    Write-Host "GNU AGPL-3.0 (Free & Open Source)"
    Write-ColorMessage "   Learn more: " "Cyan" -NoNewline
    Write-ColorMessage "https://www.gnu.org/licenses/agpl-3.0.html" "Blue"
    Write-Host ""

    # Mark installation as successful (prevents cleanup)
    $script:InstallSuccess = $true
}

# =============================================================================
# Main Installation Flow
# =============================================================================

function Start-Installation {
    # Print banner
    Write-Host ""
    Write-ColorMessage "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" "Cyan"
    Write-ColorMessage "   Agentic Installer" "Cyan"
    Write-ColorMessage "   Production-Grade Installation Script" "Cyan"
    Write-ColorMessage "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" "Cyan"
    Write-Host ""

    try {
        # Run all checks and installation steps
        Test-Dependencies
        Test-NetworkConnectivity
        Get-PlatformInfo
        Test-DiskSpace
        Test-ExistingInstallation
        Get-LatestRelease
        Get-ReleasePackage
        Install-Application
        Set-ApiConfiguration
        Set-Personalization
        Add-ToPath
        Show-SuccessMessage
    } catch {
        Invoke-FatalError "Unexpected error: $($_.Exception.Message)" `
            "Please report this issue at https://github.com/$REPO/issues"
    }
}

# Run main installation
Start-Installation
