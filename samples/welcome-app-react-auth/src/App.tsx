import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';

import { AuthPage } from '@/components/AuthPage';
import { useAuth } from '@/hooks/AuthContext';
import { AuthCallback } from '@/pages/AuthCallback.tsx';
import { Dashboard } from '@/pages/Dashboard';

/** The route a visitor asked for before being sent to sign in. */
interface AuthRedirectState {
  from?: string;
}

/**
 * Resolves where to send a visitor after they sign in.
 *
 * Only same-origin application paths are accepted, so a crafted value cannot
 * send the visitor off-site, and the sign-in routes are rejected so sign-in
 * cannot loop.
 */
function resolveReturnPath(state: unknown): string {
  const from = (state as AuthRedirectState | null)?.from;

  if (typeof from !== 'string' || !from.startsWith('/')) return '/';
  if (from.startsWith('//') || from.startsWith('/\\')) return '/';
  if (
    from === '/auth' ||
    from.startsWith('/auth/') ||
    from.startsWith('/auth?')
  ) {
    return '/';
  }

  return from;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  // Carry the requested route through sign-in. Without this, a shared link
  // opened by a signed-out visitor always lands on the default page.
  if (!isAuthenticated) {
    const redirectState: AuthRedirectState = {
      from: `${location.pathname}${location.search}`,
    };
    return <Navigate to="/auth" replace state={redirectState} />;
  }

  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to={resolveReturnPath(location.state)} replace />;
  }

  return <>{children}</>;
}

function App() {
  return (
    <BrowserRouter>
      {/* ensure all new routes require auth */}
      <Routes>
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route
          path="/auth"
          element={
            <PublicRoute>
              <AuthPage />
            </PublicRoute>
          }
        />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
