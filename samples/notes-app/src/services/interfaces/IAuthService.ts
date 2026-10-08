import type { AuthUser } from '@/models/AuthUser';

/**
 * Authentication service interface
 * Provides user authentication and session management
 */
export interface IAuthService {
  /**
   * Authenticate user with email and password
   */
  login(email: string, password: string): Promise<AuthUser>;

  /**
   * Sign out the current user
   */
  logout(): Promise<void>;

  /**
   * Get the current authenticated user
   */
  getCurrentUser(): Promise<AuthUser | null>;

  /**
   * Register a new user account
   */
  register(email: string, password: string): Promise<AuthUser>;
}
