import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authed/_admin/admin/customers/')({
  component: RouteComponent,
});

function RouteComponent() {
  return <div>Hello Admin Customers!</div>;
}
