# Storage Configuration Overview

This document describes the Rayfin declarative storage system introduced across Features 177 and 178.

## Goals

Provide a code first decorator driven way to declare logical storage folders and apply them to a backing provider in a deterministic idempotent workflow.

Enable local development with Azurite and future production usage with Onelake behind a stable abstraction.

## Feature Summary

- Feature 177 added TypeScript decorators and CLI generation for storage configuration (now updated to `rayfin dev storage apply --gen-config-only`).
- Feature 178b added backend persistence tables, provider abstraction, service validation pipeline, API endpoint, and functional CLI apply (`rayfin dev storage apply`).

## High Level Flow

1. Author decorated classes under `rayfin/storage` (e.g. `@blob` + `@role`).
2. Run `rayfin dev storage apply --gen-config-only` to produce `rayfin/.temp/storage-config.json`.
3. Run `rayfin dev storage apply` (local) to POST config to `/api/applystorageconfig`.
4. Service validates structure, semantics, conflicts, then creates provider containers and persists metadata rows.
5. CLI outputs a summary with created updated unchanged skipped warnings plus a correlation id.

## CLI Commands

```bash
# Generate storage configuration JSON
rayfin dev storage apply --gen-config-only

# Apply to local development server
rayfin dev storage apply

# Apply with force (reconcile visibility / permissions changes)
rayfin dev storage apply --force
```

## Generated Configuration Structure

```json
{
  "folders": {
    "AlbumFolder": {
      "path": "AlbumFolder",
      "visibility": "private",
      "permissions": [
        {
          "role": "authenticated",
          "actions": [{ "action": "*" }]
        }
      ]
    }
  }
}
```

Each folder key must match its `path` (v1 constraint).

Visibility defaults to `private` (future: `public`).

Permissions array is stored raw and interpreted in a future feature (RLS / policy enforcement in Feature 180).

## Backend Endpoint

`POST /api/applystorageconfig?force=true|false`

Headers:

- `Content-Type: application/json`
- Optional `X-Correlation-ID` (else generated and echoed back)

Body: storage configuration JSON as above.

### Success Response (shape excerpt)

```json
{
  "success": true,
  "createdFolders": [
    { "name": "albumfolder", "path": "AlbumFolder", "status": "created" }
  ],
  "updatedFolders": [],
  "unchangedFolders": [],
  "skippedFolders": [],
  "warnings": [],
  "elapsedMs": 123,
  "correlationId": "..."
}
```

### Failure Response (example)

```json
{
  "success": false,
  "error": "ValidationFailed",
  "message": "Folder key 'Album Folder' invalid.",
  "warnings": ["Container 'foo' may be partially created."],
  "correlationId": "..."
}
```

## Validation Pipeline

1. Structural: presence of `folders`, key pattern, path required, key equals path, max folder count.
2. Semantic: case insensitive duplicate detection, provider naming rules (lowercase container normalization constraints), visibility value.
3. Conflict analysis: metadata differences (visibility or permissions) vs existing records → requires `--force` else reported as skipped.
4. Change set execution: provider first creation, then DB persistence inside EF execution strategy.

## Force Semantics

Without force conflicting existing folders are reported in `skippedFolders` with reason `conflict (needs force)`.

With force visibility and permissions differences are updated in place (no deletion in v1).

## Provider Abstraction

`IStorageProvider` currently supports:

- Azurite (local development) via blob container creation.
- Onelake stub (placeholder for future implementation).

Configuration section example:

```json
{
  "Storage": {
    "Provider": "Azurite",
    "Azurite": {
      "Endpoint": "http://127.0.0.1:10000/devstoreaccount1",
      "AccountName": "devstoreaccount1",
      "AccountKey": "<key>"
    }
  }
}
```

Provider selection occurs at startup; unsupported value throws during service initialization.

## Upload Size Limit Configuration

Uploads to object endpoints enforce a maximum byte size.

The limit is configured via configuration key `storage.maxUploadBytes` (lowercase) or `Storage:MaxUploadBytes` (hierarchical) for flexibility.

