# .NET Aspire Evaluation for Rayfin Platform

**Date:** October 3, 2025
**Status:** Evaluation Phase
**Target:** Rayfin Host Services (`packages/host/*`)

---

## Executive Summary

.NET Aspire is Microsoft's **cloud-ready stack for building observable, production-ready distributed applications**. This evaluation assesses its applicability to the Rayfin Platform's .NET host services, considering both immediate benefits and long-term implications for a platform that **may deploy to third-party clouds beyond Azure**.

### Key Finding

.NET Aspire offers **significant value for local development orchestration and observability**, but requires **custom deployment engineering** for non-Azure production targets. The decision hinges on: **Are we willing to invest in custom publishers and integrations in exchange for superior developer experience and standardized observability?**

---

## What is .NET Aspire?

### Core Concept

Aspire is **not a framework**—it's an **opinionated stack** that provides:

1. **AppHost Orchestration Model**: Code-first definition of distributed app topology
2. **Service Discovery & Configuration**: Automatic wiring of connection strings, endpoints, and environment variables
3. **Observability by Default**: Baked-in OpenTelemetry for logs, traces, and metrics
4. **Developer Control Plane (DCP)**: Kubernetes-compatible local orchestration layer
5. **Publisher Model**: Extensible system to transform app model into deployment artifacts

### Architecture Overview

```text
┌─────────────────────────────────────────────────────────────┐
│  AppHost (Your Code)                                        │
│  └─ Define services, containers, databases, connections    │
└────────────────┬────────────────────────────────────────────┘
                 │
        ┌────────┴─────────┐
        │                  │
        ▼                  ▼
   Run Mode          Publish Mode
        │                  │
        ▼                  ▼
  ┌──────────┐      ┌──────────────┐
  │   DCP    │      │  Publishers  │
  │ (Local)  │      │  (Deployment)│
  └──────────┘      └──────────────┘
        │                  │
        ▼                  ▼
  Dev Dashboard      Docker Compose
  Redis Container    Kubernetes YAML
  SQL Container      Azure Bicep
  Your Services      Custom IaC
```

**Key Insight**: The same AppHost code serves both local development (via DCP) and deployment (via publishers).

---

## How Aspire Works: The Two Modes

### 1. Run Mode (Local Development)

**What Happens:**

- AppHost starts **Developer Control Plane (DCP)** (Kubernetes-compatible API server)
- DCP orchestrates containers, services, and executables locally
- **Aspire Dashboard** launches at `http://localhost:18888` with:
  - Live telemetry (logs, traces, metrics via OTLP)
  - Service topology visualization
  - Real-time health checks
- Services auto-discover each other via configuration injection

**Example AppHost Code:**

```csharp
var builder = DistributedApplication.CreateBuilder(args);

// Add resources
var postgres = builder.AddPostgres("postgres")
                     .AddDatabase("rayfindb");

var redis = builder.AddRedis("cache");

var api = builder.AddProject<Projects.Rayfin_WebService>("webservice")
                 .WithReference(postgres)
                 .WithReference(redis);

builder.Build().Run();
```

**What You Get:**

- Postgres container auto-starts
- Redis container auto-starts
- WebService gets `ConnectionStrings__rayfindb` and `ConnectionStrings__cache` injected
- All telemetry flows to dashboard
- One `dotnet run` orchestrates everything

### 2. Publish Mode (Deployment)

**What Happens:**

- AppHost transforms app model into **deployment artifacts** via **publishers**
- Built-in publishers: Docker Compose, Kubernetes, Azure (Bicep/ARM)
- **Custom publishers** can generate Terraform, Pulumi, Fly.io, Render, etc.
- Artifacts are **parameterized** (no secrets baked in)

**Example:**

```bash
# Generate Docker Compose files
aspire publish -o ./artifacts

# Generate Kubernetes manifests
aspire publish -o ./k8s-artifacts  # with Aspire.Hosting.Kubernetes

# Deploy to Azure Container Apps
aspire deploy  # with Aspire.Hosting.Azure.AppContainers
```

**Output for Docker Compose:**

```yaml
services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_PASSWORD: ${PG_PASSWORD}  # Parameterized!

  webservice:
    build: ./src/WebService
    environment:
      ConnectionStrings__rayfindb: "Host=postgres;Database=rayfindb;Username=postgres;Password=${PG_PASSWORD}"
    depends_on:
      - postgres
```

