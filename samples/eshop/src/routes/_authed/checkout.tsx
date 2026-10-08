import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';

import { Address } from '../../../rayfin/data/Address';

import { useCart } from '@/contexts/CartContext';
import { useAddressManagement } from '@/hooks/useAddressManagement';
import { useCheckout, CheckoutFormData } from '@/hooks/useCheckout';

export const Route = createFileRoute('/_authed/checkout')({
  component: CheckoutComponent,
});

function CheckoutComponent() {
  const navigate = useNavigate();
  const {
    cartItems,
    cartSubtotal,
    cartCount,
    loading: cartLoading,
  } = useCart();
  const { addresses, loading: addressLoading } = useAddressManagement();
  const {
    loading: checkoutLoading,
    error: checkoutError,
    success,
    order,
    processCheckout,
    clearError,
    reset,
  } = useCheckout();

  const [formData, setFormData] = useState<CheckoutFormData>({
    shippingAddressId: '',
    billingAddressId: '',
    paymentMethod: 'credit_card',
    notes: '',
    useSameAddress: true,
  });

  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});

  // Redirect if cart is empty
  useEffect(() => {
    if (!cartLoading && cartCount === 0) {
      navigate({ to: '/cart' });
    }
  }, [cartLoading, cartCount, navigate]);

  // Set default addresses
  useEffect(() => {
    if (addresses.length > 0 && !formData.shippingAddressId) {
      const defaultShipping = addresses.find(
        (addr) =>
          addr.isDefault && (addr.type === 'shipping' || addr.type === 'both')
      );
      const defaultBilling = addresses.find(
        (addr) =>
          addr.isDefault && (addr.type === 'billing' || addr.type === 'both')
      );

      setFormData((prev) => ({
        ...prev,
        shippingAddressId: defaultShipping?.id || addresses[0]?.id || '',
        billingAddressId: defaultBilling?.id || addresses[0]?.id || '',
      }));
    }
  }, [addresses, formData.shippingAddressId]);

  // Redirect to order confirmation on success
  useEffect(() => {
    if (success && order) {
      navigate({ to: `/orders/${order.id}` });
    }
  }, [success, order, navigate]);

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};

    if (!formData.shippingAddressId) {
      errors.shippingAddressId = 'Please select a shipping address';
    }

    if (!formData.useSameAddress && !formData.billingAddressId) {
      errors.billingAddressId = 'Please select a billing address';
    }

    if (!formData.paymentMethod) {
      errors.paymentMethod = 'Please select a payment method';
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    const success = await processCheckout(formData);
    if (!success) {
      // Error handling is managed by the hook
    }
  };

  const calculateTax = (subtotal: number): number => {
    // Simple tax calculation - 8.5%
    return subtotal * 0.085;
  };

  const calculateShipping = (subtotal: number): number => {
    // Free shipping over $50, otherwise $5.99
    return subtotal >= 50 ? 0 : 5.99;
  };

  const tax = calculateTax(cartSubtotal);
  const shipping = calculateShipping(cartSubtotal);
  const total = cartSubtotal + tax + shipping;

  const getAddressDisplay = (address: Address): string => {
    return `${address.firstName} ${address.lastName}, ${address.addressLine1}, ${address.city}, ${address.state} ${address.postalCode}`;
  };

  if (cartLoading || addressLoading) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="text-center py-8">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-zava-600"></div>
          <p className="mt-2 text-sm text-gray-500">Loading checkout...</p>
        </div>
      </div>
    );
  }

  if (cartCount === 0) {
    return null; // Will redirect
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="lg:grid lg:grid-cols-2 lg:gap-x-12 xl:gap-x-16">
        {/* Checkout Form */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900 mb-8">Checkout</h1>

          {/* Error Display */}
          {checkoutError && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-md">
              <div className="flex">
                <div className="ml-3">
                  <h3 className="text-sm font-medium text-red-800">
                    Checkout Error
                  </h3>
                  <div className="mt-2 text-sm text-red-700">
                    {checkoutError}
                  </div>
                  <div className="mt-3">
                    <button
                      onClick={clearError}
                      className="text-sm text-red-800 hover:text-red-600"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-8">
            {/* Shipping Address */}
            <div>
              <h2 className="text-lg font-medium text-gray-900 mb-4">
                Shipping Address
              </h2>

              {addresses.length === 0 ? (
                <div className="p-4 border border-gray-300 rounded-md">
                  <p className="text-sm text-gray-600 mb-2">
                    No addresses found. Please add a shipping address.
                  </p>
                  <button
                    type="button"
                    onClick={() => navigate({ to: '/profile' })}
                    className="text-sm text-zava-600 hover:text-zava-500"
                  >
                    Go to Profile to Add Address
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {addresses
                    .filter(
                      (addr) => addr.type === 'shipping' || addr.type === 'both'
                    )
                    .map((address) => (
                      <label
                        key={address.id}
                        className={`flex items-start p-4 border rounded-lg cursor-pointer ${
                          formData.shippingAddressId === address.id
                            ? 'border-zava-500 bg-zava-50'
                            : 'border-gray-300'
                        }`}
                      >
                        <input
                          type="radio"
                          name="shippingAddress"
                          value={address.id}
                          checked={formData.shippingAddressId === address.id}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              shippingAddressId: e.target.value,
                            })
                          }
                          className="mt-1 h-4 w-4 text-zava-600 focus:ring-zava-500 border-gray-300"
                        />
                        <div className="ml-3 flex-1">
                          <div className="text-sm font-medium text-gray-900">
                            {address.firstName} {address.lastName}
                            {address.isDefault && (
                              <span className="ml-2 text-xs text-zava-600">
                                (Default)
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-gray-600">
                            {getAddressDisplay(address)}
                          </div>
                        </div>
                      </label>
                    ))}
                </div>
              )}

              {validationErrors.shippingAddressId && (
                <p className="mt-1 text-sm text-red-600">
                  {validationErrors.shippingAddressId}
                </p>
              )}
            </div>

            {/* Billing Address */}
            <div>
              <h2 className="text-lg font-medium text-gray-900 mb-4">
                Billing Address
              </h2>

              <div className="mb-4">
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={formData.useSameAddress}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        useSameAddress: e.target.checked,
                      })
                    }
                    className="h-4 w-4 text-zava-600 focus:ring-zava-500 border-gray-300 rounded"
                  />
                  <span className="ml-2 text-sm text-gray-700">
                    Same as shipping address
                  </span>
                </label>
              </div>

              {!formData.useSameAddress && (
                <div className="space-y-3">
                  {addresses
                    .filter(
                      (addr) => addr.type === 'billing' || addr.type === 'both'
                    )
                    .map((address) => (
                      <label
                        key={address.id}
                        className={`flex items-start p-4 border rounded-lg cursor-pointer ${
                          formData.billingAddressId === address.id
                            ? 'border-zava-500 bg-zava-50'
                            : 'border-gray-300'
                        }`}
                      >
                        <input
                          type="radio"
                          name="billingAddress"
                          value={address.id}
                          checked={formData.billingAddressId === address.id}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              billingAddressId: e.target.value,
                            })
                          }
                          className="mt-1 h-4 w-4 text-zava-600 focus:ring-zava-500 border-gray-300"
                        />
                        <div className="ml-3 flex-1">
                          <div className="text-sm font-medium text-gray-900">
                            {address.firstName} {address.lastName}
                            {address.isDefault && (
                              <span className="ml-2 text-xs text-zava-600">
                                (Default)
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-gray-600">
                            {getAddressDisplay(address)}
                          </div>
                        </div>
                      </label>
                    ))}
                </div>
              )}

              {validationErrors.billingAddressId && (
                <p className="mt-1 text-sm text-red-600">
                  {validationErrors.billingAddressId}
                </p>
              )}
            </div>

            {/* Payment Method */}
            <div>
              <h2 className="text-lg font-medium text-gray-900 mb-4">
                Payment Method
              </h2>

              <div className="space-y-3">
                <label
                  className={`flex items-center p-4 border rounded-lg cursor-pointer ${
                    formData.paymentMethod === 'credit_card'
                      ? 'border-zava-500 bg-zava-50'
                      : 'border-gray-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="paymentMethod"
                    value="credit_card"
                    checked={formData.paymentMethod === 'credit_card'}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        paymentMethod: e.target.value,
                      })
                    }
                    className="h-4 w-4 text-zava-600 focus:ring-zava-500 border-gray-300"
                  />
                  <span className="ml-3 text-sm text-gray-900">
                    Credit Card
                  </span>
                </label>

                <label
                  className={`flex items-center p-4 border rounded-lg cursor-pointer ${
                    formData.paymentMethod === 'paypal'
                      ? 'border-zava-500 bg-zava-50'
                      : 'border-gray-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="paymentMethod"
                    value="paypal"
                    checked={formData.paymentMethod === 'paypal'}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        paymentMethod: e.target.value,
                      })
                    }
                    className="h-4 w-4 text-zava-600 focus:ring-zava-500 border-gray-300"
                  />
                  <span className="ml-3 text-sm text-gray-900">PayPal</span>
                </label>
              </div>

              {validationErrors.paymentMethod && (
                <p className="mt-1 text-sm text-red-600">
                  {validationErrors.paymentMethod}
                </p>
              )}
            </div>

            {/* Order Notes */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Order Notes (Optional)
              </label>
              <textarea
                value={formData.notes}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    notes: e.target.value,
                  })
                }
                rows={3}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-zava-500 focus:border-zava-500"
                placeholder="Any special instructions for your order..."
              />
            </div>
          </form>
        </div>

        {/* Order Summary */}
        <div className="mt-10 lg:mt-0">
          <h2 className="text-lg font-medium text-gray-900 mb-4">
            Order Summary
          </h2>

          <div className="bg-gray-50 rounded-lg p-6">
            {/* Cart Items */}
            <div className="space-y-4 mb-6">
              {cartItems.map((item) => {
                const price =
                  item.variant?.originalPrice || item.product.basePrice;
                return (
                  <div key={item.id} className="flex items-center space-x-4">
                    <div className="flex-1">
                      <h3 className="text-sm font-medium text-gray-900">
                        {item.product.name}
                      </h3>
                      {item.variant && (
                        <p className="text-sm text-gray-600">
                          {`${item.variant.color || ''} ${item.variant.size || ''}`.trim()}
                        </p>
                      )}
                      <p className="text-sm text-gray-600">
                        Qty: {item.quantity}
                      </p>
                    </div>
                    <div className="text-sm font-medium text-gray-900">
                      ${(price * item.quantity).toFixed(2)}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Order Totals */}
            <div className="border-t border-gray-200 pt-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">Subtotal</span>
                <span className="text-gray-900">
                  ${cartSubtotal.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">Shipping</span>
                <span className="text-gray-900">
                  {shipping === 0 ? 'Free' : `$${shipping.toFixed(2)}`}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">Tax</span>
                <span className="text-gray-900">${tax.toFixed(2)}</span>
              </div>
              <div className="border-t border-gray-200 pt-2 flex justify-between text-base font-medium">
                <span className="text-gray-900">Total</span>
                <span className="text-gray-900">${total.toFixed(2)}</span>
              </div>
            </div>

            {/* Place Order Button */}
            <button
              onClick={handleSubmit}
              disabled={checkoutLoading || addresses.length === 0}
              className="w-full mt-6 bg-zava-600 text-white py-3 px-4 rounded-md text-sm font-medium hover:bg-zava-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              {checkoutLoading
                ? 'Processing...'
                : `Place Order - $${total.toFixed(2)}`}
            </button>

            {addresses.length === 0 && (
              <p className="mt-2 text-xs text-gray-500 text-center">
                Please add an address to proceed with checkout
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