If the key is missing or non positive the service falls back to a default of 20 MiB.

If the configured value exceeds 1 GiB it is clamped to 1 GiB and a warning is logged.

The effective value is logged at debug level.

### Sample `appsettings.json`

```json
{
  "storage.maxUploadBytes": 52428800
}
```

### Environment Variable Example

```bash
export storage__maxUploadBytes=52428800
```

Underscore section separators map to colon in .NET configuration binding.

### Runtime Behavior

- Request with `Content-Length` above the limit is rejected before streaming begins (HTTP 413, code `TooLarge`).
- Input is buffered with a bounded memory threshold and spills to a temporary file for larger uploads.
- Mid stream enforcement rejects input when cumulative bytes exceed the limit, before changing object bytes or metadata (HTTP 413, code `TooLarge`).
- The error payload includes the max limit so clients can surface feedback.

### Object upload constraints

The OSS object endpoint, `PUT /storage/{folder}/{file}`, reads the persisted folder configuration before accepting an upload.

`allowedContentTypes` is an allowlist of MIME types, `type/*` patterns, or `*/*`.
Matching is case-insensitive and ignores valid media-type parameters, such as `charset=utf-8`.
An omitted `Content-Type` is treated as `application/octet-stream`.
An omitted or empty allowlist permits any content type.
With a nonempty allowlist, malformed headers, request-side wildcards, and nonmatching types return HTTP 400 with code `UnsupportedContentType`, without changing bytes or metadata.
This checks the declared content type, not the file contents.

`onConflict: "error"` returns HTTP 409 with code `Conflict` for an existing object path and leaves the object untouched.
`onConflict: "overwrite"` replaces bytes while retaining the metadata row's identity and owner.
Replacement requires the existing owner and a matching caller role with `update` or `*`; otherwise it returns HTTP 403 with code `PermissionDenied`.
Both successful creates and replacements return HTTP 201.

The upload reserves the unique metadata path within a database transaction before writing bytes.
Existing metadata is write-locked before its replacement timestamp is assigned, so concurrent overwrites keep the final blob and metadata ordering consistent.
An overwrite keeps a temporary provider-side backup until the replacement completes.
Provider failures restore the previous bytes before rolling back metadata.
Request cancellation remains compensatable until provider work finishes; database commit then uses a bounded internal token instead of the canceled request token.
If restoration fails or the database commit outcome is unknown, the request fails and the backup is retained and logged for recovery rather than deleted.
Commit-ambiguity exceptions are excluded from the database execution strategy's retries so external provider writes are never replayed.

`StorageIntegrationTests` provides opt-in PostgreSQL and Azurite coverage through `RAYFIN_STORAGE_TEST_POSTGRES_CONNECTION_STRING` and `RAYFIN_STORAGE_TEST_AZURITE_CONNECTION_STRING`.
It verifies successful and concurrent overwrites, conflict and permission behavior, uniqueness races, provider failure compensation, cancellation compensation, and retained backups after an unknown commit outcome.

## Logging Events

The storage service emits structured logs with scopes: `Action`, `Folder`, `File`, `Prefix`, `CorrelationId`.

Event identifiers are centralized for correlation and filtering.

| EventId | Name                   | Description                                         |
| ------- | ---------------------- | --------------------------------------------------- |
| 6000    | ConfigurationLoaded    | Effective upload size limit loaded.                 |
| 6001    | ConfigurationFallback  | Invalid or missing limit, default applied.          |
| 6002    | ConfigurationClamped   | Limit exceeded hard cap and was clamped.            |
| 6100    | UploadStart            | Upload initiated.                                   |
| 6101    | UploadTooLarge         | Upload rejected or aborted due to size.             |
| 6102    | UploadCanceled         | Client canceled upload.                             |
| 6103    | UploadStreamFailure    | Unexpected streaming failure; compensation cleanup. |
| 6104    | UploadConflict         | Uniqueness conflict during metadata persist.        |
| 6105    | MetadataPersistFailure | Metadata save failed; compensation executed.        |
| 6106    | UploadSuccess          | Upload completed successfully.                      |
| 6200    | InvalidFolder          | Folder name not declared.                           |
| 6201    | NotFound               | Object metadata not found.                          |
| 6202    | OrphanBlobMissing      | Blob missing for existing metadata row.             |
| 6300    | DeleteSuccess          | Delete completed (blob + metadata).                 |
| 6301    | DeleteMetadataFailure  | DB delete failed after blob removal.                |
| 6400    | InvalidContinuation    | Continuation token malformed.                       |
| 6401    | ListResult             | List call returned results.                         |

