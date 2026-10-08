import { createFileRoute, Link } from '@tanstack/react-router';

import { useCart } from '../../contexts/CartContext';

export const Route = createFileRoute('/_authed/cart')({
  component: CartComponent,
});

function CartComponent() {
  const {
    cartItems,
    cartCount,
    cartSubtotal,
    loading,
    error,
    updateQuantity,
    removeFromCart,
    clearCart,
  } = useCart();

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex justify-center items-center min-h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-zava-600"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg
                className="h-5 w-5 text-red-400"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800">Error</h3>
              <p className="mt-1 text-sm text-red-700">{error}</p>
              <button
                onClick={() => window.location.reload()}
                className="mt-2 text-sm text-red-600 hover:text-red-500 underline"
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Page Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Shopping Cart</h1>
          <p className="mt-2 text-gray-600">
            {cartCount} {cartCount === 1 ? 'item' : 'items'} in your cart
          </p>
        </div>
        {cartItems.length > 0 && (
          <button
            onClick={clearCart}
            className="text-sm text-red-600 hover:text-red-500 underline"
          >
            Clear Cart
          </button>
        )}
      </div>

      {cartItems.length === 0 ? (
        /* Empty Cart State */
        <div className="text-center py-12">
          <svg
            className="mx-auto h-12 w-12 text-gray-400"
            stroke="currentColor"
            fill="none"
            viewBox="0 0 48 48"
          >
            <path
              d="M7 12l3.586 9.993A2 2 0 0012.444 23H35.444a2 2 0 001.858-1.007L40 12M7 12l-1-5H3m4 17h32m-32 0l-1 5h34l-1-5m-32 0v6a2 2 0 002 2h28a2 2 0 002-2v-6"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <h3 className="text-lg font-medium text-gray-900 mb-2">
            Your cart is empty
          </h3>
          <p className="text-gray-500 mb-6">
            Start adding items to see them here.
          </p>
          <a
            href="/products"
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-zava-600 hover:bg-zava-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zava-500"
          >
            Continue Shopping
          </a>
        </div>
      ) : (
        /* Cart Items */
        <div className="lg:grid lg:grid-cols-12 lg:gap-x-12 lg:items-start">
          {/* Cart Items List */}
          <div className="lg:col-span-8">
            <div className="bg-white shadow overflow-hidden rounded-md">
              <ul className="divide-y divide-gray-200">
                {cartItems.map((item) => (
                  <li key={item.id} className="p-6">
                    <div className="flex items-center">
                      {/* Product Image */}
                      <div className="flex-shrink-0 w-24 h-24">
                        <img
                          className="w-24 h-24 rounded-md object-center object-cover"
                          src={
                            item.product.imageUrl || '/placeholder-product.jpg'
                          }
                          alt={item.product.name}
                        />
                      </div>

                      {/* Product Details */}
                      <div className="ml-6 flex-1">
                        <div className="flex">
                          <div className="min-w-0 flex-1">
                            <h4 className="text-sm font-medium text-gray-900">
                              <a
                                href={`/products/${item.product.id}`}
                                className="hover:text-zava-600"
                              >
                                {item.product.name}
                              </a>
                            </h4>
                            <p className="mt-1 text-sm text-gray-500">
                              {item.product.sku}
                            </p>
                            {item.variant && (
                              <p className="mt-1 text-sm text-gray-500">
                                {item.variant.size &&
                                  `Size: ${item.variant.size}`}
                                {item.variant.color &&
                                  ` • Color: ${item.variant.color}`}
                              </p>
                            )}
                          </div>
                          <div className="ml-4 flex-shrink-0 flex">
                            <button
                              onClick={() => removeFromCart(item.id)}
                              className="font-medium text-red-600 hover:text-red-500"
                            >
                              Remove
                            </button>
                          </div>
                        </div>

                        {/* Quantity and Price */}
                        <div className="mt-4 flex items-center justify-between">
                          <div className="flex items-center">
                            <label
                              htmlFor={`quantity-${item.id}`}
                              className="sr-only"
                            >
                              Quantity, {item.product.name}
                            </label>
                            <div className="flex items-center border border-gray-300 rounded-md">
                              <button
                                onClick={() =>
                                  updateQuantity(item.id, item.quantity - 1)
                                }
                                className="px-2 py-1 text-gray-600 hover:text-gray-800"
                                disabled={item.quantity <= 1}
                              >
                                −
                              </button>
                              <span className="px-3 py-1 text-sm font-medium">
                                {item.quantity}
                              </span>
                              <button
                                onClick={() =>
                                  updateQuantity(item.id, item.quantity + 1)
                                }
                                className="px-2 py-1 text-gray-600 hover:text-gray-800"
                              >
                                +
                              </button>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-medium text-gray-900">
                              $
                              {(
                                (item.variant?.originalPrice ||
                                  item.product.basePrice) * item.quantity
                              ).toFixed(2)}
                            </p>
                            <p className="text-sm text-gray-500">
                              $
                              {(
                                item.variant?.originalPrice ||
                                item.product.basePrice
                              ).toFixed(2)}{' '}
                              each
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Order Summary */}
          <div className="lg:col-span-4 mt-16 lg:mt-0">
            <div className="bg-gray-50 rounded-lg px-4 py-6 sm:p-6 lg:p-8">
              <h2 className="text-lg font-medium text-gray-900">
                Order Summary
              </h2>
              <div className="mt-6 space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-gray-600">
                    Subtotal ({cartCount} items)
                  </p>
                  <p className="text-sm font-medium text-gray-900">
                    ${cartSubtotal.toFixed(2)}
                  </p>
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-sm text-gray-600">Shipping</p>
                  <p className="text-sm font-medium text-gray-900">
                    Calculated at checkout
                  </p>
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-sm text-gray-600">Tax</p>
                  <p className="text-sm font-medium text-gray-900">
                    Calculated at checkout
                  </p>
                </div>
                <div className="border-t border-gray-200 pt-4 flex items-center justify-between">
                  <p className="text-base font-medium text-gray-900">
                    Order total
                  </p>
                  <p className="text-base font-medium text-gray-900">
                    ${cartSubtotal.toFixed(2)}
                  </p>
                </div>
              </div>
              <div className="mt-6">
                <Link
                  to="/checkout"
                  className="w-full bg-zava-600 border border-transparent rounded-md shadow-sm py-3 px-4 text-base font-medium text-white hover:bg-zava-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-50 focus:ring-zava-500 block text-center"
                >
                  Checkout
                </Link>
              </div>
              <div className="mt-6 text-center">
                <Link
                  to="/"
                  className="text-sm font-medium text-zava-600 hover:text-zava-500"
                >
                  Continue Shopping
                  <span aria-hidden="true"> &rarr;</span>
                </Link>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
