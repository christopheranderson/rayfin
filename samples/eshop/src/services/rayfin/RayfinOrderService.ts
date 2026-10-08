import type { RayfinClient } from '@microsoft/rayfin-client';

import type { Order } from '../../../rayfin/data/Order';
import type { OrderItem } from '../../../rayfin/data/OrderItem';
import type { ZavaEshopSchema } from '../../../rayfin/data/schema';
import { ServiceContainer } from '../ServiceContainer';
import type {
  IOrderService,
  CreateOrderData,
  CreateOrderItemData,
  UpdateOrderItemData,
  OrderFilters,
  OrderStatus,
} from '../interfaces/IOrderService';

import { getRayfinClient } from './RayfinClientService';

/**
 * Implementation of IOrderService using \@microsoft/rayfin-data GraphQL fluent interface
 */
export class RayfinOrderService implements IOrderService {
  private rayfinClient: RayfinClient<ZavaEshopSchema>;

  constructor() {
    this.rayfinClient = getRayfinClient();
  }

  async getOrders(): Promise<Order[]> {
    try {
      // Get orders for the current authenticated user
      // User filtering is handled automatically by DAB through JWT claims and RLS
      const orders = await this.rayfinClient.data.Order.select([
        'id',
        'orderNumber',
        'status',
        'subtotal',
        'tax',
        'shipping',
        'discount',
        'total',
        'currency',
        'paymentStatus',
        'paymentMethod',
        'trackingNumber',
        'shippingCarrier',
        'needsOverride',
        'estimatedDelivery',
        'deliveredAt',
        'notes',
        'createdAt',
        'updatedAt',
        'customer.id',
        'customer.firstName',
        'customer.lastName',
        'shippingAddress.id',
        'shippingAddress.firstName',
        'shippingAddress.lastName',
        'shippingAddress.addressLine1',
        'shippingAddress.addressLine2',
        'shippingAddress.city',
        'shippingAddress.state',
        'shippingAddress.postalCode',
        'shippingAddress.country',
        'billingAddress.id',
        'billingAddress.firstName',
        'billingAddress.lastName',
        'billingAddress.addressLine1',
        'billingAddress.addressLine2',
        'billingAddress.city',
        'billingAddress.state',
        'billingAddress.postalCode',
        'billingAddress.country',
      ])
        .orderBy({ createdAt: 'desc' })
        .execute();

      return orders;
    } catch (error) {
      console.error('RayfinOrderService.getOrders error:', error);
      throw new Error('Failed to fetch orders');
    }
  }

  async getOrder(id: string): Promise<Order | null> {
    try {
      // Get a specific order by ID for the current authenticated user
      // User filtering is handled automatically by DAB through JWT claims and RLS
      const orders = await this.rayfinClient.data.Order.select([
        'id',
        'orderNumber',
        'status',
        'subtotal',
        'tax',
        'shipping',
        'discount',
        'total',
        'currency',
        'paymentStatus',
        'paymentMethod',
        'trackingNumber',
        'shippingCarrier',
        'needsOverride',
        'estimatedDelivery',
        'deliveredAt',
        'notes',
        'createdAt',
        'updatedAt',
        'customer.id',
        'customer.firstName',
        'customer.lastName',
        'shippingAddress.id',
        'shippingAddress.firstName',
        'shippingAddress.lastName',
        'shippingAddress.addressLine1',
        'shippingAddress.addressLine2',
        'shippingAddress.city',
        'shippingAddress.state',
        'shippingAddress.postalCode',
        'shippingAddress.country',
        'billingAddress.id',
        'billingAddress.firstName',
        'billingAddress.lastName',
        'billingAddress.addressLine1',
        'billingAddress.addressLine2',
        'billingAddress.city',
        'billingAddress.state',
        'billingAddress.postalCode',
        'billingAddress.country',
      ])
        .where({ id: { eq: id } })
        .first(1)
        .execute();

      return orders[0] || null;
    } catch (error) {
      console.error('RayfinOrderService.getOrder error:', error);
      throw new Error('Failed to fetch order');
    }
  }