## Database Schema

Schema: `storage`.

Tables:

- `storage.folders`: logical folder metadata (Id, Name, Path, Visibility, CreatedBy, CreatedAt, PermissionsJson).
- `storage.objects`: placeholder for future object level features (not populated by 178b apply).

Path is indexed for lookup and uniqueness.

## Idempotency

Reapplying an unchanged configuration returns all folders under `unchangedFolders` with zero provider calls.

## Error Categories

- `ValidationFailed` → 400
- `ProviderError` → 502 (container creation failure)
- `Unexpected` → 500

## Correlation Id

Every response includes a `correlationId` enabling trace alignment across logs, CLI output, and future telemetry.

## CLI Output Summary

CLI prints created updated unchanged skipped counts, warnings list, correlation id, and total duration.

404 responses from older servers produce explicit upgrade guidance.

## Performance Considerations

Current implementation is synchronous and suitable for small bounded folder sets (default max 100).

Measured `elapsedMs` is returned for simple timing visibility.

## Roadmap (Future Work)

- Feature 180: Interpret `PermissionsJson` into RLS / policy constructs.
- Public visibility enforcement and pre signed URL flows.
- Onelake implementation (container / notebook semantics mapping).
- Deletion and rename operations with safe force semantics.
- Object level APIs (upload download listing) and caching headers.

## Usage Example End To End

```bash
# 1. Define decorated storage classes under rayfin/storage
# 2. Generate configuration
rayfin dev storage apply --gen-config-only
# 3. Apply locally
rayfin dev storage apply
```

## Troubleshooting

| Symptom                                | Cause                         | Action                                                |
| -------------------------------------- | ----------------------------- | ----------------------------------------------------- |
| 404 endpoint not found                 | Older webservice build        | Redeploy updated backend (Feature 178b required)      |
| ProviderError warning orphan container | Provider failure mid apply    | Manually delete orphan container or reapply after fix |
| Duplicate key validation failure       | Case variant of existing name | Choose a unique canonical name                        |

## Testing Summary

Unit tests cover validation paths, conflict detection, force update, provider failure, and mixed result sets.

CLI tests assert endpoint resolution, 404 guidance, and force flag behavior.

Integration tests verify idempotency, visibility update, and rollback warning semantics.

## Contributing Notes

Add new validation or change set logic by extending `StorageConfigurationService` maintaining phase ordering and immutability of the change analysis stage.

Update CLI apply parsing only when wire contract changes to avoid regressions for existing automation.

## Object API Error Codes

All object operations (`PUT/GET/DELETE /storage/{folder}/{file}` and `GET /storage/{folder}`) return a unified error envelope:

```jsonc
{
  "error": {
    "code": "<Code>",
    "message": "<HumanReadable>",
    "correlationId": "<GUID>",
  },
}
```

| Code                | HTTP | Description                                                     |
| ------------------- | ---- | --------------------------------------------------------------- |
| InvalidFolder       | 400  | Folder name not declared/applied.                               |
| InvalidName         | 400  | File name violates character/length rules.                      |
| InvalidPrefix       | 400  | Prefix path invalid (segment rules).                            |
| TooLarge            | 413  | Upload exceeds configured byte limit (limit echoed in message). |
| Conflict            | 409  | Object already exists (same folder/name/prefix).                |
| NotFound            | 404  | Object metadata (or blob) not found.                            |
| InvalidContinuation | 400  | Malformed or tampered continuation token.                       |
| Unexpected          | 500  | Unhandled server error.                                         |

