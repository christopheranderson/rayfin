import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { ConnectorSchemaAnalyzer } from '../analysis/connector-schema-analyzer';
import { SchemaAnalyzer, MAX_ENTITIES } from '../analysis/schema-analyzer';
import {
  SchemaValidationError,
  ValidationErrorCollector,
  ValidationError,
} from '../analysis/validation-errors';
import {
  entity,
  text,
  uuid,
  int,
  decimal,
  set,
  one,
  email,
} from '../decorators/decorators';

// GA-rollout gate: the finite-bounds test asserts the new behavior; enable
// the flag so the gated code paths run.
let _originalFlags: string | undefined;
beforeAll(() => {
  _originalFlags = process.env.RAYFIN_FEATURE_FLAGS;
  process.env.RAYFIN_FEATURE_FLAGS = 'cli-minor-fixes';
});
afterAll(() => {
  if (_originalFlags === undefined) delete process.env.RAYFIN_FEATURE_FLAGS;
  else process.env.RAYFIN_FEATURE_FLAGS = _originalFlags;
});

describe('Schema Validation Error Aggregation', () => {
  describe('Decorator option validation', () => {
    it('should detect invalid text field min/max options', () => {
      @entity()
      class InvalidTextRange {
        @uuid()
        id!: string;

        @text({ min: 30, max: 10 }) // min > max
        username!: string;
      }

      const analyzer = new SchemaAnalyzer([InvalidTextRange], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const minMaxError = error.errors.find(
            (e) =>
              e.field === 'username' &&
              e.message.includes(
                'min (30) must be less than or equal to max (10)'
              )
          );
          expect(minMaxError).toBeDefined();
          expect(minMaxError?.entity).toBe('InvalidTextRange');
        }
      }
    });

    it('should detect negative text field min', () => {
      @entity()
      class NegativeMin {
        @uuid()
        id!: string;

        @text({ min: -1 })
        username!: string;
      }

      const analyzer = new SchemaAnalyzer([NegativeMin], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const negMinError = error.errors.find(
            (e) =>
              e.field === 'username' && e.message.includes('cannot be negative')
          );
          expect(negMinError).toBeDefined();
        }
      }
    });

    it('should detect negative text field max', () => {
      @entity()
      class NegativeMax {
        @uuid()
        id!: string;

        @text({ max: -5 })
        title!: string;
      }

      const analyzer = new SchemaAnalyzer([NegativeMax], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const negMaxError = error.errors.find(
            (e) =>
              e.field === 'title' && e.message.includes('cannot be negative')
          );
          expect(negMaxError).toBeDefined();
        }
      }
    });

    it('should detect unique constraint on unbounded text field for MSSQL', () => {
      @entity()
      class UnboundedUniqueText {
        @uuid()
        id!: string;

        @text({ unique: true }) // No max length
        slug!: string;
      }

      const analyzer = new SchemaAnalyzer([UnboundedUniqueText], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const uniqueError = error.errors.find(
            (e) =>
              e.field === 'slug' &&
              e.message.includes('Unique constraint on unbounded text field')
          );
          expect(uniqueError).toBeDefined();
          expect(uniqueError?.fix).toContain('max');
        }
      }
    });

    it('should allow unique constraint on bounded text field', () => {
      @entity()
      class BoundedUniqueText {
        @uuid()
        id!: string;

        @text({ unique: true, max: 255 })
        slug!: string;
      }

      const analyzer = new SchemaAnalyzer([BoundedUniqueText], 'mssql');

      expect(() => analyzer.analyzeEntities()).not.toThrow();
    });

    it('should allow unbounded text field without unique constraint', () => {
      @entity()
      class UnboundedText {
        @uuid()
        id!: string;

        @text()
        content!: string;
      }

      const analyzer = new SchemaAnalyzer([UnboundedText], 'mssql');

      expect(() => analyzer.analyzeEntities()).not.toThrow();
    });

    it('should allow unique constraint on unbounded text field for PostgreSQL', () => {
      @entity()
      class UnboundedUniqueText {
        @uuid()
        id!: string;

        @text({ unique: true }) // No max length — valid for PostgreSQL TEXT
        slug!: string;
      }

      const analyzer = new SchemaAnalyzer([UnboundedUniqueText], 'postgresql');

      expect(() => analyzer.analyzeEntities()).not.toThrow();
    });

    it('should error when text field max exceeds MSSQL NVARCHAR limit', () => {
      @entity()
      class ExceedsNvarcharLimit {
        @uuid()
        id!: string;

        @text({ max: 5000 }) // Exceeds MSSQL NVARCHAR(n) limit of 4000
        description!: string;
      }

      const analyzer = new SchemaAnalyzer([ExceedsNvarcharLimit], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(
        /exceeds the maximum sized string length/
      );
    });

    it('should allow text field max at MSSQL NVARCHAR limit', () => {
      @entity()
      class AtNvarcharLimit {
        @uuid()
        id!: string;

        @text({ max: 4000 }) // Exactly at the MSSQL limit
        description!: string;
      }

      const analyzer = new SchemaAnalyzer([AtNvarcharLimit], 'mssql');

      expect(() => analyzer.analyzeEntities()).not.toThrow();
    });

    it('should allow text field max exceeding 4000 for PostgreSQL', () => {
      @entity()
      class LargeVarchar {
        @uuid()
        id!: string;

        @text({ max: 10000 }) // PostgreSQL VARCHAR has no practical limit
        description!: string;
      }

      const analyzer = new SchemaAnalyzer([LargeVarchar], 'postgresql');

      expect(() => analyzer.analyzeEntities()).not.toThrow();
    });

    it('should allow text field max at Fabric Warehouse VARCHAR(8000) limit', () => {
      @entity()
      class FabricWarehouseAtLimit {
        @uuid()
        id!: string;

        // Fabric Warehouse VARCHAR(n) ceiling is 8000 — discovery emits
        // this for `varchar`/`nvarchar` columns reported with
        // CHARACTER_MAXIMUM_LENGTH = 8000.
        @text({ max: 8000 })
        description!: string;
      }

      const analyzer = new SchemaAnalyzer(
        [FabricWarehouseAtLimit],
        'fabric-warehouse'
      );

      expect(() => analyzer.analyzeEntities()).not.toThrow();
    });

    it('should allow text field max at Fabric Lakehouse SQL Analytics VARCHAR(8000) limit', () => {
      @entity()
      class FabricLakehouseAtLimit {
        @uuid()
        id!: string;

        @text({ max: 8000 })
        description!: string;
      }

      const analyzer = new SchemaAnalyzer(
        [FabricLakehouseAtLimit],
        'fabric-sqlanalytics'
      );

      expect(() => analyzer.analyzeEntities()).not.toThrow();
    });

    it('should error when text field max exceeds Fabric Warehouse VARCHAR(8000) limit', () => {
      @entity()
      class FabricExceedsLimit {
        @uuid()
        id!: string;

        @text({ max: 8001 })
        description!: string;
      }

      const analyzer = new SchemaAnalyzer(
        [FabricExceedsLimit],
        'fabric-warehouse'
      );

      expect(() => analyzer.analyzeEntities()).toThrow(
        /exceeds the maximum sized string length \(8000\) for FABRIC-WAREHOUSE/
      );
    });

    it('Fabric dialect fix hint references VARCHAR(MAX), not NVARCHAR(MAX)', () => {
      @entity()
      class FabricFixHint {
        @uuid()
        id!: string;

        @text({ max: 9000 })
        description!: string;
      }

      const analyzer = new SchemaAnalyzer(
        [FabricFixHint],
        'fabric-sqlanalytics'
      );

      // Build-time hint should mention VARCHAR(MAX) — the Fabric Warehouse
      // unbounded text type — rather than NVARCHAR(MAX), which is the
      // on-prem MSSQL hint and doesn't exist in Fabric.
      expect(() => analyzer.analyzeEntities()).toThrow(/VARCHAR\(MAX\)/);
      expect(() => analyzer.analyzeEntities()).not.toThrow(/NVARCHAR\(MAX\)/);
    });

    it('should allow unique constraint on email field (default max 320)', () => {
      @entity()
      class UniqueEmail {
        @uuid()
        id!: string;

        @email({ unique: true }) // Defaults to max: 320
        contactEmail!: string;
      }

      const analyzer = new SchemaAnalyzer([UniqueEmail], 'mssql');

      expect(() => analyzer.analyzeEntities()).not.toThrow();
    });

    it('should detect invalid int field min/max options', () => {
      @entity()
      class InvalidIntRange {
        @uuid()
        id!: string;

        @int({ min: 100, max: 50 }) // min > max
        score!: number;
      }

      const analyzer = new SchemaAnalyzer([InvalidIntRange], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const minMaxError = error.errors.find(
            (e) =>
              e.field === 'score' &&
              e.message.includes(
                'min (100) must be less than or equal to max (50)'
              )
          );
          expect(minMaxError).toBeDefined();
        }
      }
    });

    it('should detect invalid decimal field min/max options', () => {
      @entity()
      class InvalidDecimalRange {
        @uuid()
        id!: string;

        @decimal({ min: 99.99, max: 10.5 }) // min > max
        price!: number;
      }

      const analyzer = new SchemaAnalyzer([InvalidDecimalRange], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const minMaxError = error.errors.find(
            (e) =>
              e.field === 'price' &&
              e.message.includes(
                'min (99.99) must be less than or equal to max (10.5)'
              )
          );
          expect(minMaxError).toBeDefined();
        }
      }
    });

    it.each([SchemaAnalyzer, ConnectorSchemaAnalyzer])(
      '%s should reject non-finite numeric bounds',
      (Analyzer) => {
        @entity()
        class NonFiniteBounds {
          @uuid()
          id!: string;

          @int({ min: Number.NaN })
          score!: number;

          @decimal({ max: Number.POSITIVE_INFINITY })
          price!: number;
        }

        const analyzer = new Analyzer([NonFiniteBounds], 'mssql');

        expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

        try {
          analyzer.analyzeEntities();
        } catch (error) {
          expect(error).toBeInstanceOf(SchemaValidationError);
          const validationError = error as SchemaValidationError;
          expect(validationError.errors).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                field: 'score',
                message:
                  'Invalid numeric field: min (NaN) must be a finite number',
              }),
              expect.objectContaining({
                field: 'price',
                message:
                  'Invalid numeric field: max (Infinity) must be a finite number',
              }),
            ])
          );
        }
      }
    );

    it('should detect precision without scale', () => {
      @entity()
      class PrecisionOnly {
        @uuid()
        id!: string;

        @decimal({ precision: 10 })
        price!: number;
      }

      const analyzer = new SchemaAnalyzer([PrecisionOnly], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const err = error.errors.find(
            (e) =>
              e.field === 'price' &&
              e.message.includes("'precision' is defined without 'scale'")
          );
          expect(err).toBeDefined();
          expect(err?.entity).toBe('PrecisionOnly');
        }
      }
    });

    it('should detect scale without precision', () => {
      @entity()
      class ScaleOnly {
        @uuid()
        id!: string;

        @decimal({ scale: 2 })
        amount!: number;
      }

      const analyzer = new SchemaAnalyzer([ScaleOnly], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const err = error.errors.find(
            (e) =>
              e.field === 'amount' &&
              e.message.includes("'scale' is defined without 'precision'")
          );
          expect(err).toBeDefined();
          expect(err?.entity).toBe('ScaleOnly');
        }
      }
    });

    it('should detect precision exceeding maximum of 28', () => {
      @entity()
      class PrecisionTooHigh {
        @uuid()
        id!: string;

        @decimal({ precision: 29, scale: 2 })
        value!: number;
      }

      const analyzer = new SchemaAnalyzer([PrecisionTooHigh], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const err = error.errors.find(
            (e) =>
              e.field === 'value' &&
              e.message.includes('precision (29)') &&
              e.message.includes('maximum of 28')
          );
          expect(err).toBeDefined();
        }
      }
    });

    it('should enforce same max precision of 28 for PostgreSQL', () => {
      @entity()
      class PgPrecisionTooHigh {
        @uuid()
        id!: string;

        @decimal({ precision: 29, scale: 2 })
        value!: number;
      }

      const analyzer = new SchemaAnalyzer([PgPrecisionTooHigh], 'postgresql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);
    });

    it('should allow precision up to 28', () => {
      @entity()
      class MaxPrecision {
        @uuid()
        id!: string;

        @decimal({ precision: 28, scale: 10 })
        value!: number;
      }

      const analyzer = new SchemaAnalyzer([MaxPrecision], 'mssql');

      expect(() => analyzer.analyzeEntities()).not.toThrow();
    });

    it('should detect precision less than 1', () => {
      @entity()
      class ZeroPrecision {
        @uuid()
        id!: string;

        @decimal({ precision: 0, scale: 0 })
        value!: number;
      }

      const analyzer = new SchemaAnalyzer([ZeroPrecision], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const err = error.errors.find(
            (e) =>
              e.field === 'value' &&
              e.message.includes('precision (0)') &&
              e.message.includes('must be at least 1')
          );
          expect(err).toBeDefined();
        }
      }
    });

    it('should detect scale exceeding precision', () => {
      @entity()
      class ScaleExceedsPrecision {
        @uuid()
        id!: string;

        @decimal({ precision: 5, scale: 6 })
        value!: number;
      }

      const analyzer = new SchemaAnalyzer([ScaleExceedsPrecision], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const err = error.errors.find(
            (e) =>
              e.field === 'value' &&
              e.message.includes('scale (6)') &&
              e.message.includes('cannot exceed precision (5)')
          );
          expect(err).toBeDefined();
        }
      }
    });

    it('should detect negative scale', () => {
      @entity()
      class NegativeScale {
        @uuid()
        id!: string;

        @decimal({ precision: 10, scale: -1 })
        value!: number;
      }

      const analyzer = new SchemaAnalyzer([NegativeScale], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const err = error.errors.find(
            (e) =>
              e.field === 'value' &&
              e.message.includes('scale (-1)') &&
              e.message.includes('cannot be negative')
          );
          expect(err).toBeDefined();
        }
      }
    });

    it('should detect non-integer precision', () => {
      @entity()
      class NonIntPrecision {
        @uuid()
        id!: string;

        @decimal({ precision: 10.5, scale: 2 })
        value!: number;
      }

      const analyzer = new SchemaAnalyzer([NonIntPrecision], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const err = error.errors.find(
            (e) =>
              e.field === 'value' &&
              e.message.includes('precision (10.5)') &&
              e.message.includes('must be an integer')
          );
          expect(err).toBeDefined();
        }
      }
    });

    it('should detect non-integer scale', () => {
      @entity()
      class NonIntScale {
        @uuid()
        id!: string;

        @decimal({ precision: 10, scale: 2.5 })
        value!: number;
      }

      const analyzer = new SchemaAnalyzer([NonIntScale], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const err = error.errors.find(
            (e) =>
              e.field === 'value' &&
              e.message.includes('scale (2.5)') &&
              e.message.includes('must be an integer')
          );
          expect(err).toBeDefined();
        }
      }
    });

    it('should accept valid precision and scale', () => {
      @entity()
      class ValidDecimal {
        @uuid()
        id!: string;

        @decimal({ precision: 10, scale: 2 })
        price!: number;

        @decimal({ precision: 28, scale: 0 })
        bigInteger!: number;

        @decimal()
        defaultDecimal!: number;
      }

      const analyzer = new SchemaAnalyzer([ValidDecimal], 'mssql');

      expect(() => analyzer.analyzeEntities()).not.toThrow();
    });
  });

  describe('Validation severity', () => {
    it('should support error severity (default)', () => {
      @entity()
      class TestEntity {
        @uuid()
        id!: string;

        @text({ min: 50, max: 10 })
        field!: string;
      }

      const analyzer = new SchemaAnalyzer([TestEntity], 'mssql');

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          expect(error.errors.length).toBeGreaterThan(0);
          // Default severity should be 'error' (or undefined, treated as error)
          const allErrors = error.errors.every(
            (e) => !e.severity || e.severity === 'error'
          );
          expect(allErrors).toBe(true);
        }
      }
    });

    it('should not throw for warnings only', () => {
      // Create a collector manually to test warning-only scenario
      const collector = new (class extends ValidationErrorCollector {
        addWarning(error: ValidationError): void {
          this.addError({ ...error, severity: 'warning' });
        }
      })();

      collector.addWarning({
        entity: 'TestEntity',
        field: 'testField',
        message: 'This is a warning',
        severity: 'warning',
      });

      expect(collector.hasIssues()).toBe(true);
      expect(collector.hasErrors()).toBe(false);
      expect(() => collector.throwIfErrors()).not.toThrow();
    });
  });

  describe('Set/Enum validation', () => {
    it('should report empty set values error via schema analyzer', () => {
      // TypeScript's type system prevents empty enums at compile time with SetFieldOptions<T>
      // But if someone bypasses the type check, the schema analyzer should catch it
      // alongside all other validation errors rather than failing fast in the decorator.
      @entity()
      class EmptySet {
        @uuid()
        id!: string;

        // @ts-expect-error - Testing runtime validation of empty enum
        @set({ enum: [] })
        status!: string;
      }

      const analyzer = new SchemaAnalyzer([EmptySet], 'mssql');
      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const enumError = error.errors.find((e) =>
            e.message.includes('at least one value')
          );
          expect(enumError).toBeDefined();
          expect(enumError?.field).toBe('status');
        }
      }
    });

    it('should report duplicate set values error via schema analyzer', () => {
      // Duplicate value validation is deferred to the schema analyzer so that
      // all errors are collected and reported together.
      @entity()
      class DuplicateSet {
        @uuid()
        id!: string;

        @set('active', 'active', 'inactive')
        status!: 'active' | 'inactive';
      }

      const analyzer = new SchemaAnalyzer([DuplicateSet], 'mssql');
      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const dupError = error.errors.find((e) =>
            e.message.includes('enum values must be unique')
          );
          expect(dupError).toBeDefined();
          expect(dupError?.field).toBe('status');
        }
      }
    });
  });

  describe('Field name collision validation', () => {
    it('should detect duplicate field names (case-insensitive)', () => {
      @entity()
      class DuplicateFieldNames {
        @uuid()
        id!: string;

        @text()
        Name!: string;

        @text()
        name!: string; // Collision with Name
      }

      const analyzer = new SchemaAnalyzer([DuplicateFieldNames], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const duplicateError = error.errors.find(
            (e) =>
              e.field === 'name' && e.message.includes('Duplicate field name')
          );
          expect(duplicateError).toBeDefined();
          expect(duplicateError?.message).toContain('case-insensitive');
          // Check that the error message includes both field names
          expect(duplicateError?.message).toContain('name');
          expect(duplicateError?.message).toContain('Name');
        }
      }
    });
  });

  describe('Relationship and FK validation', () => {
    it('should detect unresolved relationship target', () => {
      @entity()
      class Order {
        @uuid()
        id!: string;

        // Target lambda throws (simulating a broken import / typo)
        @one((() => {
          throw new Error('Cannot find module');
        }) as any)
        customer!: unknown;
      }

      const analyzer = new SchemaAnalyzer([Order], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const resolveError = error.errors.find(
            (e) =>
              e.field === 'customer' &&
              e.message.includes('could not resolve its target entity')
          );
          expect(resolveError).toBeDefined();
          expect(resolveError?.entity).toBe('Order');
        }
      }
    });

    it('should detect relationship target not in schema', () => {
      @entity()
      class Author {
        @uuid()
        id!: string;

        @text()
        name!: string;
      }

      @entity()
      class Book {
        @uuid()
        id!: string;

        @text()
        title!: string;

        @one(() => Author)
        author!: Author;
      }

      // Author is NOT passed to the schema array
      const analyzer = new SchemaAnalyzer([Book], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const missingError = error.errors.find(
            (e) =>
              e.field === 'author' &&
              e.message.includes('not included in the schema')
          );
          expect(missingError).toBeDefined();
          expect(missingError?.entity).toBe('Book');
          expect(missingError?.message).toContain('Author');
        }
      }
    });

    it('should allow explicitly defined FK column fields', () => {
      // Users are allowed to explicitly define the FK column for a relationship.
      // The docs confirm that manual key definitions are valid.
      @entity()
      class Category {
        @uuid()
        id!: string;

        @text()
        name!: string;
      }

      @entity()
      class Product {
        @uuid()
        id!: string;

        @text()
        name!: string;

        // This relationship will try to generate 'category_id' FK
        @one(() => Category)
        category!: Category;

        // Explicitly defining the FK column alongside the relationship is valid
        @uuid()
        category_id!: string;
      }

      const analyzer = new SchemaAnalyzer([Category, Product], 'mssql');

      // Should succeed without errors
      expect(() => analyzer.analyzeEntities()).not.toThrow();
    });

    it('should detect FK type mismatch', () => {
      @entity()
      class Category {
        @uuid()
        id!: string;

        @text()
        name!: string;
      }

      @entity()
      class Product {
        @uuid()
        id!: string;

        @text()
        name!: string;

        // This relationship will try to use 'category_id' as FK
        @one(() => Category)
        category!: Category;

        // But this field is text, not UUID
        @text()
        category_id!: string;
      }

      const analyzer = new SchemaAnalyzer([Category, Product], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const typeError = error.errors.find((e) =>
            e.message.includes('Foreign key type conflict')
          );
          expect(typeError).toBeDefined();
          expect(typeError?.field).toBe('category');
          expect(typeError?.message).toContain('UUID');
        }
      }
    });

    it('should detect a required self-referencing @one relationship', () => {
      @entity()
      class TreeNode {
        @uuid()
        id!: string;

        @text()
        name!: string;

        // Required self-reference — its FK column lives on this same table,
        // so the first row could never be inserted.
        @one(() => TreeNode)
        parent!: TreeNode;
      }

      const analyzer = new SchemaAnalyzer([TreeNode], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const selfRefError = error.errors.find(
            (e) =>
              e.field === 'parent' &&
              e.message.includes(
                "Self-referencing relationship 'TreeNode.parent' must be optional"
              )
          );
          expect(selfRefError).toBeDefined();
          expect(selfRefError?.entity).toBe('TreeNode');
          expect(selfRefError?.fix).toContain('{ optional: true }');
        }
      }
    });

    it('should allow an optional self-referencing @one relationship', () => {
      @entity()
      class TreeNode {
        @uuid()
        id!: string;

        @text()
        name!: string;

        @one(() => TreeNode, { optional: true })
        parent?: TreeNode;
      }

      const analyzer = new SchemaAnalyzer([TreeNode], 'mssql');

      expect(() => analyzer.analyzeEntities()).not.toThrow();
    });
  });

  describe('Multiple errors aggregation', () => {
    it('should aggregate multiple validation errors from different entities', () => {
      @entity()
      class Entity1 {
        @uuid()
        id!: string;

        @text({ min: 50, max: 10 }) // Error 1: min > max
        field1!: string;
      }

      @entity()
      class Entity2 {
        @uuid()
        id!: string;

        @int({ min: 100, max: 50 }) // Error 2: min > max
        score!: number;
      }

      const analyzer = new SchemaAnalyzer([Entity1, Entity2], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          expect(error.errors.length).toBeGreaterThanOrEqual(2);
          expect(error.message).toContain('Found');
          expect(error.message).toContain('schema validation error');

          // Check that errors from both entities are present
          const entity1Errors = error.errors.filter(
            (e) => e.entity === 'Entity1'
          );
          const entity2Errors = error.errors.filter(
            (e) => e.entity === 'Entity2'
          );
          expect(entity1Errors.length).toBeGreaterThan(0);
          expect(entity2Errors.length).toBeGreaterThan(0);
        }
      }
    });

    it('should aggregate multiple errors from the same entity', () => {
      @entity()
      class MultipleErrors {
        @uuid()
        id!: string;

        @text({ min: -1 }) // Error 1: negative min
        field1!: string;

        @int({ min: 100, max: 50 }) // Error 2: min > max
        field2!: number;
      }

      const analyzer = new SchemaAnalyzer([MultipleErrors], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          expect(error.errors.length).toBeGreaterThanOrEqual(2);
          expect(error.errors.every((e) => e.entity === 'MultipleErrors')).toBe(
            true
          );
        }
      }
    });
  });

  describe('Primary key decorator validation', () => {
    it('should detect @text() on id field', () => {
      @entity()
      class TextId {
        @text()
        id!: string;
      }

      const analyzer = new SchemaAnalyzer([TextId], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const idError = error.errors.find(
            (e) =>
              e.field === 'id' &&
              e.message.includes('must use @uuid() decorator')
          );
          expect(idError).toBeDefined();
          expect(idError?.entity).toBe('TextId');
          expect(idError?.message).toContain("'text'");
        }
      }
    });

    it('should detect @email() on id field', () => {
      @entity()
      class EmailId {
        @email()
        id!: string;
      }

      const analyzer = new SchemaAnalyzer([EmailId], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const idError = error.errors.find(
            (e) =>
              e.field === 'id' &&
              e.message.includes('must use @uuid() decorator')
          );
          expect(idError).toBeDefined();
          expect(idError?.entity).toBe('EmailId');
          expect(idError?.message).toContain("'email'");
        }
      }
    });

    it('should not throw when id uses @uuid()', () => {
      @entity()
      class UuidId {
        @uuid()
        id!: string;

        @text()
        name!: string;
      }

      const analyzer = new SchemaAnalyzer([UuidId], 'mssql');

      expect(() => analyzer.analyzeEntities()).not.toThrow();
    });
  });

  describe('Valid schemas should pass', () => {
    it('should not throw for valid schema with proper constraints', () => {
      @entity()
      class ValidEntity {
        @uuid()
        id!: string;

        @text({ min: 1, max: 50 })
        username!: string;

        @int({ min: 0, max: 100 })
        score!: number;

        @set('active', 'inactive', 'pending')
        status!: 'active' | 'inactive' | 'pending';
      }

      const analyzer = new SchemaAnalyzer([ValidEntity], 'mssql');

      expect(() => analyzer.analyzeEntities()).not.toThrow();
      const result = analyzer.analyzeEntities();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('ValidEntity');
    });

    it('should not throw for valid relationships', () => {
      @entity()
      class Category {
        @uuid()
        id!: string;

        @text()
        name!: string;
      }

      @entity()
      class Product {
        @uuid()
        id!: string;

        @text()
        name!: string;

        @one(() => Category)
        category!: Category;
      }

      const analyzer = new SchemaAnalyzer([Category, Product], 'mssql');

      expect(() => analyzer.analyzeEntities()).not.toThrow();
      const result = analyzer.analyzeEntities();
      expect(result).toHaveLength(2);
    });
  });

  describe('Entity count limit', () => {
    it('should throw when schema exceeds MAX_ENTITIES', () => {
      // Dynamically create MAX_ENTITIES + 1 entity classes
      const entities = Array.from({ length: MAX_ENTITIES + 1 }, (_, i) => {
        @entity()
        class GeneratedEntity {
          @uuid()
          id!: string;

          @text()
          name!: string;
        }
        // Give each class a unique name so metadata doesn't collide
        Object.defineProperty(GeneratedEntity, 'name', {
          value: `Entity${i}`,
        });
        return GeneratedEntity;
      });

      const analyzer = new SchemaAnalyzer(entities, 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        // Use a fresh analyzer to avoid accumulated errors from prior call
        const analyzer2 = new SchemaAnalyzer(entities, 'mssql');
        analyzer2.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          expect(error.errors).toHaveLength(1);
          expect(error.errors[0].message).toContain(
            `exceeds the maximum of ${MAX_ENTITIES}`
          );
        }
      }
    });

    it('should not throw when schema has exactly MAX_ENTITIES', () => {
      const entities = Array.from({ length: MAX_ENTITIES }, (_, i) => {
        @entity()
        class GeneratedEntity {
          @uuid()
          id!: string;

          @text()
          name!: string;
        }
        Object.defineProperty(GeneratedEntity, 'name', {
          value: `Entity${i}`,
        });
        return GeneratedEntity;
      });

      const analyzer = new SchemaAnalyzer(entities, 'mssql');

      expect(() => analyzer.analyzeEntities()).not.toThrow();
    });
  });

  describe('System entity name conflicts', () => {
    it('should throw when an entity uses a reserved system entity name', () => {
      @entity()
      class User {
        @uuid()
        id!: string;

        @text()
        name!: string;

        @text()
        extraField!: string;
      }

      const analyzer = new SchemaAnalyzer([User], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        const analyzer2 = new SchemaAnalyzer([User], 'mssql');
        analyzer2.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          expect(error.errors).toHaveLength(1);
          expect(error.errors[0].entity).toBe('User');
          expect(error.errors[0].message).toContain(
            'built-in system entity and cannot be redefined'
          );
        }
      }
    });
  });

  // Custom foreign-key options (sourceFields / targetFields) on a relationship
  // are connector-only. The data-path DDL generator references the target's
  // `id` by convention, so the analyzer rejects them — this is the host-aware
  // backstop that also closes the compile-time cross-path blind spot (a
  // data-path host whose relationship targets a connector entity). Each test
  // asserts the specific custom-FK guard error fired, not merely that some
  // validation error was thrown.
  describe('Custom FK options are connector-only on the data path', () => {
    it('should reject a data-path relationship that sets sourceFields', () => {
      @entity()
      class Category {
        @uuid()
        id!: string;
      }
      @entity()
      class Product {
        @uuid()
        id!: string;

        @uuid()
        categoryId!: string;

        // Cast past the compile-time guard to exercise the runtime backstop,
        // as a JavaScript (or `any`-typed) caller would reach it.
        @one(() => Category, { sourceFields: ['categoryId'] } as never)
        category!: Category;
      }

      const analyzer = new SchemaAnalyzer([Product, Category], 'mssql');
      let caught: SchemaValidationError | undefined;
      try {
        analyzer.analyzeEntities();
      } catch (e) {
        caught = e as SchemaValidationError;
      }
      expect(caught).toBeInstanceOf(SchemaValidationError);
      expect(
        caught!.errors.some(
          (err) =>
            err.field === 'category' && /not supported here/.test(err.message)
        )
      ).toBe(true);
    });

    it('should reject a data-path relationship that sets targetFields', () => {
      @entity()
      class Category {
        @uuid()
        id!: string;

        @uuid()
        code!: string;
      }
      @entity()
      class Product {
        @uuid()
        id!: string;

        // Cast past the compile-time guard to exercise the runtime backstop,
        // as a JavaScript (or `any`-typed) caller would reach it.
        @one(() => Category, { targetFields: ['code'] } as never)
        category!: Category;
      }

      const analyzer = new SchemaAnalyzer([Product, Category], 'mssql');
      let caught: SchemaValidationError | undefined;
      try {
        analyzer.analyzeEntities();
      } catch (e) {
        caught = e as SchemaValidationError;
      }
      expect(caught).toBeInstanceOf(SchemaValidationError);
      expect(
        caught!.errors.some(
          (err) =>
            err.field === 'category' && /not supported here/.test(err.message)
        )
      ).toBe(true);
    });
  });

  describe('Custom schema rejection', () => {
    it('should reject @entity() name containing a dot', () => {
      @entity('ops.Foo')
      class OpsFoo {
        @uuid()
        id!: string;
      }

      const analyzer = new SchemaAnalyzer([OpsFoo], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const schemaError = error.errors.find((e) =>
            e.message.includes('Only the default database schema is supported')
          );
          expect(schemaError).toBeDefined();
          expect(schemaError?.entity).toBe('ops.Foo');
          expect(schemaError?.fix).toContain("Remove the '.'");
        }
      }
    });

    it('should accept unqualified entity names', () => {
      @entity()
      class Todo {
        @uuid()
        id!: string;
      }

      const analyzer = new SchemaAnalyzer([Todo], 'mssql');

      expect(() => analyzer.analyzeEntities()).not.toThrow();
    });
  });

  describe('Primary key column collision', () => {
    it("should reject a field named 'Id' that collides with the auto-injected 'id' primary key", () => {
      @entity()
      class CapitalId {
        @uuid()
        Id!: string;
      }

      const analyzer = new SchemaAnalyzer([CapitalId], 'mssql');

      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        analyzer.analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const pkError = error.errors.find((e) =>
            e.message.includes(
              "collides with the auto-generated 'id' primary key column"
            )
          );
          expect(pkError).toBeDefined();
          expect(pkError?.entity).toBe('CapitalId');
          expect(pkError?.field).toBe('Id');
          expect(pkError?.fix).toContain("lowercase 'id'");
        }
      }
    });

    it("should accept a field named lowercase 'id' as the primary key without injection", () => {
      @entity()
      class LowercaseId {
        @uuid()
        id!: string;
      }

      const analyzer = new SchemaAnalyzer([LowercaseId], 'mssql');

      expect(() => analyzer.analyzeEntities()).not.toThrow();

      const [result] = analyzer.analyzeEntities();
      const idFields = result.fields.filter(
        (f) => f.name.toLowerCase() === 'id'
      );
      expect(idFields).toHaveLength(1);
      expect(idFields[0].primaryKey).toBe(true);
    });
  });
});
