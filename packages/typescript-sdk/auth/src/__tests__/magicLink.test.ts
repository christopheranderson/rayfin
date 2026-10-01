import { ApiClient } from '@microsoft/rayfin-lib';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { Auth } from '..';

// Mock localStorage (used by Auth for PKCE state - uses localStorage for cross-tab support)
const mockLocalStorage: Record<string, string> = {};
const localStorageMock = {
  getItem: vi.fn((key: string) => mockLocalStorage[key] || null),
  setItem: vi.fn((key: string, value: string) => {
    mockLocalStorage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete mockLocalStorage[key];
  }),
  clear: vi.fn(() => {
    for (const key in mockLocalStorage) {
      delete mockLocalStorage[key];
    }
  }),
  length: 0,
  key: vi.fn(() => null),
};

// Mock sessionStorage (kept for any other uses)
const mockSessionStorage: Record<string, string> = {};
const sessionStorageMock = {
  getItem: vi.fn((key: string) => mockSessionStorage[key] || null),
  setItem: vi.fn((key: string, value: string) => {
    mockSessionStorage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete mockSessionStorage[key];
  }),
  clear: vi.fn(() => {
    for (const key in mockSessionStorage) {
      delete mockSessionStorage[key];
    }
  }),
  length: 0,
  key: vi.fn(() => null),
};

// Mock fetch for magic link endpoints
const createMockFetch = () =>
  vi.fn(async (url: any, init?: any) => {
    const urlString = typeof url === 'string' ? url : url.toString();

    let body: any = {};
    if (init?.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = {};
      }
    }

    // Magic link send endpoint
    if (urlString.endsWith('/api/auth/v1/passwordless/send')) {
      if (body.email && body.codeChallenge && body.state && body.redirectUri) {
        // Validate redirect URI
        if (body.redirectUri === 'invalid://not-a-url') {
          return new Response(
            JSON.stringify({ error: 'Invalid redirect URI' }),
            { status: 422 }
          );
        }
        return new Response(
          JSON.stringify({
            success: true,
            message: 'Magic link sent successfully',
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ error: 'Invalid request' }), {
        status: 400,
      });
    }

    // Token endpoint for verification code exchange
    if (urlString.endsWith('/api/auth/v1/token')) {
      if (body.grantType === 'authorization_code' && body.verificationCode) {
        // Valid verification code
        if (body.verificationCode === 'VALID_CODE') {
          return new Response(
            JSON.stringify({
              accessToken:
                'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEyMyIsImVtYWlsIjoidXNlckBleGFtcGxlLmNvbSIsImV4cCI6OTk5OTk5OTk5OX0.test',
              tokenType: 'Bearer',
              expiresIn: 900,
              refreshToken: 'REFRESH_TOKEN_123',
            }),
            { status: 200 }
          );
        }
        // Expired verification code
        if (body.verificationCode === 'EXPIRED_CODE') {
          return new Response(JSON.stringify({ error: 'Code expired' }), {
            status: 401,
          });
        }
        // PKCE mismatch
        if (body.verificationCode === 'PKCE_MISMATCH_CODE') {
          return new Response(
            JSON.stringify({ error: 'PKCE verification failed' }),
            { status: 403 }
          );
        }
        return new Response(JSON.stringify({ error: 'Invalid code' }), {
          status: 401,
        });
      }
      // Default for other token requests
      return new Response(JSON.stringify({ error: 'Invalid request' }), {
        status: 400,
      });
    }

    // JWKS endpoint for token validation
    if (urlString.endsWith('/.well-known/jwks.json')) {
      return new Response(JSON.stringify({ keys: [] }), { status: 200 });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
    });
  });

