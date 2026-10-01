import { OpaqueSession } from '@microsoft/rayfin-auth';
import type { RayfinClient } from '@microsoft/rayfin-client';

import type { Customer } from '../../../rayfin/data/Customer';
import type { User, ZavaEshopSchema } from '../../../rayfin/data/schema';
import type { ICustomerService } from '../interfaces/ICustomerService';

import { getRayfinClient } from './RayfinClientService';

/**
 * Implementation of ICustomerService using \@microsoft/rayfin-data GraphQL fluent interface
 */
export class RayfinCustomerService implements ICustomerService {
  private rayfinClient: RayfinClient<ZavaEshopSchema>;

  constructor() {
    this.rayfinClient = getRayfinClient();
  }

  async getProfile(): Promise<Customer | null> {
    try {
      // Get the current authenticated user's customer profile
      // User filtering is handled automatically by DAB through JWT claims and RLS
      const userSession = this.rayfinClient.auth.getSession();
      if (
        !userSession ||
        userSession?.role === 'Anonymous' ||
        !userSession.user
      ) {
        return null;
      }
      let profile = await this.readProfile(userSession);
      if (!profile) {
        profile = await this.createProfile({
          firstName: '',
          lastName: '',
          user: {
            Email: userSession.user.email,
            Id: userSession.user.id,
          },
        });
      }

      return profile;
    } catch (error) {
      console.error('RayfinCustomerService.getProfile error:', error);
      throw new Error('Failed to fetch customer profile');
    }
  }

  async readProfile(userSession: OpaqueSession): Promise<Customer | null> {
    try {
      const customers = await this.rayfinClient.data.Customer.select([
        'id',
        'firstName',
        'lastName',
        'phone',
        'dateOfBirth',
        'shippingPreferences',
        'createdAt',
        'updatedAt',
        'user.Id',
        'user.Email',
      ])
        .where({
          user: {
            Email: {
              eq: userSession?.user?.email!,
            },
          },
        })
        .first(1)
        .execute();

      return customers[0] || null;
    } catch (error) {
      console.error('RayfinCustomerService.readProfile error:', error);
      throw new Error('Failed to fetch customer profile');
    }
  }

  async createProfile(
    profile: Omit<Customer, 'id' | 'userId' | 'createdAt' | 'updatedAt'>
  ): Promise<Customer> {
    try {
      // Create the customer profile
      const customerData = {
        ...profile,
        createdAt: new Date(),
        updatedAt: new Date(),
        // user relationship would be set via foreign key in real implementation
      };

      return await this.rayfinClient.data.Customer.create(customerData);
    } catch (error) {
      console.error('RayfinCustomerService.createProfile error:', error);
      throw new Error('Failed to create customer profile');
    }
  }

  async updateProfile(
    updates: Partial<
      Omit<Customer, 'id' | 'userId' | 'createdAt' | 'updatedAt'>
    >
  ): Promise<Customer> {
    try {
      // First, get the current customer profile to ensure it exists
      const currentProfile = await this.getProfile();
      if (!currentProfile) {
        throw new Error(
          'Customer profile not found. Please create a profile first.'
        );
      }

      // Add updatedAt timestamp to the updates
      const updateData = {
        ...updates,
        updatedAt: new Date(),
      };

      // Update the customer profile
      await this.rayfinClient.data.Customer.update(
        { id: currentProfile.id },
        updateData
      );

      // Return the updated profile
      const updatedProfile = await this.getProfile();
      if (!updatedProfile) {
        throw new Error('Customer profile not found after update');
      }

      return updatedProfile;
    } catch (error) {
      console.error('RayfinCustomerService.updateProfile error:', error);
      throw new Error('Failed to update customer profile');
    }
  }

  async deleteProfile(customerId: string): Promise<void> {
    try {
      // Admin operation - delete customer profile by ID
      // Note: This should only be accessible to admin users
      // In a real implementation, you would also:
      // 1. Check for any related orders, addresses, cart items, etc.
      // 2. Handle cascade deletions or prevent deletion if dependencies exist
      // 3. Audit log the deletion
      // 4. Potentially soft delete instead of hard delete for compliance

      await this.rayfinClient.data.Customer.delete({ id: customerId });
    } catch (error) {
      console.error('RayfinCustomerService.deleteProfile error:', error);
      throw new Error('Failed to delete customer profile');
    }
  }
}
