import { createFileRoute, Link } from '@tanstack/react-router';

export const Route = createFileRoute('/_authed/_admin/admin/orders/new')({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Create New Order</h1>
        <Link
          to="/admin/orders"
          className="bg-gray-500 hover:bg-gray-600 text-white px-4 py-2 rounded-md font-medium transition-colors"
        >
          Back to Orders
        </Link>
      </div>

      <div className="bg-white rounded-lg shadow p-6">
        <div className="text-center py-12">
          <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-yellow-100">
            <svg
              className="h-6 w-6 text-yellow-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z"
              />
            </svg>
          </div>
          <h2 className="mt-4 text-lg font-medium text-gray-900">
            Order Creation Not Available
          </h2>
          <p className="mt-2 text-sm text-gray-500 max-w-md mx-auto">
            Manual order creation requires integration with customer management,
            product inventory, and payment processing systems. This feature
            would typically include:
          </p>
          <div className="mt-4 text-left inline-block">
            <ul className="text-sm text-gray-500 space-y-1">
              <li>• Customer selection and verification</li>
              <li>• Product and variant selection</li>
              <li>• Address management</li>
              <li>• Payment method configuration</li>
              <li>• Tax and shipping calculation</li>
              <li>• Inventory validation</li>
            </ul>
          </div>
          <p className="mt-4 text-sm text-gray-500">
            For now, orders are created through the regular customer checkout
            process.
          </p>
          <div className="mt-6">
            <Link
              to="/admin/orders"
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md font-medium transition-colors"
            >
              View Existing Orders
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
