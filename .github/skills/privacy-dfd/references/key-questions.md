# Privacy Review Key Questions

Privacy reviews revolve around these key questions and the full data lifecycle.

## Key Questions

Every DFD and inventory must answer:

1. **Who** — Whose data is being collected and from where?
   - Enterprise Customers, Consumers, Partners, Suppliers, Microsoft 1st Party, Other
   - Identify all data subjects (C1 users, C2 users, tenant admins, etc.)

2. **What** — What type of data is being collected (stored, processed, transmitted)?
   - Apply data classifications from the official taxonomy
   - Identify key controls and mitigations

3. **When** — How long will it be stored?
   - Specify retention periods for all persisted data
   - Document passive deletion policies for subscription expiry

4. **Where** — Where will it be stored?
   - Name specific Azure/platform services
   - State geo-boundary compliance (within / outside customer's geolocation)

5. **Why** — Why is the data being collected?
   - Purpose of each data element (service operation, telemetry, compliance, etc.)

6. **How** — How was notice and consent accomplished? How is the data used?
   - Notice mechanisms (terms of service, privacy statements, in-product disclosures)
   - Data usage patterns and access controls

7. **AI/ML** — Does the service keep a copy of customer data for Microsoft's own use?
   - AI model training, evaluation, research
   - If no AI features: state explicitly "No AI/ML features"

## Data Lifecycle Stages

Validate each data element across the full lifecycle:

1. **Collection** — How and where is data collected? What is the source?
2. **Use** — How is the data processed? What transforms or queries operate on it?
3. **Storage** — Where is data persisted? For how long? In what format?
4. **Transfer (Access & Share)** — Who can access the data? Is it shared externally?
5. **Retention** — What retention policies apply? How long after subscription end?
6. **Deletion** — How are GDPR DSR delete requests processed? What is the deletion mechanism?