describe('Magic Link Authentication', () => {
  let auth: Auth;
  let apiClient: ApiClient;
  let mockFetch: ReturnType<typeof createMockFetch>;

  beforeEach(() => {
    // Clear storage mocks
    for (const key in mockLocalStorage) {
      delete mockLocalStorage[key];
    }
    for (const key in mockSessionStorage) {
      delete mockSessionStorage[key];
    }
    vi.clearAllMocks();

    // Set up mocks
    mockFetch = createMockFetch();
    global.fetch = mockFetch;

    // Mock window with both sessionStorage and localStorage
    Object.defineProperty(global, 'window', {
      value: {
        sessionStorage: sessionStorageMock,
        localStorage: localStorageMock,
        location: {
          href: 'https://myapp.com/page',
        },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      writable: true,
    });

    apiClient = new ApiClient({
      baseUrl: 'https://api.example.com',
      publishableKey: 'pk-commonSampleAppPKkey',
    });
    auth = new Auth(apiClient, { storage: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (auth) {
      auth.destroy();
    }
  });

  describe('sendMagicLink', () => {
    it('should send magic link and return success with state', async () => {
      const result = await auth.sendMagicLink({
        email: 'user@example.com',
        redirectUri: 'https://myapp.com/auth/callback',
      });

      expect(result.success).toBe(true);
      expect(result.state).toBeDefined();
      expect(result.state).toHaveLength(22); // Base64url encoded 16 bytes
    });

    it('should store PKCE state when custom storage is provided', async () => {
      const customStorage: Record<string, string> = {};
      const storageAuth = new Auth(apiClient, {
        storage: {
          getItem: (key: string) => customStorage[key] ?? null,
          setItem: (key: string, value: string) => {
            customStorage[key] = value;
          },
          removeItem: (key: string) => {
            delete customStorage[key];
          },
        },
      });

      const result = await storageAuth.sendMagicLink({
        email: 'user@example.com',
        redirectUri: 'https://myapp.com/auth/callback',
      });

      const pkceKey = `rayfin_pkce_${result.state}`;
      expect(customStorage[pkceKey]).toBeDefined();

      const storedState = JSON.parse(customStorage[pkceKey]!);
      expect(storedState.codeVerifier).toBeDefined();
      expect(storedState.redirectUri).toBe('https://myapp.com/auth/callback');
      expect(storedState.createdAt).toBeDefined();

      storageAuth.destroy();
    });

    it('should throw error when email is missing', async () => {
      await expect(
        auth.sendMagicLink({
          email: '',
          redirectUri: 'https://myapp.com/auth/callback',
        })
      ).rejects.toThrow('Email is required');
    });

    it('should throw error when redirectUri is missing', async () => {
      await expect(
        auth.sendMagicLink({
          email: 'user@example.com',
          redirectUri: '',
        })
      ).rejects.toThrow('Redirect URI is required');
    });

    it('should emit AUTH_MAGIC_LINK_SENT event on success', async () => {
      const eventHandler = vi.fn();
      auth.on('AUTH_MAGIC_LINK_SENT', eventHandler);

      await auth.sendMagicLink({
        email: 'user@example.com',
        redirectUri: 'https://myapp.com/auth/callback',
      });

      expect(eventHandler).toHaveBeenCalled();
    });

    it('should emit AUTH_MAGIC_LINK_ERROR event on failure', async () => {
      const eventHandler = vi.fn();
      auth.on('AUTH_MAGIC_LINK_ERROR', eventHandler);

      // Make the API call fail
      mockFetch.mockImplementationOnce(async () => {
        return new Response(JSON.stringify({ error: 'Server error' }), {
          status: 500,
        });
      });

      await expect(
        auth.sendMagicLink({
          email: 'user@example.com',
          redirectUri: 'https://myapp.com/auth/callback',
        })
      ).rejects.toThrow();

      expect(eventHandler).toHaveBeenCalled();
    });
  });

  describe('isMagicLinkCallback', () => {
    it('should return true when URL has verification_code and state', () => {
      const result = auth.isMagicLinkCallback(
        'https://myapp.com/callback?verification_code=abc123&state=xyz789'
      );
      expect(result).toBe(true);
    });

    it('should return false when verification_code is missing', () => {
      const result = auth.isMagicLinkCallback(
        'https://myapp.com/callback?state=xyz789'
      );
      expect(result).toBe(false);
    });

    it('should return false when state is missing', () => {
      const result = auth.isMagicLinkCallback(
        'https://myapp.com/callback?verification_code=abc123'
      );
      expect(result).toBe(false);
    });

    it('should return false for a regular URL', () => {
      const result = auth.isMagicLinkCallback('https://myapp.com/page');
      expect(result).toBe(false);
    });

    it('should return false for invalid URL', () => {
      const result = auth.isMagicLinkCallback('not-a-valid-url');
      expect(result).toBe(false);
    });

    it('should use window.location.href when no URL provided', () => {
      // Set up window.location
      Object.defineProperty(global.window, 'location', {
        value: {
          href: 'https://myapp.com/callback?verification_code=abc&state=123',
        },
        writable: true,
      });

      const result = auth.isMagicLinkCallback();
      expect(result).toBe(true);
    });
  });

  describe('getMagicLinkVerificationCode', () => {
    it('should extract verification code from URL', () => {
      const code = auth.getMagicLinkVerificationCode(
        'https://myapp.com/callback?verification_code=abc123&state=xyz789'
      );
      expect(code).toBe('abc123');
    });

    it('should return null when verification_code is missing', () => {
      const code = auth.getMagicLinkVerificationCode(
        'https://myapp.com/callback?state=xyz789'
      );
      expect(code).toBeNull();
    });

    it('should return null for invalid URL', () => {
      const code = auth.getMagicLinkVerificationCode('not-a-valid-url');
      expect(code).toBeNull();
    });
  });

  describe('handleMagicLinkCallback', () => {
    it('should return error when verification_code is missing', async () => {
      const result = await auth.handleMagicLinkCallback(
        'https://myapp.com/callback?state=xyz789'
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('MISSING_VERIFICATION_CODE');
    });

    it('should return error when state is missing', async () => {
      const result = await auth.handleMagicLinkCallback(
        'https://myapp.com/callback?verification_code=abc123'
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('MISSING_STATE');
    });

    it('should return error when state not found in storage', async () => {
      const result = await auth.handleMagicLinkCallback(
        'https://myapp.com/callback?verification_code=abc123&state=unknown_state'
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('STATE_NOT_FOUND');
      expect(result.error).toContain('different browser');
    });

    it('should successfully authenticate with valid code and state', async () => {
      // First, send a magic link to set up the state
      const sendResult = await auth.sendMagicLink({
        email: 'user@example.com',
        redirectUri: 'https://myapp.com/auth/callback',
      });

      // Now handle the callback with the state and a valid code
      const result = await auth.handleMagicLinkCallback(
        `https://myapp.com/callback?verification_code=VALID_CODE&state=${sendResult.state}`
      );

      expect(result.success).toBe(true);
      expect(result.session).toBeDefined();
      expect(result.session?.isAuthenticated).toBe(true);
    });

    it('should clear PKCE state from storage after successful callback', async () => {
      const customStorage: Record<string, string> = {};
      const storageAuth = new Auth(apiClient, {
        storage: {
          getItem: (key: string) => customStorage[key] ?? null,
          setItem: (key: string, value: string) => {
            customStorage[key] = value;
          },
          removeItem: (key: string) => {
            delete customStorage[key];
          },
        },
      });

      const sendResult = await storageAuth.sendMagicLink({
        email: 'user@example.com',
        redirectUri: 'https://myapp.com/auth/callback',
      });

      const pkceKey = `rayfin_pkce_${sendResult.state}`;
      expect(customStorage[pkceKey]).toBeDefined();

      await storageAuth.handleMagicLinkCallback(
        `https://myapp.com/callback?verification_code=VALID_CODE&state=${sendResult.state}`
      );

      expect(customStorage[pkceKey]).toBeUndefined();
      storageAuth.destroy();
    });

    it('should clear PKCE state from storage even on failure', async () => {
      const customStorage: Record<string, string> = {};
      const storageAuth = new Auth(apiClient, {
        storage: {
          getItem: (key: string) => customStorage[key] ?? null,
          setItem: (key: string, value: string) => {
            customStorage[key] = value;
          },
          removeItem: (key: string) => {
            delete customStorage[key];
          },
        },
      });

      const sendResult = await storageAuth.sendMagicLink({
        email: 'user@example.com',
        redirectUri: 'https://myapp.com/auth/callback',
      });

      const pkceKey = `rayfin_pkce_${sendResult.state}`;

      await storageAuth.handleMagicLinkCallback(
        `https://myapp.com/callback?verification_code=EXPIRED_CODE&state=${sendResult.state}`
      );

      expect(customStorage[pkceKey]).toBeUndefined();
      storageAuth.destroy();
    });

    it('should handle server error in callback URL', async () => {
      const result = await auth.handleMagicLinkCallback(
        'https://myapp.com/callback?error=access_denied&error_description=User%20cancelled'
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('access_denied');
      expect(result.error).toBe('User cancelled');
    });

    it('should emit AUTH_LOGIN event on successful authentication', async () => {
      const eventHandler = vi.fn();
      auth.on('AUTH_LOGIN', eventHandler);

      const sendResult = await auth.sendMagicLink({
        email: 'user@example.com',
        redirectUri: 'https://myapp.com/auth/callback',
      });

      await auth.handleMagicLinkCallback(
        `https://myapp.com/callback?verification_code=VALID_CODE&state=${sendResult.state}`
      );

      expect(eventHandler).toHaveBeenCalled();
    });
  });
});
