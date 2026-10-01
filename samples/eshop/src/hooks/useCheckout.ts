import { useState, useCallback } from 'react';

import { Address } from '../../rayfin/data/Address';
import { Order } from '../../rayfin/data/Order';
import { useCart } from '../contexts/CartContext';
import { ServiceContainer } from '../services/ServiceContainer';
import { CreateOrderData } from '../services/interfaces/IOrderService';

export interface CheckoutFormData {
  shippingAddressId: string;
  billingAddressId: string;
  paymentMethod: string;
  notes?: string;
  useSameAddress: boolean;
}

export interface UseCheckoutReturn {
  loading: boolean;
  error: string | null;
  success: boolean;
  order: Order | null;
  processCheckout: (formData: CheckoutFormData) => Promise<boolean>;
  clearError: () => void;
  reset: () => void;
}

export function useCheckout(): UseCheckoutReturn {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [order, setOrder] = useState<Order | null>(null);

  const { orderService } = ServiceContainer.getInstance();
  const { clearCart } = useCart();

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const reset = useCallback(() => {
    setLoading(false);
    setError(null);
    setSuccess(false);
    setOrder(null);
  }, []);

  const processCheckout = useCallback(
    async (formData: CheckoutFormData): Promise<boolean> => {
      setLoading(true);
      setError(null);
      setSuccess(false);

      try {
        // Prepare order data
        const orderData: CreateOrderData = {
          shippingAddressId: formData.shippingAddressId,
          billingAddressId: formData.useSameAddress
            ? formData.shippingAddressId
            : formData.billingAddressId,
          paymentMethod: formData.paymentMethod,
          notes: formData.notes,
        };

        // Create the order (this should convert cart items to order items)
        const createdOrder = await orderService.createOrder(orderData);

        // Clear the cart after successful order creation
        await clearCart();

        setOrder(createdOrder);
        setSuccess(true);
        return true;
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : 'Failed to process checkout';
        setError(errorMessage);
        console.error('Checkout failed:', err);
        return false;
      } finally {
        setLoading(false);
      }
    },
    [orderService, clearCart]
  );

  return {
    loading,
    error,
    success,
    order,
    processCheckout,
    clearError,
    reset,
  };
}
