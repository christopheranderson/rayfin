import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';

import { Order } from '../../../../../rayfin/data/Order';
import { OrderItem } from '../../../../../rayfin/data/OrderItem';
import { Product } from '../../../../../rayfin/data/Product';
import { ProductVariant } from '../../../../../rayfin/data/ProductVariant';
import { ServiceContainer } from '../../../../services/ServiceContainer';
import type { OrderStatus } from '../../../../services/interfaces/IOrderService';

export const Route = createFileRoute(
  '/_authed/_admin/admin/orders/$orderId/edit'
)({
  component: OrderEditComponent,
  loader: async ({ params }) => {
    const serviceContainer = ServiceContainer.getInstance();
    const orderService = serviceContainer.orderService;
    const productService = serviceContainer.productService;

    try {
      const [order, orderItems, products] = await Promise.all([
        orderService.getOrder(params.orderId),
        orderService.getOrderItems(params.orderId),
        productService.getProducts(), // Get all products for adding new items
      ]);

      if (!order) {
        throw new Error('Order not found');
      }

      return { order, orderItems, products };
    } catch (error) {
      console.error('Failed to load order:', error);
      throw new Error('Failed to load order');
    }
  },
});

interface OrderItemWithChanges extends OrderItem {
  isModified?: boolean;
  originalQuantity?: number;
}

