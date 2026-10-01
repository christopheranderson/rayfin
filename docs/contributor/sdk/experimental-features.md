# Experimental Features

> [!WARNING]
> Builders and coding agents helping to build Rayfin Apps should ignore this doc. These features are not intended for public consumption.

## Feature Flags - CLI

> [!NOTE]
> This currently only impacts the CLI behaviors. How the runtime behaves is not yet defined and SDKs use experimental exports.

Feature flags enable features not yet intended for general consumption. There can be documented feature flags (for preview features) and undocumented feature flags (for internal/experimental features).

Feature Flags can be controled with an environment variable, `RAYFIN_FEATURE_FLAGS`. For example, `RAYFIN_FEATURE_FLAGS=storage` exposes storage commands while the storage CLI workflow is feature-gated.

Some features can be enabled via the rayfin.yml. For example, if your project sets `services.storage.enabled: true` in `rayfin/rayfin.yml`, the CLI shows storage commands automatically and you do not need the feature flag.

Feature Flags signals are "OR"'d - if any of them are true, it's enabled. For example, if storage is disabled in `rayfin/rayfin.yml`, set `RAYFIN_FEATURE_FLAGS=storage` in `rayfin/.env` or in your shell environment to make storage commands visible.

### Defined feature flags

|Feature|ENV Flag|rayfin.yml|
|-------|--------|----------|
|Storage|storage |storage   |

## Experimental Service Composition

Use the experimental entrypoint to compose additional services onto `RayfinClient`.

```typescript
import { RayfinClient } from '@microsoft/rayfin-client';
import {
  ExtendableRayfinClient,
  type ServicePluginClass,
} from '@microsoft/rayfin-client/experimental';
import {
  createStorageClient,
  type StorageObjectRef,
  type TypedStorageFolderClients,
} from '@microsoft/rayfin-storage';

type AppSchema = { Todo: { id: string; title: string } };
type AppStorageSchema = { Photos: StorageObjectRef };

const client = ExtendableRayfinClient.create<
  AppSchema,
  { storage: TypedStorageFolderClients<AppStorageSchema> }
>(
  {
    baseUrl: 'https://api.rayfin.io',
    services: {
      storage:
        createStorageClient<AppStorageSchema>,
    }
  }
);

await client.data.Todo.select(['id', 'title']).execute();
await client.storage.Photos.list({ prefix: 'user-123' });
```
