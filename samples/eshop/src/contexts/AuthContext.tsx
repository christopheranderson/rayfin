import React, {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useCallback,
} from 'react';

import { User } from '../../rayfin/data/schema';

import { getRayfinClient } from '@/services/rayfin/RayfinClientService';

/**
 * User interface for authentication context
 * Extends the base User type with role information
 */
export interface AuthUser extends User {
  role: 'customer' | 'admin' | 'unauthenticated';
  customerId?: string;
}

/**
 * Authentication state interface
 */
export interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
  error: string | null;
  isAuthenticated: boolean;
}

/**
 * Authentication action types
 */
export type AuthAction =
  | { type: 'AUTH_START' }
  | { type: 'AUTH_SUCCESS'; payload: AuthUser }
  | { type: 'AUTH_ERROR'; payload: string }
  | { type: 'AUTH_CLEAR_ERROR' }
  | { type: 'LOGOUT' }
  | { type: 'REFRESH_START' }
  | { type: 'REFRESH_SUCCESS'; payload: AuthUser }
  | { type: 'REFRESH_ERROR'; payload: string };

/**
 * Authentication context interface
 */
export interface AuthContextType {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  error: string | null;
  getCurrentUser: () => Promise<AuthUser | null>;
  refreshUser: () => Promise<void>;
  logout: () => Promise<void>;
  login: (loginParams: {
    email: string;
    password: string;
  }) => Promise<AuthUser>;
  clearError: () => void;
}

/**
 * Initial authentication state
 */
const initialAuthState: AuthState = {
  user: null,
  isLoading: true,
  error: null,
  isAuthenticated: false,
};

/**
 * Authentication reducer function
 * Handles all authentication state transitions in a centralized, predictable way
 */
function authReducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case 'AUTH_START':
      return {
        ...state,
        isLoading: true,
        error: null,
      };

    case 'AUTH_SUCCESS':
      return {
        ...state,
        user: action.payload,
        isLoading: false,
        error: null,
        isAuthenticated: true,
      };

    case 'AUTH_ERROR':
      return {
        ...state,
        user: null,
        isLoading: false,
        error: action.payload,
        isAuthenticated: false,
      };

    case 'AUTH_CLEAR_ERROR':
      return {
        ...state,
        error: null,
      };

    case 'LOGOUT':
      return {
        ...state,
        user: null,
        isLoading: false,
        error: null,
        isAuthenticated: false,
      };

    case 'REFRESH_START':
      return {
        ...state,
        isLoading: true,
        error: null,
      };

    case 'REFRESH_SUCCESS':
      return {
        ...state,
        user: action.payload,
        isLoading: false,
        error: null,
        isAuthenticated: true,
      };

    case 'REFRESH_ERROR':
      return {
        ...state,
        isLoading: false,
        error: action.payload,
        // Keep existing user state on refresh error to avoid unnecessary logouts
      };

    default:
      return state;
  }
}

/**
 * Authentication context with default values
 */
const AuthContext = createContext<AuthContextType>({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  error: null,
  getCurrentUser: async () => null,
  refreshUser: async () => {},
  logout: async () => {},
  login: undefined!,
  clearError: () => {},
});

/**
 * Custom hook to access authentication context
 * @throws Error if used outside of AuthProvider
 */
export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

/**
 * Props for AuthProvider component
 */
export interface AuthProviderProps {
  children: React.ReactNode;
  mode?: 'mock' | 'rayfin';
}

/**
 * Authentication provider component
 * Manages global authentication state using React context and useReducer
 */
export const AuthProvider: React.FC<AuthProviderProps> = ({
  children,
  mode = 'rayfin',
}) => {
  const [state, dispatch] = useReducer(authReducer, initialAuthState);

  /**
   * Get current user from the appropriate service
   */
  const getCurrentUser = useCallback(async (): Promise<AuthUser | null> => {
    try {
      if (mode === 'rayfin') {
        const rayfin = getRayfinClient();
        const session = rayfin.auth.getSession();

        if (!session || !session.isAuthenticated) {
          console.info('AuthContext: No authenticated user found');
          return null;
        }

        console.info('AuthContext: User found - ', session.user);

        const sessionUser = session.user;
        if (!sessionUser) {
          console.warn('AuthContext: Session exists but user is null');
          return null;
        }

        // WARNING: This is not properly done. See issue: https://github.com/microsoft/project-rayfin/issues/203
        const role = sessionUser.email.includes('admin')
          ? 'admin'
          : sessionUser.role === 'Anonymous'
            ? 'unauthenticated'
            : 'customer';

        // Create AuthUser with role determination
        const authUser: AuthUser = {
          Id: sessionUser.id,
          Email: sessionUser.email,
          role,
        };

        return authUser;
      } else {
        // Mock mode
        return {
          Id: 'mock-user',
          Email: 'customer@example.com',
          role: 'customer',
        };
      }
    } catch (error) {
      console.error('Error getting current user:', error);
      return null;
    }
  }, [mode]);

  /**
   * Refresh user data from the service
   */
  const refreshUser = useCallback(async (): Promise<void> => {
    dispatch({ type: 'REFRESH_START' });

    try {
      const currentUser = await getCurrentUser();

      if (currentUser) {
        dispatch({ type: 'REFRESH_SUCCESS', payload: currentUser });
      } else {
        throw new Error('Failed to refresh user');
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to refresh user';
      console.error('Error refreshing user:', error);
      dispatch({ type: 'REFRESH_ERROR', payload: errorMessage });
    }
  }, [getCurrentUser]);

  /**
   * Logout user and clear authentication state
   */
  const logout = useCallback(async (): Promise<void> => {
    try {
      if (mode === 'rayfin') {
        const rayfin = getRayfinClient();
        await rayfin.auth.signOut();
      }
      await refreshUser();
      dispatch({ type: 'LOGOUT' });
    } catch (error) {
      console.error('Error during logout:', error);
      // Even if logout fails, clear local state
      dispatch({ type: 'LOGOUT' });
    }
  }, [mode]);

  const login = useCallback(
    async ({
      email,
      password,
    }: {
      email: string;
      password: string;
    }): Promise<AuthUser> => {
      try {
        if (mode === 'rayfin') {
          const rayfin = getRayfinClient();
          await rayfin.auth.signIn({ email, password });
          await refreshUser();
          return state.user!;
        } else {
          throw new Error('Not yet implemented');
        }
      } catch (error) {
        console.error('Error during login:', error);
        throw new Error('Login failed');
      }
    },
    [mode]
  );

  /**
   * Clear any authentication errors
   */
  const clearError = useCallback((): void => {
    dispatch({ type: 'AUTH_CLEAR_ERROR' });
  }, []);

  /**
   * Initialize user on component mount
   */
  useEffect(() => {
    const initializeAuth = async () => {
      dispatch({ type: 'AUTH_START' });

      try {
        const currentUser = await getCurrentUser();

        if (currentUser) {
          dispatch({ type: 'AUTH_SUCCESS', payload: currentUser });
        } else {
          dispatch({ type: 'LOGOUT' });
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : 'Failed to initialize authentication';
        console.error('Error initializing auth:', error);
        dispatch({ type: 'AUTH_ERROR', payload: errorMessage });
      }
    };

    initializeAuth();
  }, [getCurrentUser]);

  const contextValue: AuthContextType = {
    user: state.user,
    isLoading: state.isLoading,
    isAuthenticated: state.isAuthenticated,
    error: state.error,
    getCurrentUser,
    refreshUser,
    logout,
    login,
    clearError,
  };

  return (
    <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>
  );
};
