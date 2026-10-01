import {
  entity,
  text,
  date,
  uuid,
  one,
  many,
  boolean,
} from '@microsoft/rayfin-core';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
  deserializeDabResponse,
  deserializeBoolean,
  deserializeDate,
  isDabStringBoolean,
} from '../utils/serialization';

// GA-rollout gate: these tests validate the new behavior; enable the flag.
let _originalFlags: string | undefined;
beforeAll(() => {
  _originalFlags = process.env.RAYFIN_FEATURE_FLAGS;
  process.env.RAYFIN_FEATURE_FLAGS = 'cli-minor-fixes';
});
afterAll(() => {
  if (_originalFlags === undefined) delete process.env.RAYFIN_FEATURE_FLAGS;
  else process.env.RAYFIN_FEATURE_FLAGS = _originalFlags;
});

describe('DAB Serialization Utilities', () => {
  describe('deserializeBoolean', () => {
    it('should convert string "true" to boolean true', () => {
      expect(deserializeBoolean('true')).toBe(true);
    });

    it('should convert string "false" to boolean false', () => {
      expect(deserializeBoolean('false')).toBe(false);
    });

    it('should return boolean values as-is', () => {
      expect(deserializeBoolean(true)).toBe(true);
      expect(deserializeBoolean(false)).toBe(false);
    });

    it('should return false for undefined, null, or other types', () => {
      expect(deserializeBoolean(undefined)).toBe(false);
      expect(deserializeBoolean(null)).toBe(false);
      expect(deserializeBoolean('random')).toBe(false);
    });
  });

  describe('deserializeDate', () => {
    it('should convert ISO date strings to Date objects', () => {
      const isoString = '2023-12-25T10:30:00.000Z';
      const result = deserializeDate(isoString);
      expect(result).toBeInstanceOf(Date);
      expect(result?.toISOString()).toBe(isoString);
    });

    it('should return Date objects as-is', () => {
      const date = new Date();
      expect(deserializeDate(date)).toBe(date);
    });

    it('should return undefined for invalid dates', () => {
      expect(deserializeDate('not-a-date')).toBeUndefined();
      expect(deserializeDate(undefined)).toBeUndefined();
      expect(deserializeDate(null)).toBeUndefined();
    });
  });

  describe('isDabStringBoolean', () => {
    it('should identify DAB string booleans', () => {
      expect(isDabStringBoolean('true')).toBe(true);
      expect(isDabStringBoolean('false')).toBe(true);
    });

    it('should reject non-boolean strings and other types', () => {
      expect(isDabStringBoolean('TRUE')).toBe(false);
      expect(isDabStringBoolean('FALSE')).toBe(false);
      expect(isDabStringBoolean('random')).toBe(false);
      expect(isDabStringBoolean(true)).toBe(false);
      expect(isDabStringBoolean(123)).toBe(false);
    });
  });

  describe('deserializeDabResponse', () => {
    it('preserves "true"/"false" strings verbatim (do not coerce to boolean)', () => {
      // Regression: `@text()` and `@set('true', 'false')` values are
      // byte-identical to `@boolean()` values on the wire — the
      // deserializer must NOT guess.
      const input = {
        id: '1',
        name: 'Test',
        isActive: 'true',
        isCompleted: 'false',
      };

      const result = deserializeDabResponse(input);

      expect(result.id).toBe('1');
      expect(result.name).toBe('Test');
      expect(result.isActive).toBe('true');
      expect(result.isCompleted).toBe('false');
    });

    it('should preserve ISO date strings verbatim (do not coerce to Date)', () => {
      // Regression: date-shaped strings on the wire are indistinguishable
      // between @text() and @date() fields — the deserializer must NOT guess.
      const input = {
        id: '1',
        createdAt: '2023-12-25T10:30:00.000Z',
        updatedAt: '2023-12-26T15:45:30.123Z',
      };

      const result = deserializeDabResponse(input);

      expect(result.id).toBe('1');
      expect(result.createdAt).toBe('2023-12-25T10:30:00.000Z');
      expect(result.updatedAt).toBe('2023-12-26T15:45:30.123Z');
    });

    it('should preserve date-only strings verbatim (do not coerce to Date)', () => {
      const input = {
        id: '1',
        dueDate: '2025-07-01',
        createdAt: '2023-12-25T10:30:00.000Z',
      };

      const result = deserializeDabResponse(input);

      expect(result.id).toBe('1');
      expect(result.dueDate).toBe('2025-07-01');
      expect(result.createdAt).toBe('2023-12-25T10:30:00.000Z');
    });

    it('should handle arrays of objects and preserve boolean-shaped strings', () => {
      const input = [
        { id: '1', isActive: 'true' },
        { id: '2', isActive: 'false' },
      ];

      const result = deserializeDabResponse(input);

      expect(Array.isArray(result)).toBe(true);
      expect(result[0].isActive).toBe('true');
      expect(result[1].isActive).toBe('false');
    });

    it('should handle nested objects and preserve string-shaped scalars', () => {
      const input = {
        user: {
          id: '1',
          isActive: 'true',
          profile: {
            isPublic: 'false',
            lastLogin: '2023-12-25T10:30:00.000Z',
          },
        },
      };

      const result = deserializeDabResponse(input);

      // Regression: boolean- and date-shaped strings must round-trip
      // unchanged so `@text()` and `@set()` fields are preserved.
      expect(result.user.isActive).toBe('true');
      expect(result.user.profile.isPublic).toBe('false');
      expect(result.user.profile.lastLogin).toBe('2023-12-25T10:30:00.000Z');
    });

    it('should preserve primitive values', () => {
      const input = {
        id: '1',
        count: 42,
        name: 'Test',
        rating: 4.5,
        status: null,
      };

      const result = deserializeDabResponse(input);

      expect(result.id).toBe('1');
      expect(result.count).toBe(42);
      expect(result.name).toBe('Test');
      expect(result.rating).toBe(4.5);
      expect(result.status).toBe(null);
    });

    it('should handle null and undefined inputs', () => {
      expect(deserializeDabResponse(null)).toBe(null);
      expect(deserializeDabResponse(undefined)).toBe(undefined);
    });

    it('should preserve existing Date objects without corrupting them', () => {
      const testDate = new Date('2023-12-25T10:30:00.000Z');
      const input = {
        id: '1',
        created_at: testDate, // Already a Date object
        isActive: 'true',
      };

      const result = deserializeDabResponse(input);

      expect(result.id).toBe('1');
      expect(result.created_at).toBeInstanceOf(Date);
      expect(result.created_at).toBe(testDate); // Should be the exact same Date object
      expect(result.isActive).toBe('true');
    });
  });

  // Regression: value-sniffing "true"/"false" strings mis-classified
  // `@text()` and `@set('true', 'false')` fields as booleans. Parallel to
  // the date-coercion bug — same fix: preserve strings unchanged.
  describe('deserializeDabResponse — boolean-coercion regressions', () => {
    it('does not coerce a "true" string on a text field', () => {
      const result = deserializeDabResponse({ label: 'true' });
      expect(result.label).toBe('true');
      expect(typeof result.label).toBe('string');
    });

    it('does not coerce a "false" string on a text field', () => {
      const result = deserializeDabResponse({ label: 'false' });
      expect(result.label).toBe('false');
      expect(typeof result.label).toBe('string');
    });

    it('does not coerce "true"/"false" strings nested in child objects', () => {
      const result = deserializeDabResponse({
        user: { profile: { flag: 'true', other: 'false' } },
      });
      expect(result.user.profile.flag).toBe('true');
      expect(result.user.profile.other).toBe('false');
    });
  });

  // Regression: value-sniffing ISO strings mis-classified `@text()` and
  // `@set()` fields as dates. See the "date-coercion" bug report.
  describe('deserializeDabResponse — date-coercion regressions', () => {
    it('does not coerce a date-only string on a text field', () => {
      const result = deserializeDabResponse({ label: '2026-01-15' });
      expect(result.label).toBe('2026-01-15');
      expect(result.label).not.toBeInstanceOf(Date);
    });

    it('does not coerce a full ISO string (with Z) on a text field', () => {
      const result = deserializeDabResponse({
        ref: '2023-12-25T10:30:00.000Z',
      });
      expect(result.ref).toBe('2023-12-25T10:30:00.000Z');
      expect(result.ref).not.toBeInstanceOf(Date);
    });

    it('does not coerce a timezone-less ISO string on a text field', () => {
      const result = deserializeDabResponse({
        ref: '2023-12-25T10:30:00',
      });
      expect(result.ref).toBe('2023-12-25T10:30:00');
      expect(result.ref).not.toBeInstanceOf(Date);
    });

    it('does not coerce ISO strings nested in child objects', () => {
      const result = deserializeDabResponse({
        user: {
          profile: {
            lastLogin: '2023-12-25T10:30:00.000Z',
          },
        },
      });
      expect(result.user.profile.lastLogin).toBe('2023-12-25T10:30:00.000Z');
      expect(result.user.profile.lastLogin).not.toBeInstanceOf(Date);
    });
  });

  // Targeted, metadata-aware conversion: when a decorated entity class is
  // provided, only fields declared as `@date()` are converted to `Date`.
  // `@text()` fields whose values happen to look like ISO dates stay as
  // strings, and relationship fields recurse into the target entity's
  // metadata.
  describe('deserializeDabResponse — metadata-aware (@entity)', () => {
    @entity()
    class Category {
      @uuid() id!: string;
      @text() name!: string;
      @date() createdAt!: Date;
      @boolean() isArchived!: boolean;
    }

    @entity()
    class Todo {
      @uuid() id!: string;
      @text() title!: string;
      // A `@text()` field whose value looks like an ISO date must stay a
      // string in metadata-aware mode.
      @text() note!: string;
      // A `@text()` field whose value looks like `"true"`/`"false"` must
      // also stay a string in metadata-aware mode.
      @text() label!: string;
      @date() createdAt!: Date;
      @date() dueDate?: Date;
      @boolean() isCompleted!: boolean;
      @boolean() isPinned?: boolean;
      @one(() => Category) category?: Category;
      @many(() => Category) categories?: Category[];
    }

    it('converts @date() strings to Date and preserves @text() strings', () => {
      const result = deserializeDabResponse<Todo>(
        {
          id: '1',
          title: 'Ship it',
          note: '2026-01-15T10:30:00.000Z',
          createdAt: '2026-09-11T12:34:56.789Z',
          dueDate: '2026-10-01',
        },
        Todo
      );

      expect(result.createdAt).toBeInstanceOf(Date);
      expect((result.createdAt as Date).toISOString()).toBe(
        '2026-09-11T12:34:56.789Z'
      );
      expect(result.dueDate).toBeInstanceOf(Date);
      expect(typeof result.note).toBe('string');
      expect(result.note).toBe('2026-01-15T10:30:00.000Z');
      expect(result.title).toBe('Ship it');
    });

    it.each([
      // Out-of-range month/day — parses to NaN.
      '2026-13-45',
      // Calendar rollovers — JS silently normalizes these to a valid Date
      // (Feb 30 → Mar 2, Apr 31 → May 1) so a naive `new Date()` would
      // corrupt bad wire data.
      '2026-02-30',
      '2026-04-31',
      '2025-02-29', // non-leap year
      // Datetime rollovers.
      '2026-01-01T25:00:00Z',
      '2026-01-01T00:60:00Z',
      // Malformed ISO shapes we do not accept.
      'not-a-date',
      '2026/01/15',
      '2026-1-1',
    ])('preserves invalid or malformed @date() value %j as a string', (bad) => {
      const result = deserializeDabResponse<Todo>(
        {
          id: '1',
          title: 't',
          note: 'n',
          label: 'n',
          createdAt: bad,
        },
        Todo
      );

      expect(result.createdAt).not.toBeInstanceOf(Date);
      expect(result.createdAt as unknown as string).toBe(bad);
    });

    it('recurses into a to-one relationship with the target metadata', () => {
      const result = deserializeDabResponse<Todo>(
        {
          id: '1',
          title: 't',
          note: '2026-01-15T10:30:00.000Z',
          createdAt: '2026-09-11T12:34:56.789Z',
          category: {
            id: 'c1',
            name: '2026-05-01', // @text() on Category — must stay a string
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        },
        Todo
      );

      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.category).toBeDefined();
      expect(typeof result.category!.name).toBe('string');
      expect(result.category!.name).toBe('2026-05-01');
      expect(result.category!.createdAt).toBeInstanceOf(Date);
    });

    it('unwraps DAB `{ items: [...] }` to-many envelopes to match the declared array type', () => {
      const result = deserializeDabResponse<Todo>(
        {
          id: '1',
          title: 't',
          note: 'n',
          createdAt: '2026-09-11T12:34:56.789Z',
          categories: {
            items: [
              {
                id: 'c1',
                name: '2026-01-15',
                createdAt: '2026-01-01T00:00:00.000Z',
              },
              {
                id: 'c2',
                name: 'plain',
                createdAt: '2026-02-01T00:00:00.000Z',
              },
            ],
            hasNextPage: false,
          },
        },
        Todo
      );

      // Declared type is `Category[]`; runtime must be an array (no envelope).
      expect(Array.isArray(result.categories)).toBe(true);
      expect(result.categories).toHaveLength(2);
      expect(result.categories![0].createdAt).toBeInstanceOf(Date);
      expect(result.categories![0].name).toBe('2026-01-15');
      expect(typeof result.categories![0].name).toBe('string');
      expect(result.categories![1].createdAt).toBeInstanceOf(Date);
    });

    it('handles arrays of rows', () => {
      const result = deserializeDabResponse(
        [
          {
            id: '1',
            title: 'a',
            note: '2026-01-15',
            createdAt: '2026-09-11T12:34:56.789Z',
          },
          {
            id: '2',
            title: 'b',
            note: 'plain',
            createdAt: '2026-09-12T00:00:00.000Z',
          },
        ],
        Todo
      ) as unknown as Todo[];

      expect(result).toHaveLength(2);
      expect(result[0].createdAt).toBeInstanceOf(Date);
      expect(result[0].note).toBe('2026-01-15');
      expect(result[1].createdAt).toBeInstanceOf(Date);
    });

    it('preserves nulls, undefined, and existing Date instances', () => {
      const existing = new Date('2026-01-01T00:00:00.000Z');
      const result = deserializeDabResponse<Todo>(
        {
          id: '1',
          title: 't',
          note: 'n',
          createdAt: existing,
          dueDate: null,
        },
        Todo
      );

      expect(result.createdAt).toBe(existing);
      expect(result.dueDate).toBe(null);
    });

    it('converts DAB string booleans to booleans only on @boolean() fields', () => {
      const result = deserializeDabResponse<Todo>(
        {
          id: '1',
          title: 't',
          note: 'n',
          // A @text() field whose value is `"false"` must stay a string —
          // runtime `"false"` is truthy, so callers that accidentally treat
          // the wire string as a boolean would silently see truthy.
          label: 'false',
          createdAt: '2026-09-11T12:34:56.789Z',
          isCompleted: 'false',
          isPinned: 'true',
        },
        Todo
      );

      expect(result.isCompleted).toBe(false);
      expect(typeof result.isCompleted).toBe('boolean');
      expect(result.isPinned).toBe(true);
      expect(typeof result.isPinned).toBe('boolean');
      expect(result.label).toBe('false');
      expect(typeof result.label).toBe('string');
    });

    it('passes real booleans through and preserves nulls on @boolean() fields', () => {
      const result = deserializeDabResponse<Todo>(
        {
          id: '1',
          title: 't',
          note: 'n',
          label: 'n',
          createdAt: '2026-09-11T12:34:56.789Z',
          isCompleted: true,
          isPinned: null,
        },
        Todo
      );

      expect(result.isCompleted).toBe(true);
      expect(result.isPinned).toBe(null);
    });

    it('applies boolean conversion inside related entities', () => {
      const result = deserializeDabResponse<Todo>(
        {
          id: '1',
          title: 't',
          note: 'n',
          label: 'n',
          createdAt: '2026-09-11T12:34:56.789Z',
          isCompleted: 'true',
          category: {
            id: 'c1',
            name: 'work',
            createdAt: '2026-01-01T00:00:00.000Z',
            isArchived: 'false',
          },
          categories: {
            items: [
              {
                id: 'c1',
                name: 'a',
                createdAt: '2026-01-01T00:00:00.000Z',
                isArchived: 'true',
              },
              {
                id: 'c2',
                name: 'b',
                createdAt: '2026-02-01T00:00:00.000Z',
                isArchived: 'false',
              },
            ],
            hasNextPage: false,
          },
        },
        Todo
      );

      expect(result.isCompleted).toBe(true);
      expect(result.category!.isArchived).toBe(false);
      expect(typeof result.category!.isArchived).toBe('boolean');
      expect(Array.isArray(result.categories)).toBe(true);
      expect(result.categories![0].isArchived).toBe(true);
      expect(result.categories![1].isArchived).toBe(false);
    });
  });

  // Rollback path: with the `cli-minor-fixes` flag off, `deserializeDabResponse`
  // must fall back to the pre-PR legacy value-sniffing walker for both the
  // structure-only and metadata-aware entry points. This mirrors production
  // default behavior and guards the GA rollback story.
  describe('deserializeDabResponse — gate off (legacy value-sniffing)', () => {
    let _prevFlags: string | undefined;
    beforeAll(() => {
      _prevFlags = process.env.RAYFIN_FEATURE_FLAGS;
      delete process.env.RAYFIN_FEATURE_FLAGS;
    });
    afterAll(() => {
      if (_prevFlags === undefined) delete process.env.RAYFIN_FEATURE_FLAGS;
      else process.env.RAYFIN_FEATURE_FLAGS = _prevFlags;
    });

    it('coerces "true"/"false" strings to booleans (legacy behavior)', () => {
      const result = deserializeDabResponse({
        id: '1',
        isActive: 'true',
        isCompleted: 'false',
      });

      expect(result.isActive).toBe(true);
      expect(result.isCompleted).toBe(false);
    });

    it('coerces ISO-shaped strings to Date objects (legacy behavior)', () => {
      const result = deserializeDabResponse({
        id: '1',
        createdAt: '2023-12-25T10:30:00.000Z',
        dueDate: '2025-07-01',
      });

      expect(result.createdAt).toBeInstanceOf(Date);
      expect((result.createdAt as Date).toISOString()).toBe(
        '2023-12-25T10:30:00.000Z'
      );
      expect(result.dueDate).toBeInstanceOf(Date);
    });

    it('coerces nested "true"/"false" and ISO strings inside child objects', () => {
      const result = deserializeDabResponse({
        user: {
          profile: {
            isPublic: 'false',
            lastLogin: '2023-12-25T10:30:00.000Z',
          },
        },
      });

      expect(result.user.profile.isPublic).toBe(false);
      expect(result.user.profile.lastLogin).toBeInstanceOf(Date);
    });

    it('ignores the entity argument and still value-sniffs when the flag is off', () => {
      // The metadata-aware overload must not run while the gate is off —
      // an `@text()` field with an ISO-shaped value should still be
      // coerced to a Date by the legacy walker, matching pre-PR behavior.
      @entity()
      class Row {
        @uuid() id!: string;
        @text() note!: string;
        @date() createdAt!: Date;
      }

      const result = deserializeDabResponse<Row>(
        {
          id: '1',
          note: '2026-01-15T10:30:00.000Z',
          createdAt: '2026-09-11T12:34:56.789Z',
        },
        Row
      );

      expect(result.note).toBeInstanceOf(Date);
      expect(result.createdAt).toBeInstanceOf(Date);
    });
  });
});
