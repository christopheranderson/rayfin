/**
 * Events integration example using ultra-simplified decorators
 *
 * This demonstrates the new zero-config decorator system for a complex
 * event management application with multiple entities and relationships.
 */

import {
  entity,
  uuid,
  text,
  int,
  boolean,
  date,
  one,
  many,
  role,
} from '../../../decorators/decorators';

// Note: @dataSource and @runtime decorators are no longer needed!
// Configuration is handled by the CLI tool during static analysis.

@entity()
@role('anonymous', 'read')
@role('authenticated', '*')
export class Address {
  @uuid()
  id!: string; // UUID PK

  @text()
  friendlyName?: string; // NVARCHAR(255), nullable

  @text()
  address1!: string; // NVARCHAR(255), not null

  @text()
  address2?: string; // NVARCHAR(255), nullable

  @text()
  city!: string; // NVARCHAR(255), not null

  @text()
  state!: string; // Auto: NVARCHAR(255), not null

  @text()
  zipCode!: string; // Auto: NVARCHAR(255), not null

  @text()
  country!: string; // Auto: NVARCHAR(255), not null
}

@entity()
@role('authenticated', '*')
export class Category {
  @uuid()
  id!: string; // Auto: PK, UNIQUEIDENTIFIER, not null

  @text({ unique: true })
  name!: string; // Auto: NVARCHAR(255), not null, unique

  @text()
  description?: string; // Auto: NVARCHAR(MAX), nullable

  @text()
  color?: string; // Auto: NVARCHAR(255), nullable

  @many(() => Event)
  events!: Event[]; // Auto: one-to-many relationship
}

@entity()
@role('anonymous', 'read')
@role('authenticated', ['create', 'read', 'update'])
export class Event {
  @uuid()
  id!: string; // Auto: PK, UNIQUEIDENTIFIER, not null

  @text()
  title!: string; // Auto: NVARCHAR(255), not null

  @text()
  description?: string; // Auto: NVARCHAR(MAX), nullable

  @date()
  startDate!: Date; // Auto: DATETIME2, not null

  @date()
  endDate?: Date; // Auto: DATETIME2, nullable

  @boolean()
  isPublic!: boolean; // Auto: BIT, not null

  @int()
  maxAttendees?: number; // Auto: INT, nullable

  @text()
  status!: 'draft' | 'published' | 'cancelled' | 'completed'; // Auto: check constraint

  @one(() => Category)
  category!: Category; // Auto: many-to-one + generates category_id FK

  @one(() => Venue)
  venue!: Venue; // Auto: many-to-one + generates venue_id FK

  @one(() => User)
  organizer!: User; // Auto: many-to-one + generates organizer_id FK

  @many(() => User)
  attendees!: User[]; // Auto: many-to-many via junction table
}

@entity()
@role('authenticated', '*')
export class Venue {
  @uuid()
  id!: string; // Auto: PK, UNIQUEIDENTIFIER, not null

  @text()
  name!: string; // Auto: NVARCHAR(255), not null

  @int()
  capacity?: number; // Auto: INT, nullable

  @one(() => Address)
  address!: Address; // Auto: many-to-one + generates address_id FK

  @many(() => Event)
  events!: Event[]; // Auto: one-to-many relationship
}

@entity()
@role('authenticated', ['read', 'update']) // Users can read others and update themselves
export class User {
  @uuid()
  id!: string; // Auto: PK, UNIQUEIDENTIFIER, not null

  @text({ unique: true })
  email!: string; // Auto: NVARCHAR(255), not null, unique

  @text()
  firstName!: string; // Auto: NVARCHAR(255), not null

  @text()
  lastName!: string; // Auto: NVARCHAR(255), not null

  @text()
  role!: 'admin' | 'organizer' | 'attendee'; // Auto: check constraint

  @boolean()
  isActive!: boolean; // Auto: BIT, not null

  @date()
  createdAt!: Date; // Auto: DATETIME2, not null

  @many(() => Event)
  organizedEvents!: Event[]; // Auto: one-to-many relationship

  @many(() => Event)
  attendingEvents!: Event[]; // Auto: many-to-many via junction table
}

@entity()
export class Registration {
  @uuid()
  id!: string; // PK auto-inferred from 'id' name

  @date()
  registrationDate!: Date; // Auto: DATETIME2, not null

  @text()
  status!: 'pending' | 'confirmed' | 'cancelled'; // Auto: check constraint

  @one(() => User)
  user!: User; // Auto: many-to-one + generates user_id FK

  @one(() => Event)
  event!: Event; // Auto: many-to-one + generates event_id FK
}

/**
 * Expected Generated Schema (MSSQL):
 *
 * Tables: addresses, categories, events, venues, users, registrations
 * Junction Tables: event_user (for many-to-many between events and attendees)
 *
 * Key Features Demonstrated:
 * - Convention-based table naming (Category becomes categories)
 * - Auto-generated foreign keys (category becomes category_id)
 * - Many-to-many relationships with junction tables
 * - Check constraints from TypeScript union types
 * - Primary key inference (id fields)
 * - Unique constraints (unique option)
 * - Nullability from TypeScript ? operator
 * - Smart type inference (Date becomes DATETIME2, boolean becomes BIT, etc.)
 *
 * CLI Usage:
 * rayfin generate src/ --dialect mssql --output events-dab-config.json
 */
