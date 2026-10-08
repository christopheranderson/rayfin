# Spec: Secret Management PoC

## Purpose

Define a single-feature proof of concept for Rayfin secret management that stores secrets encrypted in Cosmos DB, uses one test Azure Key Vault for DEK wrap and unwrap, exposes a minimal write API, and injects decrypted plaintext secrets into function invocation HTTP bodies.

## Requirements

### Requirement: PoC key management scope is single-vault and no-rotation

The system SHALL use a single configured Key Vault for all PoC workspaces and projects.
The system MUST keep KEK and DEK rotation behavior disabled for this PoC.
The system MUST NOT implement TIPS-based Key Vault provisioning or vault pool expansion in this PoC.

#### Scenario: Secret operations use the configured single Key Vault

- **WHEN** a DEK wrap or unwrap operation is executed
- **THEN** the operation targets the configured test Key Vault and does not invoke TIPS provisioning logic

Example value stored in the single PoC Key Vault and how it is used:

| Key Vault item | Example value (JSON) | PoC usage |
| --- | --- | --- |
| KEK key | `<KEK Key>` | Used by `WrapKey` and `UnwrapKey` operations to protect project DEKs |

### Requirement: Persist PoC secret records in Cosmos DB

The system SHALL persist secret-management PoC records in Cosmos DB using logical record types WorkspaceKeyVault, DekMetadata, and Secret.
The system SHALL store records by workspace and project identifiers so secret data is isolated per project context.
The system SHALL support extending the existing Project record with currentDekVersion and currentDekCreatedAt when secret infrastructure is initialized.

#### Scenario: First secret write initializes required records

- **WHEN** the first secret is written for a project
- **THEN** WorkspaceKeyVault, DekMetadata version 1, and Secret records are persisted with valid identifiers and timestamps

Example Cosmos table structure and values for this scenario:

| Logical table (`type`) | Partition key values (`tenantId`, `projectId`) | `id` example | Example fields and values (JSON) |
| --- | --- | --- | --- |
| `WorkspaceKeyVault` | `("ws-001", "_workspace")` | `workspace-keyvault` | `{"vaultUri":"https://rayfin-secrets-poc.vault.azure.net/","kekKeyName":"kek-ws-001","kekKeyVersion":"5f3a...","createdAt":"2026-06-03T20:10:00Z"}` |
| `DekMetadata` | `("ws-001", "app-123")` | `dek:app-123:v1` | `{"wrappedDek":"<base64>","algorithm":"RSA-OAEP-256","status":"active","kekKeyId":"https://rayfin-secrets-poc.vault.azure.net/keys/kek-ws-001/5f3a..."}` |
| `Secret` | `("ws-001", "app-123")` | `secret:app-123:OPENAI_API_KEY` | `{"name":"OPENAI_API_KEY","encryptedValue":"<base64>","iv":"<base64>","authTag":"<base64>","dekVersion":1}` |

### Requirement: Use encrypted secret fields only at rest

The system SHALL store only encrypted secret payload fields at rest, including encryptedValue, iv, authTag, and dekVersion.
The system MUST NOT persist plaintext secret values in any Cosmos document field.

#### Scenario: Secret record is stored without plaintext

- **WHEN** a secret is persisted
- **THEN** the Cosmos Secret document contains encrypted fields and contains no plaintext secret value

Example Cosmos `Secret` document shape and values for this scenario:

```json
{
  "id": "secret:app-123:OPENAI_API_KEY",
  "tenantId": "ws-001",
  "projectId": "app-123",
  "type": "Secret",
  "name": "OPENAI_API_KEY",
  "description": "Used for model calls",
  "encryptedValue": "QmFzZTY0Q2lwaGVydGV4dA==",
  "iv": "dTQ2M2Q4NTJmMzE2",
  "authTag": "YXV0aFRhZ0Jhc2U2NA==",
  "dekVersion": 1,
  "createdAt": "2026-06-03T20:15:00Z",
  "updatedAt": "2026-06-03T20:15:00Z"
}
```

Example .NET code to generate `encryptedValue`, `iv`, `authTag`, and `dekVersion` for storage:

```csharp
using System;
using System.Security.Cryptography;
using System.Text;

public static class SecretEncryptionExample
{
  public static object BuildSecretRecord(
    string workspaceId,
    string projectId,
    string secretName,
    string plaintextSecret,
    byte[] dek,
    int dekVersion)
  {
    // AAD binds ciphertext to tenant/project/name/version and prevents record swapping.
    var aad = Encoding.UTF8.GetBytes($"{workspaceId}:{projectId}:{secretName}:{dekVersion}");
    var plaintext = Encoding.UTF8.GetBytes(plaintextSecret);

    var iv = new byte[12];
    RandomNumberGenerator.Fill(iv);

    var ciphertext = new byte[plaintext.Length];
    var authTag = new byte[16];

    using var aesGcm = new AesGcm(dek, 16);
    aesGcm.Encrypt(iv, plaintext, ciphertext, authTag, aad);

    CryptographicOperations.ZeroMemory(plaintext);

    return new
    {
      id = $"secret:{projectId}:{secretName}",
      tenantId = workspaceId,
      projectId,
      type = "Secret",
      name = secretName,
      encryptedValue = Convert.ToBase64String(ciphertext),
      iv = Convert.ToBase64String(iv),
      authTag = Convert.ToBase64String(authTag),
      dekVersion,
      createdAt = DateTime.UtcNow,
      updatedAt = DateTime.UtcNow
    };
  }
}
```

