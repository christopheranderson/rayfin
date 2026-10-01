# Database Migrations for Rayfin WebService

This document explains how to manage database migrations for the User and Session tables in the Rayfin WebService.

## Schema Overview

The database schema includes two main tables:

1. **Users Table**
   - `Id` (Primary Key): Unique identifier for each user
   - `Email` (Unique): User's email address
   - `PasswordHash`: Hashed password
   - `PasswordSalt`: Salt used for password hashing
   - `CreatedAt`: Timestamp when the user was created

2. **Sessions Table**
   - `Id` (Primary Key): Unique identifier for each session
   - `UserId` (Foreign Key): References Users.Id
   - `CreatedAt`: Timestamp when the session was created
   - `ExpiresAt`: Timestamp when the session expires
   - `IsAuthenticated`: Flag indicating if the session is active

## Working with Migrations

### Running Migrations

To apply migrations to your database, you can use one of the following approaches:

1. **From the project root**:
   - For Windows Command Prompt: `update-database.bat`
   - For PowerShell: `./update-database.ps1`

2. **Directly from the WebService project**:
   - Navigate to `packages/host/Microsoft.Rayfin.WebService`
   - For Windows Command Prompt: `Scripts\update-database.bat`
   - For PowerShell: `.\Scripts\update-database.ps1`

3. **To migrate to a specific version**:
   - Use the `-targetMigration` parameter: `.\Scripts\update-database.ps1 -targetMigration YourMigrationName`
   - This is useful for rolling back to a specific migration

4. **Using EF Core CLI directly**:

   ```bash
   cd packages/host/Microsoft.Rayfin.WebService
   dotnet ef database update
   ```

Any of these methods will apply all pending migrations to your configured database. The script will also attempt to verify the database schema, especially authentication tables, if you have `sqlcmd` installed.

### Creating New Migrations

If you make changes to the data models (`UserRecord`, `SessionRecord`), you need to create a new migration. There are several ways to do this:

1. **From the project root**:
   - For Windows Command Prompt: `add-migration.bat YourMigrationName`
   - For PowerShell: `./add-migration.ps1 -MigrationName YourMigrationName`

2. **Directly from the WebService project**:
   - Navigate to `packages/host/Microsoft.Rayfin.WebService`
   - For Windows Command Prompt: `Scripts\add-migration.bat YourMigrationName`
   - For PowerShell: `.\Scripts\add-migration.ps1 -MigrationName YourMigrationName`

3. **Using EF Core CLI directly**:

   ```bash
   cd packages/host/Microsoft.Rayfin.WebService
   dotnet ef migrations add YourMigrationName
   ```

Replace `YourMigrationName` with a descriptive name for your changes, e.g., `AddUserPhoneNumber`.

### Connection String

The migrations use the connection string from `appsettings.Development.json`. Ensure this is properly configured before running migrations.

Current configuration targets Azure SQL with Active Directory authentication:

```json
"ConnectionStrings": {
  "DefaultConnection": "Server=tcp:baasserver.database.windows.net,1433;Initial Catalog=BaaSAzureSQLDB;Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;Authentication=Active Directory Default"
}
```

### Creating Database Objects Manually

If you prefer to create the database objects manually, the following SQL scripts can be used:

```sql
-- Create Users table
CREATE TABLE [dbo].[Users] (
    [Id] NVARCHAR(450) NOT NULL,
    [Email] NVARCHAR(450) NOT NULL,
    [PasswordHash] NVARCHAR(MAX) NOT NULL,
    [PasswordSalt] NVARCHAR(MAX) NOT NULL,
    [CreatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [PK_Users] PRIMARY KEY ([Id])
);

-- Create unique index on Email
CREATE UNIQUE INDEX [IX_Users_Email] ON [dbo].[Users] ([Email]);

-- Create Sessions table
CREATE TABLE [dbo].[Sessions] (
    [Id] NVARCHAR(450) NOT NULL,
    [UserId] NVARCHAR(450) NOT NULL,
    [Token] NVARCHAR(450) NOT NULL,
    [CreatedAt] DATETIME2 NOT NULL,
    [ExpiresAt] DATETIME2 NOT NULL,
    [IsAuthenticated] BIT NOT NULL,
    CONSTRAINT [PK_Sessions] PRIMARY KEY ([Id]),
    CONSTRAINT [FK_Sessions_Users_UserId] FOREIGN KEY ([UserId]) REFERENCES [dbo].[Users] ([Id]) ON DELETE CASCADE
);

-- Create unique index on Token
CREATE UNIQUE INDEX [IX_Sessions_Token] ON [dbo].[Sessions] ([Token]);

-- Create index on UserId
CREATE INDEX [IX_Sessions_UserId] ON [dbo].[Sessions] ([UserId]);
```

## Recent Migration History

### RemoveTokenFromSessions (June 28, 2025)

This migration removes the `Token` column from the Sessions table as part of transitioning to a stateless JWT authentication model. With this change:

1. JWT tokens are no longer stored in the database
2. Session validation is based on the JWT claims rather than database lookups
3. Sessions are still tracked for user management and security purposes

### RemoveTokenIndexFromSessions (June 28, 2025)

This migration removes the unique index on the Token column that was previously removed.

## Current Schema

After all migrations, the Sessions table schema is now:

```sql
-- Sessions table
CREATE TABLE [dbo].[Sessions] (
    [Id] NVARCHAR(450) NOT NULL,
    [UserId] NVARCHAR(450) NOT NULL,
    [CreatedAt] DATETIME2 NOT NULL,
    [ExpiresAt] DATETIME2 NOT NULL,
    [IsAuthenticated] BIT NOT NULL,
    CONSTRAINT [PK_Sessions] PRIMARY KEY ([Id]),
    CONSTRAINT [FK_Sessions_Users_UserId] FOREIGN KEY ([UserId]) REFERENCES [dbo].[Users] ([Id]) ON DELETE CASCADE
);

-- Create index on UserId
CREATE INDEX [IX_Sessions_UserId] ON [dbo].[Sessions] ([UserId]);
```

## Troubleshooting

If you encounter issues with migrations, check:

1. The connection string in `appsettings.Development.json`
2. Azure SQL firewall rules to ensure your IP is allowed
3. Azure AD authentication configuration if using Active Directory authentication
