# Authentication Scripts for GitHub Packages

This directory contains scripts to authenticate with GitHub Packages for accessing private npm packages.

## Prerequisites

- [GitHub CLI (gh)](https://github.com/cli/cli#installation) must be installed and authenticated
- npm must be installed
- You must have `read:packages` permission for the target repositories
- tip: `gh auth` requires a browser, ensure that $BROWSER is set to something useful
  - if using wsl, you can use `export $BROWSER="powershell.exe /c start msedge"'

## Scripts

### Bash Script: `setup-npm-auth.sh`

**Prereq:**

<details>
<summary>
GitHub CLI

</summary>

**macOS:**

```bash
brew install gh
```

**Ubuntu:**

```bash
(type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \
 && sudo mkdir -p -m 755 /etc/apt/keyrings \
 && out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
 && cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
 && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && sudo mkdir -p -m 755 /etc/apt/sources.list.d \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
 && sudo apt update \
 && sudo apt install gh -y
```

**Other Linux:**

[GitHub CLI Linux Install Instructions](https://github.com/cli/cli/blob/trunk/docs/install_linux.md)

</details>
</br>

**Install:**

```bash
# need to login because repo is private
gh auth login
# Download from specific branch
gh api repos/microsoft/project-rayfin/contents/common/scripts/npm-auth/setup-npm-auth.sh\
  -H "Accept: application/vnd.github.v3.raw" > setup-npm-auth.sh

# Make executable and run
chmod +x setup-npm-auth.sh
./setup-npm-auth.sh
```

**Usage:**

```bash
# Interactive mode (default) - starts new shell with env vars
./common/scripts/npm-auth/setup-npm-auth.sh

# Non-interactive mode with defaults - starts new shell
./common/scripts/npm-auth/setup-npm-auth.sh --yes

# Non-interactive with profile addition - starts new shell
./common/scripts/npm-auth/setup-npm-auth.sh -y -p

# Force refresh token even if scope exists
./common/scripts/npm-auth/setup-npm-auth.sh --force-refresh

# Source the script to set variables in current shell (no new shell)
source ./common/scripts/npm-auth/setup-npm-auth.sh

# Show help
./common/scripts/npm-auth/setup-npm-auth.sh --help
```

**Arguments:**

- `-y, --yes, --non-interactive` - Run without interactive prompts (use defaults)
- `-p, --add-to-profile` - Add NODE_AUTH_TOKEN to shell profile for persistence
- `-f, --force-refresh` - Force token refresh even if read:packages scope exists
- `-h, --help` - Show help message

**Features:**

- **Smart token management** - checks existing scopes before refreshing
- **Non-interactive mode** - perfect for CI/CD and automation
- **Environment handling** - starts new shell when executed, sets vars when sourced
- Generates GitHub token with `read:packages` scope only when needed
- Configures npm registry for `@microsoft` scopes
- Sets `NODE_AUTH_TOKEN` environment variable
- Optionally adds token to shell profile for persistence
- Auto-detects shell type (zsh, bash, or generic)
- **Tests authentication** by querying `@microsoft/rayfin-cli` package

### PowerShell Script: `setup-npm-auth.ps1`

**Prereq:**

<details>
<summary>
GitHub CLI

</summary>

```powershell
winget install --id GitHub.cli
```

</details>
</br>

**Install:**

```powershell
# need to login because repo is private
gh auth login
# Download from specific branch
gh api repos/microsoft/project-rayfin/contents/common/scripts/npm-auth/setup-npm-auth.ps1 `
  -H "Accept: application/vnd.github.v3.raw" | Out-File -FilePath setup-npm-auth.ps1 -Encoding UTF8

# Run the script
.\setup-npm-auth.ps1
```

**Usage:**

```powershell
# Interactive mode (default)
.\common\scripts\npm-auth\setup-npm-auth.ps1

# Non-interactive mode with defaults
.\common\scripts\npm-auth\setup-npm-auth.ps1 -NonInteractive

# Non-interactive with profile addition
.\common\scripts\npm-auth\setup-npm-auth.ps1 -NonInteractive -AddToProfile

# Force refresh token even if scope exists
.\common\scripts\npm-auth\setup-npm-auth.ps1 -ForceRefresh

# Show help
.\common\scripts\npm-auth\setup-npm-auth.ps1 -Help
```

**Parameters:**

- `-NonInteractive` - Run without interactive prompts (use defaults)
- `-AddToProfile` - Add NODE_AUTH_TOKEN to PowerShell profile for persistence
- `-ForceRefresh` - Force token refresh even if read:packages scope exists
- `-Help` - Show help message

**Features:**

- **Smart token management** - checks existing scopes before refreshing
- **Non-interactive mode** - perfect for CI/CD and automation
- **Environment handling** - sets environment variables in current PowerShell session
- Generates GitHub token with `read:packages` scope only when needed
- Configures npm registry for `@microsoft` scopes
- Sets `NODE_AUTH_TOKEN` environment variable
- Optionally adds token to PowerShell profile for persistence
- Comprehensive error handling and colored output
- **Tests authentication** by querying `@microsoft/rayfin-cli` package

## Authentication Flow

1. **Scope Check**: Verifies if current token already has `read:packages` scope
2. **Token Generation**: Uses `gh auth refresh --scopes "read:packages"` only if needed
3. **npm Configuration**: Sets up scoped registries for GitHub Packages
4. **Environment Setup**: Configures `NODE_AUTH_TOKEN` for CI/CD compatibility
5. **Persistence**: Optionally saves configuration to shell/PowerShell profile
6. **Verification**: Tests authentication by querying a private package

## Execution Modes

### Bash Script Execution Modes

**1. Execute directly (`./common/scripts/npm-auth/setup-npm-auth.sh`):**

- Configures npm and sets environment variables
- **Starts a new bash session** with `NODE_AUTH_TOKEN` available
- User can immediately use `npm install @microsoft/package-name`
- Type `exit` to return to the original shell

**2. Source the script (`source ./common/scripts/npm-auth/setup-npm-auth.sh`):**

- Automatically runs in non-interactive mode
- Sets `NODE_AUTH_TOKEN` in the **current shell**
- No new shell session started
- Environment variables are immediately available

**Benefits:**

- **Executed mode**: Perfect for one-time setup where you want a clean environment
- **Sourced mode**: Perfect for adding to existing shell sessions or automation scripts

### PowerShell Script

PowerShell scripts always set environment variables in the current session. No sourcing mechanism needed.

## After Running

Once authenticated, you can install private packages:

```bash
npm install @microsoft/rayfin-core
npm install @microsoft/rayfin-data
npm install @microsoft/some-package
```

## Troubleshooting

### Common Issues

1. **"gh: command not found"**
   - Install GitHub CLI: <https://github.com/cli/cli#installation>

2. **"GitHub CLI is not authenticated"**
   - Run `gh auth login` and follow the prompts

3. **"403 Forbidden" when installing packages**
   - Ensure you have `read:packages` permission for the repository
   - Check that the package actually exists in GitHub Packages

4. **Token expires**
   - Re-run the script to generate a new token
   - GitHub CLI tokens are typically short-lived for security

### Manual Configuration

If the scripts don't work, you can manually configure npm:

```bash
# Generate token
TOKEN=$(gh auth token --scopes "read:packages")

# Configure npm
npm config set @microsoft:registry https://npm.pkg.github.com/
npm config set //npm.pkg.github.com/:_authToken $TOKEN

# Set environment variable
export NODE_AUTH_TOKEN=$TOKEN
```

## Security Notes

- Tokens are generated with minimal required scope (`read:packages`)
- Tokens are masked in output (only first 8 characters shown)
- Scripts use `gh auth token` which generates temporary tokens
- Consider using personal access tokens for long-term CI/CD scenarios