---

## Aspire's Value Propositions

### 1. ✅ Local Development Orchestration (High Value)

**Problem Solved:**

- **Before:** Developers manually start Postgres, Redis, SQL Server, Azurite, etc.
- **After:** One `dotnet run` starts everything with correct wiring

**Rayfin Context:**
Currently, Rayfin has:

- `docker-compose.developer.yml` for SQL Server + Azurite
- Manual configuration of connection strings
- No unified orchestration for DAB, Auth API, WebService

**Aspire Would Give:**

```csharp
var builder = DistributedApplication.CreateBuilder(args);

// Database
var sql = builder.AddSqlServer("sql")
                 .AddDatabase("rayfindb");

// Storage
var azurite = builder.AddAzureStorage("storage")
                     .RunAsEmulator()
                     .AddBlobs("uploads");

// Services
var webservice = builder.AddProject<Projects.Rayfin_WebService>("webservice")
                        .WithReference(sql)
                        .WithReference(azurite);

var dab = builder.AddContainer("dab", "mcr.microsoft.com/azure-databases/data-api-builder")
                 .WithReference(sql);

builder.Build().Run();
```

**Benefit:** New developers run AppHost → Everything works™

---

### 2. ✅ Observability by Default (High Value)

**What's Included:**

- **OpenTelemetry** configured automatically via `ServiceDefaults`
- **Aspire Dashboard** visualizes telemetry in real-time
- **No production overhead**—dashboard is dev-only

**Current Rayfin State:**
WebService already has OpenTelemetry configured manually in `Program.cs`:

```csharp
builder.Services.AddOpenTelemetry()
    .WithTracing(...)
    .WithMetrics(...)
    .WithLogging(...);
```

**Aspire Would Give:**

- **ServiceDefaults project** with standardized OTel config
- Reusable across all Rayfin services (WebService, Auth API, future microservices)
- **Aspire Dashboard** for dev-time visualization (no need for external Grafana/Jaeger)

**Example ServiceDefaults:**

```csharp
public static class Extensions
{
    public static IHostApplicationBuilder AddServiceDefaults(this IHostApplicationBuilder builder)
    {
        builder.Services.AddServiceDiscovery();

        builder.Services.AddOpenTelemetry()
            .WithTracing(tracing =>
            {
                tracing.AddAspNetCoreInstrumentation()
                       .AddHttpClientInstrumentation();
            })
            .WithMetrics(metrics =>
            {
                metrics.AddAspNetCoreInstrumentation()
                       .AddHttpClientInstrumentation()
                       .AddRuntimeInstrumentation();
            });

        builder.Logging.AddOpenTelemetry();

        return builder;
    }
}
```

**WebService would simplify to:**

```csharp
var builder = WebApplication.CreateBuilder(args);
builder.AddServiceDefaults();  // ✨ That's it!
```

---

### 3. ✅ Service Discovery (Medium-High Value)

**How It Works:**

- AppHost injects configuration for referenced services
- Services resolve endpoints via `http://service-name` (DNS-style)
- Works via **configuration-based endpoint resolver** (no magic)

**Rayfin Example:**

```csharp
// AppHost
var webservice = builder.AddProject<Projects.Rayfin_WebService>("webservice");
var authApi = builder.AddProject<Projects.Rayfin_Auth>("auth-api");

webservice.WithReference(authApi);  // WebService can now call Auth API

// In WebService code
builder.Services.AddHttpClient<IAuthClient>(client =>
{
    client.BaseAddress = new Uri("https+http://auth-api");  // Resolved automatically!
});
```

**Current State:**
Rayfin uses manual configuration for service URLs (e.g., `RayfinFunctionsOptions`)

---

### 4. ⚠️ Deployment (Mixed Value—Depends on Target)

#### Built-in Publishers

| Publisher | Status | Deploy Support | Notes |
|-----------|--------|----------------|-------|
| Docker Compose | ✅ Stable | ❌ No | Generate → Use with CI/CD |
| Kubernetes | ✅ Stable | ❌ No | Generate manifests → Apply with `kubectl` |
| Azure Container Apps | 🔬 Preview | ✅ Yes | Full `aspire deploy` support |
| Azure App Service | 🔬 Preview | ✅ Yes | Full `aspire deploy` support |

