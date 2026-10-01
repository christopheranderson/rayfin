import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';

import { Order } from '../../../rayfin/data/Order';
import { OrderItem } from '../../../rayfin/data/OrderItem';

import { ServiceContainer } from '@/services/ServiceContainer';

export const Route = createFileRoute('/_authed/orders/$orderId')({
  component: OrderDetailComponent,
});

function OrderDetailComponent() {
  const { orderId } = Route.useParams();
  const navigate = useNavigate();
  const [order, setOrder] = useState<Order | null>(null);
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { orderService } = ServiceContainer.getInstance();

  useEffect(() => {
    const fetchOrder = async () => {
      try {
        setLoading(true);
        setError(null);

        const [orderData, itemsData] = await Promise.all([
          orderService.getOrder(orderId),
          orderService.getOrderItems(orderId),
        ]);

        if (!orderData) {
          setError('Order not found');
          return;
        }

        setOrder(orderData);
        setOrderItems(itemsData);
      } catch (err) {
        console.error('Failed to fetch order:', err);
        setError('Failed to load order details');
      } finally {
        setLoading(false);
      }
    };

    fetchOrder();
  }, [orderId, orderService]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'confirmed':
        return 'bg-blue-100 text-blue-800';
      case 'processing':
        return 'bg-purple-100 text-purple-800';
      case 'shipped':
        return 'bg-indigo-100 text-indigo-800';
      case 'delivered':
        return 'bg-green-100 text-green-800';
      case 'cancelled':
        return 'bg-red-100 text-red-800';
      case 'refunded':
        return 'bg-gray-100 text-gray-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getPaymentStatusColor = (status: string) => {
    switch (status) {
      case 'paid':
        return 'bg-green-100 text-green-800';
      case 'pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'failed':
        return 'bg-red-100 text-red-800';
      case 'refunded':
        return 'bg-gray-100 text-gray-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="text-center py-8">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-zava-600"></div>
          <p className="mt-2 text-sm text-gray-500">Loading order details...</p>
        </div>
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="text-center py-12">
          <div className="text-red-500 mb-4">
            <svg
              className="mx-auto h-12 w-12"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-gray-900 mb-2">
            {error || 'Order not found'}
          </h3>
          <button
            onClick={() => navigate({ to: '/' })}
            className="mt-4 bg-zava-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-zava-700"
          >
            Go Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Order Confirmation Header */}
      <div className="text-center mb-8">
        <div className="text-green-500 mb-4">
          <svg
            className="mx-auto h-16 w-16"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        </div>
        <h1 className="text-3xl font-bold text-gray-900">Order Confirmed!</h1>
        <p className="mt-2 text-lg text-gray-600">
          Thank you for your order. We'll send you shipping updates via email.
        </p>
      </div>

      <div className="bg-white shadow-sm rounded-lg">
        {/* Order Header */}
        <div className="px-6 py-4 border-b border-gray-200">
          <div className="flex justify-between items-start">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">
                Order #{order.orderNumber}
              </h2>
              <p className="text-sm text-gray-600">
                Placed on {new Date(order.createdAt).toLocaleDateString()}
              </p>
            </div>
            <div className="text-right">
              <div className="flex space-x-2 mb-2">
                <span
                  className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(order.status)}`}
                >
                  {order.status.charAt(0).toUpperCase() + order.status.slice(1)}
                </span>
                <span
                  className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getPaymentStatusColor(order.paymentStatus)}`}
                >
                  Payment {order.paymentStatus}
                </span>
              </div>
              {order.trackingNumber && (
                <p className="text-sm text-gray-600">
                  Tracking:{' '}
                  <span className="font-medium">{order.trackingNumber}</span>
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="px-6 py-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Order Items */}
            <div>
              <h3 className="text-lg font-medium text-gray-900 mb-4">
                Order Items
              </h3>
              <div className="space-y-4">
                {orderItems.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center space-x-4 p-4 border border-gray-200 rounded-lg"
                  >
                    <div className="flex-1">
                      <h4 className="text-sm font-medium text-gray-900">
                        {item.productName}
                      </h4>
                      {item.variantName && (
                        <p className="text-sm text-gray-600">
                          Variant: {item.variantName}
                        </p>
                      )}
                      <p className="text-sm text-gray-600">
                        SKU: {item.productSku}
                      </p>
                      <p className="text-sm text-gray-600">
                        Quantity: {item.quantity}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Order Summary & Details */}
            <div>
              {/* Order Totals */}
              <div className="mb-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">
                  Order Summary
                </h3>
                <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Subtotal</span>
                    <span className="text-gray-900">
                      ${order.subtotal.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Shipping</span>
                    <span className="text-gray-900">
                      {order.shipping === 0
                        ? 'Free'
                        : `$${order.shipping.toFixed(2)}`}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Tax</span>
                    <span className="text-gray-900">
                      ${order.tax.toFixed(2)}
                    </span>
                  </div>
                  {order.discount > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-600">Discount</span>
                      <span className="text-green-600">
                        -${order.discount.toFixed(2)}
                      </span>
                    </div>
                  )}
                  <div className="border-t border-gray-200 pt-2 flex justify-between text-base font-medium">
                    <span className="text-gray-900">Total</span>
                    <span className="text-gray-900">
                      ${order.total.toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Shipping Address */}
              <div className="mb-6">
                <h3 className="text-lg font-medium text-gray-900 mb-2">
                  Shipping Address
                </h3>
                <div className="text-sm text-gray-600">
                  <p className="font-medium text-gray-900">
                    {order.shippingAddress.firstName}{' '}
                    {order.shippingAddress.lastName}
                  </p>
                  {order.shippingAddress.company && (
                    <p>{order.shippingAddress.company}</p>
                  )}
                  <p>{order.shippingAddress.addressLine1}</p>
                  {order.shippingAddress.addressLine2 && (
                    <p>{order.shippingAddress.addressLine2}</p>
                  )}
                  <p>
                    {order.shippingAddress.city}, {order.shippingAddress.state}{' '}
                    {order.shippingAddress.postalCode}
                  </p>
                  <p>{order.shippingAddress.country}</p>
                  {order.shippingAddress.phone && (
                    <p>{order.shippingAddress.phone}</p>
                  )}
                </div>
              </div>

              {/* Payment Method */}
              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-2">
                  Payment Method
                </h3>
                <p className="text-sm text-gray-600 capitalize">
                  {order.paymentMethod?.replace('_', ' ')}
                </p>
              </div>

              {/* Order Notes */}
              {order.notes && (
                <div className="mt-6">
                  <h3 className="text-lg font-medium text-gray-900 mb-2">
                    Order Notes
                  </h3>
                  <p className="text-sm text-gray-600">{order.notes}</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-between">
          <button
            onClick={() => navigate({ to: '/' })}
            className="bg-gray-200 text-gray-700 px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-300"
          >
            Continue Shopping
          </button>

          {order.status === 'pending' && (
            <button
              onClick={() => {
                // TODO: Implement order cancellation
                alert(
                  'Order cancellation will be implemented in the admin panel'
                );
              }}
              className="text-red-600 hover:text-red-500 text-sm font-medium"
            >
              Cancel Order
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
