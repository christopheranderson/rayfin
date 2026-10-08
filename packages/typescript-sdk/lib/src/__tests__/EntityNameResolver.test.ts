import { describe, it, expect, beforeEach } from 'vitest';

import { EntityNameResolver } from '../utils/EntityNameResolver.js';

describe('EntityNameResolver', () => {
  beforeEach(() => {
    // Clear custom plurals before each test
    EntityNameResolver.clearCustomPlurals();
  });

  describe('getPlural', () => {
    it('should pluralize standard nouns correctly', () => {
      expect(EntityNameResolver.getPlural('Todo')).toBe('Todos');
      expect(EntityNameResolver.getPlural('Category')).toBe('Categories');
      expect(EntityNameResolver.getPlural('User')).toBe('Users');
      expect(EntityNameResolver.getPlural('Product')).toBe('Products');
    });

    it('should handle irregular plurals correctly', () => {
      expect(EntityNameResolver.getPlural('Person')).toBe('People');
      expect(EntityNameResolver.getPlural('Child')).toBe('Children');
      expect(EntityNameResolver.getPlural('Mouse')).toBe('Mice');
    });

    it('should handle words ending in "y" correctly', () => {
      expect(EntityNameResolver.getPlural('Story')).toBe('Stories');
      expect(EntityNameResolver.getPlural('Company')).toBe('Companies');
    });

    it('should allow custom plural mappings', () => {
      EntityNameResolver.setCustomPlural('Octopus', 'Octopodes');
      expect(EntityNameResolver.getPlural('Octopus')).toBe('Octopodes');
    });

    it('should prioritize custom plurals over default rules', () => {
      EntityNameResolver.setCustomPlural('Person', 'Persons');
      expect(EntityNameResolver.getPlural('Person')).toBe('Persons');
    });
  });

  describe('getSingular', () => {
    it('should singularize standard nouns correctly', () => {
      expect(EntityNameResolver.getSingular('Todos')).toBe('Todo');
      expect(EntityNameResolver.getSingular('Categories')).toBe('Category');
      expect(EntityNameResolver.getSingular('Users')).toBe('User');
    });

    it('should handle irregular plurals correctly', () => {
      expect(EntityNameResolver.getSingular('People')).toBe('Person');
      expect(EntityNameResolver.getSingular('Children')).toBe('Child');
    });
  });

  describe('clearCustomPlurals', () => {
    it('should clear all custom plurals', () => {
      EntityNameResolver.setCustomPlural('Octopus', 'Octopodes');
      EntityNameResolver.setCustomPlural('Person', 'Persons');

      EntityNameResolver.clearCustomPlurals();

      // Should revert to default pluralization
      expect(EntityNameResolver.getPlural('Person')).toBe('People');
    });
  });

  describe('isPlural', () => {
    it('should correctly identify plural forms', () => {
      expect(EntityNameResolver.isPlural('todos')).toBe(true);
      expect(EntityNameResolver.isPlural('categories')).toBe(true);
      expect(EntityNameResolver.isPlural('posts')).toBe(true);
      expect(EntityNameResolver.isPlural('people')).toBe(true);
      expect(EntityNameResolver.isPlural('children')).toBe(true);
    });

    it('should correctly identify singular forms', () => {
      expect(EntityNameResolver.isPlural('todo')).toBe(false);
      expect(EntityNameResolver.isPlural('category')).toBe(false);
      expect(EntityNameResolver.isPlural('post')).toBe(false);
      expect(EntityNameResolver.isPlural('person')).toBe(false);
      expect(EntityNameResolver.isPlural('child')).toBe(false);
    });

    it('should handle edge cases', () => {
      // Note: pluralize considers some uncountable nouns as plural
      // This is expected behavior from the library
      expect(EntityNameResolver.isPlural('equipment')).toBe(true);
      expect(EntityNameResolver.isPlural('information')).toBe(true);
      expect(EntityNameResolver.isPlural('news')).toBe(true);

      // Words ending in 'us' are correctly detected as singular
      expect(EntityNameResolver.isPlural('status')).toBe(false);
      expect(EntityNameResolver.isPlural('campus')).toBe(false);
    });
  });
});