  async createOrder(orderData: CreateOrderData): Promise<Order> {
    try {
      // Get services from ServiceContainer
      const { cartService, customerService, addressService } =
        ServiceContainer.getInstance();

      // 1. Get cart items for the current user
      const cartItems = await cartService.getCart();
      if (cartItems.length === 0) {
        throw new Error('Cannot create order with empty cart');
      }

      // 2. Get current customer profile
      const customer = await customerService.getProfile();
      if (!customer) {
        throw new Error('Customer profile not found');
      }

      // 3. Get shipping and billing addresses
      const shippingAddress = await addressService.getAddress(
        orderData.shippingAddressId
      );
      if (!shippingAddress) {
        throw new Error('Shipping address not found');
      }

      const billingAddress = await addressService.getAddress(
        orderData.billingAddressId
      );
      if (!billingAddress) {
        throw new Error('Billing address not found');
      }

      // 4. Calculate totals
      let subtotal = 0;
      for (const item of cartItems) {
        const price = item.variant?.originalPrice || item.product.basePrice;
        subtotal += price * item.quantity;
      }

      // Simple tax calculation (8.5% for example)
      const taxRate = 0.085;
      const tax = Math.round(subtotal * taxRate * 100) / 100;

      // Simple shipping calculation (free over $100, otherwise $10)
      const shipping = subtotal >= 100 ? 0 : 10;

      const discount = 0; // No discounts for now
      const total = subtotal + tax + shipping - discount;

      // 5. Generate order number
      const orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

      // 6. Create order record
      const order = await this.rayfinClient.data.Order.create({
        orderNumber,
        status: 'pending' as const,
        subtotal: Math.round(Math.round(subtotal * 100) / 100),
        tax: Math.round(Math.round(tax * 100) / 100),
        shipping: Math.round(Math.round(shipping * 100) / 100),
        discount: Math.round(Math.round(discount * 100) / 100),
        total: Math.round(Math.round(total * 100) / 100),
        currency: 'USD',
        paymentStatus: 'pending' as const,
        paymentMethod: orderData.paymentMethod,
        notes: orderData.notes,
        createdAt: new Date(),
        updatedAt: new Date(),
        customer,
        shippingAddress,
        billingAddress,
      });

      // 7. Create order items from cart items
      for (const cartItem of cartItems) {
        let variantName: string | undefined;
        if (cartItem.variant) {
          variantName =
            `${cartItem.variant.color || ''} ${cartItem.variant.size || ''}`.trim();
        }

        await this.rayfinClient.data.OrderItem.create({
          quantity: cartItem.quantity,
          productName: cartItem.product.name,
          productSku: cartItem.product.sku,
          variantName,
          createdAt: new Date(),
          updatedAt: new Date(),
          order,
          product: cartItem.product,
          // variant: cartItem.variant, // TODO: variant implementation
        });
      }

      // 8. Cart clearing is intentionally handled by the CartContext in the checkout hook
      // This ensures proper UI state management and allows for better error handling

      return order;
    } catch (error) {
      console.error('RayfinOrderService.createOrder error:', error);
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Failed to create order');
    }
  }

  async getOrderItems(orderId: string): Promise<OrderItem[]> {
    try {
      // Get order items for a specific order
      // For now, we'll get all order items and let DAB's permissions handle filtering
      // In a real implementation, we'd filter by orderId through the relationship
      const orderItems = await this.rayfinClient.data.OrderItem.select([
        'id',
        'quantity',
        'productName',
        'productSku',
        'variantName',
        'createdAt',
        'updatedAt',
        'override',
        'order.id',
        'order.orderNumber',
        'product.id',
        'product.name',
        'product.basePrice',
        'product.imageUrl',
        'variant.id',
        'variant.size',
        'variant.color',
        'variant.originalPrice',
      ]).execute();

      // Filter client-side for now (in production this would be done at DB level)
      return orderItems.filter((item: any) => item.order.id === orderId);
    } catch (error) {
      console.error('RayfinOrderService.getOrderItems error:', error);
      throw new Error('Failed to fetch order items');
    }
  }

  async getOrderItem(orderItemId: string): Promise<OrderItem> {
    try {
      const orderItems = await this.rayfinClient.data.OrderItem.select([
        'id',
        'quantity',
        'productName',
        'productSku',
        'variantName',
        'createdAt',
        'updatedAt',
        'override',
        'order.id',
        'order.orderNumber',
        'product.id',
        'product.name',
        'product.basePrice',
        'product.imageUrl',
        'variant.id',
        'variant.size',
        'variant.color',
        'variant.originalPrice',
      ])
        .where({ id: { eq: orderItemId } })
        .execute();

      // Filter client-side for now (in production this would be done at DB level)
      return orderItems[0];
    } catch (error) {
      console.error('RayfinOrderService.getOrderItems error:', error);
      throw new Error('Failed to fetch order items');
    }
  }

