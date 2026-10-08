# token-signing-infrastructure Specification

## Purpose

TBD - created by archiving change implement-remote-key-signing. Update Purpose after archive.

## Requirements

### Requirement: Provider-Agnostic Signing Interface

The `IKeyProvider` interface SHALL provide a `SignAsync()` method that encapsulates signing operations, allowing providers to implement remote (HSM) or local signing without exposing private key material.

**ID**: `SIGN-INTERFACE-001`

#### Scenario: Azure Key Vault provider signs remotely

- **WHEN** `SignAsync()` is called on `AzureKeyVaultKeyProvider`
- **THEN** the provider MUST call Azure Key Vault's `CryptographyClient.SignAsync()` API
- **AND** the private key MUST never leave the Key Vault HSM boundary
- **AND** the signature bytes MUST be returned to the caller

#### Scenario: Local file provider signs locally

- **WHEN** `SignAsync()` is called on `LocalFileKeyProvider`
- **THEN** the provider MUST sign using locally loaded key material
- **AND** the private key MUST remain in process memory only
- **AND** the signature bytes MUST be returned to the caller

#### Scenario: Algorithm mapping for Key Vault

- **WHEN** `SignAsync()` is called with algorithm `RS256`
- **THEN** the provider MUST map to `SignatureAlgorithm.RS256` for Key Vault
- **AND** when called with `ES256`, MUST map to `SignatureAlgorithm.ES256`
- **AND** unsupported algorithms MUST throw `NotSupportedException`

### Requirement: Key Cache Infrastructure

The system SHALL maintain a cache of public keys for token validation, supporting a retention ring of the last 2 key versions.

**ID**: `SIGN-CACHE-001`

#### Scenario: Cache stores JsonWebKey objects

- **WHEN** public keys are fetched from the key provider
- **THEN** the cache MUST store them as `JsonWebKey` objects
- **AND** keys MUST be indexed by `kid` (key identifier)
- **AND** the cache MUST support lookup by `kid`

#### Scenario: Key ring maintains active and previous keys

- **WHEN** the key cache is refreshed
- **THEN** the cache MUST retain the 2 most recent keys by `CreatedOn` date
- **AND** the key with the latest `CreatedOn` MUST be the active key
- **AND** the second-latest key MUST be the previous key for validation during rollover

#### Scenario: Unknown kid rejected without remote fetch

- **WHEN** a token has a `kid` not present in the local cache
- **THEN** the system MUST reject the token immediately
- **AND** the system MUST NOT query Key Vault on-demand (DoS prevention)
- **AND** the system MUST log a warning with the unknown `kid` value

### Requirement: Custom JWT Construction

The token generator SHALL construct JWTs manually to support remote signing via `IKeyProvider.SignAsync()`.

**ID**: `SIGN-JWT-001`

#### Scenario: JWT header and payload encoding

- **WHEN** generating a JWT
- **THEN** the system MUST build the header as JSON with `alg`, `kid`, and `typ` fields
- **AND** the system MUST build the payload as JSON with claims
- **AND** both MUST be Base64Url encoded per RFC 7515

#### Scenario: Digest computation for signing

- **WHEN** signing a JWT
- **THEN** the system MUST compute the digest of `base64url(header).base64url(payload)`
- **AND** for RS256/ES256, MUST use SHA-256
- **AND** for RS384/ES384, MUST use SHA-384
- **AND** for RS512/ES512, MUST use SHA-512

#### Scenario: JWT assembly with remote signature

- **WHEN** `IKeyProvider.SignAsync()` returns signature bytes
- **THEN** the system MUST Base64Url encode the signature
- **AND** the system MUST assemble the JWT as `header.payload.signature`
- **AND** the resulting JWT MUST be valid per RFC 7519

### Requirement: Azure Key Vault Key Provider

The `AzureKeyVaultKeyProvider` SHALL use Azure Key Vault keys for remote signing operations, with public keys cached locally.

**ID**: `SIGN-KEYVAULT-001`

#### Scenario: Key Vault client initialization

- **WHEN** `AzureKeyVaultKeyProvider` is initialized
- **THEN** the provider MUST create a `KeyClient` for key metadata operations
- **AND** the provider MUST NOT use `CertificateClient`
- **AND** the provider MUST support both DefaultAzureCredential and ManagedIdentity

#### Scenario: CryptographyClient for signing

- **WHEN** `SignAsync()` is called
- **THEN** the provider MUST obtain a `CryptographyClient` for the current key
- **AND** the provider MUST call `SignAsync()` on the `CryptographyClient`
- **AND** the provider MUST extract and return the signature from the result

#### Scenario: Public key retrieval from key versions

- **WHEN** `GetPublicKeysAsync()` is called
- **THEN** the provider MUST use `KeyClient.GetPropertiesOfKeyVersionsAsync()` to list versions
- **AND** the provider MUST select the 2 most recent versions by `CreatedOn`
- **AND** the provider MUST retrieve the public key portion as `JsonWebKey`

#### Scenario: Kid derived from key version

- **WHEN** generating the `kid` for a Key Vault key
- **THEN** the provider MUST derive `kid` from the Key Vault key version ID
- **AND** the `kid` MUST be consistent between signing and JWKS publication

### Requirement: Local File Key Provider Signing

The `LocalFileKeyProvider` SHALL implement `SignAsync()` using locally loaded key material for development environments.

**ID**: `SIGN-LOCAL-001`

#### Scenario: RSA key signing

- **WHEN** `SignAsync()` is called with an RSA key
- **THEN** the provider MUST use `RSA.SignHash()` with PKCS1 padding
- **AND** the provider MUST use the hash algorithm matching the JWT algorithm

#### Scenario: ECDSA key signing

- **WHEN** `SignAsync()` is called with an ECDSA key
- **THEN** the provider MUST use `ECDsa.SignHash()`
- **AND** the provider MUST use the hash algorithm matching the JWT algorithm

#### Scenario: Private key not exposed publicly

- **WHEN** using `LocalFileKeyProvider`
- **THEN** the private key retrieval MUST be internal/private to the provider
- **AND** external callers MUST only access signing via `SignAsync()`

### Requirement: Key Provider Configuration

The key provider configuration SHALL support key-based (not certificate-based) settings.

**ID**: `SIGN-CONFIG-001`

#### Scenario: Azure Key Vault configuration uses key name

- **WHEN** configuring `AzureKeyVaultKeyProvider`
- **THEN** the configuration MUST use `SigningKeyName` (not `SigningCertificateName`)
- **AND** the configuration MUST specify the Key Vault URI
- **AND** the configuration MUST specify the signing algorithm

#### Scenario: Service registration uses KeyClient

- **WHEN** registering key provider services via DI
- **THEN** the registration MUST create `KeyClient` for Azure Key Vault provider
- **AND** the registration MUST create `CryptographyClient` factory
- **AND** the registration MUST NOT create `CertificateClient`

### Requirement: Key Vault Permissions

The webservice identity SHALL have minimal Key Vault permissions for signing operations.

**ID**: `SIGN-PERMS-001`

#### Scenario: Required permissions for signing

- **WHEN** the webservice signs tokens
- **THEN** the identity MUST have `Key Sign` permission
- **AND** the identity MUST have `Key Get` permission for public key retrieval
- **AND** the identity MUST have `Key List` permission for version enumeration

#### Scenario: Certificate permissions not required

- **WHEN** configuring Key Vault access
- **THEN** the identity MUST NOT require `Certificate Get` permission
- **AND** the identity MUST NOT require `Certificate List` permission
- **AND** the identity MUST NOT have key export capabilities
