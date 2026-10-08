import type { Order } from '../../../rayfin/data/Order';
import type { OrderItem } from '../../../rayfin/data/OrderItem';

export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded';
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'refunded';

export interface CreateOrderData {
  shippingAddressId: string;
  billingAddressId: string;
  paymentMethod: string;
  notes?: string;
}

export interface CreateOrderItemData {
  productId: string;
  variantId?: string;
  quantity: number;
  override?: 'add' | 'remove';
}

export interface UpdateOrderItemData {
  quantity?: number;
  override?: 'add' | 'remove';
}

export interface OrderFilters {
  status?: OrderStatus[];
  paymentStatus?: PaymentStatus[];
  dateFrom?: Date;
  dateTo?: Date;
  customerId?: string;
  search?: string; // Search by order number or customer name
  sortBy?: 'orderNumber' | 'createdAt' | 'total' | 'status';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

/**
 * Interface for order management operations
 */
export interface IOrderService {
  /**
   * Get orders for current customer
   */
  getOrders(): Promise<Order[]>;

  /**
   * Get order by ID
   */
  getOrder(id: string): Promise<Order | null>;

  /**
   * Create order from current cart
   */
  createOrder(orderData: CreateOrderData): Promise<Order>;

  /**
   * Get order items for an order
   */
  getOrderItems(orderId: string): Promise<OrderItem[]>;

  /**
   * Cancel order (if still pending/confirmed)
   */
  cancelOrder(orderId: string): Promise<Order>;

  // Admin operations
  /**
   * Get all orders with filtering (admin only)
   */
  getAllOrders(filters?: OrderFilters): Promise<Order[]>;

  /**
   * Update order status (admin only)
   */
  updateOrderStatus(orderId: string, status: OrderStatus): Promise<Order>;

  /**
   * Update order details (admin only)
   */
  updateOrder(orderId: string, updates: Partial<Order>): Promise<Order>;

  /**
   * Add tracking information (admin only)
   */
  updateTracking(
    orderId: string,
    trackingNumber: string,
    carrier: string
  ): Promise<Order>;

  /**
   * Process refund (admin only)
   */
  processRefund(orderId: string, amount?: number): Promise<Order>;

  /**
   * Add item to order (admin only)
   */
  addOrderItem(
    orderId: string,
    itemData: CreateOrderItemData
  ): Promise<OrderItem>;

  /**
   * Update order item (admin only)
   */
  updateOrderItem(
    itemId: string,
    updates: UpdateOrderItemData
  ): Promise<OrderItem>;

  /**
   * Remove order item (admin only) - sets override to 'remove'
   */
  removeOrderItem(itemId: string): Promise<OrderItem>;

  /**
   * Recalculate and update order totals based on current order items (admin only)
   */
  recalculateOrderTotals(orderId: string): Promise<Order>;

  /**
   * Get order statistics (admin only)
   */
  getOrderStats(): Promise<{
    totalOrders: number;
    totalRevenue: number;
    averageOrderValue: number;
    ordersByStatus: Record<OrderStatus, number>;
  }>;
}