  async cancelOrder(orderId: string): Promise<Order> {
    try {
      // First, get the order to check if it can be cancelled
      const order = await this.getOrder(orderId);
      if (!order) {
        throw new Error('Order not found');
      }

      // Check if order can be cancelled (only pending or confirmed orders)
      if (!['pending', 'confirmed'].includes(order.status)) {
        throw new Error(`Cannot cancel order with status: ${order.status}`);
      }

      // Update order status to cancelled
      await this.rayfinClient.data.Order.update(
        { id: orderId },
        {
          status: 'cancelled' as const,
          updatedAt: new Date(),
        }
      );

      // Return the updated order
      const updatedOrder = await this.getOrder(orderId);
      if (!updatedOrder) {
        throw new Error(
          `Order with id ${orderId} not found after cancellation`
        );
      }

      return updatedOrder;
    } catch (error) {
      console.error('RayfinOrderService.cancelOrder error:', error);
      throw new Error('Failed to cancel order');
    }
  }

  // Admin operations
  async getAllOrders(filters?: OrderFilters): Promise<Order[]> {
    try {
      // Get all orders with optional filtering (admin only)
      let query = this.rayfinClient.data.Order.select([
        'id',
        'orderNumber',
        'status',
        'subtotal',
        'tax',
        'shipping',
        'discount',
        'total',
        'currency',
        'needsOverride',
        'paymentStatus',
        'paymentMethod',
        'trackingNumber',
        'shippingCarrier',
        'estimatedDelivery',
        'deliveredAt',
        'notes',
        'createdAt',
        'updatedAt',
        'customer.id',
        'customer.firstName',
        'customer.lastName',
        'shippingAddress.id',
        'shippingAddress.firstName',
        'shippingAddress.lastName',
        'shippingAddress.addressLine1',
        'shippingAddress.city',
        'shippingAddress.state',
        'shippingAddress.postalCode',
        'billingAddress.id',
        'billingAddress.firstName',
        'billingAddress.lastName',
        'billingAddress.addressLine1',
        'billingAddress.city',
        'billingAddress.state',
        'billingAddress.postalCode',
      ]);

      // Apply filters if provided
      if (filters?.status && filters.status.length > 0) {
        // For multiple statuses, we'd need to use OR logic
        // For now, just use the first status
        query = query.where({ status: { eq: filters.status[0] } });
      }

      // Apply sorting
      const sortBy = filters?.sortBy || 'createdAt';
      const sortOrder = filters?.sortOrder || 'desc';
      query = query.orderBy({ [sortBy]: sortOrder });

      // Apply pagination if provided
      if (filters?.limit) {
        query = query.first(filters.limit);
      }

      const orders = await query.execute();
      return orders;
    } catch (error) {
      console.error('RayfinOrderService.getAllOrders error:', error);
      throw new Error('Failed to fetch all orders');
    }
  }

  async updateOrderStatus(
    orderId: string,
    status: OrderStatus
  ): Promise<Order> {
    try {
      // Update order status (admin only)
      await this.rayfinClient.data.Order.update(
        { id: orderId },
        {
          status,
          updatedAt: new Date(),
        }
      );

      // Return the updated order
      const updatedOrder = await this.getOrder(orderId);
      if (!updatedOrder) {
        throw new Error(
          `Order with id ${orderId} not found after status update`
        );
      }

      return updatedOrder;
    } catch (error) {
      console.error('RayfinOrderService.updateOrderStatus error:', error);
      throw new Error('Failed to update order status');
    }
  }

  async updateTracking(
    orderId: string,
    trackingNumber: string,
    carrier: string
  ): Promise<Order> {
    try {
      // Update tracking information (admin only)
      await this.rayfinClient.data.Order.update(
        { id: orderId },
        {
          trackingNumber,
          shippingCarrier: carrier,
          updatedAt: new Date(),
        }
      );

      // Return the updated order
      const updatedOrder = await this.getOrder(orderId);
      if (!updatedOrder) {
        throw new Error(
          `Order with id ${orderId} not found after tracking update`
        );
      }

      return updatedOrder;
    } catch (error) {
      console.error('RayfinOrderService.updateTracking error:', error);
      throw new Error('Failed to update tracking information');
    }
  }

