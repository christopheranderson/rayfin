import { entity, uuid, text, boolean, date } from '@microsoft/rayfin-core';
import { describe, it, expect, expectTypeOf } from 'vitest';

import type { CreateInput } from '../graphql/types';

// --- Test entity types ---

/** Entity with a standard string `id` field */
@entity()
class TodoEntity {
  @uuid() id!: string;
  @text() title!: string;
  @boolean() completed!: boolean;
}

/** Entity with no `id` field at all */
@entity()
class LogEntry {
  @text() message!: string;
  @text() level!: string;
  @date() timestamp!: Date;
}

/** Entity with `id` and optional fields */
@entity()
class ProjectEntity {
  @uuid() id!: string;
  @text() name!: string;
  @text({ optional: true }) description?: string;
  @boolean() archived!: boolean;
}

/** Entity with only an `id` field */
@entity()
class MinimalEntity {
  @uuid() id!: string;
}

// --- Type-level tests ---

describe('CreateInput', () => {
  describe('entity with id field', () => {
    it('should make id optional while keeping other fields required', () => {
      expectTypeOf<CreateInput<TodoEntity>>().toEqualTypeOf<
        Omit<TodoEntity, 'id'> & Partial<Pick<TodoEntity, 'id'>>
      >();
    });

    it('should accept input without id (database-generated)', () => {
      const input: CreateInput<TodoEntity> = {
        title: 'Buy groceries',
        completed: false,
      };
      expect(input).toEqual({ title: 'Buy groceries', completed: false });
    });

    it('should accept input with explicit id', () => {
      const input: CreateInput<TodoEntity> = {
        id: 'custom-id-123',
        title: 'Buy groceries',
        completed: false,
      };
      expect(input).toEqual({
        id: 'custom-id-123',
        title: 'Buy groceries',
        completed: false,
      });
    });

    it('should still require non-id fields', () => {
      // @ts-expect-error - title is required
      const _missing: CreateInput<TodoEntity> = { completed: false };
      expect(_missing).toBeDefined();
    });

    it('should preserve optional fields from the entity', () => {
      const withOptional: CreateInput<ProjectEntity> = {
        name: 'My Project',
        archived: false,
      };
      expect(withOptional.description).toBeUndefined();

      const withDescription: CreateInput<ProjectEntity> = {
        name: 'My Project',
        description: 'A cool project',
        archived: false,
      };
      expect(withDescription.description).toBe('A cool project');
    });

    it('should work with minimal entity (only id)', () => {
      const withoutId: CreateInput<MinimalEntity> = {};
      expect(withoutId).toEqual({});

      const withId: CreateInput<MinimalEntity> = { id: 'abc' };
      expect(withId.id).toBe('abc');
    });
  });

  describe('entity without id field', () => {
    it('should pass through T unchanged', () => {
      expectTypeOf<CreateInput<LogEntry>>().toEqualTypeOf<LogEntry>();
    });

    it('should require all fields from the original type', () => {
      const input: CreateInput<LogEntry> = {
        message: 'Something happened',
        level: 'info',
        timestamp: new Date(),
      };
      expect(input.message).toBe('Something happened');
    });

    it('should reject missing required fields', () => {
      // @ts-expect-error - all fields are required for entities without id
      const _missing: CreateInput<LogEntry> = { message: 'oops' };
      expect(_missing).toBeDefined();
    });
  });
});
