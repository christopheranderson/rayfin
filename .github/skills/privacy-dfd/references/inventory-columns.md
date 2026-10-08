# Data Inventory — Required Columns

The data inventory table must have exactly these columns.
Each row is numbered with a `#` that cross-references the DFD edge sample labels.

## Column Definitions

| Column | Description | Guidance |
|---|---|---|
| **#** | Row number matching DFD `Sample #N` labels | Sequential, starting from 1 |
| **Name/Description of element** | Human-readable name of the specific data element | Be specific — "User email address" not "user data". "Telemetry data" is too generic; list specific elements. |
| **Sample Data** | Concrete example value or realistic structure | Use realistic but fake values. Show JSON structure for complex data. |
| **Data Classification** | One or more from the official taxonomy | See classifications reference. Multiple allowed (comma-separated). |
| **Data Subject in Scope** | Who the data is about | See data subjects reference. Leave blank for non-personal data (OII, System Metadata). |
| **Dependent service(s) that store (at rest >= 48 hrs)** | Where data persists long-term | Name the specific Azure/platform service. |
| **Dependent service(s) that process (at rest < 48 hrs)** | Where data is processed transiently | Name the specific service processing the data. |
| **Handled per Data Handling standard** | Compliance with C+AI Data Handling Standard | Yes / No / No - Exception Approved / No - Exception Requested |
| **Stored within/outside geolocation boundary?** | Whether data at rest is in customer's geo | Within / Outside / N/A - Data not stored / N/A - Data at rest < 48 hours |
| **Processed within/outside geolocation boundary?** | Whether processing occurs in customer's geo | Within / Outside / N/A |
| **Shared with/processed by 3rd party?** | Whether any 3rd party handles this data | Yes (name the party) / No |
| **3rd party SSPA compliant?** | SSPA compliance of any 3rd party | Yes / No / N/A |
| **3rd party on approved Subprocessor list?** | For EUII/Customer Content shared with 3rd party | Yes / No / N/A |
| **3rd party on C+AI Approved Vendor list?** | For personal data accessed by 3rd party | Yes / No / N/A |
| **How are GDPR DSR export/delete requests processed?** | Mechanism for honoring GDPR requests | See options below |
| **Storing Personal Data > 30 days?** | Whether personal data is retained long-term | Yes (with retention period) / No |
| **Data retained after subscription ended?** | Passive deletion compliance | See options below |
| **Comments** | Additional context, uncertainties, notes | Use for "Requires confirmation" flags |

## GDPR DSR Processing Options

- Delete and/or Export Agents (Data Grid or S360 Agents)
- In-product (API Call, Scheduled job, HOBO subscription)
- Manual (Service team has a documented manual process)
- Data stored in customer owned subscription or on customer premise
- Redundant stream or Source Refresh
- Variant applicable (Delete and/or Export requests are not honored.)
- N/A - Not in a position to identify
- N/A - Data at rest < 48 hours

## Passive Deletion / Retention Options

- Yes - The retention period in this storage is in sync with data source receiving the customer termination signals.
- Yes - When receives "Expired" signal for subscriptions managed by ARM, personal data is deleted within 90 days
- Yes - When receives "Deleted" state for licenses managed by MSFT commerce, personal data is deleted within 90 days
- Yes - Once the notification of service deprecation/termination is sent to customers, personal data is deleted within 90 days of deprecation of service.
- Yes - This storage asset does not contain personal data, but non-personal data is deleted within 3 years after customer termination date
- No - The required passive deletion retention period is not met (Exception required)
- No - Personal data is retained for the period specified in the approved variant request
- No - Personal data is deleted within 30 days of collection, independent of the status of subscriptions/licenses
- N/A - Service does not collect data related to any license/subscription/trial account
- N/A - Employee data out of scope for passive deletion
- N/A - Data not stored

## Storage Service Options

Common dependent services for Fabric workloads:

- Cosmos DB
- Azure SQL Database
- (xStore) Storage Blob
- ADLS Gen 2
- App Insight
- Log Analytics
- Kusto
- N/A - Data not Stored
- N/A - Less than 48 hours
- N/A - Data stored in customer owned subscription