  async processRefund(orderId: string, amount?: number): Promise<Order> {
    try {
      // Get the order to check current status and calculate refund amount
      const order = await this.getOrder(orderId);
      if (!order) {
        throw new Error('Order not found');
      }

      // Validate that order can be refunded
      if (order.paymentStatus !== 'paid') {
        throw new Error('Cannot refund unpaid order');
      }

      // Calculate refund amount (default to full refund)
      const refundAmount = amount || order.total;

      if (refundAmount > order.total) {
        throw new Error('Refund amount cannot exceed order total');
      }

      // Update order status and payment status
      await this.rayfinClient.data.Order.update(
        { id: orderId },
        {
          status: 'refunded' as const,
          paymentStatus: 'refunded' as const,
          updatedAt: new Date(),
        }
      );

      // In a real implementation, you would:
      // 1. Process the actual refund through payment gateway
      // 2. Update inventory to restock items
      // 3. Send refund confirmation email
      // 4. Create refund record for accounting

      // Return the updated order
      const updatedOrder = await this.getOrder(orderId);
      if (!updatedOrder) {
        throw new Error(
          `Order with id ${orderId} not found after refund processing`
        );
      }

      return updatedOrder;
    } catch (error) {
      console.error('RayfinOrderService.processRefund error:', error);
      throw new Error('Failed to process refund');
    }
  }

  async getOrderStats(): Promise<{
    totalOrders: number;
    totalRevenue: number;
    averageOrderValue: number;
    ordersByStatus: Record<OrderStatus, number>;
  }> {
    try {
      // Get all orders for statistics calculation (admin only)
      const orders = await this.rayfinClient.data.Order.select([
        'id',
        'total',
        'status',
      ]).execute();

      // Calculate statistics
      const totalOrders = orders.length;
      const totalRevenue = orders.reduce((sum, order) => sum + order.total, 0);
      const averageOrderValue =
        totalOrders > 0 ? totalRevenue / totalOrders : 0;

      // Count orders by status
      const ordersByStatus: Record<OrderStatus, number> = {
        pending: 0,
        confirmed: 0,
        processing: 0,
        shipped: 0,
        delivered: 0,
        cancelled: 0,
        refunded: 0,
      };

      orders.forEach((order) => {
        ordersByStatus[order.status as OrderStatus]++;
      });

      return {
        totalOrders,
        totalRevenue: Math.round(totalRevenue * 100) / 100, // Round to 2 decimal places
        averageOrderValue: Math.round(averageOrderValue * 100) / 100,
        ordersByStatus,
      };
    } catch (error) {
      console.error('RayfinOrderService.getOrderStats error:', error);
      throw new Error('Failed to fetch order statistics');
    }
  }

  async updateOrder(orderId: string, updates: Partial<Order>): Promise<Order> {
    try {
      // Update order details (admin only)
      await this.rayfinClient.data.Order.update(
        { id: orderId },
        {
          ...updates,
          updatedAt: new Date(),
        }
      );

      // Return the updated order
      const updatedOrder = await this.getOrder(orderId);
      if (!updatedOrder) {
        throw new Error(`Order with id ${orderId} not found after update`);
      }

      return updatedOrder;
    } catch (error) {
      console.error('RayfinOrderService.updateOrder error:', error);
      throw new Error('Failed to update order');
    }
  }

