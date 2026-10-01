import { describe, it, expect } from 'vitest';

import { DatabaseDialect } from '../analysis/dialect-config';
import { TypeInferenceEngine } from '../analysis/type-inference';

describe('Pluralization', () => {
  const engine = new TypeInferenceEngine(DatabaseDialect.MsSql);

  describe('generateTableName', () => {
    it('should pluralize standard nouns correctly', () => {
      expect(engine.generateTableName('Todo')).toBe('Todos');
      expect(engine.generateTableName('Category')).toBe('Categories');
      expect(engine.generateTableName('User')).toBe('Users');
      expect(engine.generateTableName('Product')).toBe('Products');
    });

    it('should handle irregular plurals correctly', () => {
      expect(engine.generateTableName('Person')).toBe('People');
      expect(engine.generateTableName('Child')).toBe('Children');
      expect(engine.generateTableName('Mouse')).toBe('Mice');
      expect(engine.generateTableName('Goose')).toBe('Geese');
    });

    it('should handle words ending in "y" correctly', () => {
      expect(engine.generateTableName('Story')).toBe('Stories');
      expect(engine.generateTableName('Company')).toBe('Companies');
      expect(engine.generateTableName('City')).toBe('Cities');
    });

    it('should handle words ending in "s", "x", "z", "ch", "sh" correctly', () => {
      expect(engine.generateTableName('Bus')).toBe('Buses');
      expect(engine.generateTableName('Box')).toBe('Boxes');
      expect(engine.generateTableName('Quiz')).toBe('Quizzes');
      expect(engine.generateTableName('Watch')).toBe('Watches');
      expect(engine.generateTableName('Dish')).toBe('Dishes');
    });

    it('should handle words ending in "f" or "fe" correctly', () => {
      expect(engine.generateTableName('Knife')).toBe('Knives');
      expect(engine.generateTableName('Life')).toBe('Lives');
      expect(engine.generateTableName('Wolf')).toBe('Wolves');
    });

    it('should document known limitations with uncountable nouns', () => {
      // These work correctly
      expect(engine.generateTableName('Equipment')).toBe('Equipment');
      expect(engine.generateTableName('Information')).toBe('Information');

      // Known limitation: Some uncountable nouns are incorrectly pluralized
      // See docs/contributor/pluralization-standardization.md for workarounds
      expect(engine.generateTableName('Money')).toBe('Monies'); // Documented limitation
    });

    it('should handle compound words correctly', () => {
      expect(engine.generateTableName('TodoItem')).toBe('TodoItems');
      expect(engine.generateTableName('UserProfile')).toBe('UserProfiles');
    });

    it('should document known limitations with acronym casing', () => {
      // Known limitation: All-caps acronyms lose casing during pluralization
      // Workaround: Use PascalCase (e.g., Api → Apis)
      // See docs/contributor/pluralization-standardization.md
      expect(engine.generateTableName('API')).toBe('APIS'); // Documented limitation
      expect(engine.generateTableName('URL')).toBe('URLS'); // Documented limitation

      // Recommended approach with PascalCase
      expect(engine.generateTableName('Api')).toBe('Apis');
      expect(engine.generateTableName('Url')).toBe('Urls');
    });

    it('should handle edge cases', () => {
      // Already plural
      expect(engine.generateTableName('Users')).toBe('Users');

      // Single letter (uncommon but possible)
      expect(engine.generateTableName('A')).toBe('AS');

      // Numbers in class names
      expect(engine.generateTableName('User2')).toBe('User2s');
    });

    it('should preserve casing style', () => {
      // PascalCase should remain PascalCase
      expect(engine.generateTableName('UserAccount')).toBe('UserAccounts');

      // Single word
      expect(engine.generateTableName('order')).toBe('orders');
      expect(engine.generateTableName('Order')).toBe('Orders');
    });
  });
});
