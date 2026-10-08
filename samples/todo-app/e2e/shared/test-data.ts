import { randomBytes } from 'crypto';

export interface TestUser {
  email: string;
  password: string;
}

/**
 * Generate a unique test user with random email and secure password
 * @returns TestUser with unique email and random password
 */
export function generateUniqueUser(): TestUser {
  const timestamp = Date.now();
  const randomSuffix = randomBytes(4).toString('hex');
  const email = `test-${timestamp}-${randomSuffix}@example.com`;

  // Generate secure random password (16 chars with mixed case, numbers, symbols)
  const password = randomBytes(12).toString('base64').slice(0, 16);

  return { email, password };
}

export interface TestTodo {
  title: string;
  description?: string;
}

/**
 * Generate a unique test todo with random title
 * @returns TestTodo with unique title
 */
export function generateUniqueTodo(): TestTodo {
  const timestamp = Date.now();
  const randomSuffix = randomBytes(3).toString('hex');
  return {
    title: `Todo ${timestamp}-${randomSuffix}`,
    description: 'Test todo created by E2E test',
  };
}

export interface TestCategory {
  name: string;
  color: string;
}

/**
 * Generate a unique test category with random name and color
 * @returns TestCategory with unique name and color
 */
export function generateUniqueCategory(): TestCategory {
  const timestamp = Date.now();
  const randomSuffix = randomBytes(3).toString('hex');
  return {
    name: `Category ${timestamp}-${randomSuffix}`,
    color: `#${randomBytes(3).toString('hex')}`,
  };
}
