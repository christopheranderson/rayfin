#!/bin/bash

# setup-npm-auth.sh
# Script to authenticate with GitHub Packages for private npm packages
# Requires: gh CLI tool installed and authenticated

# Default values
IS_SOURCED=false
NON_INTERACTIVE=false
SKIP_PROFILE=false
FORCE_REFRESH=false

# Detect if script is sourced before parsing arguments
is_sourced() {
    # bash
    if [[ -n "${BASH_VERSION-}" ]]; then
        [[ "${BASH_SOURCE[0]}" != "${0}" ]] && return 0 || return 1
    fi

    # zsh
    if [[ -n "${ZSH_VERSION-}" ]]; then
        # When sourced from a file, ZSH_EVAL_CONTEXT typically contains ':file'
        [[ "${ZSH_EVAL_CONTEXT-}" == *":file"* ]] && return 0 || return 1
    fi

    return 1
}

if is_sourced; then
    IS_SOURCED=true
    NON_INTERACTIVE=true
fi

# Only enable set -e when not sourced to avoid affecting caller's shell
if [[ "$IS_SOURCED" != "true" ]]; then
    set -e
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to update shell profile with fresh token
update_profile_with_token() {
    local token="$1"
    local profile

    # Detect shell and add to appropriate profile
    # Check $SHELL first as it's more reliable, then fall back to version variables
    if [[ "$SHELL" == *"zsh"* ]] || [[ -n "${ZSH_VERSION}" ]]; then
        profile="$HOME/.zshrc"
    elif [[ "$SHELL" == *"bash"* ]] || [[ -n "${BASH_VERSION}" ]]; then
        profile="$HOME/.bashrc"
    else
        profile="$HOME/.profile"
    fi

    # Remove any existing NODE_AUTH_TOKEN to avoid stale tokens
    if grep -q "NODE_AUTH_TOKEN" "$profile" 2>/dev/null; then
        # Remove old token and comment (portable sed syntax for macOS and Linux)
        if [[ "$(uname)" == "Darwin" ]]; then
            # macOS (BSD sed)
            sed -i .bak '/# GitHub Packages authentication/d' "$profile"
            sed -i .bak '/NODE_AUTH_TOKEN/d' "$profile"
        else
            # Linux (GNU sed)
            sed -i.bak '/# GitHub Packages authentication/d' "$profile"
            sed -i.bak '/NODE_AUTH_TOKEN/d' "$profile"
        fi
        print_info "Removed old NODE_AUTH_TOKEN from $profile"
    fi

    # Add fresh token
    echo "" >> "$profile"
    echo "# GitHub Packages authentication" >> "$profile"
    echo "export NODE_AUTH_TOKEN=\"$token\"" >> "$profile"

    # Set global variable for use later in script
    PROFILE_UPDATED_PATH="$profile"
    print_info "Added NODE_AUTH_TOKEN to shell profile: $profile"
}

