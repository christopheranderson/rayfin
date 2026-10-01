# @microsoft/rayfin-storage Agent Instructions

This package provides the standalone storage SDK for blob operations (upload, download, list, delete) with typed folder access.

## Commands

Run these from `packages/typescript-sdk/storage/`:

```bash
# Build
rush build --to @microsoft/rayfin-storage

# Test
rushx test              # Unit tests
rushx test:watch        # Watch mode
rushx test:integration  # Integration tests (requires host services)

# Lint
rushx lint
```

## Architecture

- **Entrypoint**: `createStorageClient` returns a proxy mapping schema keys to folder clients.
- **Clients**: Folder clients enforce strongly typed metadata from the schema.
- **Network**: Uses shared `ApiClient` (`@microsoft/rayfin-lib`) for retries, auth, and error shaping.
- **Errors**: Unified via `StorageErrorCode` literals and `isStorageError` guard.

## Implementation Rules

- **Schema Alignment**: Keep folder names and schema keys aligned; proxy maps properties directly to service folders.
- **Composition**: Prefer composing small helpers around folder clients over subclassing (clients are regenerated on access).
- **Data Shapes**: Extend `StorageObjectRef` in schema to support multiple data shapes per folder.
- **Options**: Use options objects for prefixes, content types, and signals; do not mutate headers manually.
- **Exports**: Align public exports with `src/index.ts`.
- **Error Codes**: Document new codes in `storageErrorCodes.ts`.

## Testing Strategy

- **Unit**: `src/__tests__/StorageClient.test.ts` uses mocked `ApiClient` to validate request shaping.
- **Integration**: `src/__tests__/integration` runs against the host web service.

### Integration Test Workflow

1. **Prerequisites**: Docker Desktop running (for SQL/Azurite).
2. **Infrastructure**: Run `pwsh -File developer-setup.ps1 start` from `packages/host`.
3. **Service**: Run `dotnet run` in `packages/host/Microsoft.Rayfin.WebService`.
4. **Run**: Execute `rushx test:integration` from this package.
5. **Troubleshoot**: If containers are unhealthy, run `pwsh -File developer-setup.ps1 clean` then `start`.
