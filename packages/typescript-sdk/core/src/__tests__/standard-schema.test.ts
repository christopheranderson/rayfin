import { describe, it, expect, expectTypeOf } from 'vitest';

import {
  boolean,
  date,
  decimal,
  email,
  entity,
  int,
  one,
  set,
  text,
  uuid,
} from '../decorators/decorators.js';
import { getFieldConstraints, toStandardSchema } from '../index.js';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('toStandardSchema', () => {
  describe('basic shape', () => {
    it('exposes the Standard Schema v1 contract', () => {
      @entity()
      class Simple {
        @uuid() id!: string;
        @text() name!: string;
      }

      const schema = toStandardSchema(Simple);
      expect(schema['~standard'].version).toBe(1);
      expect(schema['~standard'].vendor).toBe('rayfin');
      expect(typeof schema['~standard'].validate).toBe('function');
    });

    it('exposes a convenience .validate() method', () => {
      @entity()
      class Simple {
        @uuid() id!: string;
        @text() name!: string;
      }

      const schema = toStandardSchema(Simple);
      expect(typeof schema.validate).toBe('function');
    });

    it('returns the value when input is valid', () => {
      @entity()
      class User {
        @uuid() id!: string;
        @text() name!: string;
        @int() age!: number;
        @boolean() isActive!: boolean;
      }

      // id is auto-omitted — form schemas don't validate the PK
      const result = toStandardSchema(User).validate({
        name: 'Alice',
        age: 30,
        isActive: true,
      });

      expect(result.issues).toBeUndefined();
      expect(result.value).toEqual({
        name: 'Alice',
        age: 30,
        isActive: true,
      });
    });

    it('auto-omits id and rejects it if sent', () => {
      @entity()
      class User {
        @uuid() id!: string;
        @text() name!: string;
      }

      const result = toStandardSchema(User).validate({
        id: VALID_UUID,
        name: 'Alice',
      });

      expect(
        result.issues?.some(
          (i) => i.path?.[0] === 'id' && /omitted/.test(i.message)
        )
      ).toBe(true);
    });

    it('rejects non-object input', () => {
      @entity()
      class E {
        @text() name!: string;
      }
      const result = toStandardSchema(E).validate('nope');
      expect(result.issues?.[0]?.message).toMatch(/object/);
    });
  });

  describe('field validation', () => {
    @entity()
    class All {
      @uuid() id!: string;
      @uuid() externalId!: string;
      @text({ min: 1, max: 5 }) name!: string;
      @int({ min: 0 }) count!: number;
      @decimal() price!: number;
      @boolean() active!: boolean;
      @date() when!: Date;
      @email() contact!: string;
      @set('low', 'high') level!: 'low' | 'high';
    }

    it('rejects invalid UUID', () => {
      const result = toStandardSchema(All).validate({
        externalId: 'not-a-uuid',
        name: 'a',
        count: 1,
        price: 1.5,
        active: true,
        when: new Date(),
        contact: 'a@b.co',
        level: 'low',
      });
      expect(
        result.issues?.some(
          (i) => i.path?.[0] === 'externalId' && /UUID/.test(i.message)
        )
      ).toBe(true);
    });

    it('enforces text min/max', () => {
      const result = toStandardSchema(All).validate({
        externalId: VALID_UUID,
        name: 'too long',
        count: 1,
        price: 1.5,
        active: true,
        when: new Date(),
        contact: 'a@b.co',
        level: 'low',
      });
      expect(result.issues?.some((i) => i.path?.[0] === 'name')).toBe(true);
    });

    it('rejects non-integer for @int', () => {
      const result = toStandardSchema(All).validate({
        externalId: VALID_UUID,
        name: 'ok',
        count: 1.5,
        price: 1.5,
        active: true,
        when: new Date(),
        contact: 'a@b.co',
        level: 'low',
      });
      expect(
        result.issues?.some(
          (i) => i.path?.[0] === 'count' && /integer/.test(i.message)
        )
      ).toBe(true);
    });

    it('accepts ISO date strings as well as Date objects', () => {
      const result = toStandardSchema(All).validate({
        externalId: VALID_UUID,
        name: 'ok',
        count: 1,
        price: 1.5,
        active: true,
        when: '2026-04-19T12:00:00Z',
        contact: 'a@b.co',
        level: 'low',
      });
      expect(result.issues).toBeUndefined();
    });

    it('rejects invalid email', () => {
      const result = toStandardSchema(All).validate({
        externalId: VALID_UUID,
        name: 'ok',
        count: 1,
        price: 1.5,
        active: true,
        when: new Date(),
        contact: 'not-email',
        level: 'low',
      });
      expect(result.issues?.some((i) => i.path?.[0] === 'contact')).toBe(true);
    });

    it('rejects values outside @set', () => {
      const result = toStandardSchema(All).validate({
        externalId: VALID_UUID,
        name: 'ok',
        count: 1,
        price: 1.5,
        active: true,
        when: new Date(),
        contact: 'a@b.co',
        level: 'medium',
      });
      expect(result.issues?.some((i) => i.path?.[0] === 'level')).toBe(true);
    });
  });

  describe('required vs optional', () => {
    it('flags missing required fields', () => {
      @entity()
      class E {
        @text() name!: string;
        @int({ optional: true }) age?: number;
      }
      const result = toStandardSchema(E).validate({});
      expect(
        result.issues?.some(
          (i) => i.path?.[0] === 'name' && /required/.test(i.message)
        )
      ).toBe(true);
    });

    it('allows optional fields to be omitted', () => {
      @entity()
      class E {
        @text() name!: string;
        @int({ optional: true }) age?: number;
      }
      const result = toStandardSchema(E).validate({
        name: 'ok',
      });
      expect(result.issues).toBeUndefined();
    });
  });

  describe('default value injection', () => {
    it('auto-fills default for missing required field with @int({ default })', () => {
      @entity()
      class Task {
        @text() title!: string;
        @int({ default: 2 }) points!: number;
      }
      const result = toStandardSchema(Task).validate({ title: 'test' });
      expect(result.issues).toBeUndefined();
      expect(result.value).toEqual({ title: 'test', points: 2 });
    });

    it('auto-fills default for missing required field with @boolean({ default })', () => {
      @entity()
      class Settings {
        @text() name!: string;
        @boolean({ default: false }) darkMode!: boolean;
      }
      const result = toStandardSchema(Settings).validate({ name: 'prefs' });
      expect(result.issues).toBeUndefined();
      expect(result.value).toEqual({ name: 'prefs', darkMode: false });
    });

    it('auto-fills default for missing required field with @text({ default })', () => {
      @entity()
      class Note {
        @text({ default: 'untitled' }) title!: string;
      }
      const result = toStandardSchema(Note).validate({});
      expect(result.issues).toBeUndefined();
      expect(result.value).toEqual({ title: 'untitled' });
    });

    it('uses explicit value over default when provided', () => {
      @entity()
      class Task {
        @text() title!: string;
        @int({ default: 2 }) points!: number;
      }
      const result = toStandardSchema(Task).validate({
        title: 'test',
        points: 5,
      });
      expect(result.issues).toBeUndefined();
      expect(result.value).toEqual({ title: 'test', points: 5 });
    });

    it('auto-fills default for optional field with default when value is missing', () => {
      @entity()
      class Task {
        @text() title!: string;
        @int({ default: 10, optional: true }) score?: number;
      }
      const result = toStandardSchema(Task).validate({ title: 'test' });
      expect(result.issues).toBeUndefined();
      expect(result.value).toEqual({ title: 'test', score: 10 });
    });
  });

  describe('unknown fields', () => {
    it('rejects fields not declared on the entity', () => {
      @entity()
      class E {
        @text() name!: string;
      }
      const result = toStandardSchema(E).validate({
        name: 'ok',
        bogus: 1,
      });
      expect(
        result.issues?.some(
          (i) => i.path?.[0] === 'bogus' && /Unknown/.test(i.message)
        )
      ).toBe(true);
    });
  });

  describe('omit option', () => {
    @entity()
    class Todo {
      @uuid() id!: string;
      @text() title!: string;
      @date() createdAt!: Date;
      @date() updatedAt!: Date;
    }

    it('auto-omits id and additional configured fields', () => {
      const schema = toStandardSchema(Todo, {
        omit: ['createdAt', 'updatedAt'] as const,
      });
      const result = schema.validate({ title: 'buy milk' });
      expect(result.issues).toBeUndefined();
      expect(result.value).toEqual({ title: 'buy milk' });
    });

    it('rejects id even when not listed in omit (auto-omitted)', () => {
      const schema = toStandardSchema(Todo, {
        omit: ['createdAt', 'updatedAt'] as const,
      });
      const result = schema.validate({
        id: VALID_UUID,
        title: 'buy milk',
      });
      expect(
        result.issues?.some(
          (i) => i.path?.[0] === 'id' && /omitted/.test(i.message)
        )
      ).toBe(true);
    });

    it('still requires non-omitted fields', () => {
      const schema = toStandardSchema(Todo);
      const result = schema.validate({});
      expect(result.issues?.some((i) => i.path?.[0] === 'title')).toBe(true);
    });

    it('narrows the validated value type to Omit<T, K | "id">', () => {
      const schema = toStandardSchema(Todo, {
        omit: ['createdAt', 'updatedAt'] as const,
      });
      type Validated = ReturnType<(typeof schema)['validate']>;
      type SuccessValue = Extract<Validated, { value: unknown }>['value'];
      expectTypeOf<SuccessValue>().toEqualTypeOf<{
        title: string;
      }>();
    });

    it('catches typos in omit at compile time', () => {
      @entity()
      class E {
        @text() name!: string;
      }
      // @ts-expect-error 'naem' is not a key of E.
      toStandardSchema(E, { omit: ['naem'] as const });
    });

    it('auto-skips relationship fields', () => {
      @entity()
      class Author {
        @uuid() id!: string;
        @text() name!: string;
      }

      @entity()
      class Book {
        @uuid() id!: string;
        @text() title!: string;
        @one(() => Author) author?: Author;
      }

      // 'author' is a @one() relationship — should not need to be in omit
      const schema = toStandardSchema(Book);
      const result = schema.validate({ title: 'Moby Dick' });
      expect(result.issues).toBeUndefined();
      expect(result.value).toEqual({ title: 'Moby Dick' });
    });
  });
});

describe('getFieldConstraints', () => {
  it('returns string constraints for @text with min/max', () => {
    @entity()
    class E {
      @text({ min: 2, max: 10 }) name!: string;
    }
    const c = getFieldConstraints(E, 'name');
    expect(c).toMatchObject({
      type: 'string',
      min: 2,
      max: 10,
      optional: false,
    });
  });

  it('returns enum constraints for @set', () => {
    @entity()
    class E {
      @set('a', 'b') letter!: 'a' | 'b';
    }
    const c = getFieldConstraints(E, 'letter');
    expect(c).toMatchObject({
      type: 'enum',
      values: ['a', 'b'],
    });
  });

  it('returns undefined for unknown fields', () => {
    @entity()
    class E {
      @text() name!: string;
    }
    expect(getFieldConstraints(E, 'name' as 'name')).toBeDefined();
    // @ts-expect-error 'missing' is not a key of E.
    expect(getFieldConstraints(E, 'missing')).toBeUndefined();
  });
});
