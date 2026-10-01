import type { Customer } from '../../../rayfin/data/Customer';

/**
 * Interface for customer profile management operations
 */
export interface ICustomerService {
  /**
   * Get the current customer's profile
   */
  getProfile(): Promise<Customer | null>;

  /**
   * Create a customer profile for a new user
   */
  createProfile(
    profile: Omit<Customer, 'id' | 'userId' | 'createdAt' | 'updatedAt'>
  ): Promise<Customer>;

  /**
   * Update customer profile information
   */
  updateProfile(
    updates: Partial<
      Omit<Customer, 'id' | 'userId' | 'createdAt' | 'updatedAt'>
    >
  ): Promise<Customer>;

  /**
   * Delete customer profile (admin only)
   */
  deleteProfile(customerId: string): Promise<void>;
}
