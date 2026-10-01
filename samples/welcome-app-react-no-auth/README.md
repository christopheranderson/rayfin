# Build an app with Project Rayfin

Project Rayfin is a modern **Backend-as-a-Service (BaaS)** platform that helps teams build and ship applications faster. It provides ready-to-use backend infrastructure so you can focus on the product experience.

## Getting started experience

Now that you have the welcome template downloaded. Follow the steps below to get started with a basic React app.

To run the timestamp tracker frontend (React):

  1. In a terminal window,  run `npm run dev`
  2. When the frontend starts, it will output the page to visit. Visit and ensure you can view the Timestamp Tracker.
  3. Click **Send Timestamp** to POST the current time to `/api/graphql/Timestamp`, then use **Refresh list** to pull back the newest 100 entries.
  4. All UI + data-fetching logic lives in a single file: `src/App.tsx`.

## Next Steps

### Step 1: Update the Timestamp entity

Add a `message` field to the **Timestamp** entity in `rayfin/data/Timestamp.ts`.

```typescript
import { entity, text, date, role, uuid } from "@microsoft/rayfin-core";

@entity()
@role('anonymous', '*')
export class Timestamp {
  @uuid() id!: string;
  @date() timestamp!: Date;
  @text() message!: string;  // Add this field
}
```

### Step 2: Update the frontend to display the message

In `src/App.tsx`, update the creation and query to include the `message` field, add a table header, and display the message in the table rows.

```typescript
// 1. Update sendTimestamp to include message
await rayfinClient.data.Timestamp.create({
  timestamp: now,
  message: 'Hello from Rayfin!',  // Add this
});

// 2. Update the query to include 'message'
const items = await rayfinClient.data.Timestamp.select([
  'id',
  'timestamp',
  'message',  // Add this
]).orderBy({ timestamp: 'desc' }).first(100).execute();

// 3. Update the table headers in the JSX
<thead>
  <tr>
    <th>ID</th>
    <th>Timestamp</th>
    <th>Message</th>  {/* Add this */}
  </tr>
</thead>

// 4. Update the row template in the JSX
{timestamps.map((entry) => (
  <tr key={entry.id}>
    <td className="timestamp-mono">{entry.id}</td>
    <td>{formatDate(entry.timestamp)}</td>
    <td>{entry.message}</td>  {/* Add this */}
  </tr>
))}
```

### Step 3: Apply database changes

After updating your data models, apply the changes to your database.

```bash
rayfin up db apply
```

### Step 4: Deploy to production

When you're ready, publish your Rayfin project to Microsoft Fabric (cloud).

```bash
rayfin up
```

## Glossary

Essential terms and definitions for the Rayfin ecosystem:

- **Rayfin App/Project** - An application built on the Rayfin platform, utilizing Rayfin SDKs and services.
- **Rayfin Workload/Item** - Rayfin web services as hosted in Microsoft Fabric (the cloud-managed experience).
- **Rayfin OSS Host** - Rayfin web services as hosted on self-managed or local infrastructure (the open-source experience).

## Feedback

Have an idea, question, or bug report? [Open a new issue](https://github.com/microsoft/project-rayfin/issues/new/choose) and select the template that best fits your scenario.

## Trademarks

This project may contain trademarks or logos for projects, products, or services.
Authorized use of Microsoft trademarks or logos must follow the [Microsoft Trademark and Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos is subject to those third parties' policies.

## License

[MIT](LICENSE)