  async addOrderItem(
    orderId: string,
    itemData: CreateOrderItemData
  ): Promise<OrderItem> {
    try {
      // First verify the order exists
      const order = await this.getOrder(orderId);
      if (!order) {
        throw new Error('Order not found');
      }

      // Get product info for the snapshot data
      const products = await this.rayfinClient.data.Product.select([
        'id',
        'name',
        'sku',
        'basePrice',
        'description',
        'shortDescription',
        'isActive',
        'weight',
        'color',
        'imageUrl',
        'stockQuantity',
        'compareAtPrice',
        'materialComposition',
        'careInstructions',
        'sizeGuide',
        'seoTitle',
        'seoDescription',
        'createdAt',
        'updatedAt',
      ])
        .where({ id: { eq: itemData.productId } })
        .first(1)
        .execute();

      if (!products[0]) {
        throw new Error('Product not found');
      }

      const product = products[0];

      let variant = null;
      if (itemData.variantId) {
        const variants = await this.rayfinClient.data.ProductVariant.select([
          'id',
          'productId',
          'size',
          'color',
          'colorHex',
          'sku',
          'originalPrice',
          'stockQuantity',
          'isActive',
          'createdAt',
          'updatedAt',
        ])
          .where({ id: { eq: itemData.variantId } })
          .first(1)
          .execute();

        if (variants[0]) {
          variant = variants[0];
        }
      }

      // Create order item with snapshot data
      const orderItem = await this.rayfinClient.data.OrderItem.create({
        quantity: itemData.quantity,
        productName: product.name,
        productSku: product.sku,
        variantName: variant
          ? `${variant.color || ''} ${variant.size || ''}`.trim()
          : undefined,
        override: itemData.override || 'add', // Default to 'add' for new items
        createdAt: new Date(),
        updatedAt: new Date(),
        order,
        product,
        variant: variant || undefined,
      });

      return await this.getOrderItem(orderItem.id);
    } catch (error) {
      console.error('RayfinOrderService.addOrderItem error:', error);
      throw new Error('Failed to add order item');
    }
  }

  async updateOrderItem(
    itemId: string,
    updates: UpdateOrderItemData
  ): Promise<OrderItem> {
    try {
      // Update order item
      await this.rayfinClient.data.OrderItem.update(
        { id: itemId },
        {
          ...updates,
          updatedAt: new Date(),
        }
      );

      // Return the updated order item
      const updatedItem = await this.rayfinClient.data.OrderItem.select([
        'id',
        'quantity',
        'productName',
        'productSku',
        'variantName',
        'override',
        'createdAt',
        'updatedAt',
        'order.id',
        'order.orderNumber',
        'product.id',
        'product.name',
        'product.basePrice',
        'product.imageUrl',
        'variant.id',
        'variant.size',
        'variant.color',
        'variant.originalPrice',
      ])
        .where({ id: { eq: itemId } })
        .first(1)
        .execute();

      if (!updatedItem[0]) {
        throw new Error(`Order item with id ${itemId} not found after update`);
      }

      return updatedItem[0];
    } catch (error) {
      console.error('RayfinOrderService.updateOrderItem error:', error);
      throw new Error('Failed to update order item');
    }
  }

  async removeOrderItem(itemId: string): Promise<OrderItem> {
    try {
      // Don't actually delete, just set override to 'remove'
      return await this.updateOrderItem(itemId, { override: 'remove' });
    } catch (error) {
      console.error('RayfinOrderService.removeOrderItem error:', error);
      throw new Error('Failed to remove order item');
    }
  }

  /**
   * Recalculate and update order totals based on current order items
   */
  async recalculateOrderTotals(orderId: string): Promise<Order> {
    try {
      // Get all active order items (not removed)
      const orderItems = await this.getOrderItems(orderId);
      const activeItems = orderItems.filter(
        (item) => item.override !== 'remove'
      );

      // Calculate new subtotal
      let subtotal = 0;
      for (const item of activeItems) {
        const price = item.variant?.originalPrice || item.product.basePrice;
        subtotal += price * item.quantity;
      }

      // Simple tax calculation (8.5% for example)
      const taxRate = 0.085;
      const tax = Math.round(subtotal * taxRate * 100) / 100;

      // Simple shipping calculation (free over $100, otherwise $10)
      const shipping = subtotal >= 100 ? 0 : 10;

      const discount = 0; // No discounts for now - could be made configurable
      const total = subtotal + tax + shipping - discount;

      // Update the order with new totals
      await this.rayfinClient.data.Order.update(
        { id: orderId },
        {
          subtotal: Math.round(Math.round(subtotal * 100) / 100),
          tax: Math.round(Math.round(tax * 100) / 100),
          shipping: Math.round(Math.round(shipping * 100) / 100),
          discount: Math.round(Math.round(discount * 100) / 100),
          total: Math.round(Math.round(total * 100) / 100),
          updatedAt: new Date(),
        }
      );

      // Return the updated order
      const updatedOrder = await this.getOrder(orderId);
      if (!updatedOrder) {
        throw new Error(
          `Order with id ${orderId} not found after total recalculation`
        );
      }

      return updatedOrder;
    } catch (error) {
      console.error('RayfinOrderService.recalculateOrderTotals error:', error);
      throw new Error('Failed to recalculate order totals');
    }
  }
}
