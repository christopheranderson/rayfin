import {
  createFileRoute,
  redirect,
  Outlet,
  Link,
} from '@tanstack/react-router';

import { useAuth } from '@/contexts/AuthContext';

export const Route = createFileRoute('/_authed/_admin')({
  beforeLoad: async ({ context }) => {
    if (!context.auth.user || context.auth.user.role !== 'admin') {
      throw redirect({
        to: '/',
      });
    }
  },
  component: AdminLayoutComponent,
});

function AdminLayoutComponent() {
  const { logout } = useAuth();

  const handleLogout = async () => {
    await logout();
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Admin Navigation Sidebar */}
      <div className="flex">
        <div className="w-64 bg-white shadow-sm">
          <div className="p-6">
            <h2 className="text-lg font-semibold text-gray-900">Admin Panel</h2>
          </div>
          <nav className="mt-6">
            <div className="px-6 space-y-1">
              <Link
                to="/admin/dashboard"
                className="group flex items-center px-2 py-2 text-sm font-medium rounded-md text-gray-700 hover:text-gray-900 hover:bg-gray-50"
              >
                📊 Dashboard
              </Link>
              <Link
                to="/admin/products"
                className="group flex items-center px-2 py-2 text-sm font-medium rounded-md text-gray-700 hover:text-gray-900 hover:bg-gray-50"
              >
                📦 Products
              </Link>
              <Link
                to="/admin/categories"
                className="group flex items-center px-2 py-2 text-sm font-medium rounded-md text-gray-700 hover:text-gray-900 hover:bg-gray-50"
              >
                📂 Categories
              </Link>
              <Link
                to="/admin/orders"
                className="group flex items-center px-2 py-2 text-sm font-medium rounded-md text-gray-700 hover:text-gray-900 hover:bg-gray-50"
              >
                🛒 Orders
              </Link>
              <Link
                to="/admin/customers"
                className="group flex items-center px-2 py-2 text-sm font-medium rounded-md text-gray-700 hover:text-gray-900 hover:bg-gray-50"
              >
                👥 Customers
              </Link>
            </div>
          </nav>
        </div>

        {/* Main Content Area */}
        <div className="flex-1">
          <div className="bg-white shadow-sm">
            <div className="px-6 py-4 border-b border-gray-200">
              <div className="flex items-center justify-between">
                <h1 className="text-2xl font-bold text-gray-900">Zava Admin</h1>
                <div className="flex items-center space-x-4">
                  <Link
                    to="/"
                    className="text-sm text-gray-600 hover:text-gray-900"
                  >
                    View Store
                  </Link>
                  <div className="h-6 border-l border-gray-300"></div>
                  <button
                    onClick={handleLogout}
                    className="text-sm text-gray-600 hover:text-gray-900"
                  >
                    Logout
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="p-6">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
