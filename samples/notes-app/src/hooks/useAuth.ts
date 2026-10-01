import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AuthUser } from '@/models/AuthUser';
import { ServiceContainer } from '@/services/ServiceContainer';

/**
 * Hook for managing authentication state
 */
export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const services = useMemo(() => ServiceContainer.create(), []);

  const checkCurrentUser = useCallback(async () => {
    try {
      setLoading(true);
      const currentUser = await services.auth.getCurrentUser();
      setUser(currentUser);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to check authentication'
      );
    } finally {
      setLoading(false);
    }
  }, [services.auth]);

  useEffect(() => {
    checkCurrentUser();
  }, [checkCurrentUser]);

  const login = async (email: string, password: string) => {
    try {
      setLoading(true);
      setError(null);
      const authUser = await services.auth.login(email, password);
      setUser(authUser);
      return authUser;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      setError(message);
      throw new Error(message);
    } finally {
      setLoading(false);
    }
  };

  const register = async (email: string, password: string) => {
    try {
      setLoading(true);
      setError(null);
      const authUser = await services.auth.register(email, password);
      setUser(authUser);
      return authUser;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Registration failed';
      setError(message);
      throw new Error(message);
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    setLoading(true);
    try {
      await services.auth.logout();
    } catch (err) {
      // Log error but don't prevent logout - we still want to clear frontend state
      console.error('Logout request failed:', err);
    } finally {
      // Always clear user state even if backend request fails
      setUser(null);
      setError(null);
      setLoading(false);
    }
  };

  return {
    user,
    loading,
    error,
    login,
    register,
    logout,
    isAuthenticated: !!user,
  };
}
