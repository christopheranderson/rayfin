import type { RayfinClient } from '@microsoft/rayfin-client';

import type { Address } from '../../../rayfin/data/Address';
import type { ZavaEshopSchema } from '../../../rayfin/data/schema';
import type {
  IAddressService,
  CreateAddressData,
} from '../interfaces/IAddressService';

import { getRayfinClient } from './RayfinClientService';

/**
 * Implementation of IAddressService using \@microsoft/rayfin-data GraphQL fluent interface
 */
export class RayfinAddressService implements IAddressService {
  private rayfinClient: RayfinClient<ZavaEshopSchema>;

  constructor() {
    this.rayfinClient = getRayfinClient();
  }

  async getAddresses(): Promise<Address[]> {
    try {
      // Get all addresses for the current authenticated user
      // User filtering is handled automatically by DAB through JWT claims and RLS
      const addresses = await this.rayfinClient.data.Address.select([
        'id',
        'customerId',
        'type',
        'firstName',
        'lastName',
        'company',
        'addressLine1',
        'addressLine2',
        'city',
        'state',
        'postalCode',
        'country',
        'phone',
        'isDefault',
        'createdAt',
        'updatedAt',
        'customer.id',
        'customer.firstName',
        'customer.lastName',
      ])
        .orderBy({ isDefault: 'desc', createdAt: 'desc' }) // Default addresses first, then by creation date
        .execute();

      return addresses;
    } catch (error) {
      console.error('RayfinAddressService.getAddresses error:', error);
      throw new Error('Failed to fetch addresses');
    }
  }

  async getAddress(id: string): Promise<Address | null> {
    try {
      // Get a specific address by ID for the current authenticated user
      // User filtering is handled automatically by DAB through JWT claims and RLS
      const addresses = await this.rayfinClient.data.Address.select([
        'id',
        'customerId',
        'type',
        'firstName',
        'lastName',
        'company',
        'addressLine1',
        'addressLine2',
        'city',
        'state',
        'postalCode',
        'country',
        'phone',
        'isDefault',
        'createdAt',
        'updatedAt',
        'customer.id',
        'customer.firstName',
        'customer.lastName',
      ])
        .where({ id: { eq: id } })
        .first(1)
        .execute();

      return addresses[0] || null;
    } catch (error) {
      console.error('RayfinAddressService.getAddress error:', error);
      throw new Error('Failed to fetch address');
    }
  }

  async getDefaultShippingAddress(): Promise<Address | null> {
    try {
      // Get default shipping address for the current authenticated user
      const addresses = await this.rayfinClient.data.Address.select([
        'id',
        'customerId',
        'type',
        'firstName',
        'lastName',
        'company',
        'addressLine1',
        'addressLine2',
        'city',
        'state',
        'postalCode',
        'country',
        'phone',
        'isDefault',
        'createdAt',
        'updatedAt',
        'customer.id',
        'customer.firstName',
        'customer.lastName',
      ])
        .where({
          isDefault: { eq: true },
          or: [{ type: { eq: 'shipping' } }, { type: { eq: 'both' } }],
        })
        .first(1)
        .execute();

      return addresses[0] || null;
    } catch (error) {
      console.error(
        'RayfinAddressService.getDefaultShippingAddress error:',
        error
      );
      throw new Error('Failed to fetch default shipping address');
    }
  }

  async getDefaultBillingAddress(): Promise<Address | null> {
    try {
      // Get default billing address for the current authenticated user
      const addresses = await this.rayfinClient.data.Address.select([
        'id',
        'customerId',
        'type',
        'firstName',
        'lastName',
        'company',
        'addressLine1',
        'addressLine2',
        'city',
        'state',
        'postalCode',
        'country',
        'phone',
        'isDefault',
        'createdAt',
        'updatedAt',
        'customer.id',
        'customer.firstName',
        'customer.lastName',
      ])
        .where({
          isDefault: { eq: true },
          or: [{ type: { eq: 'billing' } }, { type: { eq: 'both' } }],
        })
        .first(1)
        .execute();

      return addresses[0] || null;
    } catch (error) {
      console.error(
        'RayfinAddressService.getDefaultBillingAddress error:',
        error
      );
      throw new Error('Failed to fetch default billing address');
    }
  }