# Main function to wrap all logic
__main() {
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            -y|--yes|--non-interactive)
                NON_INTERACTIVE=true
                shift
                ;;
            --no)
                SKIP_PROFILE=true
                shift
                ;;
            -f|--force-refresh)
                FORCE_REFRESH=true
                shift
                ;;
            -h|--help)
                echo "setup-npm-auth.sh - Configure npm authentication for GitHub Packages"
                echo ""
                echo "SYNOPSIS"
                echo "    $0 [OPTIONS]"
                echo ""
                echo "DESCRIPTION"
                echo "    This script authenticates with GitHub Packages and configures npm to access"
                echo "    private packages in the @microsoft scopes."
                echo "    It also logs in to GitHub Container Registry (GHCR) at ghcr.io using your"
                echo "    GitHub auth token so you can pull Rayfin images."
                echo ""
                echo "PARAMETERS"
                echo "    -y, --yes, --non-interactive    Run without interactive prompts (adds token to profile by default)"
                echo "    --no                            Skip adding NODE_AUTH_TOKEN to shell profile"
                echo "    -f, --force-refresh            Force token refresh even if scope exists"
                echo "    -h, --help                     Display this help message"
                echo ""
                echo "REQUIREMENTS"
                echo "    - GitHub CLI (gh) must be installed and authenticated"
                echo "    - npm must be installed"
                echo ""
                echo "EXAMPLES"
                echo "    source $0"
                echo "    source $0 -y"
                echo "    source $0 -y --no"
                echo "    $0 --force-refresh"
                return 0
                ;;
            *)
                echo "Unknown option: $1"
                echo "Use --help for usage information"
                return 1
                ;;
        esac
    done

    # Check if gh CLI is installed
    if ! command -v gh &> /dev/null; then
        print_error "GitHub CLI (gh) is not installed. Please install it first:"
        echo "  macOS: brew install gh"
        echo "  Ubuntu/Debian: apt install gh"
        echo "  Other: https://github.com/cli/cli#installation"
        return 1
    fi

    # Check if gh is authenticated
    if ! gh auth status &> /dev/null; then
        print_error "GitHub CLI is not authenticated. Please run 'gh auth login' first."
        return 1
    fi

    print_info "Checking current token scopes..."

    # Check if current token already has read:packages scope
    CURRENT_SCOPES=$(gh auth status --show-token 2>&1 | grep -i "token scopes" || echo "")

    if [[ "$CURRENT_SCOPES" == *"read:packages"* && "$FORCE_REFRESH" != "true" ]]; then
        print_info "✅ Current token already has read:packages scope"
        TOKEN=$(gh auth token)
    else
        if [[ "$FORCE_REFRESH" == "true" ]]; then
            print_info "🔄 Force refreshing token as requested..."
        else
            print_info "🔄 Current token missing read:packages scope, refreshing token..."
        fi
        # Generate a token with read:packages scope
        gh auth refresh --scopes "read:packages"
        TOKEN=$(gh auth token)
    fi

    if [ -z "$TOKEN" ]; then
        print_error "Failed to generate GitHub token"
        return 1
    fi

    print_info "Setting NODE_AUTH_TOKEN environment variable..."

    # Set environment variable for current session
    export NODE_AUTH_TOKEN="$TOKEN"

    print_info "Configuring npm for GitHub Packages (project-local)..."

    # Configure npm to use GitHub Packages registry for @microsoft scope (project-local)
    # This creates a .npmrc file in the current directory
    npm config set "@microsoft:registry" "https://npm.pkg.github.com/" --location=project
    npm config set "//npm.pkg.github.com/:_authToken" "\${NODE_AUTH_TOKEN}" --location=project

    # Track where the profile was updated for later use
    PROFILE_UPDATED_PATH=""

    # Add to shell profile for persistence if requested
    if [[ "$SKIP_PROFILE" == "true" ]]; then
        print_info "Skipping shell profile update (--no flag provided)"
    elif [[ "$NON_INTERACTIVE" == "true" ]]; then
        update_profile_with_token "$TOKEN"
    else
        read -p "Do you want to add NODE_AUTH_TOKEN to your shell profile? (Y/n): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Nn]$ ]]; then
            update_profile_with_token "$TOKEN"
        fi
    fi

    print_info "npm authentication configured successfully!"
    print_info "You can now install private packages with: npm install @microsoft/rayfin-core"

    # If Docker is installed, log in to GitHub Container Registry (ghcr.io)
    echo
    print_info "Checking for Docker to configure GHCR (ghcr.io) login..."

    if ! command -v docker >/dev/null 2>&1; then
        print_warning "Docker CLI (docker) is not installed. Skipping GHCR login."
        echo "  You can install Docker later to enable container image pulls:"
        echo "  macOS: https://docs.docker.com/desktop/install/mac-install/"
        echo "  Linux: https://docs.docker.com/engine/install/"
        echo "  Windows (WSL2): https://docs.docker.com/desktop/install/windows-install/"
    else
        # Determine GitHub username for docker login
        GH_USER=$(gh api user -q .login 2>/dev/null | tr -d '\r')
        if [[ -z "$GH_USER" ]]; then
            print_warning "Could not determine GitHub username. Skipping GHCR login."
            echo "  You can manually login to GHCR later with:"
            echo "    gh auth token | docker login ghcr.io -u <GITHUB_USERNAME> --password-stdin"
            echo "    echo <PAT> | docker login ghcr.io -u <GITHUB_USERNAME> --password-stdin  # PAT must have read:packages"
        else
            print_info "Logging in to ghcr.io as '$GH_USER'..."
            # Pipe the token via stdin to avoid exposing it in args/history
            if ! DOCKER_LOGIN_OUTPUT=$(echo "$TOKEN" | docker login ghcr.io -u "$GH_USER" --password-stdin 2>&1); then
                print_warning "GHCR docker login failed: $DOCKER_LOGIN_OUTPUT"
                echo "  You can try logging in manually later with:"
                echo "    gh auth token | docker login ghcr.io -u $GH_USER --password-stdin"
            else
                print_info "✅ GHCR login succeeded."
            fi
        fi
    fi

    # Display current npm configuration
    echo
    print_info "Current npm configuration:"
    NPM_CONFIG_OUTPUT=$(npm config list | grep -E "(registry|_authToken)" || echo "")
    if [[ -n "$NPM_CONFIG_OUTPUT" ]]; then
        echo "$NPM_CONFIG_OUTPUT" | while IFS= read -r line; do
            if [[ -n "$line" ]]; then
                echo "  $line"
            fi
        done
    fi

    echo
    print_info "Environment variable set:"
    echo "NODE_AUTH_TOKEN=${NODE_AUTH_TOKEN:0:8}..."

    echo
    print_info "Testing authentication by querying a private package..."

    # Test authentication by trying to view a private package
    NPM_OUTPUT=$(npm view "@microsoft/rayfin-cli" 2>&1 || true)
    NPM_EXIT_CODE=$?

    if [[ $NPM_EXIT_CODE -eq 0 ]] &&
       [[ ! "$NPM_OUTPUT" =~ "404 Not Found" ]] &&
       [[ ! "$NPM_OUTPUT" =~ "403 Forbidden" ]] &&
       [[ ! "$NPM_OUTPUT" =~ "E404" ]] &&
       [[ ! "$NPM_OUTPUT" =~ "E403" ]] &&
       [[ -n "$(echo "$NPM_OUTPUT" | tr -d '[:space:]')" ]]; then
        print_info "✅ Authentication test successful! Private package access confirmed."
    else
        print_warning "⚠️  Authentication test failed. This could mean:"
        echo "  - The package @microsoft/rayfin-cli doesn't exist in GitHub Packages"
        echo "  - You don't have read access to the package"
        echo "  - There's a configuration issue"
        if [[ -n "$PROFILE_UPDATED_PATH" ]]; then
            echo "  - You may need to restart your terminal, or run 'source $PROFILE_UPDATED_PATH' for NODE_AUTH_TOKEN to be available"
        fi
        echo "  - Try manually: npm view @microsoft/rayfin-cli"
        if [[ -n "$NPM_OUTPUT" ]]; then
            TRUNCATED_OUTPUT="${NPM_OUTPUT:0:200}"
            if [[ ${#NPM_OUTPUT} -gt 200 ]]; then
                TRUNCATED_OUTPUT="${TRUNCATED_OUTPUT}..."
            fi
            echo "  - Response: $TRUNCATED_OUTPUT"
        fi
    fi

    # Provide instructions for sourcing the profile if it was updated
    if [[ "$IS_SOURCED" != "true" ]]; then
        echo
        if [[ -n "$PROFILE_UPDATED_PATH" ]]; then
            # Detect OS
            if [[ "$(uname)" == "Darwin" ]]; then
                OS_NAME="macOS"
            elif [[ "$(uname)" == "Linux" ]]; then
                OS_NAME="Linux"
            else
                OS_NAME="Unix"
            fi

            print_info "NODE_AUTH_TOKEN was added to $PROFILE_UPDATED_PATH"
            print_warning "Run 'source $PROFILE_UPDATED_PATH' for NODE_AUTH_TOKEN to be available in your current shell."
            print_info "On $OS_NAME, you can run: source $PROFILE_UPDATED_PATH"
        else
            print_warning "NODE_AUTH_TOKEN was set only for this script process."
            print_info "To set it in your current shell, source this script instead:"
            print_info "  source setup-npm-auth.sh"
        fi
    fi

    return 0
}

# Call main function with all arguments, and exit/return with its exit code
__main "$@"
exit_code=$?
if [[ "$IS_SOURCED" == "true" ]]; then
    return $exit_code
else
    exit $exit_code
fi
