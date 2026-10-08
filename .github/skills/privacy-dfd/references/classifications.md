# Microsoft Enterprise Data Taxonomy — Classifications

Reference: [Microsoft Enterprise Online Services Data Taxonomy](https://aka.ms/entonlinesvcdatataxonomy)

## Classification Definitions

| Classification | Definition | Examples |
|---|---|---|
| **Access Control Data** | Data used to manage access to administrative roles or sensitive functions | Microsoft-owned secrets (passwords, certificates, encryption keys, storage keys), partner operator secrets |
| **Customer Content** | Data, information, and code provided by C1 admins, C1 users, and C2 users | Customer secrets, blob storage, ML models, email addresses, biometric identifiers, PHI, SharePoint content |
| **End User Identifiable Information (EUII)** | Data that directly identifies or could be used to identify authenticated C1 or C2 users | IP addresses, user principal names, email subject lines, employee IDs, location info, SIP URI, device IDs |
| **End User Pseudonymous Identifiers (EUPI)** | Identifiers created by Microsoft tied to C1 or C2 users | GUIDs, PUIDs, session IDs, salted hashed EUII moving outside compliance boundary |
| **Support Data** | Data provided to Microsoft by customers as part of support engagements | Support requests, chat sessions, case notes |
| **Feedback** | Data provided as part of a review or feedback that includes personal data | Survey responses, reviews, ratings, upvotes |
| **Account Data** | Contact and billing/purchase/payment/license info for the C1 enterprise | Provisioning info, account configuration, tenant admin contact info |
| **Public Personal Data** | Publicly available personal information obtained from external sources | Public tweets, Facebook posts, LinkedIn data |
| **Managed Service Data** | Data provided by Managed Service customers as part of a Managed Service engagement | Messaging, chat transcripts, case notes |
| **Organization Identifiable Information (OII)** | Data that can identify a particular tenant, subscription, deployment, or organization | Tenant IDs, usage data, tenant IP addresses, domain names, mapping of organizational GUIDs |
| **System Metadata** | Data generated in the course of running the service, not linkable to a user or tenant | Event logs, access control logs, server names/IPs, telemetry, behavioral/usage data, service config data |
| **Public Non-Personal Data** | Publicly available information that does not contain personal data | Weather data, news stories without personal info, corporate announcements |

## Which Classifications Are Personal Data?

| Classification | Personal Data? |
|---|---|
| Access Control Data | No |
| Customer Content | Yes |
| End User Identifiable Information (EUII) | Yes |
| Support Data | Yes |
| End User Pseudonymous Identifiers (EUPI) | Yes |
| Feedback Data | Yes |
| Account Data (Admin Data, Payment Data) | Yes |
| Public Personal Data | Yes |
| Organization Identifiable Information (OII) | No |
| System Metadata | No |
| Public Non-Personal Data | No |

## Usage Rules

- A single data element can have **multiple** classifications (e.g., a JWT token may be EUPI + Access Control Data)
- If classification is uncertain, include the element with `Requires confirmation` in Comments
- Always prefer the most specific classification — do not default to System Metadata for anything that could identify a user or tenant
- Customer Content is always personal data and requires full GDPR DSR handling
- EUII requires the strongest protections — minimize collection and retention
