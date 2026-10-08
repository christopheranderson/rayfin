# Versioning Guide

This document describes the centralized versioning system for Rayfin host NuGet packages.

## Overview

The following packages use centralized versioning and are published to NuGet:

- `Microsoft.Rayfin.Common`
- `Microsoft.Rayfin.DataApi`
- `Microsoft.Rayfin.Auth`

The following projects are **not currently published** as NuGet packages (`IsPackable=false`):

- `Microsoft.Rayfin.WebService` - ASP.NET Core web service host (will not be published)
- `Microsoft.Rayfin.Function` - Function-style hosting primitives (future candidate for publishing)
- `Microsoft.Rayfin.Storage` - Storage abstractions (future candidate for publishing)
- `*.Tests` - Test projects (will not be published)

Version information is centrally managed in [`Version.props`](../../../packages/host/Version.props) and can be overridden via command-line parameters.

## Default Version

The default version is defined in `Version.props`:

- **VersionPrefix**: `0.0.1`
- **VersionSuffix**: `rc1`
- **Computed Version**: `0.0.1-rc1`

## Version Properties

### VersionPrefix

The base version number following semantic versioning (`MAJOR.MINOR.PATCH`).

### VersionSuffix

Optional prerelease label (e.g., `rc1`, `beta`, `alpha`).
Leave empty for stable releases.

### Version

The computed version combining prefix and suffix.
If `VersionSuffix` is set: `{VersionPrefix}-{VersionSuffix}` (e.g., `0.0.1-rc1`).
If `VersionSuffix` is empty: `{VersionPrefix}` (e.g., `1.0.0`).

## Overriding Version

You can override the version at build or publish time using command-line parameters:

### Override Complete Version

```powershell
dotnet pack -p:Version=1.2.3
dotnet publish -p:Version=1.2.3
```

### Override Version Prefix and Suffix Separately

```powershell
dotnet pack -p:VersionPrefix=1.2.3 -p:VersionSuffix=beta1
dotnet publish -p:VersionPrefix=1.2.3 -p:VersionSuffix=
```

### Override for Specific Project

```powershell
dotnet pack packages/host/Microsoft.Rayfin.Auth/Microsoft.Rayfin.Auth.csproj -p:Version=2.0.0
```

## Updating Default Version

To update the default version for all packages:

1. Edit [`Version.props`](../../../packages/host/Version.props)
2. Update `VersionPrefix` and/or `VersionSuffix`
3. Commit the changes

Example:

```xml
<VersionPrefix>1.0.0</VersionPrefix>
<VersionSuffix></VersionSuffix> <!-- Empty for stable release -->
```

## Semantic Versioning

Follow [Semantic Versioning 2.0.0](https://semver.org/) guidelines:

- **MAJOR**: Incompatible API changes
- **MINOR**: Backwards-compatible functionality additions
- **PATCH**: Backwards-compatible bug fixes

### Prerelease Labels

Common prerelease labels:

- `alpha`: Early development, unstable
- `beta`: Feature complete, testing phase
- `rc`: Release candidate, stable for testing
- `preview`: Preview release for feedback

## Version in CI/CD

For automated builds, you can use build metadata:

```powershell
# Using build number from CI
dotnet pack -p:VersionPrefix=1.0.0 -p:VersionSuffix=ci.$env:BUILD_NUMBER
```

## Assembly Versioning

Assembly and file versions are automatically set based on `VersionPrefix`:

- **AssemblyVersion**: `{VersionPrefix}.0` (e.g., `0.0.1.0`)
- **FileVersion**: `{VersionPrefix}.0` (e.g., `0.0.1.0`)

## Future Package Publishing

When ready to publish the Storage or other packages:

1. Edit [`Microsoft.Rayfin.Storage.csproj`](./Microsoft.Rayfin.Storage/Microsoft.Rayfin.Storage.csproj)
2. Change `<IsPackable>false</IsPackable>` to `<IsPackable>true</IsPackable>`
3. Add package metadata if needed:

   ```xml
   <PropertyGroup>
     <IsPackable>true</IsPackable>
     <Description>Storage abstractions and Azure Storage integration for Rayfin hosts</Description>
     <PackageTags>rayfin;storage;azure</PackageTags>
   </PropertyGroup>
   ```

4. Follow the standard [publishing process](./publishing.md)

## Related Files

- [`Version.props`](../../../packages/host/Version.props): Centralized version configuration
- [`Directory.Build.props`](../../../packages/host/Directory.Build.props): Imports Version.props
- [Publishing Guide](./publishing.md): Publishing guide for NuGet packages
