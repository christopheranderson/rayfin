import { createFileRoute, redirect, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_authed')({
  component: () => <Outlet />,
  beforeLoad: async ({ context }) => {
    if (context.auth.user?.role === 'unauthenticated' || !context.auth.user) {
      throw redirect({
        to: '/login',
      });
    }
  },
});
