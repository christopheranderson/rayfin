/**
 * Database credentials used in docker-compose files for local development.
 *
 * IMPORTANT: These values MUST match the credentials defined in:
 * - packages/tools/cli/assets/.env.example
 * - packages/host/.env.example
 * - packages/host/docker-compose.developer.yml (via env vars)
 * - packages/tools/cli/assets/docker-compose.yml (via env vars)
 *
 * If you change these values, you MUST also update the .env.example files.
 */
export const DOCKER_DB_CREDENTIALS = {
  /** Password used for all database services (PostgreSQL and SQL Server) */
  password: 'YourStrong!Passw0rd',
  /** PostgreSQL username */
  postgresUser: 'postgres',
  /** PostgreSQL database name */
  postgresDatabase: 'RayfinDB',
  /** SQL Server username */
  sqlServerUser: 'sa',
} as const;
