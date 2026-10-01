# Personal Data Classifications

Quick reference for which data classifications constitute personal data under the Microsoft Enterprise Data Taxonomy.

## Personal Data

These classifications contain personal data and require GDPR DSR handling:

- **Customer Content** — Data provided by customers (content they create or control)
- **End User Identifiable Information (EUII)** — Data that directly identifies authenticated users
- **End User Pseudonymous Identifiers (EUPI)** — Microsoft-created identifiers tied to users
- **Support Data** — Data provided during support engagements
- **Feedback Data** — Reviews or feedback containing personal data
- **Account Data** — Billing, payment, and license information
- **Public Personal Data** — Publicly available personal information

## Non-Personal Data

These classifications do not constitute personal data:

- **Access Control Data** — Secrets and keys for access management
- **Organization Identifiable Information (OII)** — Tenant, subscription, and org identifiers
- **System Metadata** — Service-generated data not linkable to a user or tenant
- **Public Non-Personal Data** — Publicly available non-personal information

## Implications

- Personal data elements **must** specify a Data Subject
- Personal data stored > 48 hours **must** have GDPR DSR handling documented
- Personal data stored > 30 days **must** justify retention
- Non-personal data (OII, System Metadata) can leave Data Subject blank
- Access Control Data is non-personal but still requires security controls
