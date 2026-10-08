import {
  entity,
  role,
  uuid,
  text,
  set,
  decimal,
  date,
  boolean,
  one,
} from '@microsoft/rayfin-core';

import { Address } from './Address.js';
import { Customer } from './Customer.js';

@entity()
@role('authenticated', '*')
export class Order {
  @uuid() id!: string;
  @text() orderNumber!: string; // Human-readable order number
  // @uuid() customerId!: string; // FK to Customer
  @set(
    'pending',
    'confirmed',
    'processing',
    'shipped',
    'delivered',
    'cancelled',
    'refunded'
  )
  status!:
    | 'pending'
    | 'confirmed'
    | 'processing'
    | 'shipped'
    | 'delivered'
    | 'cancelled'
    | 'refunded';
  @decimal() subtotal!: number;
  @decimal() tax!: number;
  @decimal() shipping!: number;
  @decimal() discount!: number; // Discount amount
  @decimal() total!: number;
  @text() currency!: string; // Currency code (USD, EUR, etc.)
  @set('pending', 'paid', 'failed', 'refunded') paymentStatus!:
    | 'pending'
    | 'paid'
    | 'failed'
    | 'refunded';
  @text({ optional: true }) paymentMethod?: string; // Payment method used
  @text({ optional: true }) trackingNumber?: string; // Shipping tracking number
  @text({ optional: true }) shippingCarrier?: string; // Shipping carrier (FedEx, UPS, etc.)
  @date({ optional: true }) estimatedDelivery?: Date; // Estimated delivery date
  @date({ optional: true }) deliveredAt?: Date; // Actual delivery date
  @text({ optional: true }) notes?: string; // Order notes
  @date() createdAt!: Date;
  @date() updatedAt!: Date;
  @boolean({ optional: true }) needsOverride?: boolean; // Flag for manual review

  // Relationships
  @one(() => Customer) customer!: Customer;
  @one(() => Address) shippingAddress!: Address;
  @one(() => Address) billingAddress!: Address;
}
