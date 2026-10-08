# 📦 Package Publishing Guide

This guide covers how Rayfin TypeScript packages are published and how contributors can publish manually to GitHub Packages for validation.

## 🎯 Overview

Rayfin packages reach consumers through two registries:

- **npmjs.org** — the public registry where builders install packages.
  Releases are published automatically via Azure Pipelines using ESRP and manual approval.
  Builders do **not** need any authentication or `.npmrc` configuration to install these packages.
- **GitHub Packages** (`npm.pkg.github.com`) — an internal registry used for pre-release validation between npmjs.org releases.
  Every push to `main` automatically runs the `publish-npm.yml` GitHub Actions workflow in an attempt to publish to GitHub Packages.
  The action skips any package whose current `package.json` version already exists on the registry.
  Only contributors with repository access can install from this registry.

The rest of this guide focuses on the GitHub Packages workflow, which is relevant when you need to test a package before it reaches npmjs.org or publish manually during development.

## 🔑 Prerequisites

Before you can publish packages, ensure you have:

- **Node.js** 20+ and npm installed
- **Rush** installed (`npm i -g @microsoft/rush)
- **GitHub account** with access to the `microsoft/project-rayfin` repository
- **Write permissions** to the repository
- **Personal Access Token (PAT)** with appropriate scopes

## 📋 Available Packages

| Package Name                  | Directory                           | Description                                     | Version | Status    |
| ----------------------------- | ----------------------------------- | ----------------------------------------------- | ------- | --------- |
| `@microsoft/rayfin-core`      | `packages/typescript-sdk/core`      | TypeScript decorators for DAB config generation | 1.0.7   | ✅ Active |
| `@microsoft/rayfin-data`      | `packages/typescript-sdk/data`      | 100% DAB-compliant client library               | 1.0.7   | ✅ Active |
| `@microsoft/rayfin-auth`      | `packages/typescript-sdk/auth`      | Authentication and authorization utilities      | 1.0.7   | ✅ Active |
| `@microsoft/rayfin-client`    | `packages/typescript-sdk/client`    | Main client SDK for Rayfin services             | 1.0.7   | ✅ Active |
| `@microsoft/rayfin-lib`       | `packages/typescript-sdk/lib`       | Shared library utilities and HTTP client        | 1.0.7   | ✅ Active |
| `@microsoft/rayfin-cli`       | `packages/typescript-sdk/cli`       | Command-line interface tools                    | 1.0.7   | ✅ Active |
| `@microsoft/rayfin-functions` | `packages/typescript-sdk/functions` | Functions API client for serverless invocation  | 1.0.7   | ✅ Active |

## 🔐 Step 1: Create GitHub Personal Access Token (PAT)

### 1.1 Navigate to GitHub Token Settings

1. Go to [GitHub.com](https://github.com) and sign in
2. Click your **profile picture** in the top right
3. Select **Settings** from the dropdown
4. In the left sidebar, scroll down and click **Developer settings**
5. Click **Personal access tokens** → **Tokens (classic)**

### 1.2 Generate New Token

1. Click **Generate new token (classic)**
2. Fill in the token details:
   - **Note**: `rayfin-packages-publishing` (or similar descriptive name)
   - **Expiration**: Select appropriate timeframe (90 days recommended)

### 1.3 Select Required Scopes

**⚠️ CRITICAL:** You must select the following scopes:

```text
✅ repo                    (Full control of private repositories)
  ├── repo:status         (Access commit status)
  ├── repo_deployment     (Access deployment status)
  ├── public_repo         (Access public repositories)
  └── repo:invite         (Access repository invitations)

✅ write:packages          (Upload packages to GitHub Package Registry)
  ├── read:packages       (Download packages from GitHub Package Registry)
  └── package:delete      (Delete packages from GitHub Package Registry)

✅ read:org                (Read org and team membership, read org projects)
```

### 1.4 Generate and Secure Token

1. Click **Generate token**
2. **🚨 IMMEDIATELY COPY THE TOKEN** - you will not see it again!
3. Store it securely in a password manager
4. The token will look like: `ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

## 🔧 Step 2: Configure Environment Variables

### 2.1 Windows (PowerShell) - Recommended

```powershell
# Set for current session only
$env:NODE_AUTH_TOKEN = "ghp_your_actual_token_here"

# Verify it's set
echo $env:NODE_AUTH_TOKEN

# Set permanently for your user account
[Environment]::SetEnvironmentVariable("NODE_AUTH_TOKEN", "ghp_your_actual_token_here", "User")

# Restart PowerShell to pick up permanent changes
```

### 2.2 Windows (Command Prompt)

```cmd
# Set for current session
set NODE_AUTH_TOKEN=ghp_your_actual_token_here

# Set permanently
setx NODE_AUTH_TOKEN "ghp_your_actual_token_here"

# Verify (after reopening cmd)
echo %NODE_AUTH_TOKEN%
```

### 2.3 macOS/Linux (Bash/Zsh)

```bash
# Set for current session
export NODE_AUTH_TOKEN="ghp_your_actual_token_here"

# Set permanently (choose your shell's config file)
echo 'export NODE_AUTH_TOKEN="ghp_your_actual_token_here"' >> ~/.bashrc
# OR for Zsh users:
echo 'export NODE_AUTH_TOKEN="ghp_your_actual_token_here"' >> ~/.zshrc

# Reload your shell configuration
source ~/.bashrc  # or source ~/.zshrc

# Verify
echo $NODE_AUTH_TOKEN
```

### 2.4 Verify Environment Variable

Before proceeding, verify your token is properly set:

```bash
# PowerShell
if ($env:NODE_AUTH_TOKEN) {
    Write-Host "✅ TOKEN SET: $($env:NODE_AUTH_TOKEN.Substring(0,8))..." -ForegroundColor Green
} else {
    Write-Host "❌ TOKEN NOT SET" -ForegroundColor Red
}

# Bash/Zsh
if [ -n "$NODE_AUTH_TOKEN" ]; then
    echo "✅ TOKEN SET: ${NODE_AUTH_TOKEN:0:8}..."
else
    echo "❌ TOKEN NOT SET"
fi
```

## 📦 Step 3: Publishing Packages

### 3.1 Prepare Your Environment

```bash
# Navigate to project root
cd path/to/project-rayfin

# Preflight
rush update
rush build
rush test
rush format:check
rush lint:check

# No errors means you're good to go
```

### 3.2 Bump the versions

```bash
rush version --bump
```

The updates should be committed before proceeding, under normal circumstances

### 3.2 Publishing Options

#### Option A: Publish All Packages (Recommended)

```bash
rush publish --include-all

```

#### Option B: Publish Individual Package

```bash
# Method 1: Navigate to package directory
cd packages/typescript-sdk/core
npm publish --access restricted

# Method 2: Use workspace flag from root
npm publish --workspace=packages/typescript-sdk/core --access restricted
```

#### Option C: Automated via GitHub Actions

The repository includes workflows that automatically publish packages:

1. **On Push to Main**: Publishes packages when changes are detected
2. **Manual Trigger**: Use repository dispatch to trigger publishing
3. **Pull Request**: Validates packages can be built and published

## 🔍 Step 4: Verify Publication

### 4.1 Check GitHub Packages

1. Navigate to your repository on GitHub
2. Click **Packages** tab
3. Verify your packages appear with correct versions

### 4.2 Test Installation

```bash
# Create a test directory
mkdir test-install && cd test-install

# Initialize npm project
npm init -y

# Configure registry for scoped packages
echo "@microsoft:registry=https://npm.pkg.github.com/" > .npmrc
echo "//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}" >> .npmrc

# Test installation
npm install @microsoft/rayfin-core@latest
```

## ⚠️ Common Issues & Solutions

### Issue 1: "401 Unauthorized" Error

**Symptoms:**

```text
npm ERR! 401 Unauthorized - PUT https://npm.pkg.github.com/@microsoft%2frayfin-core
```

**Solutions:**

1. **Verify token is set:**

   ```bash
   echo $NODE_AUTH_TOKEN  # Should show your token
   ```

2. **Check token permissions:**
   - Ensure `write:packages` scope is selected
   - Verify `repo` access if publishing to private repo

3. **Re-authenticate npm:**

   ```bash
   npm logout
   npm login --scope=@microsoft --registry=https://npm.pkg.github.com
   # Username: your-github-username
   # Password: your-PAT-token
   ```

### Issue 2: "Cannot find module @rollup/rollup-linux-x64-gnu"

**Symptoms:**

```text
Error: Cannot find module '@rollup/rollup-linux-x64-gnu'
```

**Solutions:**

1. **Quick fix:**

   ```bash
   rush purge
   rush update
   ```

2. **Use provided scripts:**

   ```bash
   # Windows
   .\scripts\fix-npm-optional-deps.ps1

   # macOS/Linux
   ./scripts/fix-npm-optional-deps.sh
   ```

3. **Manual workaround:**

   ```bash
   rush update
   ```

### Issue 3: "Package already exists"

**Symptoms:**

```text
npm ERR! 403 Forbidden - PUT https://npm.pkg.github.com/@microsoft%2frayfin-core - Package version already exists
```

**Solutions:**

1. **Update version in package.json:**

   ```json
   {
     "version": "1.0.1" // Increment from current version
   }
   ```

2. **Use semantic versioning:**
   - **Patch**: `1.0.0` → `1.0.1` (bug fixes)
   - **Minor**: `1.0.0` → `1.1.0` (new features)
   - **Major**: `1.0.0` → `2.0.0` (breaking changes)

### Issue 4: "ENOTFOUND" or Network Errors

**Symptoms:**

```text
npm ERR! network request to https://npm.pkg.github.com/ failed
```

**Solutions:**

1. **Check network connectivity:**

   ```bash
   ping github.com
   curl -I https://npm.pkg.github.com
   ```

2. **Configure npm registry:**

   ```bash
   npm config set @microsoft:registry https://npm.pkg.github.com/
   ```

3. **Check corporate firewall/proxy:**

   ```bash
   npm config set proxy http://proxy.company.com:8080
   npm config set https-proxy http://proxy.company.com:8080
   ```

## 🔒 Security Best Practices

### 1. Token Management

- **🔄 Rotate tokens every 90 days**
- **🚫 Never commit tokens to version control**
- **🔐 Store tokens in secure password managers**
- **📝 Document token purposes and expiration dates**

### 2. Environment Variables

```bash
# ✅ Good: Use environment variables
export NODE_AUTH_TOKEN="ghp_..."

# ❌ Bad: Hardcode in scripts
npm publish --registry=https://npm.pkg.github.com --token=ghp_...
```

### 3. .gitignore Entries

Ensure your `.gitignore` includes:

```gitignore
# Environment files
.env
.env.local
.env.*.local

# npm
.npmrc.local
npm-debug.log*

# Personal tokens
*.token
.auth
```

## 📞 Getting Help

### Documentation Resources

- [GitHub Packages Documentation](https://docs.github.com/en/packages)
- [npm Publishing Guide](https://docs.npmjs.com/cli/v10/commands/npm-publish)
- [Project Development Docs](../README.md)

### Support Channels

1. **Internal Issues**: Create issue in this repository
2. **GitHub Packages**: [GitHub Support](https://support.github.com)
3. **npm Issues**: [npm Support](https://www.npmjs.com/support)

### Quick Debug Commands

```bash
# Check npm configuration
npm config list

# Verify registry settings
npm config get @microsoft:registry

# Test authentication
npm whoami --registry=https://npm.pkg.github.com

# View package info
npm view @microsoft/rayfin-core --registry=https://npm.pkg.github.com
```

---

## 📝 Quick Reference

### Essential Commands

```bash
# Set environment variable (PowerShell)
$env:NODE_AUTH_TOKEN = "ghp_your_token_here"

# Publish all packages
rush publish --include-all

# Verify publication
npm view @microsoft/rayfin-core --registry=https://npm.pkg.github.com
```

### Required Files

- ✅ `.npmrc` (configured for GitHub Packages)
- ✅ `package.json` (with correct name and publishConfig)
- ✅ Environment variable `NODE_AUTH_TOKEN`

---

## 🌐 Publishing to npmjs.org

Publication to the public npmjs.org registry is **not a manual process**.
It is handled by the Azure Pipelines release pipeline:

1. The `NpmBuild` stage builds all packages and creates `.tgz` tarballs via `rush publish --publish --pack`.
1. The `PublishNpm` stage uploads those tarballs to npmjs.org via ESRP under a dist-tag chosen by the `NpmProductState` parameter (`preview`, `latest`, or `experimental`).
1. This stage requires manual approval and only runs on the `main` branch or when explicitly triggered.

### Publishing the current `main` build under `@experimental`

To ship the current `main` build to public npmjs on-demand under the `@experimental` dist-tag (e.g. so others can test a not-yet-released change), queue the `rayfin.official.yml` pipeline manually from `main` with:

- `PublishNpm` = `true`
- `NpmProductState` = `experimental`

The `PublishNpm` override bypasses the alpha-version guard, so an alpha `main` build still publishes. Consumers can then install it with `npm install @microsoft/rayfin-core@experimental`. The `@latest` / `@preview` tags are untouched, so the experimental build never becomes the default `npm install` target.

Each experimental publish is stamped with a unique `alpha.N` suffix at pack time (e.g. `1.34.0-alpha.1234`, where `N` is the commit count — mirroring the GitHub Action alpha flow), so repeated publishes from `main` don't collide on npmjs with an "already exists" error. Alpha builds are not git-tagged.

If you need to verify what a package tarball contains before it reaches npmjs.org, run `npm pack --dry-run` from the package directory.

### Pipeline files

- `.azure-pipelines/rayfin.official.yml` — orchestrates all stages
- `.azure-pipelines/templates/npm-build-stage.yml` — builds tarballs
- `.azure-pipelines/templates/publish-npm-stage.yml` — publishes to npmjs.org via ESRP

### GitHub Packages pipeline

- `.github/workflows/publish-npm.yml` — runs on every push to `main` (and manual dispatch); skips packages whose version already exists on the registry

---

## Last updated: April 2026
