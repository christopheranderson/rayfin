# Rayfin Local Development Environment

This repository contains configurations for running Rayfin webservice locally using Docker. This guide will help you set up and run the local development environment.

## Prerequisites

- Docker Desktop installed and running
- Azure CLI installed and configured (required for Azure Container Registry access)
- Access to the Rayfin Azure Container Registry (rayfin-chcvgsdxacg9gkd4.azurecr.io)

## Quick Start with Docker Compose

The simplest way to run Rayfin is using the provided docker-compose.yml file, which uses a local SQL Server container.

The Docker setup includes:

- **Rayfin WebService**: .NET Web API
- **SQL Server**: Local database for development

### Login to Azure Container Registry (required first)

```powershell
# Navigate to the directory containing docker-compose.yml
cd packages/host/docker-compose

# Login to Azure Container Registry
az acr login --name rayfin-chcvgsdxacg9gkd4
```

### Run Rayfin Environment

The Docker Compose setup includes all necessary configuration files for Azure Functions in the docker-compose directory. All required files are co-located with the docker-compose.yml file, so you can run the environment directly after logging in to ACR:

```powershell
# Navigate to the docker-compose directory
cd packages/host/docker-compose

# Start the local SQL Server and Rayfin web service
docker-compose up -d
```

This will:

- Start a SQL Server 2022 container with a persistent volume for data storage
- Pull the Rayfin web service image from Azure Container Registry
- Start a Rayfin Functions container with hot-reloading for Python development
- Set up networking between the containers
- Automatically create and configure host.json and local.settings.json in the rayfin-functions folder

### Accessing the API

Once the containers are running, you can access the Rayfin API at:

- Health check endpoint: <http://localhost:5168/healthcheck>
- Swagger doc: <http://localhost:5168/swagger/index.html>
- OpenApi spec: <http://localhost:5168/swagger/v1/swagger.json>

### Managing Docker Compose Services

To view logs:

```powershell
docker-compose logs
# Or follow logs in real-time
docker-compose logs -f
```

To stop the services:

```powershell
docker-compose down
```

To stop the services and remove the volume (which will delete all data):

```powershell
docker-compose down -v
```

To restart all services:

```powershell
docker-compose restart
```

### Port Configuration

The following ports are used:

| Service    | Local Port | Container Port |
| ---------- | ---------- | -------------- |
| Webservice | 5168       | 8080           |
| Webservice | 7126       | 443            |
| SQL Server | 1433       | 1433           |

### Advantages of using Docker Compose

- Single command to start the entire stack
- Pre-configured connection between services
- Data persistence through named volumes
- No need to manually create networks or set environment variables
- Rayfin Functions runtime included for full-stack development

## Alternative Setup Options

If you need to set up components individually, you can use the following approaches.

### Setting Up SQL Server Separately

1. Pull the SQL Server 2025 Docker image:

    ```powershell
    docker pull mcr.microsoft.com/mssql/server:2025-latest
    ```

2. Run SQL Server container:

    ```powershell
    docker run -e "ACCEPT_EULA=Y" -e "MSSQL_SA_PASSWORD=${env:RAYFIN_SQLSERVER_PASSWORD}" `
      -p 1433:1433 --name RayfinDB --hostname RayfinDB `
      -d `
      mcr.microsoft.com/mssql/server:2025-latest
    ```

> Note: Make sure to use a strong password that meets SQL Server requirements (at least 8 characters, including uppercase, lowercase, base-10 digits, and symbols).
>
> After running the SQL Server container, the Rayfin application will automatically create a database named "RayfinDB" when it first connects.

### Running Rayfin WebService Separately

#### Using the Dockerfile with Local SQL Server

1. Build the Docker image:

    ```powershell
    docker build -t rayfin-local .
    ```

2. Run the container:

    ```powershell
    docker run -d --name rayfin-webservice -p 5168:8080 -p 7126:443 rayfin-local
    ```

#### Running directly from Azure Container Registry

```powershell
# Login to Azure Container Registry first
az acr login --name rayfin-chcvgsdxacg9gkd4

