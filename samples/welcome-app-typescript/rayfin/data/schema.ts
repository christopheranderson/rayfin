import type { Timestamp } from './Timestamp.js';

/**
 * Schema type definition for your Rayfin project
 *
 * This type maps entity names to their corresponding model types,
 * enabling full type safety throughout the application when using
 * the RayfinClient and DataApi.
 *
 * Add additional entities to this schema as you create them:
 *
 * ```ts
 * export type AppSchema = {
 *   Timestamp: Timestamp;
 *   YourEntity: YourEntity;
 *   AnotherEntity: AnotherEntity;
 * };
 * ```
 */
export type AppSchema = {
  Timestamp: Timestamp;
};
