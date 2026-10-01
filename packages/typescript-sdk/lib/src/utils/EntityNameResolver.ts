import pluralize from 'pluralize';

/**
 * Resolves singular and plural forms of entity names. The SDK uses this when
 * deriving collection names for generated data operations, so the plural form
 * an entity resolves to here determines the names you query against.
 *
 * Register overrides with {@link EntityNameResolver.setCustomPlural} when the
 * default English pluralization does not match your domain terminology.
 *
 * @example
 * ```ts
 * // Ensure the `Person` entity pluralizes to `people`, not `persons`.
 * EntityNameResolver.setCustomPlural('Person', 'People');
 * EntityNameResolver.getPlural('Person'); // 'People'
 * ```
 */
export class EntityNameResolver {
  private static customPluralMap = new Map<string, string>();

  /**
   * Gets the plural form of an entity name, honoring any registered custom
   * plural before falling back to standard English pluralization.
   *
   * @param entityName - The singular entity name.
   * @returns The plural form.
   */
  static getPlural(entityName: string): string {
    const customPlural = this.customPluralMap.get(entityName);
    if (customPlural) {
      return customPlural;
    }
    return pluralize.plural(entityName);
  }

  /**
   * Registers a custom plural form for a domain-specific entity name, taking
   * precedence over the default pluralization.
   *
   * @param singular - The singular entity name.
   * @param plural - The plural form to use for that entity.
   */
  static setCustomPlural(singular: string, plural: string): void {
    this.customPluralMap.set(singular, plural);
  }

  /**
   * Clears all registered custom plural forms.
   */
  static clearCustomPlurals(): void {
    this.customPluralMap.clear();
  }

  /**
   * Gets the singular form of a plural entity name.
   *
   * @param pluralName - The plural entity name.
   * @returns The singular form.
   */
  static getSingular(pluralName: string): string {
    return pluralize.singular(pluralName);
  }

  /**
   * Determines whether a word is already in plural form.
   *
   * @param word - The word to test.
   * @returns `true` if the word is plural.
   */
  static isPlural(word: string): boolean {
    return pluralize.isPlural(word);
  }
}
