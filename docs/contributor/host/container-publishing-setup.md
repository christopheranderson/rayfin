# Setting Up Rayfin Container Publishing

This guide explains how to set up and manage the container publishing workflow for the Rayfin WebService.

## Publishing Workflow

The WebService container is automatically published when the `@microsoft/rayfin-cli` package version changes. This ensures version alignment between the CLI tool and the WebService container it orchestrates.

### When Publishing Happens

The container is published in these scenarios:

1. **CLI Version Bump**: When a PR that bumps the CLI version in `packages/tools/cli/package.json` is merged to main
2. **Manual Override**: When the workflow is manually triggered with `force_publish=true` (for emergency hotfixes)

The container is **not** published when:
- Only host package files change without a CLI version bump
- Only tests or documentation are updated
- Infrastructure-only changes are made

### Container Tags

Published containers are tagged with:
- `latest`: Always points to the most recently published container
- `<version>`: CLI version number (e.g., `1.6.0`) for version-specific references

This dual-tagging strategy allows builders to use `latest` for normal development while enabling pinning to specific versions when needed.

## Prerequisites

- GitHub repository access with permission to manage Actions secrets
- Docker installed locally for testing

## Developer Image Source (GHCR — Default)

For development, pull the WebService image from GitHub Container Registry (GHCR).

If the repository is private, authenticate to GHCR using a GitHub personal access token with `read:packages`.

```bash
# Login to GHCR
# Replace <GITHUB_USERNAME> and <PAT> accordingly

echo <PAT> | docker login ghcr.io -u <GITHUB_USERNAME> --password-stdin

# Pull the developer image

docker pull ghcr.io/microsoft/project-rayfin/webservice:latest
```

## Testing the Workflow

### Testing Automatic Publishing (CLI Version Bump)

1. **Create a PR that bumps the CLI version**:
   - Follow the `bump-npm-version.md` workflow to update package versions
   - This will update `packages/tools/cli/package.json`

2. **Merge the PR to main**:
   - Once the PR is merged, the workflow will automatically trigger
   - Go to the Actions tab to monitor the build

3. **Verify the published container**:
   - Check that both `latest` and version-specific tags were created
   - Test the container:

   ```bash
   docker pull ghcr.io/microsoft/project-rayfin/webservice:latest

   # Run the container
   docker run -d -p 5000:80 \
     -e ConnectionStrings__DefaultConnection="Your_Connection_String" \
     ghcr.io/microsoft/project-rayfin/webservice:latest
   ```

### Testing Manual Publishing (Hotfix Override)

1. **Navigate to Actions**:
   - Go to the Actions tab in your GitHub repository
   - Select "Publish WebService Container" workflow

2. **Trigger manually**:
   - Click "Run workflow"
   - Check the "Force publish even if CLI version unchanged" box
   - Click "Run workflow" to confirm

3. **Monitor the build**:
   - The workflow will run regardless of version changes
   - Verify successful completion in the Actions tab

## Creating a Release

Container publishing is now tied to CLI version changes through the standard `bump-npm-version.md` workflow. When you bump versions:

1. **Follow the bump-npm-version.md workflow**:
   - Run `rush version --bump` to update package versions
   - Create and merge the version bump PR

2. **Automatic container publish**:
   - The WebService container is automatically published when the PR merges
   - Container is tagged with both `latest` and the new CLI version

## Troubleshooting

### Container Not Publishing

**Problem**: You made changes to host files but the container didn't publish.

**Solution**: The container only publishes when the CLI version changes. If you need to publish without a version bump, use manual workflow dispatch with `force_publish=true`.

### Version Not Detected

**Problem**: CLI version was bumped but workflow didn't detect the change.

**Solution**:
- Verify the change was to `packages/tools/cli/package.json`
- Check that the file was actually modified in the commit
- Review the workflow logs to see version comparison output
- Try manual dispatch with `force_publish=true` as a workaround

### Emergency Hotfix Publication

**Problem**: Critical WebService bug needs immediate fix but CLI version hasn't changed.

**Solution**:
1. Commit and merge the hotfix to main
2. Go to Actions → Publish WebService Container
3. Click "Run workflow" and check "Force publish"
4. The container will be republished with current tags

### Authentication failures

- **Authentication failures**:
  - For GHCR, ensure you used a PAT with `read:packages` and ran `docker login ghcr.io`.

- **Build failures**:
  - Check the Dockerfile for errors.
  - Ensure all dependencies are accessible during the build.

- **Push failures**:
  - Verify network connectivity to the registry.
  - Check permissions in the registry.

## Additional Resources

- [GitHub Actions documentation](https://docs.github.com/en/actions)
- [Docker documentation](https://docs.docker.com/)
