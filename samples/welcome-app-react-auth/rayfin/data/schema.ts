import { Timestamp } from './Timestamp.js';

/**
 * Schema type definition for the Welcome app with UI components
 *
 * This type maps entity names to their corresponding model types,
 * enabling full type safety throughout the application when using
 * the RayfinClient and DataApi.
 */
export type WelcomeAppSchema = {
  Timestamp: Timestamp;
};

export const schema = [Timestamp];
