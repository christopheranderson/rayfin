# @microsoft/rayfin-cli

CLI for Rayfin

## Installing

```bash
npm i -D @microsoft/rayfin-cli
npx rayfin -h
```

Install the CLI into the project, not globally. A project-local install keeps the CLI and the SDK version locked together, so every contributor and CI run gets the same CLI the project's dependencies expect. A global install drifts out of sync with the SDK version each project pins, so it is not recommended.

## Getting started

```bash
npm create @microsoft/rayfin

# Deploy your new app
npx rayfin up

# Test code locally
npm run dev
```

## Options

```bash
npx rayfin -h
npx rayfin [command] -h
```

For more details, [visit our docs](https://aka.ms/rayfin/docs).

## Telemetry

Rayfin CLI collects telemetry data, which is used to help understand how to improve the product.
For example, this usage data helps to debug issues, such as deployment failures, validation failures or template initialization failures.
Remote Fabric, workload, and Power BI calls add validated response correlation IDs so a command can be joined with service diagnostics without recording request URLs, bodies, or credentials.
The CLI prefers `x-ms-root-activity-id` and falls back to `RequestId` from the configured endpoint.
Known CI and hosted development environments are categorized automatically.
Hosts can override the category with `RAYFIN_TELEMETRY_ENV`; values are trimmed and lowercased.
Known labels include `github-actions`, `azure-pipelines`, `gitlab-ci`, `jenkins`, `codespaces`, `devcontainer`, `local`, and `other`.
Custom labels containing 1–64 ASCII letters, digits, hyphens, or underscores are also accepted; non-empty values outside that format map to `other`.
An empty value behaves as though the variable were unset and falls through to automatic detection.
Custom labels must not contain user, customer, resource, repository, machine, or other sensitive identifiers.
While we appreciate the insights this data provides, we also know that not everyone wants to send usage data and you can disable telemetry by setting the environment variable `RAYFIN_TELEMETRY_OPTOUT=1`.
You can also read our [privacy statement](https://go.microsoft.com/fwlink/?LinkID=528096&clcid=0x409) to learn more.

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