### Sample Upload Success

```http
PUT /storage/albumcover/photo.png?prefix=2025/08 HTTP/1.1
X-Correlation-ID: 7f8c2c9f-9f6e-4c7d-8d4b-e5e9e5b4a111
Content-Type: application/octet-stream
Content-Length: 1234
```

```json
{
  "object": {
    "folder": "albumcover",
    "name": "photo.png",
    "prefix": "2025/08",
    "createdAt": "2025-08-08T12:34:56.789Z"
  },
  "correlationId": "7f8c2c9f-9f6e-4c7d-8d4b-e5e9e5b4a111"
}
```

### Sample Conflict

```json
{
  "error": {
    "code": "Conflict",
    "message": "Object already exists",
    "correlationId": "7f8c2c9f-9f6e-4c7d-8d4b-e5e9e5b4a111"
  }
}
```

### Deterministic Pagination

Continuation tokens are opaque (base64 of `ticks:guid` minus `=` padding). Clients must treat tokens as opaque strings and pass verbatim. A 400 `InvalidContinuation` is returned if the token cannot be decoded.

## Client SDK Usage Examples

This section shows how to use the TypeScript storage client added in Feature 179 for common scenarios.

### Creating A Storage Folder Client

The storage client factory is now **generic**, enabling compile-time safety for folder names and per-folder object metadata types.

```ts
import { ApiClient } from '@microsoft/rayfin-lib';
import {
  createStorageApi,
  type StorageError,
  type StorageObjectRef,
} from '@microsoft/rayfin-data';

// Base API client (configure baseUrl to your web service origin)
const api = new ApiClient({ baseUrl: 'http://localhost:5000' });

// Define a typed folder schema mapping folder names to the object metadata shape you expect back.
// You can use the default StorageObjectRef or extend it with additional server-enriched fields.
type MyStorageSchema = {
  albumcover: StorageObjectRef; // default shape
  avatars: StorageObjectRef & { size: number; contentType: string }; // custom enriched shape
};

// Create a typed storage client. Folder names are now type-safe (typos become compile errors).
const storage = createStorageApi<MyStorageSchema>(api);

// Access folder clients directly as properties with full IntelliSense & typed results.
const photos = storage.albumcover;
const avatars = storage.avatars;

// photos.upload returns Promise<StorageUploadResult<StorageObjectRef>>
// avatars.list returns Promise<StorageListResult<StorageObjectRef & { size: number; contentType: string }>>

// Attempting to access a non-declared folder causes a TypeScript error:
// storage.typo; // ❌ Property 'typo' does not exist in type 'MyStorageSchema'
```

The `StorageApi<TSchema>` class provides a typed entry point that mirrors the `DataApi<TSchema>` pattern.
It exposes folder clients as direct properties.
You can use it directly with `ApiClient` or attach it to `RayfinClient` via `@microsoft/rayfin-client/experimental`.

```ts
import { ApiClient } from '@microsoft/rayfin-lib';
import {
  createStorageClient,
  type StorageObjectRef,
} from '@microsoft/rayfin-storage';

type StorageSchema = {
  albumcover: StorageObjectRef;
  avatars: StorageObjectRef & { size: number; contentType: string };
};

const api = new ApiClient({ baseUrl: 'http://localhost:5000' });
const storage = createStorageClient<StorageSchema>(api);
const uploaded = await storage.albumcover.upload(
  'pic.png',
  new Uint8Array([1, 2, 3])
);
```

### Integrating With RayfinClient Through Experimental Extensions

The base `RayfinClient` focuses on auth and data.
To expose `client.storage`, compose the storage service with `ExtendableRayfinClient`.

