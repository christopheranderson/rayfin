import { entity, role, uuid, text, date, one } from '@microsoft/rayfin-core';

import { User } from './User.js';

@entity()
@role('authenticated', '*')
export class Customer {
  @uuid() id!: string;
  // @uuid() userId!: string; // FK to User
  @text() firstName!: string;
  @text() lastName!: string;
  @text({ optional: true }) phone?: string;
  @date({ optional: true }) dateOfBirth?: Date;
  //@text() @optional() preferredSizes?: string[]; // JSON array of preferred sizes
  @text({ optional: true }) shippingPreferences?: string; // JSON object for shipping preferences
  @date() createdAt!: Date;
  @date() updatedAt!: Date;

  // Relationships
  @one(() => User) user!: User;
}
