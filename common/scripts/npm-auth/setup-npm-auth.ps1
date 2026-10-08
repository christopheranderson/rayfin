# setup-npm-auth.ps1
# Script to authenticate with GitHub Packages for private npm packages
# Requires: gh CLI tool installed and authenticated

param(
    [switch]$NonInteractive = $false,
    [switch]$AddToProfile = $false,
    [switch]$ForceRefresh = $false,
    [switch]$Help = $false
)

# Display help
if ($Help) {
    Write-Host @"
setup-npm-auth.ps1 - Configure npm authentication for GitHub Packages

SYNOPSIS
    .\setup-npm-auth.ps1 [OPTIONS]

DESCRIPTION
    This script authenticates with GitHub Packages and configures npm to access
    private packages in the @microsoft scopes.
    It also logs in to GitHub Container Registry (GHCR) at ghcr.io using your
    GitHub auth token so you can pull Rayfin images.

PARAMETERS
    -NonInteractive     Run without interactive prompts (use defaults)
    -AddToProfile      Add NODE_AUTH_TOKEN to PowerShell profile for persistence
    -ForceRefresh      Force token refresh even if scope exists
    -Help             Display this help message

REQUIREMENTS
    - GitHub CLI (gh) must be installed and authenticated
    - npm must be installed
    - Docker CLI (docker) must be installed

EXAMPLES
    .\setup-npm-auth.ps1
    .\setup-npm-auth.ps1 -NonInteractive
    .\setup-npm-auth.ps1 -NonInteractive -AddToProfile
    .\setup-npm-auth.ps1 -ForceRefresh
"@
    exit 0
}

# Function to write colored output
function Write-Info {
    param([string]$Message)
    Write-Host "[INFO] $Message" -ForegroundColor Green
}

function Write-Warning {
    param([string]$Message)
    Write-Host "[WARNING] $Message" -ForegroundColor Yellow
}

function Write-Error {
    param([string]$Message)
    Write-Host "[ERROR] $Message" -ForegroundColor Red
}

# Set error action preference
$ErrorActionPreference = "Stop"

# Detect operating system
$isWindowsOS = $IsWindows -or ($PSVersionTable.PSVersion.Major -lt 6)
$isMacOSOS = $IsMacOS
$isLinuxOS = $IsLinux