```ts
import { RayfinClient } from '@microsoft/rayfin-client';
import {
  ExtendableRayfinClient,
  type ServicePluginClass,
} from '@microsoft/rayfin-client/experimental';
import type { Todo } from '../rayfin/data/Todo';
import type { Project } from '../rayfin/data/Project';
import {
  createStorageClient,
  type StorageObjectRef,
  type TypedStorageFolderClients,
} from '@microsoft/rayfin-storage';

type AppSchema = { Todo: Todo; Project: Project };
type StorageSchema = { albumcover: StorageObjectRef };

const client = ExtendableRayfinClient.create<
  AppSchema,
  { storage: TypedStorageFolderClients<StorageSchema> }
>(
  {
    baseUrl: 'http://localhost:5000',
    services: {
      storage:
        createStorageApi as unknown as ServicePluginClass<
          TypedStorageFolderClients<StorageSchema>
        >,
    }
  }
);

// Data usage
await client.data.Todo.select(['id', 'title']).execute();

// Storage usage (typed folder name)
await client.storage.albumcover.upload('cover.png', new Uint8Array([0x01]));
```

If you do not attach the storage plugin, storage APIs are not present on the base client.
Adding typed storage later is a non-breaking, compile-time enhancement.

> Tip: Start untyped during exploration, then introduce a schema type once folder names and object metadata are stable.

### Uploading A File (Streaming)

```ts
async function uploadExample(file: File) {
  const result = await photos.upload(
    file.name,
    file, // Blob streams under the hood
    { prefix: '2025/08', contentType: file.type }
  );
  console.log(
    'Uploaded object',
    result.object,
    'correlation',
    result.correlationId
  );
}
```

Each upload automatically sends or generates an `X-Correlation-ID` echoed by the server. You can override it:

```ts
await photos.upload('logo.png', someArrayBuffer, {
  correlationId: crypto.randomUUID(),
});
```

### Handling Conflicts And Other Errors

All failures throw a `StorageError` with `code`, `status`, and `correlationId`.

```ts
try {
  await photos.upload('logo.png', new Uint8Array([1, 2, 3]));
} catch (e) {
  const err = e as StorageError;
  if (err.code === 'Conflict') {
    console.warn(
      'Already exists. Retry with a different name.',
      err.correlationId
    );
  } else if (err.code === 'TooLarge') {
    console.error('File exceeds limit.', err.correlationId);
  } else {
    console.error(
      'Unexpected storage failure',
      err.code,
      err.status,
      err.correlationId
    );
  }
}
```

### Listing With Continuation

```ts
async function listAll(prefix?: string) {
  let page = await photos.list({ prefix, limit: 2 });
  for (const item of page.items) console.log(item.name);
  while (page.continuation) {
    page = await photos.list({
      prefix,
      continuation: page.continuation,
      limit: 2,
    });
    for (const item of page.items) console.log(item.name);
  }
}
```

Treat the continuation token as opaque.
Do not attempt to parse or mutate it.
A tampered token results in `InvalidContinuation` (400).

### Downloading (Streaming Read)

```ts
async function downloadToBlob(name: string) {
  const { stream } = await photos.download(name, { prefix: '2025/08' });
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const blob = new Blob(chunks, { type: 'application/octet-stream' });
  return blob;
}
```

### Deleting An Object

```ts
await photos.delete('old.png', { prefix: '2025/08' });
```

### Aborting An In Flight Upload

```ts
const controller = new AbortController();
const promise = photos.upload('big.bin', hugeReadableStream, {
  signal: controller.signal,
});
// Later (timeout or user action)
controller.abort();
try {
  await promise;
} catch (e) {
  if ((e as StorageError).code === 'Aborted') console.log('Upload canceled');
}
```

### Error Code Summary (Client Perspective)

| Code                | Typical Cause                           |
| ------------------- | --------------------------------------- |
| InvalidFolder       | Folder not declared/applied.            |
| InvalidName         | Filename validation failure.            |
| InvalidPrefix       | Prefix validation failure.              |
| TooLarge            | Exceeds configured max bytes.           |
| Conflict            | Object already exists.                  |
| NotFound            | Object absent or not owned.             |
| InvalidContinuation | Malformed continuation token.           |
| Aborted             | Local abort signal triggered.           |
| Unexpected          | Non mapped or network failure fallback. |

Use the `correlationId` in errors and successes to cross reference server logs.
