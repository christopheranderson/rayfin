# DFD Conventions — Mermaid Diagram Rules

## Diagram Type

Always use `flowchart LR` (left-to-right) for readability.

## Title Comment

Include a comment at the top with service name and date:

```mermaid
flowchart LR
  %% Data Flow Diagram for [Service Name] [Date]
```

## Node Shapes

Use these Mermaid shapes consistently:

| Shape | Syntax | Meaning | Example |
|---|---|---|---|
| Rectangle | `[Label]` | Processing component / service | `GQL["GraphQL Workload"]` |
| Database | `[(Label)]` | Data store | `CDB[("Cosmos DB")]` |
| Rounded | `([Label])` | External system / platform dependency | `AAD(["Azure AD"])` |
| Hexagon | `{{Label}}` | Identity / auth system | `KV{{"Key Vault"}}` |
| Asymmetric | `>Label]` | User / persona | `DEV>"Builder"]` |
| Double bracket | `[[Label]]` | Service within a subgraph | `FE[["Frontend"]]` |

## Subgraphs

Group related components into subgraphs:

```mermaid
subgraph BOUNDARY["Service Boundary"]
  AUTH["Auth Module"]
  DATA["Data Module"]
end
```

Common subgraph categories:

- **External Clients** — user personas and client applications
- **Platform Shared Services** — Fabric platform, AAD, shared infrastructure
- **Service Boundary** — the service under review (the privacy scope)
- **Runtime Integrations** — dependent Azure services (Cosmos, Key Vault, ACS, etc.)
- **Telemetry Boundary** — telemetry pipeline and sinks

## Edge Labels

Every edge **must** include:

1. **Data classification(s)** in the label text
2. **Sample reference numbers** matching inventory table rows (e.g., `Sample #1, #3`)

Format:

```mermaid
A -->|"Data description\nClassification(s)\nSample #N, #M"| B
```

Example:

```mermaid
AUTH -->|"email, password hash\nEUII, EUPI\nSample #1, #2"| CDB
```

## Direction Arrows

- Use `-->` for one-way flows
- Use `<-->` for bidirectional flows
- Add `%% direction uncertain` as a comment for flows where direction is not confirmed

## Readability

- Keep the diagram to one page/screen when rendered
- Use short but descriptive node IDs (e.g., `AUTH`, `CDB`, `APIM`)
- Use `<br/>` for line breaks in node labels
- Limit subgraph nesting to 2 levels maximum
- Aim for the level of detail in the example DFDs — not more
