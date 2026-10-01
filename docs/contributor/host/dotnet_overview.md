# .NET Overview

## Build

```dotnet
# normal dotnet flow
dotnet build
dotnet test
```

## New package

- project name: CamelCase
- directory name: lowercase
- location: typically under `./packages/host/`

```bash
dotnet new classlib -n Microsoft.Rayfin.${Name Here} -o ./packages/host/${name here} -lang C#
dotnet new mstest -n Microsoft.Rayfin.${Name Here}.Tests -o ./packages/host/${name here}.tests
dotnet sln rayfin.sln add ./packages/host/${Name Here}
dotnet sln rayfin.sln add ./packages/host/${name here}.tests
```
