import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import App from '../App';
import { AuthProvider } from '../hooks/AuthContext';
import { AuthSettingsProvider } from '../hooks/AuthSettingsContext';
import { ServiceContainer } from '../services/ServiceContainer';

// Test wrapper component that provides necessary context
function TestWrapper({ children }: { children: React.ReactNode }) {
  return (
    <AuthSettingsProvider>
      <AuthProvider>{children}</AuthProvider>
    </AuthSettingsProvider>
  );
}

// Use mock mode for tests so all auth methods are available
ServiceContainer.create('mock');

describe('App', () => {
  it('renders without crashing', () => {
    render(
      <TestWrapper>
        <App />
      </TestWrapper>
    );
    // The app should render either the login form or the main app
    expect(document.body).toBeTruthy();
  });

  it('displays login form when not authenticated', async () => {
    render(
      <TestWrapper>
        <App />
      </TestWrapper>
    );

    // Wait for loading to complete and login form to appear
    await waitFor(() => {
      expect(screen.getByText('Sign in to Todo App')).toBeInTheDocument();
    });

    // Check for login form elements
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    // Check for the primary sign in button (submit type)
    expect(
      screen.getByRole('button', { name: /^sign in$/i })
    ).toBeInTheDocument();
    // Check for magic link option (in development mode)
    expect(
      screen.getByRole('button', { name: /sign in with magic link/i })
    ).toBeInTheDocument();
  });
});