try {
    # Check if gh CLI is installed
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        Write-Error "GitHub CLI (gh) is not installed. Please install it first:"
        Write-Host "  Windows: winget install GitHub.cli"
        Write-Host "  Or download from: https://github.com/cli/cli#installation"
        exit 1
    }

    # Check if gh is authenticated
    $authStatus = gh auth status 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "GitHub CLI is not authenticated. Please run 'gh auth login' first."
        exit 1
    }

    Write-Info "Checking current token scopes..."

    # Check if current token already has read:packages scope
    $tokenInfo = gh auth status --show-token 2>&1 | Out-String
    $scopesLine = $tokenInfo -split "`n" | Where-Object { $_ -match "token scopes" }

    if ($scopesLine -and $scopesLine -match "read:packages" -and -not $ForceRefresh) {
        Write-Info "✅ Current token already has read:packages scope"
        $token = gh auth token
    } else {
        if ($ForceRefresh) {
            Write-Info "🔄 Force refreshing token as requested..."
        } else {
            Write-Info "🔄 Current token missing read:packages scope, refreshing token..."
        }
        # Generate a token with read:packages scope
        gh auth refresh --scopes "read:packages"
        $token = gh auth token
    }

    if (-not $token) {
        Write-Error "Failed to generate GitHub token"
        exit 1
    }

    Write-Info "Setting NODE_AUTH_TOKEN environment variable..."

    # Set environment variable for current session
    $env:NODE_AUTH_TOKEN = $token

    Write-Info "Configuring npm for GitHub Packages (project-local)..."

    # Configure npm to use GitHub Packages registry for @microsoft scope (project-local)
    # This creates a .npmrc file in the current directory
    npm config set "@microsoft:registry" "https://npm.pkg.github.com/" --location=project
    npm config set "//npm.pkg.github.com/:_authToken" "`${NODE_AUTH_TOKEN}" --location=project

    # Track where the profile was updated for later use
    $profileUpdatedPath = $null

    # Add to shell profile for persistence if requested
    if ($isWindowsOS) {
        # Windows PowerShell profile handling
        if ($NonInteractive) {
            if ($AddToProfile) {
                $profilePath = $PROFILE.CurrentUserAllHosts

                if (-not (Test-Path $profilePath)) {
                    New-Item -Path $profilePath -ItemType File -Force | Out-Null
                    Write-Info "Created PowerShell profile at: $profilePath"
                }

                # Check if NODE_AUTH_TOKEN is already in profile
                $profileContent = Get-Content $profilePath -ErrorAction SilentlyContinue
                $hasToken = $profileContent | Where-Object { $_ -match "NODE_AUTH_TOKEN" }
                if (-not $hasToken) {
                    Add-Content -Path $profilePath -Value "`n# GitHub Packages authentication"
                    Add-Content -Path $profilePath -Value "`$env:NODE_AUTH_TOKEN = `"$token`""
                    $profileUpdatedPath = $profilePath
                    Write-Info "Added NODE_AUTH_TOKEN to PowerShell profile: $profilePath"
                    Write-Warning "You'll need to restart PowerShell or run '. `$PROFILE.CurrentUserAllHosts' for the change to take effect"
                } else {
                    Write-Info "NODE_AUTH_TOKEN already exists in profile"
                }
            } else {
                Write-Info "Skipping PowerShell profile update (use -AddToProfile to enable)"
            }
        } else {
            $response = Read-Host "Do you want to add NODE_AUTH_TOKEN to your PowerShell profile? (Y/n)"
            if ($response -notmatch "^[Nn]") {
                $profilePath = $PROFILE.CurrentUserAllHosts

                if (-not (Test-Path $profilePath)) {
                    New-Item -Path $profilePath -ItemType File -Force | Out-Null
                    Write-Info "Created PowerShell profile at: $profilePath"
                }

                # Check if NODE_AUTH_TOKEN is already in profile
                $profileContent = Get-Content $profilePath -ErrorAction SilentlyContinue
                $hasToken = $profileContent | Where-Object { $_ -match "NODE_AUTH_TOKEN" }
                if (-not $hasToken) {
                    Add-Content -Path $profilePath -Value "`n# GitHub Packages authentication"
                    Add-Content -Path $profilePath -Value "`$env:NODE_AUTH_TOKEN = `"$token`""
                    $profileUpdatedPath = $profilePath
                    Write-Info "Added NODE_AUTH_TOKEN to PowerShell profile: $profilePath"
                    Write-Warning "You'll need to restart PowerShell or run '. `$PROFILE.CurrentUserAllHosts' for the change to take effect"
                } else {
                    Write-Info "NODE_AUTH_TOKEN already exists in profile"
                }
            }
        }
    } elseif ($isMacOSOS -or $isLinuxOS) {
        # Unix-like systems (macOS/Linux) - detect shell and update appropriate profile
        if ($NonInteractive) {
            if ($AddToProfile) {
                # Detect the shell
                $shellProfilePath = $null
                if ($env:SHELL -match "zsh") {
                    $shellProfilePath = "$env:HOME/.zshrc"
                } elseif ($env:SHELL -match "bash") {
                    $shellProfilePath = "$env:HOME/.bashrc"
                    # Also check for .bash_profile on macOS
                    if ($isMacOSOS -and (Test-Path "$env:HOME/.bash_profile")) {
                        $shellProfilePath = "$env:HOME/.bash_profile"
                    }
                } else {
                    Write-Warning "Unknown shell: $env:SHELL. Defaulting to ~/.profile"
                    $shellProfilePath = "$env:HOME/.profile"
                }

                if ($shellProfilePath) {
                    if (-not (Test-Path $shellProfilePath)) {
                        New-Item -Path $shellProfilePath -ItemType File -Force | Out-Null
                        Write-Info "Created shell profile at: $shellProfilePath"
                    }

                    $profileContent = Get-Content $shellProfilePath -ErrorAction SilentlyContinue
                    $hasToken = $profileContent | Where-Object { $_ -match "NODE_AUTH_TOKEN" }
                    if (-not $hasToken) {
                        Add-Content -Path $shellProfilePath -Value "`n# GitHub Packages authentication"
                        Add-Content -Path $shellProfilePath -Value "export NODE_AUTH_TOKEN=`"$token`""
                        $profileUpdatedPath = $shellProfilePath
                        Write-Info "Added NODE_AUTH_TOKEN to shell profile: $shellProfilePath"
                        Write-Warning "You'll need to restart your terminal or run 'source $shellProfilePath' for the change to take effect"
                    } else {
                        Write-Info "NODE_AUTH_TOKEN already exists in profile"
                    }
                }
            } else {
                Write-Info "Skipping shell profile update (use -AddToProfile to enable)"
            }
        } else {
            $response = Read-Host "Do you want to add NODE_AUTH_TOKEN to your shell profile? (Y/n)"
            if ($response -notmatch "^[Nn]") {
                # Detect the shell
                $shellProfilePath = $null
                if ($env:SHELL -match "zsh") {
                    $shellProfilePath = "$env:HOME/.zshrc"
                } elseif ($env:SHELL -match "bash") {
                    $shellProfilePath = "$env:HOME/.bashrc"
                    # Also check for .bash_profile on macOS
                    if ($isMacOSOS -and (Test-Path "$env:HOME/.bash_profile")) {
                        $shellProfilePath = "$env:HOME/.bash_profile"
                    }
                } else {
                    Write-Warning "Unknown shell: $env:SHELL. Defaulting to ~/.profile"
                    $shellProfilePath = "$env:HOME/.profile"
                }

                if ($shellProfilePath) {
                    if (-not (Test-Path $shellProfilePath)) {
                        New-Item -Path $shellProfilePath -ItemType File -Force | Out-Null
                        Write-Info "Created shell profile at: $shellProfilePath"
                    }

                    $profileContent = Get-Content $shellProfilePath -ErrorAction SilentlyContinue
                    $hasToken = $profileContent | Where-Object { $_ -match "NODE_AUTH_TOKEN" }
                    if (-not $hasToken) {
                        Add-Content -Path $shellProfilePath -Value "`n# GitHub Packages authentication"
                        Add-Content -Path $shellProfilePath -Value "export NODE_AUTH_TOKEN=`"$token`""
                        $profileUpdatedPath = $shellProfilePath
                        Write-Info "Added NODE_AUTH_TOKEN to shell profile: $shellProfilePath"
                        Write-Warning "You'll need to restart your terminal or run 'source $shellProfilePath' for the change to take effect"
                    } else {
                        Write-Info "NODE_AUTH_TOKEN already exists in profile"
                    }
                }
            }
        }
    }

    Write-Info "npm authentication configured successfully!"
    Write-Info "You can now install private packages with: npm install @microsoft/rayfin-core"

    # If Docker is installed, log in to GitHub Container Registry (ghcr.io)
    Write-Host ""
    Write-Info "Checking for Docker to configure GHCR (ghcr.io) login..."

    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Error "Docker CLI (docker) is not installed."
        Write-Host "  Install Docker Desktop: https://docs.docker.com/desktop/install/windows-install/"
        Write-Host "  Or via winget: winget install -e --id Docker.DockerDesktop"
        exit 1
    } else {
        # Determine the GitHub username for docker login
        $ghUser = (gh api user -q ".login" 2>$null | Out-String).Trim()
        if (-not $ghUser) {
            Write-Error "Could not determine GitHub username."
            Write-Host "  Try: gh auth login"
                Write-Host "  Or manually login to GHCR with your GitHub username:"
                Write-Host "    gh auth token | docker login ghcr.io -u <GITHUB_USERNAME> --password-stdin"
                Write-Host "    echo <PAT> | docker login ghcr.io -u <GITHUB_USERNAME> --password-stdin  # PAT must have read:packages"
                exit 1
            }

            Write-Info "Logging in to ghcr.io as '$ghUser'..."
            # Pipe the token via stdin to avoid exposing it in args/history
            $dockerLoginOutput = $token | docker login ghcr.io -u $ghUser --password-stdin 2>&1 | Out-String
            $dockerExitCode = $LASTEXITCODE
            if ($dockerExitCode -ne 0) {
                Write-Error "GHCR docker login failed: $dockerLoginOutput"
                exit 1
            }

            Write-Info "✅ GHCR login succeeded."
    }

    # Display current npm configuration
    Write-Host ""
    Write-Info "Current npm configuration:"
    $npmConfig = npm config list | Select-String -Pattern "(registry|_authToken)"
    if ($npmConfig) {
        $npmConfig | ForEach-Object { Write-Host $_.Line }
    }

    Write-Host ""
    Write-Info "Environment variable set:"
    $maskedToken = $token.Substring(0, [Math]::Min(8, $token.Length)) + "..."
    Write-Host "NODE_AUTH_TOKEN=$maskedToken"

    Write-Host ""
    Write-Info "Testing authentication by querying a private package..."

    # Test authentication by trying to view a private package
    try {
        $npmOutput = npm view "@microsoft/rayfin-cli" 2>&1 | Out-String
        $npmExitCode = $LASTEXITCODE

        if ($npmExitCode -eq 0 -and
            $npmOutput -notmatch "404 Not Found" -and
            $npmOutput -notmatch "403 Forbidden" -and
            $npmOutput -notmatch "E404" -and
            $npmOutput -notmatch "E403" -and
            $npmOutput.Trim() -ne "") {
            Write-Info "✅ Authentication test successful! Private package access confirmed."
        } else {
            throw "npm view failed or returned error content"
        }
    } catch {
        Write-Warning "⚠️  Authentication test failed. This could mean:"
        Write-Host "  - The package @microsoft/rayfin-cli doesn't exist in GitHub Packages"
        Write-Host "  - You don't have read access to the package"
        Write-Host "  - There's a configuration issue"
        if ($profileUpdatedPath) {
            if ($isMacOSOS -or $isLinuxOS) {
                Write-Host "  - You may need to exit PowerShell and restart your terminal, or run 'source $profileUpdatedPath' for NODE_AUTH_TOKEN to be available"
            }
        }
        Write-Host "  - Try manually: npm view @microsoft/rayfin-cli"
        if ($npmOutput) {
            $truncatedOutput = if ($npmOutput.Length -gt 200) { $npmOutput.Substring(0, 200) + "..." } else { $npmOutput }
            Write-Host "  - Response: $truncatedOutput"
        }
    }

} catch {
    $errMsg = "" + $($_.Exception.Message)
    $maxLen = 500
    if ($null -ne $errMsg -and $errMsg.Length -gt $maxLen) {
        $errMsg = $errMsg.Substring(0, $maxLen) + "..."
    }
    Write-Error "An error occurred: $errMsg"
    exit 1
}
