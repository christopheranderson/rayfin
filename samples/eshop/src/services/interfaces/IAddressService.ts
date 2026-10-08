import type { Address } from '../../../rayfin/data/Address';

export interface CreateAddressData {
  type: 'shipping' | 'billing' | 'both';
  firstName: string;
  lastName: string;
  company?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone?: string;
  isDefault?: boolean;
}

/**
 * Interface for address management operations
 */
export interface IAddressService {
  /**
   * Get all addresses for current customer
   */
  getAddresses(): Promise<Address[]>;

  /**
   * Get address by ID
   */
  getAddress(id: string): Promise<Address | null>;

  /**
   * Get default shipping address
   */
  getDefaultShippingAddress(): Promise<Address | null>;

  /**
   * Get default billing address
   */
  getDefaultBillingAddress(): Promise<Address | null>;

  /**
   * Create new address
   */
  createAddress(address: CreateAddressData): Promise<Address>;

  /**
   * Update address
   */
  updateAddress(
    id: string,
    updates: Partial<CreateAddressData>
  ): Promise<Address>;

  /**
   * Delete address
   */
  deleteAddress(id: string): Promise<void>;

  /**
   * Set address as default for its type
   */
  setAsDefault(id: string): Promise<Address>;

  /**
   * Validate address (future integration with address validation service)
   */
  validateAddress(
    address: CreateAddressData
  ): Promise<{ isValid: boolean; suggestions?: Address[] }>;
}
