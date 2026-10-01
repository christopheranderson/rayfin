import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from '../hooks/AuthContext';
import type { AuthUser } from '../models/AuthUser';
import type { IAuthService } from '../services/interfaces/IAuthService';

const { authService, observer } = vi.hoisted(() => ({
  authService: {
    initEmbeddedAuth: vi.fn<IAuthService['initEmbeddedAuth']>(),
    getCurrentUser: vi.fn<IAuthService['getCurrentUser']>(),
  },
  observer: vi.fn(() => null),
}));

vi.mock('../services/ServiceContainer', () => ({
  ServiceContainer: {
    create: () => ({ authService }),
  },
}));

vi.mock('../components/AuthStateObserver', () => ({
  AuthStateObserver: observer,
}));

const storedUser: AuthUser = {
  Id: 'stored-user',
  Email: 'stored@example.com',
  Name: 'Stored user',
};

const embeddedUser: AuthUser = {
  Id: 'parent-user',
  Email: 'parent@example.com',
  Name: 'Parent user',
};

function AuthStatus() {
  const { user, loading, error } = useAuth();
  return (
    <>
      <div data-testid="status">
        {loading ? 'loading' : (user?.Id ?? 'signed-out')}
      </div>
      {error && <div role="alert">{error}</div>}
    </>
  );
}

function renderProvider() {
  return render(
    <AuthProvider>
      <AuthStatus />
    </AuthProvider>
  );
}

describe('AuthProvider startup', () => {
  beforeEach(() => {
    authService.initEmbeddedAuth.mockReset();
    authService.getCurrentUser.mockReset();
    authService.getCurrentUser.mockResolvedValue(storedUser);
    observer.mockClear();
  });

  afterEach(cleanup);

  it('awaits embedded auth before exposing a persisted user or observing session changes', async () => {
    let complete!: (user: AuthUser | null) => void;
    authService.initEmbeddedAuth.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      })
    );
    renderProvider();

    expect(authService.initEmbeddedAuth).toHaveBeenCalledTimes(1);
    expect(authService.getCurrentUser).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
    expect(screen.getByTestId('status')).toHaveTextContent('loading');

    await act(async () => complete(embeddedUser));

    expect(screen.getByTestId('status')).toHaveTextContent('parent-user');
    expect(authService.getCurrentUser).not.toHaveBeenCalled();
    expect(observer).toHaveBeenCalled();
  });

  it('resumes the stored user after embedded initialization returns null', async () => {
    authService.initEmbeddedAuth.mockResolvedValue(null);
    renderProvider();

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('stored-user');
    });
    expect(authService.initEmbeddedAuth).toHaveBeenCalledTimes(1);
    expect(authService.getCurrentUser).toHaveBeenCalledTimes(1);
    expect(
      authService.initEmbeddedAuth.mock.invocationCallOrder[0]
    ).toBeLessThan(authService.getCurrentUser.mock.invocationCallOrder[0]);
  });

  it('stays signed out when neither path provides a user', async () => {
    authService.initEmbeddedAuth.mockResolvedValue(null);
    authService.getCurrentUser.mockResolvedValue(null);
    renderProvider();

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('signed-out');
    });
  });

  it('surfaces initialization errors without falling back to the stored user', async () => {
    authService.initEmbeddedAuth.mockRejectedValue(new Error('Handoff failed'));
    renderProvider();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Handoff failed');
    });
    expect(screen.getByTestId('status')).toHaveTextContent('signed-out');
    expect(authService.getCurrentUser).not.toHaveBeenCalled();
  });
});