# Run Rayfin container directly
docker run -d `
  --name rayfin-webservice `
  -p 5168:8080 `
  -p 7126:443 `
  -e "ConnectionStrings__DefaultConnection=Server=host.docker.internal;Database=RayfinDB;User Id=sa;Password=$RAYFIN_SQLSERVER_PASSWORD;TrustServerCertificate=True;" `
  rayfin-chcvgsdxacg9gkd4.azurecr.io/rayfin/webservice:latest
```

## Troubleshooting

### Profile-Related Issues

If you encounter issues with Docker Compose profiles:

1. **Port conflicts**: If you see errors about ports already being in use:

   ```text
   Error response from daemon: Ports are not available: exposing port TCP 0.0.0.0:7126 -> 127.0.0.1:0: listen tcp 0.0.0.0:7126: bind: Only one usage of each socket address (protocol/network address/port) is normally permitted.
   ```

   Solution:

   ```powershell
   # Stop all containers first
   docker-compose down

   # If that doesn't work, force remove all containers
   docker rm -f $(docker ps -aq)

   # Check for any processes using the port
   netstat -ano | findstr "7126"

   # Start again with the desired profile
   docker-compose --profile local up -d
   ```

2. **Network still in use**: If you see errors about the network still being in use:

   ```text
   Network rayfin-local_rayfin-network Resource is still in use
   ```

   Solution:

   ```powershell
   # Force stop all containers
   docker rm -f $(docker ps -aq)

   # Check that all containers are stopped
   docker ps -a

   # Then try again
   docker-compose down
   ```

### Authentication Issues with Azure Container Registry

If you encounter issues pulling images from Azure Container Registry:

1. Make sure you're logged in to the ACR:

   ```powershell
   az login
   az acr login --name rayfin-chcvgsdxacg9gkd4
   ```

2. Check if your Azure credentials have expired:

   ```powershell
   az account get-access-token
   ```

3. Verify your ACR access:

   ```powershell
   az acr repository list --name rayfin-chcvgsdxacg9gkd4
   ```

4. If you still have issues, you can try pulling the image manually:

   ```powershell
   docker pull rayfin-chcvgsdxacg9gkd4.azurecr.io/rayfin/webservice:latest
   ```

5. Check the registry availability:

   ```powershell
   az acr check-health --name rayfin-chcvgsdxacg9gkd4
   ```

### Check Docker Compose Logs

To view logs for all services:

```powershell
docker-compose logs
```

To view logs for a specific service:

```powershell
docker-compose logs webservice
# or
docker-compose logs sqlserver
```

To follow logs in real-time:

```powershell
docker-compose logs -f
```

### Checking SQL Server connectivity

> **Note:** The commands below reference `$env:RAYFIN_SQLSERVER_PASSWORD`.
> Load the `.env` file first so the variable is available in your PowerShell session:
>
> ```powershell
> # Load .env variables into the current session
> Get-Content packages/host/.env | ForEach-Object {
>     if ($_ -match '^\s*([A-Za-z_]\w*)=(.*)$') {
>         [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2])
>     }
> }
> ```

With Docker Compose:

```powershell
# Connect to SQL Server in the docker-compose environment
docker-compose exec sqlserver /opt/mssql-tools/bin/sqlcmd -S localhost -U sa -P $env:RAYFIN_SQLSERVER_PASSWORD -C
```

Or with standalone containers:

```powershell
# Connect to SQL Server
docker exec -it RayfinDB /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P $env:RAYFIN_SQLSERVER_PASSWORD -C

# View all databases (should include RayfinDB after first run)
SELECT name FROM sys.databases;
GO

# Connect to RayfinDB specifically
USE RayfinDB;
GO

# View tables in RayfinDB
SELECT table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE';
GO
```

### Restarting containers

For Docker Compose (recommended):

```powershell
# Restart all services
docker-compose restart

# Restart a specific service
docker-compose restart webservice
docker-compose restart sqlserver
docker-compose restart python-functions-local
```

For individual containers:

```powershell
docker restart RayfinDB  # Only if using local SQL Server
docker restart rayfin-webservice
```
