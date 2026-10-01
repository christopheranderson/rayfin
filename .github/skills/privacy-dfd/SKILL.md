---
name: privacy-dfd
description: 'Create or update Microsoft privacy compliance Data Flow Diagrams (DFDs) and data inventory tables for services. Use when: privacy review, data flow diagram, DFD, data inventory, GDPR, data classification, privacy compliance, 1CS privacy artifact, data handling attestation.'
argument-hint: 'Describe the service or component to diagram, or ask to update an existing DFD/inventory.'
---

# Privacy DFD and Data Inventory

Produce Microsoft privacy compliance artifacts — a **Mermaid Data Flow Diagram (DFD)** and a **Markdown data inventory table** — for a service or system under privacy review.

## When to Use

- Creating a new privacy DFD for a service
- Updating an existing DFD after architecture changes
- Building a data inventory table for privacy review
- Preparing 1CS privacy review artifacts
- Answering privacy review key questions (Who, What, Where, When, Why, How, AI/ML)
- Classifying data elements with Microsoft taxonomy

## Outputs

1. **Mermaid DFD** (`.mmd` file) — a single `flowchart LR` showing all privacy-relevant data flows
2. **Data Inventory Table** (`.md` file) — a Markdown table listing every data element the service collects, processes, stores, or transmits

## Procedure

### Step 1: Gather Context

Before diagramming, collect evidence from code and docs. Identify:

- **Personas**: Who interacts with the system? (Builders, App Users, Admins, platform services)
- **Data stores**: Databases, caches, blob storage, telemetry sinks
- **External dependencies**: Platform shared services, identity providers, CDNs, gateways
- **Data flows**: What data moves between components, in what direction, with what classification?
- **Auth flows**: Token issuance, refresh, validation, session management
- **Telemetry**: What events are emitted, where do they go, what properties do they carry?

Evidence sources to check:

- Architecture docs and RFCs
- Controller and API endpoint code
- Auth/identity modules
- Database models and schema definitions
- Telemetry/logging configuration
- CLI and extension code (for developer tool telemetry)
- UX extension code (for portal interactions)

### Step 2: Classify Data Elements

Apply [Microsoft data classifications](./references/classifications.md) to every data element. Use the official taxonomy — do not invent classifications.

Key rules:

- If classification is uncertain, include the element but mark as `Requires confirmation` in Comments
- A single data element can have multiple classifications (e.g., a JWT may be EUPI + Access Control Data)
- Distinguish between data at rest (>= 48 hrs) and data in transit/processing (< 48 hrs)
- Identify the [data subject](./references/data-subjects.md) for each personal data element

### Step 3: Build the DFD

Create a **single** `flowchart LR` Mermaid diagram. Follow the [DFD conventions](./references/dfd-conventions.md).

Key requirements:

- Use subgraphs to group related components (e.g., "Platform Shared Services", "Workload Boundary", "Runtime Integrations")
- Label every edge with: data classification(s) and sample reference numbers cross-referencing the inventory table (e.g., `Sample #1, #3`)
- Show external clients, platform shared services, the service boundary, dependent Azure services, and data stores
- Include telemetry flows (where telemetry data goes, what classification)
- Mark direction-uncertain flows with a comment `%% direction uncertain`
- Include a title comment at the top with service name and date

### Step 4: Build the Data Inventory

Create a Markdown table with the [required columns](./references/inventory-columns.md).

Key requirements:

- Number each row with a `#` column that matches the DFD edge sample references
- Provide concrete sample data (realistic but fake values)
- Fill in all columns — use `N/A` variants from the legend when a column does not apply
- For GDPR DSR processing, specify the mechanism (agents, API call, manual, etc.)
- For retention, specify exact periods or policies
- For geo-boundary questions, state whether within or outside

### Step 5: Validate Completeness

Check the artifacts against the [privacy review key questions](./references/key-questions.md):

1. **Who** — Is every data subject identified? Are collection sources clear?
2. **What** — Is every data element classified? Are controls and mitigations noted?
3. **Where** — Are all storage locations identified with geo-boundary status?
4. **When** — Are retention periods specified for all persisted data?
5. **Why** — Is the purpose of each data collection clear?
6. **How** — Are notice/consent mechanisms documented? Is data usage clear?
7. **AI/ML** — Is AI usage explicitly stated (including "No AI" if applicable)?

Also verify:

- Every processing component in the DFD has both inbound and outbound arrows
- Every external data transfer has labeled data type plus classification
- The DFD sample reference numbers match the inventory row numbers
- No data flows are invented — all are evidenced from code or docs
- Uncertain flows are marked as such

### Step 6: Document Confidence

For each data flow or element, assess confidence:

- **High**: Directly evidenced in code with clear implementation
- **Medium**: Evidenced in architecture docs or partially implemented
- **Low**: Inferred from naming, comments, or design docs only

Mark anything uncertain with "Requires confirmation" in Comments.

## Constraints

- Do not invent data flows not evidenced in code or architecture docs
- Treat platform internals (Fabric, Azure services) as opaque external systems
- Do not create threat models — this is a privacy review, not a security review
- If the service has no AI/ML features, state that explicitly
- Use the prior analysis as a starting point but verify claims against source code
- Prefer completeness over minimalism — the output should be ready for export as a privacy review artifact

## References

- [Data Classifications](./references/classifications.md) — Microsoft Enterprise Data Taxonomy
- [Data Subjects](./references/data-subjects.md) — Data subject definitions
- [Inventory Columns](./references/inventory-columns.md) — Required columns and value options
- [DFD Conventions](./references/dfd-conventions.md) — Mermaid diagram shape and labeling rules
- [Key Questions](./references/key-questions.md) — Privacy review key questions and data lifecycle
- [Personal Data](./references/personal-data.md) — Which classifications constitute personal data
