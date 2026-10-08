import { Customer } from 'rayfin/data/Customer';
import { useState, useCallback, useEffect } from 'react';

import { Address } from '../../rayfin/data/Address';
import { ServiceContainer } from '../services/ServiceContainer';
import { CreateAddressData } from '../services/interfaces/IAddressService';

export interface UseAddressManagementReturn {
  addresses: Address[];
  loading: boolean;
  error: string | null;
  isCreating: boolean;
  isUpdating: boolean;
  isDeleting: boolean;
  createAddress: (data: CreateAddressData) => Promise<Address | null>;
  updateAddress: (
    id: string,
    data: Partial<CreateAddressData>
  ) => Promise<Address | null>;
  deleteAddress: (id: string) => Promise<boolean>;
  setAsDefault: (id: string) => Promise<Address | null>;
  refreshAddresses: () => Promise<void>;
  clearError: () => void;
}

export function useAddressManagement(): UseAddressManagementReturn {
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const addressService = ServiceContainer.getInstance().addressService;
  const customerService = ServiceContainer.getInstance().customerService;

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const refreshAddresses = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fetchedAddresses = await addressService.getAddresses();
      // TODO: this shouldn't be needed once auth roles are corrected
      const user = await customerService.getProfile();
      setAddresses(
        fetchedAddresses.filter((addr) => addr.customerId === user?.id)
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to fetch addresses'
      );
      console.error('Failed to fetch addresses:', err);
    } finally {
      setLoading(false);
    }
  }, [addressService]);

  const createAddress = useCallback(
    async (data: CreateAddressData): Promise<Address | null> => {
      setIsCreating(true);
      setError(null);
      try {
        const newAddress = await addressService.createAddress(data);
        setAddresses((prev) => [newAddress, ...prev]);
        return newAddress;
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : 'Failed to create address';
        setError(errorMessage);
        console.error('Failed to create address:', err);
        return null;
      } finally {
        setIsCreating(false);
      }
    },
    [addressService]
  );

  const updateAddress = useCallback(
    async (
      id: string,
      data: Partial<CreateAddressData>
    ): Promise<Address | null> => {
      setIsUpdating(true);
      setError(null);
      try {
        const updatedAddress = await addressService.updateAddress(id, data);
        setAddresses((prev) =>
          prev.map((addr) => (addr.id === id ? updatedAddress : addr))
        );
        return updatedAddress;
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : 'Failed to update address';
        setError(errorMessage);
        console.error('Failed to update address:', err);
        return null;
      } finally {
        setIsUpdating(false);
      }
    },
    [addressService]
  );

  const deleteAddress = useCallback(
    async (id: string): Promise<boolean> => {
      setIsDeleting(true);
      setError(null);
      try {
        await addressService.deleteAddress(id);
        setAddresses((prev) => prev.filter((addr) => addr.id !== id));
        return true;
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : 'Failed to delete address';
        setError(errorMessage);
        console.error('Failed to delete address:', err);
        return false;
      } finally {
        setIsDeleting(false);
      }
    },
    [addressService]
  );

  const setAsDefault = useCallback(
    async (id: string): Promise<Address | null> => {
      setIsUpdating(true);
      setError(null);
      try {
        const updatedAddress = await addressService.setAsDefault(id);
        // Refresh all addresses to update default status
        await refreshAddresses();
        return updatedAddress;
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : 'Failed to set default address';
        setError(errorMessage);
        console.error('Failed to set default address:', err);
        return null;
      } finally {
        setIsUpdating(false);
      }
    },
    [addressService, refreshAddresses]
  );

  // Load addresses on mount
  useEffect(() => {
    refreshAddresses();
  }, [refreshAddresses]);

  return {
    addresses,
    loading,
    error,
    isCreating,
    isUpdating,
    isDeleting,
    createAddress,
    updateAddress,
    deleteAddress,
    setAsDefault,
    refreshAddresses,
    clearError,
  };
}
