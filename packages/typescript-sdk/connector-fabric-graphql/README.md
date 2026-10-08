# @microsoft/rayfin-connector-fabric-graphql

Base types for Rayfin's Category A (GraphQL-backed) connectors:
`fabric-sqldatabase`, `fabric-warehouse`, and `fabric-sqlanalytics`.

This package contributes nothing at runtime — it only exports the types
needed to make
`client.connectors.<name>.<Entity>.select([...]).where(...).execute()`
strongly typed when `<name>` points at a GraphQL-backed connector in
`rayfin.yml`. The runtime that backs the surface lives in
`@microsoft/rayfin-connectors`.
