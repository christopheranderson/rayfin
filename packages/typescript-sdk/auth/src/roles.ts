/**
 * User role types matching backend UserRole enum.
 * Backend supports: "Anonymous" and "Authenticated" (PascalCase).
 */
export type RayfinUserRole = 'Anonymous' | 'Authenticated';

/**
 * Returns whether the given string is a valid {@link RayfinUserRole}.
 *
 * @param role - The role string to validate.
 * @returns `true` (narrowing to `RayfinUserRole`) if the value is `"Anonymous"` or `"Authenticated"`.
 */
export function isValidRole(role: string): role is RayfinUserRole {
  return role === 'Anonymous' || role === 'Authenticated';
}

/**
 * Returns the default role assigned to newly authenticated users.
 *
 * @returns The default role, `"Authenticated"`.
 */
export function getDefaultRole(): RayfinUserRole {
  return 'Authenticated';
}
