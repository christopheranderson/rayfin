/**
 * Shared types for type safety regression tests
 * Uses class-based entities to align with \@microsoft/rayfin-core decorator pattern
 */

export class OptionalManyRelationship {
  id!: number;
  email!: string;
  posts?: ThingMany[]; // Optional array - this was the original bug case
}

export class RequiredManyRelationship {
  id!: number;
  email!: string;
  posts!: ThingMany[]; // Optional array - this was the original bug case
}

export class OptionalOneRelationship {
  id!: number;
  title!: string;
  category?: ThingOne; // Optional object
}

export class RequiredOneRelationship {
  id!: number;
  title!: string;
  /** Non-numeric scalar for testing numeric-only aggregation constraints */
  status!: string;
  /** Numeric scalar for testing numeric aggregations */
  amount!: number;
  category!: ThingOne; // Optional object
}

export class ThingOne {
  id!: number;
  name!: string;
  description?: string;
}

export class ThingMany {
  id!: number;
  title!: string;
  content!: string;
  published!: boolean;
}

export type TypeSafetyTestSchema = {
  OptionalManyRelationship: OptionalManyRelationship;
  RequiredManyRelationship: RequiredManyRelationship;
  OptionalOneRelationship: OptionalOneRelationship;
  RequiredOneRelationship: RequiredOneRelationship;
  ThingOne: ThingOne;
  ThingMany: ThingMany;
};
