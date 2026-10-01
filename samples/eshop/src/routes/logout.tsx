import { createFileRoute, redirect } from '@tanstack/react-router';
import { useEffect } from 'react';

import { useAuth } from '@/contexts/AuthContext';

export const Route = createFileRoute('/logout')({
  component: RouteComponent,
});

function RouteComponent() {
  const { logout, user } = useAuth();

  useEffect(() => {
    const performLogout = async () => {
      if (user) {
        await logout();
      }
      // Redirect to home after logout
      throw redirect({
        to: '/',
      });
    };

    performLogout();
  }, [logout, user]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-zava-600 mx-auto mb-4"></div>
        <p className="text-gray-600">Logging out...</p>
      </div>
    </div>
  );
}
