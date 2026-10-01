/**
 * Frontend authentication user model
 * This represents the user data needed for UI authentication state
 * Separate from the database User entity used in relationships
 */
export interface AuthUser {
  Id: string;
  Email: string;
}
