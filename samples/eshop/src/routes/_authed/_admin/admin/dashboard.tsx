import { createFileRoute, Link } from '@tanstack/react-router';
import { Order } from 'rayfin/data/Order';
import { Product } from 'rayfin/data/Product';

import { ServiceContainer } from '../../../../services/ServiceContainer';

export const Route = createFileRoute('/_authed/_admin/admin/dashboard')({
  component: AdminDashboardComponent,
  loader: async () => {
    // Load dashboard data
    const serviceContainer = ServiceContainer.getInstance();
    const productService = serviceContainer.productService;
    const orderService = serviceContainer.orderService;
    const customerService = serviceContainer.customerService;

    try {
      const [products, customers, orders] = await Promise.all([
        productService.getProducts(),
        customerService.getProfile(),
        orderService.getAllOrders(),
      ]);

      return {
        totalProducts: products.length,
        totalOrders: orders.length * products.length, // Mocked for demo
        totalCustomers: 4631, // Mocked for demo
        totalRevenue: orders.reduce((acc, order) => acc + order.total, 0),
        recentOrders: orders.slice(0, 5),
        topProducts: products
          .sort((a, b) => b.stockQuantity - a.stockQuantity)
          .slice(0, 5),
      };
    } catch (error) {
      console.error('Failed to load dashboard data:', error);
      return {
        totalProducts: 0,
        totalCustomers: 0,
        totalOrders: 0,
        totalRevenue: 0,
        recentOrders: [],
        topProducts: [],
      };
    }
  },
});

function AdminDashboardComponent() {
  const {
    totalProducts,
    totalCustomers,
    totalOrders,
    totalRevenue,
    recentOrders,
    topProducts,
  } = Route.useLoaderData();

  const stats = [
    {
      name: 'Total Revenue',
      value: `$${totalRevenue.toLocaleString()}`,
      icon: '💰',
      change: '+12%',
      changeType: 'positive' as const,
    },
    {
      name: 'Total Orders',
      value: totalOrders.toString(),
      icon: '🛒',
      change: '+8%',
      changeType: 'positive' as const,
    },
    {
      name: 'Total Customers',
      value: totalCustomers?.toString() || '0',
      icon: '👥',
      change: '+15%',
      changeType: 'positive' as const,
    },
    {
      name: 'Total Products',
      value: totalProducts.toString(),
      icon: '📦',
      change: '+3%',
      changeType: 'positive' as const,
    },
  ];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-600">Welcome to your admin dashboard</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        {stats.map((stat) => (
          <div
            key={stat.name}
            className="bg-white rounded-lg shadow-sm border border-gray-200 p-6"
          >
            <div className="flex items-center">
              <div className="text-2xl mr-3">{stat.icon}</div>
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-600">{stat.name}</p>
                <p className="text-2xl font-bold text-gray-900">{stat.value}</p>
              </div>
            </div>
            <div className="mt-2">
              <span
                className={`text-sm font-medium ${
                  stat.changeType === 'positive'
                    ? 'text-green-600'
                    : 'text-red-600'
                }`}
              >
                {stat.change}
              </span>
              <span className="text-sm text-gray-500"> from last month</span>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Recent Orders */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="p-6 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">
              Recent Orders
            </h2>
          </div>
          <div className="p-6">
            {recentOrders.length > 0 ? (
              <div className="space-y-4">
                {recentOrders.map((order: Order) => (
                  <div
                    key={order.id}
                    className="flex items-center justify-between"
                  >
                    <div>
                      <p className="font-medium text-gray-900">
                        <Link
                          to={`/admin/orders/$orderId/edit`}
                          params={{ orderId: order.id }}
                          className="hover:underline"
                        >
                          #{order.id}
                        </Link>
                      </p>
                      <p className="text-sm text-gray-500">
                        {order.customer?.firstName} {order.customer?.lastName}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-medium text-gray-900">
                        ${order.total}
                      </p>
                      <span
                        className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${
                          order.status === 'shipped'
                            ? 'bg-green-100 text-green-800'
                            : order.status === 'pending'
                              ? 'bg-yellow-100 text-yellow-800'
                              : 'bg-gray-100 text-gray-800'
                        }`}
                      >
                        {order.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-6">
                <div className="text-gray-500 mb-2">
                  <svg
                    className="mx-auto h-8 w-8"
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
                <p className="text-gray-500">No recent orders</p>
              </div>
            )}
          </div>
        </div>

        {/* Top Products */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="p-6 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">
              Top Products
            </h2>
          </div>
          <div className="p-6">
            {topProducts.length > 0 ? (
              <div className="space-y-4">
                {topProducts.map((product: Product) => (
                  <div key={product.id} className="flex items-center">
                    <img
                      src={product.imageUrl || '/placeholder-product.jpg'}
                      alt={product.name}
                      className="h-12 w-12 rounded-lg object-cover"
                    />
                    <div className="ml-4 flex-1">
                      <p className="font-medium text-gray-900">
                        {product.name}
                      </p>
                      <p className="text-sm text-gray-500">
                        ${product.basePrice} per unit
                      </p>
                    </div>
                    <div className="text-sm text-gray-500">
                      {product.stockQuantity || 0} in stock
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-6">
                <div className="text-gray-500 mb-2">
                  <svg
                    className="mx-auto h-8 w-8"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                    />
                  </svg>
                </div>
                <p className="text-gray-500">No products available</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          Quick Actions
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Link
            to="/admin/products/new"
            className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 hover:border-zava-300 transition-colors"
          >
            <div className="text-center">
              <div className="text-3xl mb-2">➕</div>
              <h3 className="font-medium text-gray-900">Add Product</h3>
              <p className="text-sm text-gray-500">
                Create a new product listing
              </p>
            </div>
          </Link>
          <Link
            to="/admin/categories/new"
            className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 hover:border-zava-300 transition-colors"
          >
            <div className="text-center">
              <div className="text-3xl mb-2">📂</div>
              <h3 className="font-medium text-gray-900">Add Category</h3>
              <p className="text-sm text-gray-500">
                Create a new product category
              </p>
            </div>
          </Link>
          <Link
            to="/admin/orders"
            className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 hover:border-zava-300 transition-colors"
          >
            <div className="text-center">
              <div className="text-3xl mb-2">📋</div>
              <h3 className="font-medium text-gray-900">Manage Orders</h3>
              <p className="text-sm text-gray-500">View and process orders</p>
            </div>
          </Link>
        </div>
      </div>
    </div>
  );
}
