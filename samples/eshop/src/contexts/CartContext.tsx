import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  ReactNode,
} from 'react';

import type { CartItem } from '../../rayfin/data/CartItem';
import { Product } from '../../rayfin/data/Product';
import { ServiceContainer } from '../services/ServiceContainer';

interface CartContextType {
  cartItems: CartItem[];
  cartCount: number;
  cartSubtotal: number;
  loading: boolean;
  error: string | null;
  refreshCart: () => Promise<void>;
  addToCart: (product: Product, quantity?: number) => Promise<void>;
  updateQuantity: (itemId: string, quantity: number) => Promise<void>;
  removeFromCart: (itemId: string) => Promise<void>;
  clearCart: () => Promise<void>;
}

const CartContext = createContext<CartContextType | undefined>(undefined);

export function useCart() {
  const context = useContext(CartContext);
  if (context === undefined) {
    throw new Error('useCart must be used within a CartProvider');
  }
  return context;
}

interface CartProviderProps {
  children: ReactNode;
}

export function CartProvider({ children }: CartProviderProps) {
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { cartService } = ServiceContainer.getInstance();

  // Calculate derived state
  const cartCount = cartItems.reduce((total, item) => total + item.quantity, 0);
  const cartSubtotal = cartItems.reduce((total, item) => {
    const price = item.variant?.originalPrice || item.product.basePrice;
    return total + price * item.quantity;
  }, 0);

  const refreshCart = async () => {
    try {
      setLoading(true);
      setError(null);
      const items = await cartService.getCart();
      setCartItems(items);
    } catch (err) {
      console.error('Failed to refresh cart:', err);
      setError('Failed to load cart');
      setCartItems([]);
    } finally {
      setLoading(false);
    }
  };

  const addToCart = async (product: Product, quantity = 1) => {
    try {
      setError(null);

      await cartService.addItem({
        product,
        quantity,
      });
      await refreshCart();
    } catch (err) {
      console.error('Failed to add to cart:', err);
      setError('Failed to add item to cart');
      throw err;
    }
  };

  const updateQuantity = async (itemId: string, quantity: number) => {
    try {
      setError(null);
      await cartService.updateQuantity(itemId, quantity);
      await refreshCart();
    } catch (err) {
      console.error('Failed to update quantity:', err);
      setError('Failed to update item quantity');
      throw err;
    }
  };

  const removeFromCart = async (itemId: string) => {
    try {
      setError(null);
      await cartService.removeItem(itemId);
      await refreshCart();
    } catch (err) {
      console.error('Failed to remove from cart:', err);
      setError('Failed to remove item from cart');
      throw err;
    }
  };

  const clearCart = async () => {
    try {
      setError(null);
      await cartService.clearCart();
      await refreshCart();
    } catch (err) {
      console.error('Failed to clear cart:', err);
      setError('Failed to clear cart');
      throw err;
    }
  };

  // Load cart on mount
  useEffect(() => {
    refreshCart();
  }, []);

  const value: CartContextType = {
    cartItems,
    cartCount,
    cartSubtotal,
    loading,
    error,
    refreshCart,
    addToCart,
    updateQuantity,
    removeFromCart,
    clearCart,
  };

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}
