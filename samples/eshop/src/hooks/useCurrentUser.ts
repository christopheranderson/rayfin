import { useAuth } from '@/contexts/AuthContext';
import type { AuthUser } from '@/contexts/AuthContext';

/**
 * Custom hook to get the current authenticated user
 * @returns The current user or null if not authenticated
 */
export function useCurrentUser(): AuthUser | null {
  const { user } = useAuth();
  return user;
}

/**
 * Custom hook to check if user is authenticated
 * @returns Boolean indicating if user is authenticated
 */
export function useIsAuthenticated(): boolean {
  const { isAuthenticated } = useAuth();
  return isAuthenticated;
}

/**
 * Custom hook to get authentication error state
 * @returns Current error message or null
 */
export function useAuthError(): string | null {
  const { error } = useAuth();
  return error;
}

/**
 * Custom hook to access full authentication context
 * @returns Complete authentication context
 */
export function useAuthContext() {
  return useAuth();
}