#### Custom Publishers

**Extensibility Model:**

- Implement `PublishingCallbackAnnotation` on resources
- Transform app model into **your IaC format** (Terraform, Pulumi, CloudFormation)
- Hook into `aspire publish` command

**Effort Required:**

- **Low complexity:** Docker Compose (already built-in)
- **Medium complexity:** Kubernetes (already built-in)
- **High complexity:** Terraform HCL generation, Pulumi SDK integration, Fly.io/Render custom formats

---

## Rayfin Platform: Fit Analysis

### Current Architecture

```text
Rayfin Host (packages/host)
├── Microsoft.Rayfin.WebService      (ASP.NET Core API)
├── Microsoft.Rayfin.Auth            (Auth library)
├── Microsoft.Rayfin.DataApi         (DAB wrapper)
└── Microsoft.Rayfin.Common          (Shared utilities)

External Dependencies:
- SQL Server (Azure SQL / Local)
- Azure Storage (Blob, ADLS Gen2, Azurite)
- Redis (future caching)
- DAB (Data API Builder container)
```

### Aspire Integration Scenarios

#### Scenario 1: Aspire for Local Dev Only

**What to Adopt:**

- Add `Rayfin.AppHost` project
- Add `Rayfin.ServiceDefaults` project
- Keep existing deployment (GitHub Actions + Azure Portal / Terraform)

**Changes Required:**

```text
packages/host/
├── Rayfin.AppHost/              # NEW: Orchestration
├── Rayfin.ServiceDefaults/      # NEW: Shared OTel config
├── Microsoft.Rayfin.WebService/
│   └── Program.cs               # CHANGE: builder.AddServiceDefaults()
├── Microsoft.Rayfin.Auth/
└── Microsoft.Rayfin.Common/
```

**Pros:**

- ✅ Zero deployment risk (existing CI/CD unchanged)
- ✅ Immediate dev experience improvement
- ✅ Aspire Dashboard for telemetry
- ✅ Easy onboarding for new developers

**Cons:**

- ⚠️ Dev environment diverges from production (AppHost vs. real deployment)
- ⚠️ No benefit for production observability

**Verdict:** **Low-risk, high-reward starting point**

---

#### Scenario 2: Aspire + Docker Compose Publisher

**What to Adopt:**

- AppHost + ServiceDefaults
- `aspire publish` → Docker Compose files
- Deploy Compose files to third-party clouds (Fly.io, Render, AWS ECS)

**CI/CD Flow:**

```bash
# GitHub Actions
aspire publish -o ./artifacts
docker compose -f ./artifacts/compose.yaml up -d
# OR push images + deploy to Fly.io/Render
```

**Pros:**

- ✅ Unified dev + prod artifact generation
- ✅ Docker Compose is universal (works on most clouds)
- ✅ Secrets managed via environment variables

**Cons:**

- ⚠️ Still need custom scripting for cloud-specific deployment
- ⚠️ Docker Compose isn't "infrastructure as code" (no state management)

**Verdict:** **Medium effort, good portability**

---

#### Scenario 3: Aspire + Custom Publisher (Full Adoption)

**What to Adopt:**

- AppHost + ServiceDefaults
- **Build custom publisher** for Terraform/Pulumi/Fly.io
- `aspire publish` → Your IaC format

**Example Custom Publisher:**

```csharp
// In Rayfin.Publishing library
public static class FlyIoPublisherExtensions
{
    public static IDistributedApplicationBuilder AddFlyIoPublisher(this IDistributedApplicationBuilder builder)
    {
        builder.AddComputeEnvironment("flyio")
               .WithProperties(env =>
               {
                   env.PublishingCallback = async (context, cancellationToken) =>
                   {
                       // Generate fly.toml files from app model
                       foreach (var resource in context.Resources)
                       {
                           var flyConfig = TransformToFlyConfig(resource);
                           await File.WriteAllTextAsync($"{resource.Name}.toml", flyConfig);
                       }
                   };
               });

        return builder;
    }
}
```

**Pros:**

