# Secret Management PoC Proposal

## Why

Rayfin needs a minimal, end-to-end secret management proof of concept so builders can store secrets securely and consume them during function invocation without waiting for the full production architecture.
This PoC validates the core control-plane and runtime flow now, while intentionally deferring rotation and TIPS-based provisioning complexity.

## What Changes

- Add minimal Cosmos-backed secret records in the existing storage model for `WorkspaceKeyVault`, `DekMetadata`, and `Secret`.
- Use one shared test Azure Key Vault for all PoC workspaces and projects.
- Add a simple management REST endpoint to create or update secrets from plaintext input.
- Add a runtime invocation flow that decrypts required secrets and injects plaintext values into the HTTP body sent to function execution.
- Exclude KEK and DEK rotation behavior from PoC implementation.
- Exclude TIPS-based Key Vault pool creation and expansion from PoC implementation.

## Capabilities

### New Capabilities

- `secret-management-poc`: Provide an end-to-end PoC for encrypted secret storage, management API write flow, and runtime plaintext injection for function invocations.

### Modified Capabilities

- None.

## Impact

- Affected systems: workload secret management workflow, Cosmos persistence layer, and function invocation pipeline.
- Affected APIs: new PoC management endpoint for secret create or update and internal invocation enrichment path.
- Dependencies: Azure Key Vault cryptography client usage for wrap and unwrap operations, and AES-256-GCM encryption utilities.
- Operational scope: single-region and single-vault test configuration only, with no production rotation or pool orchestration behavior.
