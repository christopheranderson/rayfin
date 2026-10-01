# Storage Integration Tests

**What**: Tests storage operations against a real running web service
**Why Different**: Unlike unit tests, these test the full HTTP stack and server responses

## Prerequisites

The integration tests require a full development environment with:

- **Docker Desktop** running
- **SQL Server** database (for storage configuration)
- **Azurite** storage emulator (for blob operations)

## Quick Start

1. **Start infrastructure** (SQL Server + Azurite):

   ```bash
   cd packages/host
   pwsh -File developer-setup.ps1 start
   ```

2. **Start web service**:

   ```bash
   cd packages/host/Microsoft.Rayfin.WebService
   dotnet run
   ```

## What Gets Tested (All Passing ✅)

All 6 integration tests validate:

- ✅ Upload text files
- ✅ Upload binary files
- ✅ Download and verify file content
- ✅ List files in storage location with pagination
- ✅ Error handling for invalid uploads
- ✅ Error handling for non-existent file downloads

## Auto-Skip Behavior

Tests automatically skip if:

- Server not running
- `CI=true` environment
- `SKIP_INTEGRATION=true`

**Note**: Tests will timeout if Docker containers (SQL Server + Azurite) are not running. Use the infrastructure setup script first.

## Troubleshooting

### Tests timeout during setup

- **Cause**: Docker containers not running
- **Fix**: Run `pwsh -File packages/host/developer-setup.ps1 start`

### Connection refused errors

- **Cause**: Web service not started
- **Fix**: Start the web service with `dotnet run` in `packages/host/Microsoft.Rayfin.WebService`

### Database connection errors

- **Cause**: SQL Server container unhealthy
- **Fix**: Check container status with `docker ps`, restart with `pwsh -File developer-setup.ps1 clean && pwsh -File developer-setup.ps1 start`

## Custom Server URL

```bash
RAYFIN_TEST_URL=http://localhost:8080 npm run test:integration
```

## Related Documentation

- [Host Developer Setup](../../../host/README.md) - Infrastructure requirements
- [Docker Overview](../../../../../docs/contributor/host/docker_overview.md) - Container details
- [Storage Package README](../../../README.md) - API documentation
