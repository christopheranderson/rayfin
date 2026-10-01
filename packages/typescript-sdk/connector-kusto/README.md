# @microsoft/rayfin-connector-kusto

> **Experimental** — this package is experimental and may change substantially in the near future.
> Mount the typed connectors runtime through `@microsoft/rayfin-client/experimental`.

Typed marker and query-result helpers for the Rayfin `kusto` (Eventhouse) connector category.
The v1 connector targets a Fabric Eventhouse KQL Database item identified by `workspaceId` and `itemId`.
It supports two operations: `executeQuery` (a KQL query) and `executeCommand` (a Kusto management command).

## Usage

Declare the connector in your application schema:

```ts
import type { Kusto } from '@microsoft/rayfin-connector-kusto';

export type AppConnectorsSchema = {
  telemetry: Kusto<'executeQuery' | 'executeCommand'>;
};
```

Invoke KQL through the typed connector client. Correlation ids are **not** part
of the response body — the connector function relays the Kusto bytes untouched —
so generate the `clientRequestId` yourself and pass the same value to both
`executeQuery` and `toQueryResult` to correlate a query end to end:

```ts
import { toQueryResult } from '@microsoft/rayfin-connector-kusto';

// One id you control: forwarded as `x-ms-client-request-id` by the connector
// function, and echoed back onto the normalized result below.
const clientRequestId = `KPC.rayfin_kusto_v1;${crypto.randomUUID()}`;

const response = await client.connectors.telemetry.executeQuery({
  query: 'StormEvents | summarize count() by State',
  clientRequestId,
});

// Normalize the raw Kusto v1 `{ Tables }` document into a discriminated result.
const result = toQueryResult(response, { clientRequestId });
if (result.status === 'success') {
  console.log(result.tables);
} else {
  console.error(result.error.message);
}
```

The response is the native Kusto v1 `{ Tables }` document, which preserves Kusto
column names, scalar types, and rows. Correlation travels **out of band**:
`toQueryResult` echoes back whatever `clientRequestId` you pass (empty when you
pass none), and `activityId` is populated only when the caller supplies it — it
is never on the wire. `toQueryResult` also transparently accepts the older
`{ status, output, errors }` envelope from a not-yet-redeployed connector
function, so a mixed-version rollout keeps returning results rather than
silently emptying them.

## Management commands

`executeCommand` runs a Kusto management (control) command. The command text
must start with a leading dot and routes to the cluster's `/v1/rest/mgmt`
endpoint. It returns the same native Kusto v1 `{ Tables }` document as a query,
so normalize it with `toQueryResult` the same way — and correlation works
identically (pass your own `clientRequestId` to correlate end to end):

```ts
const databases = await client.connectors.telemetry.executeCommand({
  command: '.show databases',
});

const result = toQueryResult(databases);
```