Example input values for this code:

```csharp
var dek = RandomNumberGenerator.GetBytes(32); // AES-256 DEK (Will come from CosmosDB)
var record = SecretEncryptionExample.BuildSecretRecord(
  workspaceId: "ws-001",
  projectId: "app-123",
  secretName: "OPENAI_API_KEY",
  plaintextSecret: "sk-test-abc123",
  dek: dek,
  dekVersion: 1);
```

### Requirement: Provide a minimal secret management write endpoint

The system SHALL provide a REST endpoint that accepts plaintext secret input for create or update operations.
The endpoint request MUST include project context, secret name, and secret value.
The endpoint SHALL validate secret name format and reject invalid names.

#### Scenario: Create a new secret with plaintext input

- **WHEN** a caller sends a valid secret create request with plaintext value
- **THEN** the service encrypts the value, stores the secret record, and returns a success response

#### Scenario: Reject invalid secret names

- **WHEN** a caller submits a secret name outside allowed format constraints
- **THEN** the endpoint returns a validation error and does not persist a secret record

### Requirement: Never return plaintext from the management API

The management API MUST NOT return plaintext secret values in response payloads.
The management API SHALL return metadata-only responses such as secret name, description, and timestamps.

#### Scenario: Successful write response excludes secret value

- **WHEN** a secret create or update request succeeds
- **THEN** the response payload excludes plaintext and encrypted secret value fields

### Requirement: Encrypt secrets before persistence

The API workflow SHALL generate or load DekMetadata version 1 and perform AES-256-GCM encryption before storing secret data.
The API workflow SHALL persist ciphertext with iv and authTag and bind encryption context to workspace, project, secret name, and dekVersion.

#### Scenario: API write produces decryptable ciphertext record

- **WHEN** a secret is written through the API
- **THEN** the persisted record can be decrypted later by the runtime path using the stored dekVersion and encryption metadata

Example Cosmos records that must align for successful runtime decrypt:

| Logical table (`type`) | Key | Required aligned fields | Example values (JSON) |
| --- | --- | --- | --- |
| `DekMetadata` | `("ws-001", "app-123", "dek:app-123:v1")` | `status`, `wrappedDek`, `kekKeyId` | `{"status":"active","wrappedDek":"<base64>","kekKeyId":"https://rayfin-secrets-poc.vault.azure.net/keys/kek-ws-001/5f3a..."}` |
| `Secret` | `("ws-001", "app-123", "secret:app-123:OPENAI_API_KEY")` | `dekVersion`, `encryptedValue`, `iv`, `authTag` | `{"dekVersion":1,"encryptedValue":"<base64>","iv":"<base64>","authTag":"<base64>"}` |

### Requirement: Inject decrypted secrets into function invocation headers

The runtime invocation pipeline SHALL resolve required project secrets and decrypt them before function execution.
The runtime pipeline SHALL include decrypted secret key and value pairs as plaintext header values sent to the function invocation handler.
The team MAY revisit HTTP body-based delivery in a later iteration.
The team can utilize the `x-ms-rayfin-info` header for the PoC implementation. This can be used as part of the RayfinContext object.

#### Scenario: Invocation receives plaintext secret values in headers

- **WHEN** a function invocation is executed for a project with configured secrets
- **THEN** the function handler receives HTTP headers containing plaintext secret values for the required secret names

Example: Pulling secret values from headers

```typescript

/** Shape of the JSON inside the `x-ms-rayfin-info` header. */
export interface RayfinInfo {
    rayfinToken: string;
    publishableKey: string;
    rayFinEndpoint: string;
    rayfinSecrets: Record<string, string>;
}

```

```typescript

udf.func("helloRayfin",
    async (ctx: RayfinContext<AppSchema>): Promise<object> => {

        const api_key = ctx.getSecret("api_key");

        // USE API KEY

        // ...

        return {};
    },
);

```

### Requirement: Keep plaintext usage transient in runtime flow

The runtime SHALL use plaintext secrets only in-memory during invocation processing.
The runtime MUST NOT persist plaintext secrets to Cosmos, logs, or management API responses.

#### Scenario: Runtime enrichment does not persist plaintext

- **WHEN** invocation body enrichment with decrypted secrets completes
- **THEN** no plaintext secret value is written to persistent storage or structured logs

### Requirement: Runtime decryption uses PoC key model

The runtime SHALL decrypt using DekMetadata version 1 and the single configured Key Vault for DEK unwrap operations.
The runtime MUST NOT execute KEK or DEK rotation logic in this PoC flow.

#### Scenario: Runtime decrypt path excludes rotation behaviors

- **WHEN** runtime decrypts a secret for invocation
- **THEN** decryption succeeds using existing key metadata without attempting any rotation workflow