  async createAddress(address: CreateAddressData): Promise<Address> {
    try {
      // Get the current user session to extract user information
      const userSession = this.rayfinClient.auth.getSession();
      if (!userSession || !userSession.user) {
        throw new Error('User not authenticated');
      }

      // First, get the customer profile for the current user
      // We need to find the customer associated with the current user's email
      const customers = await this.rayfinClient.data.Customer.select([
        'id',
        'firstName',
        'lastName',
        'user.Id',
        'user.Email',
      ])
        .where({
          user: {
            Email: {
              eq: userSession.user.email!,
            },
          },
        })
        .first(1)
        .execute();

      if (!customers || customers.length === 0) {
        throw new Error(
          'Customer profile not found. Please create a customer profile first.'
        );
      }

      const customer = customers[0];

      // If this is set as default, unset other default addresses of the same type
      if (address.isDefault) {
        await this.unsetDefaultAddressesOfType(address.type, customer.id);
      }

      // Create the new address
      const newAddressData = {
        type: address.type,
        firstName: address.firstName,
        lastName: address.lastName,
        company: address.company || undefined,
        addressLine1: address.addressLine1,
        addressLine2: address.addressLine2 || undefined,
        city: address.city,
        state: address.state,
        postalCode: address.postalCode,
        country: address.country,
        phone: address.phone || undefined,
        isDefault: address.isDefault || false,
        customerId: customer.id,
        customer,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Create the new address using the create method
      const createdAddress =
        await this.rayfinClient.data.Address.create(newAddressData);

      // Return the created address with relationships populated
      const addresses = await this.rayfinClient.data.Address.select([
        'id',
        'customerId',
        'type',
        'firstName',
        'lastName',
        'company',
        'addressLine1',
        'addressLine2',
        'city',
        'state',
        'postalCode',
        'country',
        'phone',
        'isDefault',
        'createdAt',
        'updatedAt',
        'customer.id',
        'customer.firstName',
        'customer.lastName',
      ])
        .where({ id: { eq: createdAddress.id } })
        .first(1)
        .execute();

      return addresses[0];
    } catch (error) {
      console.error('RayfinAddressService.createAddress error:', error);
      throw new Error(
        `Failed to create address: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async updateAddress(
    id: string,
    updates: Partial<CreateAddressData>
  ): Promise<Address> {
    try {
      // Update the address
      const updatedAddress = await this.rayfinClient.data.Address.update(
        { id: id },
        {
          ...updates,
          updatedAt: new Date(),
        }
      );

      // Return the updated address with relationships populated
      const updatedAddresses = await this.rayfinClient.data.Address.select([
        'id',
        'customerId',
        'type',
        'firstName',
        'lastName',
        'company',
        'addressLine1',
        'addressLine2',
        'city',
        'state',
        'postalCode',
        'country',
        'phone',
        'isDefault',
        'createdAt',
        'updatedAt',
        'customer.id',
        'customer.firstName',
        'customer.lastName',
      ])
        .where({ id: { eq: id } })
        .first(1)
        .execute();

      return updatedAddresses[0];
    } catch (error) {
      console.error('RayfinAddressService.updateAddress error:', error);
      throw new Error('Failed to update address');
    }
  }

  async deleteAddress(id: string): Promise<void> {
    try {
      await this.rayfinClient.data.Address.delete({ id: id });
    } catch (error) {
      console.error('RayfinAddressService.deleteAddress error:', error);
      throw new Error('Failed to delete address');
    }
  }

  async setAsDefault(id: string): Promise<Address> {
    try {
      // Get the address to determine its type
      const address = await this.getAddress(id);
      if (!address) {
        throw new Error('Address not found');
      }

      // First, set all other addresses of this type to non-default
      await this.unsetDefaultAddressesOfType(address.type, address.customerId);

      // Update this address to be default
      return this.updateAddress(id, { isDefault: true });
    } catch (error) {
      console.error('RayfinAddressService.setAsDefault error:', error);
      throw new Error('Failed to set default address');
    }
  }

  /**
   * Helper method to unset default status for addresses of a specific type for a customer
   */
  private async unsetDefaultAddressesOfType(
    type: 'shipping' | 'billing' | 'both',
    customerId: string
  ): Promise<void> {
    try {
      // Get all default addresses of the specified type for this customer
      const defaultAddresses = await this.rayfinClient.data.Address.select([
        'id',
      ])
        .where({
          customerId: { eq: customerId },
          isDefault: { eq: true },
          or:
            type === 'both'
              ? [
                  { type: { eq: 'shipping' } },
                  { type: { eq: 'billing' } },
                  { type: { eq: 'both' } },
                ]
              : [{ type: { eq: type } }, { type: { eq: 'both' } }],
        })
        .execute();

      // Update each address to not be default
      for (const address of defaultAddresses) {
        await this.rayfinClient.data.Address.update(
          { id: address.id },
          { isDefault: false, updatedAt: new Date() }
        );
      }
    } catch (error) {
      console.error(
        'RayfinAddressService.unsetDefaultAddressesOfType error:',
        error
      );
      throw new Error('Failed to unset default addresses');
    }
  }

  async validateAddress(
    address: CreateAddressData
  ): Promise<{ isValid: boolean; suggestions?: Address[] }> {
    // For now, always return as valid
    // Future implementation would integrate with address validation service
    return { isValid: true };
  }
}
