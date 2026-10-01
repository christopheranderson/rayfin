# Testing the Authentication API

The Auth controller provides several endpoints for user authentication and session management. This document explains how to test these endpoints.

## Automated Tests

The authentication API is now tested using .NET integration tests in the `Microsoft.Rayfin.WebService.Tests` project. These tests replace the previous Python-based script.

### Running Automated Tests

You can run the tests by navigating to the test project directory and running `dotnet test`:

```bash
cd packages/host/Microsoft.Rayfin.WebService.Tests
dotnet test
```

### Test Coverage

The automated tests cover:

- User signup (including validation and duplicate handling)
- User signin
- Anonymous token generation
- Role-based access control
- Health check endpoint

## Manual Testing

## Testing Endpoints with HTTP File

The project includes an HTTP file (`Microsoft.Rayfin.WebService.http`) that you can use to test the API endpoints. If you're using VS Code with the REST Client extension, you can execute the requests directly from the file.

### Available Endpoints

1. **Sign Up a New User**

   ```http
   POST http://localhost:5168/api/auth/signup
   Content-Type: application/json

   {
     "email": "test@example.com",
     "password": "Password123!"
   }
   ```

2. **Sign In**

   ```http
   POST http://localhost:5168/api/auth/signin
   Content-Type: application/json

   {
     "email": "test@example.com",
     "password": "Password123!"
   }
   ```

3. **Get Anonymous Token**

   ```http
   POST http://localhost:5168/api/auth/anonymous-token
   Content-Type: application/json
   ```

4. **Verify Token**

   ```http
   POST http://localhost:5168/api/auth/verify-token
   Content-Type: application/json

   {
     "token": "your-token-here"
   }
   ```

5. **Sign Out**

   ```http
   POST http://localhost:5168/api/auth/signout
   Content-Type: application/json
   Authorization: Bearer your-token-here

   {
     "token": "your-token-here"
   }
   ```

6. **Sign Out All Sessions**

   ```http
   POST http://localhost:5168/api/auth/signout-all
   Content-Type: application/json
   Authorization: Bearer your-token-here

   {
     "userId": "user-id-here"
   }
   ```

## Testing with Postman or Similar Tools

You can also use tools like Postman to test the API:

1. Set up a new request with the appropriate HTTP method and URL
2. Add a Content-Type header: `Content-Type: application/json`
3. Add the request body in JSON format
4. Send the request and check the response

## Expected Responses

- **Sign Up**:
  - Success: 200 OK with user details and token
  - Email already registered: 409 Conflict

- **Sign In**:
  - Success: 200 OK with user details and token
  - Invalid credentials: 401 Unauthorized

- **Anonymous Token**:
  - Success: 200 OK with token
- **Verify Token**:
  - Valid token: 200 OK with user claims
  - Invalid token: 401 Unauthorized

- **Sign Out**:
  - Success: 200 OK with success message
  - Invalid token: 401 Unauthorized

- **Sign Out All**:
  - Success: 200 OK with count of invalidated sessions
  - User not found: 404 Not Found

## Legacy Python Tests

The project previously included a Python script (`packages/host/Microsoft.Rayfin.WebService/Tests/test_signup_api.py`) for testing the API. This script has been replaced with the .NET tests for better integration with the solution, improved type safety, and more comprehensive test coverage.

The .NET tests provide additional benefits:

- In-memory database testing
- Integration with the CI/CD pipeline
- Consistent coding style with the rest of the solution
- Enhanced type safety
- Better test organization and structure
  - Success: 200 OK with count of invalidated sessions

## Database Requirements

The authentication system requires access to an Azure SQL database with Users and Sessions tables. These tables are created automatically through Entity Framework Core migrations.

The current schema follows a stateless JWT model where tokens are not stored in the database. The Sessions table tracks session state (active/inactive) without storing the actual tokens.

If you don't have access to the Azure SQL database, you can modify `Program.cs` to use an in-memory database for testing:

```csharp
builder.Services.AddDbContext<AppDbContext>(options =>
{
    if (builder.Environment.IsDevelopment())
    {
        // Use in-memory database for testing
        options.UseInMemoryDatabase("RayfinTestDb");
    }
    else
    {
        // Use SQL Server for production
        options.UseSqlServer(builder.Configuration.GetConnectionString("DefaultConnection"));
    }
});
```

This will allow you to test the API without connecting to Azure SQL.
