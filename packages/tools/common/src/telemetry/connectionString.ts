/**
 * Shared Application Insights connection string for Rayfin CLI tooling
 * telemetry (CLI, `create-rayfin`).
 *
 * This is a **write-only ingestion key** — it can only be used to
 * *send* telemetry, not to read or query data — so it is safe to
 * embed in source. Consumers may override it at runtime (for
 * development or testing) via a platform-appropriate mechanism, for
 * example the `RAYFIN_APPINSIGHTS_CONNECTION_STRING` environment
 * variable in Node.js hosts.
 */
export const RAYFIN_APPINSIGHTS_CONNECTION_STRING =
  'InstrumentationKey=a4218fe7-e748-42e2-bd90-cd0fdbd1aa0b;IngestionEndpoint=https://centralus-2.in.applicationinsights.azure.com/;LiveEndpoint=https://centralus.livediagnostics.monitor.azure.com/;ApplicationId=d9e9984b-8efc-4e2a-ab3d-14b69eb718f8';
