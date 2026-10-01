---
symbols: ['RayfinWebHost', 'WebServiceBuilder', 'WebServiceOptions']
---

# Microsoft.Rayfin.WebService

ASP.NET Core 8 web service host that exposes the GraphQL endpoint
generated from a Rayfin project's entity declarations.

## Quickstart (consuming as a NuGet package)

```csharp
using Microsoft.Rayfin.WebService;

var builder = RayfinWebHost.CreateBuilder(args);
builder.UseDataApiBuilderConfig("./config/dab-config.json");
builder.UseRayfinAuth(options =>
{
    options.Issuer = "https://login.microsoftonline.com/<tenant>";
    options.Audience = "<api-audience>";
});

var app = builder.Build();
await app.RunAsync();
```

## Configuration

The host reads configuration from:

1. `appsettings.json` (`Rayfin` section)
2. Environment variables (`RAYFIN_*` prefix)
3. `rayfin/.env` if running under the CLI's `rayfin up` workflow

Key settings:

- `Rayfin:DataApi:ConfigPath` — path to the generated DAB config.
- `Rayfin:Auth:Issuer` — OIDC issuer URL.
- `Rayfin:Auth:Audience` — JWT audience claim.
- `Rayfin:Storage:ConnectionString` — Azure Storage connection (for blob).

## Endpoints

After startup the host exposes:

- `GET /graphql` — GraphQL Playground (development only).
- `POST /graphql` — main GraphQL endpoint.
- `GET /health` — liveness probe (returns 200 OK).
- `GET /api/auth/*` — OIDC redirect/callback endpoints when
  `UseRayfinAuth` is configured.

## Local development with `rayfin up`

In a project scaffolded by `npm create rayfin@latest`, the host runs
automatically via:

```bash
rayfin up
```

This starts the WebService on `http://localhost:5000` with the
generated DAB config and the project's `rayfin/.env` configuration.