- ✅ Unified dev + prod orchestration
- ✅ True infrastructure as code
- ✅ Type-safe resource definitions (C# vs. YAML/HCL)

**Cons:**

- ❌ High engineering effort (weeks to build publisher)
- ❌ Maintenance burden (keep up with Aspire API changes)
- ⚠️ Custom code = custom support burden

**Verdict:** **High effort, high reward—only if Rayfin scales to 10+ microservices**

---

## Decision Framework

### When to Adopt Aspire

✅ **Strong Signals:**

- Building **multiple microservices** (not just WebService)
- Local dev is painful (manual Docker Compose + connection strings)
- Team struggles with observability setup
- Need consistent telemetry across services
- Planning to scale beyond monolith

⚠️ **Weak Signals:**

- Single monolithic service (WebService only)
- Existing Docker Compose works fine
- No plans to add microservices
- Already have production observability (App Insights)
- Small team with limited engineering capacity

❌ **Anti-Patterns:**

- Adopting Aspire "just because"
- Expecting it to replace Kubernetes/Terraform without custom work
- Using it solely for Azure deployment (use `azd` instead)

---

## Rayfin-Specific Recommendations

### Phase 1: Pilot (Low Risk)

**Goal:** Validate Aspire for local dev with minimal disruption

**Action Items:**

1. Create `Rayfin.AppHost` project
   - Add SQL Server resource
   - Add Azurite resource
   - Add WebService project reference
2. Create `Rayfin.ServiceDefaults` project
   - Move OpenTelemetry config from WebService
   - Add service discovery (for future use)
3. Update `WebService/Program.cs`
   - Call `builder.AddServiceDefaults()`
   - Remove manual OTel config
4. Test locally with Aspire Dashboard

**Success Criteria:**

- New devs can `dotnet run` AppHost → Everything works
- Aspire Dashboard shows telemetry
- Zero changes to production deployment

**Effort:** 1-2 days
**Risk:** Very low (dev-only)

---

### Phase 2: Evaluate Deployment (Medium Risk)

**Goal:** Assess whether Aspire can replace/augment existing CI/CD

**Action Items:**

1. Install `Aspire.Hosting.Docker` NuGet package
2. Run `aspire publish -o ./artifacts`
3. Inspect generated Docker Compose files
4. Compare to current deployment process
5. Test deploying Compose files to Azure Container Instances (or Fly.io trial)

**Decision Point:**

- **IF** Docker Compose output is close to production needs → Proceed to Phase 3
- **IF** significant gaps exist → Keep Aspire dev-only (Phase 1)

**Effort:** 1-2 weeks
**Risk:** Medium (testing only, no production changes)

---

### Phase 3: Production Integration (High Risk)

**Goal:** Use Aspire publishers for production deployments

**Action Items:**

1. Build custom publisher (if needed) or use Docker Compose
2. Update GitHub Actions to use `aspire publish`
3. Migrate secrets management to Aspire external parameters
4. Deploy to staging environment
5. Monitor and iterate

**Success Criteria:**

- Single AppHost defines dev + prod topology
- CI/CD uses `aspire publish` output
- Secrets injected securely (Azure Key Vault, Doppler, etc.)

**Effort:** 4-6 weeks
**Risk:** High (production deployment changes)

---

## Comparison: Aspire vs. Alternatives

| Aspect | Aspire | Docker Compose | Kubernetes | Terraform |
|--------|--------|----------------|------------|-----------|
| **Local Dev** | ✅ Excellent | ✅ Good | ❌ Overkill | ❌ Not designed for dev |
| **Observability** | ✅ Built-in (OTel) | ❌ Manual | ⚠️ Via sidecars | ❌ N/A |
| **Service Discovery** | ✅ Automatic | ❌ Manual | ✅ Native | ❌ N/A |
| **Multi-Cloud** | ⚠️ Custom publishers | ✅ Universal | ✅ Universal | ✅ Universal |
| **Type Safety** | ✅ C# | ❌ YAML | ❌ YAML | ⚠️ HCL |
| **Learning Curve** | ⚠️ Medium | ✅ Low | ❌ High | ⚠️ Medium |
| **Maturity** | ⚠️ New (2024) | ✅ Mature | ✅ Mature | ✅ Mature |

---

## Risks and Mitigations

### Risk 1: Aspire is New (Launched 2024)

**Concern:** API changes, breaking updates, community adoption

**Mitigation:**

- Aspire is **officially supported** by Microsoft (.NET Foundation)
- Strong community (Community Toolkit with 50+ integrations)
- Start with dev-only (Phase 1)—easy to rollback

---

### Risk 2: Lock-in to Aspire Model

**Concern:** Hard to migrate away if Aspire doesn't work out

**Mitigation:**

- Aspire **doesn't own your code**—it's just orchestration
- ServiceDefaults is just OTel config (portable)
- Publishers generate standard artifacts (Docker Compose, K8s YAML)
- Worst case: Continue using generated artifacts without Aspire

---

### Risk 3: Custom Publisher Effort

**Concern:** Building custom publisher is complex and time-consuming

**Mitigation:**

- Phase 1 + 2 don't require custom publishers
- Docker Compose + Kubernetes publishers are built-in
- Only build custom publisher if scaling to 10+ services (high ROI)

---

## Cost-Benefit Analysis

### Scenario: Rayfin Remains Single Service (WebService Only)

**Benefits:**

- ✅ Better local dev (AppHost)
- ✅ Aspire Dashboard telemetry
- ⚠️ ServiceDefaults (marginal benefit—OTel already configured)

**Costs:**

- Setup: 2-3 days
- Maintenance: ~1 hour/quarter

**ROI:** **Low-Medium** (nice-to-have, not transformative)

---

### Scenario: Rayfin Adds 3-5 Microservices (Auth API, Jobs Service, Realtime API)

**Benefits:**

- ✅ Consistent OTel config across services (ServiceDefaults)
- ✅ Service discovery eliminates manual configuration
- ✅ AppHost orchestrates complex local environment
- ✅ Unified deployment artifacts (if using publishers)

**Costs:**

- Setup: 1-2 weeks (AppHost + ServiceDefaults + migration)
- Custom publisher (optional): 4-6 weeks
- Maintenance: ~2 hours/quarter

**ROI:** **High** (significant productivity gains)

---

1. **Approval to Proceed**: Stakeholder sign-off on Phase 1
2. **Proof of Concept**: Implement `Rayfin.AppHost` + `ServiceDefaults`
3. **Team Training**: 2-hour workshop on Aspire basics
4. **Documentation**: Update developer setup guide
5. **Iterate**: Monitor developer feedback, adjust as needed

---

## Appendix: Technical Details

### A. Aspire Dashboard Features

- **Structured Logs**: View logs from all services in one place
- **Distributed Traces**: Visualize request flows across services
- **Metrics**: Real-time graphs (HTTP requests, CPU, memory)
- **Console Logs**: See stdout/stderr from all containers
- **Environment Variables**: Inspect injected configuration

### B. ServiceDefaults Template

Aspire generates a ServiceDefaults project with:

- OpenTelemetry configuration (logs, traces, metrics)
- Service discovery setup
- Health check defaults
- HttpClient resilience (Polly retry policies)

### C. Hosting Integrations (Built-in)

- **Databases**: SQL Server, PostgreSQL, MySQL, MongoDB, Cosmos DB
- **Caching**: Redis, Valkey
- **Messaging**: RabbitMQ, Kafka, Azure Service Bus
- **Storage**: Azure Blob/Queue/Table (with Azurite emulator)
- **AI**: Ollama, Qdrant (vector DB)

### D. Community Toolkit (50+ Integrations)

See: <https://learn.microsoft.com/en-us/dotnet/aspire/community-toolkit/overview>xsx

Examples:

- Meilisearch (search engine)
- Dapr (sidecar patterns)
- Java/Spring Boot hosting
- Python hosting
- Rust hosting

---

## References

- [.NET Aspire Official Docs](https://learn.microsoft.com/en-us/dotnet/aspire/get-started/aspire-overview)
- [Aspire Architecture Overview](https://learn.microsoft.com/en-us/dotnet/aspire/architecture/overview)
- [Aspire Publishers (Preview)](https://learn.microsoft.com/en-us/dotnet/aspire/whats-new/dotnet-aspire-9.2#%F0%9F%9A%80-deployment-improvements)
- [Custom Hosting Integrations](https://learn.microsoft.com/en-us/dotnet/aspire/extensibility/custom-hosting-integration)
- [Aspire FAQ](https://learn.microsoft.com/en-us/dotnet/aspire/reference/aspire-faq)

---

**Document Version:** 1.1
**Last Updated:** October 3, 2025
**Owner:** Rayfin Platform Team
