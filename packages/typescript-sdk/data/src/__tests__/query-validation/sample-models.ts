export class Todo {
  id!: string;
  title!: string;
  /** Field name to test keyword-like identifiers */
  type!: string;
  description?: string;
  isCompleted!: boolean;
  priority!: 'low' | 'medium' | 'high';
  /** Numeric priority level for number filter tests */
  priorityLevel!: number;
  dueDate?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  category?: Category;
  user!: User;
}

export class Category {
  id!: string;
  name!: string;
  color!: string;
  user!: User;
}

export class User {
  id!: string;
  email!: string;
  /** Deep nested relationship for testing 3+ level nesting */
  profile?: Profile;
}

/** Profile entity for deep nesting tests */
export class Profile {
  id!: string;
  displayName!: string;
  bio?: string;
  address?: Address;
}

/** Address entity for 4-level deep nesting tests */
export class Address {
  id!: string;
  street!: string;
  city!: string;
  country!: string;
  postalCode?: string;
}

export type TestSchema = {
  Todo: Todo;
  Category: Category;
  User: User;
  Profile: Profile;
  Address: Address;
};
