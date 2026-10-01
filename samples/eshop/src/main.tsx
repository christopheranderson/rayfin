import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import React from 'react';
import ReactDOM from 'react-dom/client';

import { AuthProvider, useAuth } from './contexts/AuthContext';
import { CartProvider, useCart } from './contexts/CartContext';
// Import the generated route tree
import { routeTree } from './routeTree.gen';
import { createServiceContainer } from './services/ServiceContainer';
// Import CSS
import './index.css';

// Create a new router instance
// ensure all new routes require auth
const router = createRouter({
  routeTree,
  context: { auth: undefined!, cart: undefined! },
});

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const services = createServiceContainer();

// Create a QueryClient instance
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      retry: 1,
    },
  },
});

function InnerApp() {
  const auth = useAuth();
  const cart = useCart();

  if (auth.isLoading || cart.loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        Loading...
      </div>
    );
  }

  return <RouterProvider router={router} context={{ auth, cart }} />;
}

// Render the app
const rootElement = document.getElementById('root')!;
if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <AuthProvider mode="rayfin">
        <CartProvider>
          <QueryClientProvider client={queryClient}>
            <InnerApp />
            {/* <ReactQueryDevtools initialIsOpen={false} /> */}
          </QueryClientProvider>
        </CartProvider>
      </AuthProvider>
    </React.StrictMode>
  );
}
