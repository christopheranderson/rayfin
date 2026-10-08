import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
  createRootRouteWithContext,
} from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/router-devtools';
import * as React from 'react';

import { useAuth } from '@/contexts/AuthContext';
import { useCart } from '@/contexts/CartContext';

interface RootRouteContext {
  auth: ReturnType<typeof useAuth>;
  cart: ReturnType<typeof useCart>;
}

export const Route = createRootRouteWithContext<RootRouteContext>()({
  component: RootComponent,
  notFoundComponent: () => {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">404</h1>
          <p className="text-gray-600 mb-6">
            Sorry, we couldn't find that page.
          </p>
          <Link
            to="/"
            className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-zava-600 hover:bg-zava-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zava-500"
          >
            Go back home
          </Link>
        </div>
      </div>
    );
  },
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const { cartCount, refreshCart } = useCart();

  console.info('User is authenticated: ', JSON.stringify(user));

  const handleLogout = async () => {
    await logout();
    await refreshCart();
  };

  return (
    <div className="bg-white">
      {/* Header Navigation */}
      <header className="bg-white shadow-sm border-b border-gray-200">
        <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            {/* Logo */}
            <div className="flex-shrink-0">
              <Link to="/" className="text-2xl font-bold text-zava-600">
                Zava
              </Link>
            </div>

            {/* Main Navigation */}
            <div className="hidden md:block">
              <div className="ml-10 flex items-baseline space-x-4">
                <Link
                  to="/products/{-$categoryId}"
                  params={{ categoryId: undefined }}
                  className="text-gray-600 hover:text-zava-600 px-3 py-2 rounded-md text-sm font-medium"
                  activeProps={{ className: 'text-zava-600 font-semibold' }}
                  activeOptions={{ exact: true }}
                >
                  Products
                </Link>
                <Link
                  to="/products/{-$categoryId}"
                  params={{ categoryId: 'shirts' }}
                  className="text-gray-600 hover:text-zava-600 px-3 py-2 rounded-md text-sm font-medium"
                  activeProps={{ className: 'text-zava-600 font-semibold' }}
                  activeOptions={{ exact: true }}
                >
                  Shirts
                </Link>
                <Link
                  to="/products/{-$categoryId}"
                  params={{ categoryId: 'pants' }}
                  className="text-gray-600 hover:text-zava-600 px-3 py-2 rounded-md text-sm font-medium"
                  activeProps={{ className: 'text-zava-600 font-semibold' }}
                  activeOptions={{ exact: true }}
                >
                  Pants
                </Link>
                <Link
                  to="/products/{-$categoryId}"
                  params={{ categoryId: 'materials' }}
                  className="text-gray-600 hover:text-zava-600 px-3 py-2 rounded-md text-sm font-medium"
                  activeProps={{ className: 'text-zava-600 font-semibold' }}
                  activeOptions={{ exact: true }}
                >
                  Materials
                </Link>
              </div>
            </div>

            {/* User Actions */}
            <div className="flex items-center space-x-4">
              {user && user.role !== 'unauthenticated' ? (
                <>
                  <Link
                    to="/cart"
                    className="relative text-gray-600 hover:text-zava-600 p-2 flex items-center"
                  >
                    🛒 Cart
                    {cartCount > 0 && (
                      <span className="absolute -top-1 -right-1 bg-zava-600 text-white text-xs rounded-full h-5 w-5 flex items-center justify-center font-bold">
                        {cartCount > 99 ? '99+' : cartCount}
                      </span>
                    )}
                  </Link>
                  <Link
                    to="/profile"
                    className="text-gray-600 hover:text-zava-600 text-sm font-medium"
                  >
                    {user.Email}
                  </Link>
                  {user.role === 'admin' && (
                    <Link
                      to="/admin/dashboard"
                      className="bg-zava-600 text-white px-3 py-2 rounded-md text-sm font-medium hover:bg-zava-700"
                    >
                      Admin
                    </Link>
                  )}
                  <button
                    onClick={handleLogout}
                    className="text-gray-600 hover:text-zava-600 text-sm font-medium"
                  >
                    Logout
                  </button>
                </>
              ) : (
                <>
                  <Link
                    to="/login"
                    className="text-gray-600 hover:text-zava-600 text-sm font-medium"
                  >
                    Login
                  </Link>
                  <Link
                    to="/signup"
                    className="bg-zava-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-zava-700"
                  >
                    Sign Up
                  </Link>
                </>
              )}
            </div>
          </div>
        </nav>
      </header>

      {/* Main Content */}
      <main className="min-h-screen">{children}</main>

      {/* Footer */}
      <footer className="bg-gray-900 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
            <div>
              <h3 className="text-lg font-semibold mb-4">Zava</h3>
              <p className="text-gray-400 text-sm">
                Premium running apparel with smart materials technology.
              </p>
            </div>
            <div>
              <h4 className="font-medium mb-4">Products</h4>
              <ul className="space-y-2 text-sm text-gray-400">
                <li>
                  <Link
                    to="/products/{-$categoryId}"
                    params={{ categoryId: 'running-shoes' }}
                    className="hover:text-white"
                  >
                    Running Shoes
                  </Link>
                </li>
                <li>
                  <Link
                    to="/products/{-$categoryId}"
                    params={{ categoryId: 'activewear' }}
                    className="hover:text-white"
                  >
                    Activewear
                  </Link>
                </li>
                <li>
                  <Link
                    to="/products/{-$categoryId}"
                    params={{ categoryId: 'accessories' }}
                    className="hover:text-white"
                  >
                    Accessories
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="font-medium mb-4">Support</h4>
              <ul className="space-y-2 text-sm text-gray-400">
                <li>
                  <a href="#" className="hover:text-white">
                    Size Guide
                  </a>
                </li>
                <li>
                  <a href="#" className="hover:text-white">
                    Returns
                  </a>
                </li>
                <li>
                  <a href="#" className="hover:text-white">
                    Shipping
                  </a>
                </li>
                <li>
                  <a href="#" className="hover:text-white">
                    Contact
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="font-medium mb-4">Company</h4>
              <ul className="space-y-2 text-sm text-gray-400">
                <li>
                  <a href="#" className="hover:text-white">
                    About
                  </a>
                </li>
                <li>
                  <a href="#" className="hover:text-white">
                    Technology
                  </a>
                </li>
                <li>
                  <a href="#" className="hover:text-white">
                    Sustainability
                  </a>
                </li>
                <li>
                  <a href="#" className="hover:text-white">
                    Careers
                  </a>
                </li>
              </ul>
            </div>
          </div>
          <div className="border-t border-gray-800 mt-8 pt-8 text-center text-sm text-gray-400">
            <p>
              <Link to="/initialize" className="hover:text-white">
                &copy; 2025 Zava. All rights reserved.
              </Link>
            </p>
          </div>
        </div>
      </footer>

      {/* <TanStackRouterDevtools position="bottom-right" /> */}
      <Scripts />
    </div>
  );
}
