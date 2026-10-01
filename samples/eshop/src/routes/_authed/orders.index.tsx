import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect } from 'react';

import { Order } from '../../../rayfin/data/Order';

import { ServiceContainer } from '@/services/ServiceContainer';

export const Route = createFileRoute('/_authed/orders/')({
  component: OrdersComponent,
});

function OrdersComponent() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { orderService, customerService } = ServiceContainer.getInstance();

  useEffect(() => {
    const fetchOrders = async () => {
      try {
        setLoading(true);
        setError(null);
        const ordersData = await orderService.getOrders();
        // TODO: clean up auth
        const profile = await customerService.getProfile();
        setOrders(ordersData.filter((o) => o.customer.id === profile?.id));
      } catch (err) {
        console.error('Failed to fetch orders:', err);
        setError('Failed to load orders');
      } finally {
        setLoading(false);
      }
    };

    fetchOrders();
  }, [orderService]);

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
        <h1 className="text-2xl font-bold text-gray-900 mb-6">My Orders</h1>
        <div className="text-center py-8">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-zava-600"></div>
          <p className="mt-2 text-sm text-gray-500">Loading orders...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">My Orders</h1>
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
          <h3 className="text-lg font-medium text-gray-900 mb-2">{error}</h3>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 bg-zava-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-zava-700"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">My Orders</h1>
        <div className="text-center py-12">
          <div className="text-gray-400 mb-4">
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
                d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
              />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-gray-900 mb-2">
            No orders yet
          </h3>
          <p className="text-gray-600 mb-6">
            Start shopping to see your order history here.
          </p>
          <Link
            to="/"
            className="bg-zava-600 text-white px-6 py-2 rounded-md text-sm font-medium hover:bg-zava-700"
          >
            Start Shopping
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">My Orders</h1>
        <p className="text-sm text-gray-600">
          {orders.length} order{orders.length !== 1 ? 's' : ''}
        </p>
      </div>

      <div className="space-y-4">
        {orders.map((order) => (
          <div
            key={order.id}
            className="bg-white border border-gray-200 rounded-lg shadow-sm hover:shadow-md transition-shadow"
          >
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-lg font-medium text-gray-900">
                    Order #{order.orderNumber}
                  </h3>
                  <p className="text-sm text-gray-600">
                    Placed on {new Date(order.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="text-right">
                  <div className="flex space-x-2 mb-2">
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(order.status)}`}
                    >
                      {order.status.charAt(0).toUpperCase() +
                        order.status.slice(1)}
                    </span>
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getPaymentStatusColor(order.paymentStatus)}`}
                    >
                      Payment {order.paymentStatus}
                    </span>
                  </div>
                  <p className="text-lg font-semibold text-gray-900">
                    ${order.total.toFixed(2)}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div>
                  <h4 className="text-sm font-medium text-gray-900 mb-1">
                    Shipping Address
                  </h4>
                  <div className="text-sm text-gray-600">
                    <p>
                      {order.shippingAddress.firstName}{' '}
                      {order.shippingAddress.lastName}
                    </p>
                    <p>{order.shippingAddress.addressLine1}</p>
                    {order.shippingAddress.addressLine2 && (
                      <p>{order.shippingAddress.addressLine2}</p>
                    )}
                    <p>
                      {order.shippingAddress.city},{' '}
                      {order.shippingAddress.state}{' '}
                      {order.shippingAddress.postalCode}
                    </p>
                  </div>
                </div>

                {order.trackingNumber && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-900 mb-1">
                      Tracking
                    </h4>
                    <div className="text-sm text-gray-600">
                      <p>
                        <span className="font-medium">
                          {order.shippingCarrier || 'Carrier'}:
                        </span>{' '}
                        {order.trackingNumber}
                      </p>
                      {order.estimatedDelivery && (
                        <p>
                          Est. delivery:{' '}
                          {new Date(
                            order.estimatedDelivery
                          ).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex justify-between items-center pt-4 border-t border-gray-200">
                <div className="flex space-x-4">
                  <Link
                    to="/orders/$orderId"
                    params={{ orderId: order.id }}
                    className="text-zava-600 hover:text-zava-500 text-sm font-medium"
                  >
                    View Details
                  </Link>

                  {order.status === 'delivered' && (
                    <button
                      onClick={() => {
                        // TODO: Implement reorder functionality
                        alert('Reorder functionality will be implemented');
                      }}
                      className="text-zava-600 hover:text-zava-500 text-sm font-medium"
                    >
                      Reorder
                    </button>
                  )}

                  {order.status === 'pending' && (
                    <button
                      onClick={async () => {
                        if (
                          confirm('Are you sure you want to cancel this order?')
                        ) {
                          try {
                            await orderService.cancelOrder(order.id);
                            // Refresh orders list
                            window.location.reload();
                          } catch (err) {
                            console.error('Failed to cancel order:', err);
                            alert(
                              'Failed to cancel order. Please contact support.'
                            );
                          }
                        }
                      }}
                      className="text-red-600 hover:text-red-500 text-sm font-medium"
                    >
                      Cancel Order
                    </button>
                  )}
                </div>

                {order.status === 'shipped' && order.trackingNumber && (
                  <a
                    href={`https://www.${order.shippingCarrier?.toLowerCase() || 'fedex'}.com/apps/fedextrack/?tracknumbers=${order.trackingNumber}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-zava-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-zava-700"
                  >
                    Track Package
                  </a>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
