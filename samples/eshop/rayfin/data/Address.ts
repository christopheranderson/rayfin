import {
  entity,
  role,
  uuid,
  text,
  set,
  boolean,
  date,
  one,
} from '@microsoft/rayfin-core';

import { Customer } from './Customer.js';

@entity()
@role('authenticated', '*')
export class Address {
  @uuid() id!: string;
  @uuid() customerId!: string; // FK to Customer
  @set('shipping', 'billing', 'both') type!: 'shipping' | 'billing' | 'both'; // Address type
  @text() firstName!: string;
  @text() lastName!: string;
  @text({ optional: true }) company?: string;
  @text() addressLine1!: string;
  @text({ optional: true }) addressLine2?: string;
  @text() city!: string;
  @text() state!: string;
  @text() postalCode!: string;
  @text() country!: string;
  @text({ optional: true }) phone?: string;
  @boolean() isDefault!: boolean; // Default address for customer
  @date() createdAt!: Date;
  @date() updatedAt!: Date;

  // Relationships
  @one(() => Customer) customer!: Customer;
}