function OrderEditComponent() {
  const {
    order: initialOrder,
    orderItems: initialOrderItems,
    products,
  } = Route.useLoaderData();
  const navigate = useNavigate();
  const [order, setOrder] = useState<Order>(initialOrder);
  const [orderItems, setOrderItems] = useState<OrderItemWithChanges[]>(
    initialOrderItems.map((item) => ({
      ...item,
      originalQuantity: item.quantity,
    }))
  );
  const [loading, setLoading] = useState(false);
  const [showAddItem, setShowAddItem] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<string>('');
  const [selectedVariant, setSelectedVariant] = useState<string>('');
  const [newItemQuantity, setNewItemQuantity] = useState(1);
  const [availableVariants, setAvailableVariants] = useState<ProductVariant[]>(
    []
  );

  const serviceContainer = ServiceContainer.getInstance();
  const orderService = serviceContainer.orderService;
  const productService = serviceContainer.productService;

  // Fetch variants when product is selected
  useEffect(() => {
    const fetchVariants = async () => {
      if (selectedProduct) {
        try {
          // This would typically be a method in ProductService
          // For now, we'll keep the variant selection simple
          setAvailableVariants([]);
          setSelectedVariant('');
        } catch (error) {
          console.error('Failed to fetch variants:', error);
          setAvailableVariants([]);
        }
      } else {
        setAvailableVariants([]);
        setSelectedVariant('');
      }
    };

    fetchVariants();
  }, [selectedProduct]);

  const handleOrderUpdate = async (updates: Partial<Order>) => {
    setLoading(true);
    try {
      const updatedOrder = await orderService.updateOrder(order.id, updates);
      setOrder(updatedOrder);
    } catch (error) {
      console.error('Failed to update order:', error);
      alert('Failed to update order');
    } finally {
      setLoading(false);
    }
  };

  const handleStatusChange = async (status: OrderStatus) => {
    await handleOrderUpdate({ status });
  };

  const handleItemQuantityChange = (itemId: string, quantity: number) => {
    setOrderItems((items) =>
      items.map((item) =>
        item.id === itemId
          ? {
              ...item,
              quantity,
              isModified: quantity !== item.originalQuantity,
            }
          : item
      )
    );
  };

  const handleUpdateOrderItem = async (itemId: string) => {
    const item = orderItems.find((i) => i.id === itemId);
    if (!item || !item.isModified) return;

    setLoading(true);
    try {
      const updatedItem = await orderService.updateOrderItem(itemId, {
        quantity: item.quantity,
      });
      setOrderItems((items) =>
        items.map((i) =>
          i.id === itemId
            ? {
                ...updatedItem,
                originalQuantity: updatedItem.quantity,
                isModified: false,
              }
            : i
        )
      );

      // Recalculate order totals after updating item quantity
      const updatedOrder = await orderService.recalculateOrderTotals(order.id);
      setOrder(updatedOrder);
    } catch (error) {
      console.error('Failed to update order item:', error);
      alert('Failed to update order item');
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveOrderItem = async (itemId: string) => {
    if (
      !confirm(
        'Are you sure you want to remove this item? It will be marked as removed but not deleted.'
      )
    )
      return;

    setLoading(true);
    try {
      const updatedItem = await orderService.removeOrderItem(itemId);
      setOrderItems((items) =>
        items.map((item) => (item.id === itemId ? updatedItem : item))
      );

      // Recalculate order totals after removing item
      const updatedOrder = await orderService.recalculateOrderTotals(order.id);
      setOrder(updatedOrder);
    } catch (error) {
      console.error('Failed to remove order item:', error);
      alert('Failed to remove order item');
    } finally {
      setLoading(false);
    }
  };

  const handleAddOrderItem = async () => {
    if (!selectedProduct) {
      alert('Please select a product');
      return;
    }

    setLoading(true);
    try {
      const newItem = await orderService.addOrderItem(order.id, {
        productId: selectedProduct,
        variantId: selectedVariant || undefined,
        quantity: newItemQuantity,
        override: 'add',
      });
      setOrderItems((items) => [
        ...items,
        { ...newItem, originalQuantity: newItem.quantity },
      ]);
      setShowAddItem(false);
      setSelectedProduct('');
      setSelectedVariant('');
      setNewItemQuantity(1);
      setAvailableVariants([]);

      // Recalculate order totals after adding item
      const updatedOrder = await orderService.recalculateOrderTotals(order.id);
      setOrder(updatedOrder);
    } catch (error) {
      console.error('Failed to add order item:', error);
      alert('Failed to add order item');
    } finally {
      setLoading(false);
    }
  };

  const handleRestoreOrderItem = async (itemId: string) => {
    if (!confirm('Are you sure you want to restore this item to the order?'))
      return;

    setLoading(true);
    try {
      // Remove the override by setting it to undefined
      const updatedItem = await orderService.updateOrderItem(itemId, {
        override: undefined,
      });
      setOrderItems((items) =>
        items.map((item) =>
          item.id === itemId
            ? { ...updatedItem, originalQuantity: updatedItem.quantity }
            : item
        )
      );

      // Recalculate order totals after restoring item
      const updatedOrder = await orderService.recalculateOrderTotals(order.id);
      setOrder(updatedOrder);
    } catch (error) {
      console.error('Failed to restore order item:', error);
      alert('Failed to restore order item');
    } finally {
      setLoading(false);
    }
  };

  const handleRestoreAllRemovedItems = async () => {
    const removedItemsCount = removedItems.length;
    if (
      !confirm(
        `Are you sure you want to restore all ${removedItemsCount} removed item(s) to the order?`
      )
    )
      return;

    setLoading(true);
    try {
      // Restore all removed items in parallel
      const restorePromises = removedItems.map((item) =>
        orderService.updateOrderItem(item.id, { override: undefined })
      );

      const restoredItems = await Promise.all(restorePromises);

      // Update the state with restored items
      setOrderItems((items) =>
        items.map((item) => {
          const restoredItem = restoredItems.find(
            (restored) => restored.id === item.id
          );
          return restoredItem
            ? { ...restoredItem, originalQuantity: restoredItem.quantity }
            : item;
        })
      );

      // Recalculate order totals after restoring all items
      const updatedOrder = await orderService.recalculateOrderTotals(order.id);
      setOrder(updatedOrder);
    } catch (error) {
      console.error('Failed to restore order items:', error);
      alert('Failed to restore some order items');
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadgeClass = (status: string) => {
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

  const getPaymentStatusBadgeClass = (status: string) => {
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

  const getItemPrice = (item: OrderItem) => {
    return item.variant?.originalPrice || item.product?.basePrice || 0;
  };

  const calculateItemTotal = (item: OrderItem) => {
    return getItemPrice(item) * item.quantity;
  };

  const formatDate = (date: Date) => {
    return new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const activeItems = orderItems.filter((item) => item.override !== 'remove');
  const removedItems = orderItems.filter((item) => item.override === 'remove');

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold text-gray-900">
              Edit Order #{order.orderNumber}
            </h1>
            {order.needsOverride && (
              <span className="inline-flex items-center px-3 py-1 text-sm font-medium rounded-full bg-orange-100 text-orange-800 border border-orange-200">
                <svg
                  className="w-4 h-4 mr-1.5"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                    clipRule="evenodd"
                  />
                </svg>
                Needs Review
              </span>
            )}
          </div>
          <p className="text-gray-600 mt-1">
            Created {formatDate(order.createdAt)}
          </p>
        </div>
        <div className="flex gap-3">
          <Link
            to="/admin/orders"
            className="bg-gray-500 hover:bg-gray-600 text-white px-4 py-2 rounded-md font-medium transition-colors"
          >
            Back to Orders
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Order Details */}
        <div className="lg:col-span-2 space-y-6">
          {/* Order Info */}
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold">Order Information</h2>
              {order.needsOverride && (
                <div className="flex items-center px-3 py-1 text-sm font-medium rounded-md bg-orange-50 text-orange-700 border border-orange-200">
                  <svg
                    className="w-4 h-4 mr-1.5"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                      clipRule="evenodd"
                    />
                  </svg>
                  Manual Review Required
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Status
                </label>
                <select
                  value={order.status}
                  onChange={(e) =>
                    handleStatusChange(e.target.value as OrderStatus)
                  }
                  disabled={loading}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="pending">Pending</option>
                  <option value="confirmed">Confirmed</option>
                  <option value="processing">Processing</option>
                  <option value="shipped">Shipped</option>
                  <option value="delivered">Delivered</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="refunded">Refunded</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Payment Status
                </label>
                <span
                  className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getPaymentStatusBadgeClass(order.paymentStatus)}`}
                >
                  {order.paymentStatus.charAt(0).toUpperCase() +
                    order.paymentStatus.slice(1)}
                </span>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Tracking Number
                </label>
                <input
                  type="text"
                  value={order.trackingNumber || ''}
                  onChange={(e) =>
                    setOrder({ ...order, trackingNumber: e.target.value })
                  }
                  onBlur={() =>
                    handleOrderUpdate({ trackingNumber: order.trackingNumber })
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Enter tracking number"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Shipping Carrier
                </label>
                <input
                  type="text"
                  value={order.shippingCarrier || ''}
                  onChange={(e) =>
                    setOrder({ ...order, shippingCarrier: e.target.value })
                  }
                  onBlur={() =>
                    handleOrderUpdate({
                      shippingCarrier: order.shippingCarrier,
                    })
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Enter carrier name"
                />
              </div>
            </div>
            <div className="mt-4 pt-4 border-t">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={order.needsOverride || false}
                  onChange={(e) =>
                    handleOrderUpdate({ needsOverride: e.target.checked })
                  }
                  className="mr-2 rounded border-gray-300 text-blue-600 shadow-sm focus:border-blue-300 focus:ring focus:ring-blue-200 focus:ring-opacity-50"
                />
                <span className="text-sm font-medium text-gray-700">
                  Flag this order for manual review
                </span>
              </label>
            </div>
            <div className="mt-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Notes
              </label>
              <textarea
                value={order.notes || ''}
                onChange={(e) => setOrder({ ...order, notes: e.target.value })}
                onBlur={() => handleOrderUpdate({ notes: order.notes })}
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Add order notes..."
              />
            </div>
          </div>

          {/* Order Items */}
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold">Order Items</h2>
              {order.needsOverride ? (
                <button
                  onClick={() => setShowAddItem(true)}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md font-medium transition-colors"
                >
                  Add Item
                </button>
              ) : (
                <div className="text-sm text-gray-500 italic">
                  Item modifications require manual review flag
                </div>
              )}
            </div>

            {!order.needsOverride && (
              <div className="mb-4 p-3 rounded-md bg-blue-50 border border-blue-200">
                <div className="flex items-center">
                  <svg
                    className="w-4 h-4 mr-2 text-blue-600"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <p className="text-sm text-blue-700">
                    <strong>Item modifications are disabled.</strong> To add,
                    remove, or restore items, please enable the "Flag this order
                    for manual review" option above.
                  </p>
                </div>
              </div>
            )}

            {/* Add Item Form */}
            {showAddItem && order.needsOverride && (
              <div className="mb-6 p-4 border rounded-lg bg-gray-50">
                <h3 className="font-medium mb-3">Add New Item</h3>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div>
                    <select
                      value={selectedProduct}
                      onChange={(e) => setSelectedProduct(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Select Product</option>
                      {products.map((product) => (
                        <option key={product.id} value={product.id}>
                          {product.name} (${product.basePrice})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <select
                      value={selectedVariant}
                      onChange={(e) => setSelectedVariant(e.target.value)}
                      disabled={!selectedProduct}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                    >
                      <option value="">No Variant</option>
                      {availableVariants.map((variant) => {
                        const selectedProd = products.find(
                          (p) => p.id === selectedProduct
                        );
                        const priceDiff =
                          variant.originalPrice && selectedProd
                            ? variant.originalPrice - selectedProd.basePrice
                            : 0;

                        return (
                          <option key={variant.id} value={variant.id}>
                            {variant.size} - {variant.color}
                            {priceDiff !== 0 &&
                              ` (${priceDiff > 0 ? '+' : ''}$${priceDiff.toFixed(2)})`}
                          </option>
                        );
                      })}
                      {availableVariants.length === 0 && selectedProduct && (
                        <option value="" disabled>
                          No variants available
                        </option>
                      )}
                    </select>
                  </div>
                  <div>
                    <input
                      type="number"
                      min="1"
                      value={newItemQuantity}
                      onChange={(e) =>
                        setNewItemQuantity(parseInt(e.target.value) || 1)
                      }
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="Quantity"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleAddOrderItem}
                      disabled={loading || !selectedProduct}
                      className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md font-medium transition-colors disabled:opacity-50"
                    >
                      Add
                    </button>
                    <button
                      onClick={() => {
                        setShowAddItem(false);
                        setSelectedProduct('');
                        setSelectedVariant('');
                        setNewItemQuantity(1);
                        setAvailableVariants([]);
                      }}
                      className="bg-gray-500 hover:bg-gray-600 text-white px-4 py-2 rounded-md font-medium transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Active Items */}
            <div className="space-y-4">
              {activeItems.map((item) => (
                <div
                  key={item.id}
                  className={`border rounded-lg p-4 ${item.override ? 'border-green-200 bg-green-50' : ''}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-4">
                      <img
                        src={
                          item?.product?.imageUrl || '/placeholder-product.jpg'
                        }
                        alt={item?.productName}
                        className="w-16 h-16 object-cover rounded-lg"
                      />
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-medium">{item?.productName}</h3>
                          {item.override === 'add' && (
                            <span className="inline-flex items-center px-2 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800 border border-green-200">
                              <svg
                                className="w-3 h-3 mr-1"
                                fill="currentColor"
                                viewBox="0 0 20 20"
                              >
                                <path
                                  fillRule="evenodd"
                                  d="M10 5a1 1 0 011 1v3h3a1 1 0 110 2h-3v3a1 1 0 11-2 0v-3H6a1 1 0 110-2h3V6a1 1 0 011-1z"
                                  clipRule="evenodd"
                                />
                              </svg>
                              Added to Order
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-gray-500">
                          SKU: {item?.productSku}
                        </p>
                        {item?.variantName && (
                          <p className="text-sm text-gray-500">
                            Variant: {item?.variantName}
                          </p>
                        )}
                        <p className="text-sm font-medium">
                          ${getItemPrice(item).toFixed(2)} each
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center space-x-4">
                      <div className="flex items-center space-x-2">
                        <label className="text-sm font-medium">Qty:</label>
                        <input
                          type="number"
                          min="1"
                          value={item?.quantity}
                          onChange={(e) =>
                            handleItemQuantityChange(
                              item.id,
                              parseInt(e.target.value) || 1
                            )
                          }
                          className="w-20 px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        {item.isModified && (
                          <button
                            onClick={() => handleUpdateOrderItem(item.id)}
                            disabled={loading}
                            className="bg-green-600 hover:bg-green-700 text-white px-2 py-1 rounded text-xs transition-colors disabled:opacity-50"
                          >
                            Save
                          </button>
                        )}
                      </div>
                      <div className="text-right">
                        <p className="font-medium">
                          ${calculateItemTotal(item).toFixed(2)}
                        </p>
                      </div>
                      {order.needsOverride ? (
                        <button
                          onClick={() => handleRemoveOrderItem(item.id)}
                          disabled={loading}
                          className="text-red-600 hover:text-red-800 transition-colors disabled:opacity-50"
                        >
                          Remove
                        </button>
                      ) : (
                        <div className="w-16 flex justify-center">
                          <span className="text-xs text-gray-400 italic">
                            Locked
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Removed Items */}
            {removedItems.length > 0 && (
              <div className="mt-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-medium text-gray-700 flex items-center">
                    <svg
                      className="w-4 h-4 mr-2 text-red-500"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                        clipRule="evenodd"
                      />
                    </svg>
                    Removed Items ({removedItems.length})
                  </h3>
                  {removedItems.length > 1 && order.needsOverride && (
                    <button
                      onClick={handleRestoreAllRemovedItems}
                      disabled={loading}
                      className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded text-sm font-medium transition-colors disabled:opacity-50 flex items-center"
                    >
                      <svg
                        className="w-4 h-4 mr-1"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                      >
                        <path
                          fillRule="evenodd"
                          d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z"
                          clipRule="evenodd"
                        />
                      </svg>
                      Restore All
                    </button>
                  )}
                </div>
                <div className="space-y-2">
                  {removedItems.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between p-3 bg-red-50 border border-red-200 rounded-lg"
                    >
                      <div className="flex items-center space-x-3">
                        <img
                          src={
                            item.product.imageUrl || '/placeholder-product.jpg'
                          }
                          alt={item.productName}
                          className="w-12 h-12 object-cover rounded-lg opacity-75"
                        />
                        <div>
                          <h4 className="font-medium text-gray-700">
                            {item.productName}
                          </h4>
                          <p className="text-sm text-gray-500">
                            Qty: {item.quantity}
                          </p>
                          <p className="text-sm text-gray-500">
                            SKU: {item.productSku}
                          </p>
                          {item.variantName && (
                            <p className="text-sm text-gray-500">
                              Variant: {item.variantName}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center space-x-3">
                        <span className="inline-flex items-center px-2 py-1 text-xs font-semibold rounded-full bg-red-100 text-red-800 border border-red-200">
                          <svg
                            className="w-3 h-3 mr-1"
                            fill="currentColor"
                            viewBox="0 0 20 20"
                          >
                            <path
                              fillRule="evenodd"
                              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                              clipRule="evenodd"
                            />
                          </svg>
                          Removed from Order
                        </span>
                        {order.needsOverride ? (
                          <button
                            onClick={() => handleRestoreOrderItem(item.id)}
                            disabled={loading}
                            className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded text-xs font-medium transition-colors disabled:opacity-50 flex items-center"
                          >
                            <svg
                              className="w-3 h-3 mr-1"
                              fill="currentColor"
                              viewBox="0 0 20 20"
                            >
                              <path
                                fillRule="evenodd"
                                d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z"
                                clipRule="evenodd"
                              />
                            </svg>
                            Undo
                          </button>
                        ) : (
                          <span className="text-xs text-gray-400 italic px-3 py-1">
                            Locked
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeItems.length === 0 && (
              <div className="text-center py-8 text-gray-500">
                No active items in this order
              </div>
            )}
          </div>
        </div>

        {/* Order Summary */}
        <div className="space-y-6">
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-lg font-semibold mb-4">Customer Information</h3>
            <div className="space-y-3">
              <div>
                <p className="font-medium">
                  {order.customer.firstName} {order.customer.lastName}
                </p>
                <p className="text-sm text-gray-500">
                  Customer ID: {order.customer.id}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-lg font-semibold mb-4">Order Summary</h3>

            {/* Override Summary */}
            {(order.needsOverride ||
              orderItems.some((item) => item.override)) && (
              <div className="mb-4 p-3 rounded-md bg-amber-50 border border-amber-200">
                <h4 className="text-sm font-medium text-amber-800 mb-2">
                  Order Modifications
                </h4>
                <div className="space-y-1 text-sm text-amber-700">
                  {order.needsOverride && (
                    <div className="flex items-center">
                      <svg
                        className="w-4 h-4 mr-1.5"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                      >
                        <path
                          fillRule="evenodd"
                          d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                          clipRule="evenodd"
                        />
                      </svg>
                      Order flagged for manual review
                    </div>
                  )}
                  {orderItems.filter((item) => item.override === 'add').length >
                    0 && (
                    <div className="flex items-center">
                      <svg
                        className="w-4 h-4 mr-1.5"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                      >
                        <path
                          fillRule="evenodd"
                          d="M10 5a1 1 0 011 1v3h3a1 1 0 110 2h-3v3a1 1 0 11-2 0v-3H6a1 1 0 110-2h3V6a1 1 0 011-1z"
                          clipRule="evenodd"
                        />
                      </svg>
                      {
                        orderItems.filter((item) => item.override === 'add')
                          .length
                      }{' '}
                      item(s) added
                    </div>
                  )}
                  {orderItems.filter((item) => item.override === 'remove')
                    .length > 0 && (
                    <div className="flex items-center">
                      <svg
                        className="w-4 h-4 mr-1.5"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                      >
                        <path
                          fillRule="evenodd"
                          d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                          clipRule="evenodd"
                        />
                      </svg>
                      {
                        orderItems.filter((item) => item.override === 'remove')
                          .length
                      }{' '}
                      item(s) removed
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="space-y-2">
              <div className="flex justify-between">
                <span>Subtotal:</span>
                <span>${order.subtotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>Tax:</span>
                <span>${order.tax.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>Shipping:</span>
                <span>${order.shipping.toFixed(2)}</span>
              </div>
              {order.discount > 0 && (
                <div className="flex justify-between text-green-600">
                  <span>Discount:</span>
                  <span>-${order.discount.toFixed(2)}</span>
                </div>
              )}
              <hr className="my-2" />
              <div className="flex justify-between font-semibold text-lg">
                <span>Total:</span>
                <span>
                  ${order.total.toFixed(2)} {order.currency}
                </span>
              </div>
            </div>
          </div>

          {/* Addresses */}
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-lg font-semibold mb-4">Addresses</h3>
            <div className="space-y-4">
              <div>
                <h4 className="font-medium text-sm text-gray-700">
                  Shipping Address
                </h4>
                <div className="text-sm">
                  <p>
                    {order.shippingAddress.firstName}{' '}
                    {order.shippingAddress.lastName}
                  </p>
                  <p>{order.shippingAddress.addressLine1}</p>
                  {order.shippingAddress.addressLine2 && (
                    <p>{order.shippingAddress.addressLine2}</p>
                  )}
                  <p>
                    {order.shippingAddress.city}, {order.shippingAddress.state}{' '}
                    {order.shippingAddress.postalCode}
                  </p>
                  <p>{order.shippingAddress.country}</p>
                </div>
              </div>
              <div>
                <h4 className="font-medium text-sm text-gray-700">
                  Billing Address
                </h4>
                <div className="text-sm">
                  <p>
                    {order.billingAddress.firstName}{' '}
                    {order.billingAddress.lastName}
                  </p>
                  <p>{order.billingAddress.addressLine1}</p>
                  {order.billingAddress.addressLine2 && (
                    <p>{order.billingAddress.addressLine2}</p>
                  )}
                  <p>
                    {order.billingAddress.city}, {order.billingAddress.state}{' '}
                    {order.billingAddress.postalCode}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
