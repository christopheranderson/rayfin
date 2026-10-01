import type { IAuthService } from '../interfaces/IAuthService';

import { getRayfinClient } from './RayfinClientService';

import type { AuthUser } from '@/models/AuthUser';

/**
 * Implementation of IAuthService using Rayfin client
 *
 * NOTE: This service requires a running backend API that implements
 * the authentication endpoints.
 */
export class RayfinAuthService implements IAuthService {
  async login(email: string, password: string): Promise<AuthUser> {
    try {
      const client = getRayfinClient();
      await client.auth.signIn({ email, password });

      // Get user info from the session (opaque, doesn't expose tokens)
      const session = client.auth.getSession();

      if (!session.isAuthenticated || !session.user) {
        throw new Error('Failed to establish session');
      }

      // Map from session to our AuthUser model
      return {
        Id: session.user.id,
        Email: session.user.email,
      };
    } catch (error) {
      console.error('RayfinAuthService login error:', error);
      throw new Error('Login failed. Please check your credentials.');
    }
  }

  async logout(): Promise<void> {
    try {
      const client = getRayfinClient();
      await client.auth.signOut();
    } catch (error) {
      // Log the error but don't throw - we still want to clear the frontend session
      console.error('RayfinAuthService logout error:', error);
    }
  }

  async getCurrentUser(): Promise<AuthUser | null> {
    const client = getRayfinClient();
    const session = client.auth.getSession();
    if (!session || !session.user) {
      return null;
    }

    return {
      Id: session.user.id,
      Email: session.user.email,
    };
  }

  async register(email: string, password: string): Promise<AuthUser> {
    try {
      const client = getRayfinClient();
      await client.auth.signUp({ email, password });

      // After signup, sign in to get session
      await client.auth.signIn({ email, password });

      const session = client.auth.getSession();
      if (!session.isAuthenticated || !session.user) {
        throw new Error('Failed to establish session after registration');
      }

      return {
        Id: session.user.id,
        Email: session.user.email,
      };
    } catch (error) {
      console.error('RayfinAuthService register error:', error);
      // Preserve the original error message from the SDK (e.g., "Email already registered.")
      const message =
        error instanceof Error
          ? error.message
          : 'Registration failed. Please try again.';
      throw new Error(message);
    }
  }
}
