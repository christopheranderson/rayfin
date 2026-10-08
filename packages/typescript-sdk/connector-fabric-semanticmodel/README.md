# @microsoft/rayfin-connector-fabric-semanticmodel

Typed connector for Fabric semantic models (Power BI datasets). Exposes one
operation, `executeQuery`, which runs DAX.

## Getting started

```bash
npm create @microsoft/rayfin@latest
```

```bash
npm install @microsoft/rayfin-connector-fabric-semanticmodel
```

Pass it as the third type parameter of `ConnectorsRayfinClient`:

```ts
import { ConnectorsRayfinClient } from '@microsoft/rayfin-client';
import type { AppConnectorsSchema } from '../rayfin/connectors/schema';
import type { AppSchema } from '../rayfin/data/schema';
import type { AppFunctionsSchema } from '../rayfin/functions/schema';

const client = new ConnectorsRayfinClient<
  AppSchema,
  AppFunctionsSchema,
  AppConnectorsSchema
>({
  baseUrl: import.meta.env.VITE_RAYFIN_API_URL,
  publishableKey: import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY,
});
```

For more details, [visit our docs](https://aka.ms/rayfin/docs).

The package also ships its own documentation under `assets/docs`, version-locked
to the installed release. That copy is what the CLI and its agent tooling read,
so search it from an app that has the package installed:

```bash
rayfin docs search "semantic model row limit"
```

## Security

Microsoft takes the security of our software products and services seriously, which
includes all source code repositories in our GitHub organizations.

**Please do not report security vulnerabilities through public GitHub issues.**

For security reporting information, locations, contact information, and policies,
please review the latest guidance for Microsoft repositories at
[https://aka.ms/SECURITY.md](https://aka.ms/SECURITY.md).

## Trademarks

This project may contain trademarks or logos for projects, products, or services.
Authorized use of Microsoft trademarks or logos must follow the [Microsoft Trademark and Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos is subject to those third parties' policies.

## License

Copyright (c) Microsoft Corporation.

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
