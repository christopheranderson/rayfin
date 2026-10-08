# Fabric SQL Database Configuration for Rayfin

This document provides information about the Fabric SQL Database configuration used in the Rayfin WebService.

## Overview

Rayfin WebService exclusively uses Fabric SQL Database for persistent storage of user accounts and session information.

## Connection Configuration

The connection to Fabric SQL Database is configured in the `appsettings.json` and `appsettings.Development.json` files:

```json
"ConnectionStrings": {
  "DefaultConnection": "Server=tcp:{your-server}.database.windows.net,1433;Initial Catalog={your-database};Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;Authentication=Active Directory Default"
}
```

For development, you should update the `appsettings.Development.json` file with your own Fabric SQL Database connection string.

## Authentication Options

The service uses Azure Active Directory Default authentication method, which supports:

1. Managed Identity (when deployed to Azure)
2. Azure CLI credentials (for local development)
3. Visual Studio or Azure Developer CLI credentials

## Database Schema

The database schema is automatically created and updated using Entity Framework Core migrations. The migrations are applied at application startup in development environments:

```csharp
using (var scope = app.Services.CreateScope())
{
    var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    dbContext.Database.Migrate();
    app.Logger.LogInformation("Applied database migrations to Fabric SQL");
}
```

## Table Structure

The database includes the following tables:

1. **Users**: Stores user account information
   - Id (Primary Key)
   - Email (Unique)
   - PasswordHash
   - PasswordSalt
   - CreatedAt

2. **Sessions**: Stores user session information
   - Id (Primary Key)
   - UserId (Foreign Key to Users)
   - CreatedAt
   - ExpiresAt
   - IsAuthenticated

## Migrations

To create a new migration, use the following command:

```powershell
dotnet ef migrations add [MigrationName] --project Microsoft.Rayfin.WebService.csproj
```

To manually apply migrations:

```powershell
dotnet ef database update --project Microsoft.Rayfin.WebService.csproj
```

## Local Development with Fabric SQL

For local development, you can:

1. Use a dedicated development database in Fabric SQL
2. Use SQL Server in Docker for local development or connect to a remote Fabric DB.

Remember to update your connection string in `appsettings.Development.json` accordingly.
