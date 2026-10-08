import { describe, it, expect, vi } from 'vitest';
import { expectTypeOf } from 'vitest';

import type { GraphQLClient } from '../../graphql/GraphQLClient';
import type {
  CreateInput,
  UpdateInput,
  RelationshipInput,
  PrimaryKeyOnly,
} from '../../graphql/types';

import { TestableGraphQLEntityClient } from './TestableGraphQLEntityClient';
import { compareQueries, validateDABCompliance } from './query-utils';
import type { TestSchema, Todo, User } from './sample-models';

/**
 * Tests for flexible relationship input types.
 *
 * Verifies that Builders can pass either:
 * 1. Full related entity objects (current behavior)
 * 2. Primary-key-only objects like `{ id: 'value' }` (new ergonomic shorthand)
 *
 */
describe('Flexible Relationship Input Types', () => {
  const mockGraphQLClient: GraphQLClient = {
    query: vi.fn(),
    mutation: vi.fn(),
    request: vi.fn(),
  } as any;

  describe('Type-Level Tests', () => {
    describe('PrimaryKeyOnly type', () => {
      it('should extract id field for entities with lowercase id', () => {
        // Type-level assertion: PrimaryKeyOnly<User> should be { id: string }
        expectTypeOf<PrimaryKeyOnly<User>>().toEqualTypeOf<{ id: string }>();
      });
    });

    describe('RelationshipInput type', () => {
      it('should accept full entity object', () => {
        // Full entity should be assignable to RelationshipInput
        const fullUser: User = { id: 'user-123', email: 'test@example.com' };
        expectTypeOf(fullUser).toExtend<RelationshipInput<User>>();
      });

      it('should accept primary-key-only object', () => {
        // Primary-key-only object should be assignable to RelationshipInput
        const idOnlyUser: PrimaryKeyOnly<User> = { id: 'user-123' };
        expectTypeOf(idOnlyUser).toExtend<RelationshipInput<User>>();
      });
    });

    describe('CreateInput type', () => {
      it('should accept full entity for relationship fields', () => {
        // CreateInput<Todo> should accept full Category for category field
        const input: CreateInput<Todo> = {
          title: 'Test Todo',
          isCompleted: false,
          priority: 'high',
          user: { id: 'user-123', email: 'test@example.com' },
          type: '',
          priorityLevel: 0,
          category: {
            id: 'cat-123',
            name: 'Work',
            color: '#ff0000',
            user: { id: 'user-123', email: 'test@example.com' },
          },
        };
        expectTypeOf(input).toExtend<CreateInput<Todo>>();
      });

      it('should accept primary-key-only object for required relationship fields', () => {
        // CreateInput<Todo> should accept { id: string } for user field
        const input: CreateInput<Todo> = {
          title: 'Test Todo',
          isCompleted: false,
          priority: 'high',
          type: '',
          priorityLevel: 0,
          user: { id: 'user-123' }, // Primary-key-only
        };
        expectTypeOf(input).toExtend<CreateInput<Todo>>();
      });

      it('should accept primary-key-only object for optional relationship fields', () => {
        // CreateInput<Todo> should accept { id: string } for optional category field
        const input: CreateInput<Todo> = {
          title: 'Test Todo',
          isCompleted: false,
          priority: 'high',
          type: '',
          priorityLevel: 0,
          user: { id: 'user-123' },
          category: { id: 'cat-123' }, // Primary-key-only for optional field
        };
        expectTypeOf(input).toExtend<CreateInput<Todo>>();
      });

      it('should allow omitting optional relationship fields', () => {
        // CreateInput<Todo> should allow omitting category
        const input: CreateInput<Todo> = {
          title: 'Test Todo',
          isCompleted: false,
          priority: 'high',
          type: '',
          priorityLevel: 0,
          user: { id: 'user-123' },
          // category intentionally omitted
        };
        expectTypeOf(input).toExtend<CreateInput<Todo>>();
      });
    });

    describe('UpdateInput type', () => {
      it('should accept primary-key-only object for relationship fields', () => {
        // UpdateInput<Todo> should accept { id: string } for relationships
        const input: UpdateInput<Todo> = {
          category: { id: 'new-cat-123' }, // Primary-key-only
        };
        expectTypeOf(input).toExtend<UpdateInput<Todo>>();
      });

      it('should accept full entity object for relationship fields', () => {
        // UpdateInput<Todo> should also accept full objects
        const input: UpdateInput<Todo> = {
          category: {
            id: 'cat-123',
            name: 'Work',
            color: '#ff0000',
            user: { id: 'user-123', email: 'test@example.com' },
          },
        };
        expectTypeOf(input).toExtend<UpdateInput<Todo>>();
      });
    });
  });

  describe('Runtime Tests', () => {
    describe('Create Mutations with Primary-Key-Only Input', () => {
      it('should generate correct mutation with id-only relationship object', () => {
        // Arrange
        const client = new TestableGraphQLEntityClient<TestSchema, 'Todo'>(
          mockGraphQLClient,
          'Todo'
        );

        // Act - Using primary-key-only object for user (new ergonomic shorthand)
        const actualMutation = client.buildCreateMutation({
          title: 'Test Todo',
          isCompleted: false,
          priority: 'high',
          type: '',
          priorityLevel: 0,
          user: { id: '00000000-0000-0000-0000-000000000000' }, // Primary-key-only
        });

        // Expected: Should correctly extract ID and form user_id field
        const expectedMutation = `
          mutation {
            createTodo(item: { title: "Test Todo", isCompleted: false, priority: "high", type: "", priorityLevel: 0, user_id: "00000000-0000-0000-0000-000000000000" }) {
              id
              title
              isCompleted
              priority
              type
              priorityLevel
              user_id
            }
          }
        `.trim();

        // Assert
        compareQueries(actualMutation, expectedMutation);
        validateDABCompliance(actualMutation, true);

        // Specific assertions
        expect(actualMutation).toContain(
          'user_id: "00000000-0000-0000-0000-000000000000"'
        );
        expect(actualMutation).not.toContain('email'); // Should not contain other User fields
      });

      it('should generate correct mutation with id-only optional relationship', () => {
        // Arrange
        const client = new TestableGraphQLEntityClient<TestSchema, 'Todo'>(
          mockGraphQLClient,
          'Todo'
        );

        // Act - Using primary-key-only for both required and optional relationships
        const actualMutation = client.buildCreateMutation({
          title: 'Todo with Category',
          isCompleted: false,
          priority: 'medium',
          type: '',
          priorityLevel: 0,
          user: { id: 'user-123' },
          category: { id: 'cat-456' }, // Primary-key-only for optional field
        });

        // Expected: Both relationship IDs should be extracted correctly
        const expectedMutation = `
          mutation {
            createTodo(item: { title: "Todo with Category", isCompleted: false, priority: "medium", type: "", priorityLevel: 0, user_id: "user-123", category_id: "cat-456" }) {
              id
              title
              isCompleted
              priority
              type
              priorityLevel
              user_id
              category_id
            }
          }
        `.trim();

        // Assert
        compareQueries(actualMutation, expectedMutation);
        validateDABCompliance(actualMutation, true);

        expect(actualMutation).toContain('user_id: "user-123"');
        expect(actualMutation).toContain('category_id: "cat-456"');
      });

      it('should handle mixed input (full object and id-only object)', () => {
        // Arrange
        const client = new TestableGraphQLEntityClient<TestSchema, 'Todo'>(
          mockGraphQLClient,
          'Todo'
        );

        // Act - Mix of full object and id-only
        const actualMutation = client.buildCreateMutation({
          title: 'Mixed Input Todo',
          isCompleted: true,
          priority: 'low',
          type: '',
          priorityLevel: 0,
          user: { id: 'user-789', email: 'test@example.com' }, // Full object
          category: { id: 'cat-abc' }, // Primary-key-only
        });

        // Assert: Both should work correctly
        expect(actualMutation).toContain('user_id: "user-789"');
        expect(actualMutation).toContain('category_id: "cat-abc"');
        expect(actualMutation).not.toContain('email'); // Full object properties stripped
      });
    });

    describe('Update Mutations with Primary-Key-Only Input', () => {
      it('should generate correct update mutation with id-only relationship', () => {
        // Arrange
        const client = new TestableGraphQLEntityClient<TestSchema, 'Todo'>(
          mockGraphQLClient,
          'Todo'
        );

        // Act - Update category using primary-key-only
        const actualMutation = client.buildUpdateMutation(
          { id: 'todo-123' },
          {
            category: { id: 'new-category-id' }, // Primary-key-only
          }
        );

        // Expected: Should update category_id correctly
        const expectedMutation = `
          mutation {
            updateTodo(
              id: "todo-123",
              item: { category_id: "new-category-id" }
            ) {
              id
              category_id
            }
          }
        `.trim();

        // Assert
        compareQueries(actualMutation, expectedMutation);
        validateDABCompliance(actualMutation, true);

        expect(actualMutation).toContain('category_id: "new-category-id"');
      });

      it('should handle updating multiple relationships with id-only objects', () => {
        // Arrange
        const client = new TestableGraphQLEntityClient<TestSchema, 'Todo'>(
          mockGraphQLClient,
          'Todo'
        );

        // Act - Update both user and category
        const actualMutation = client.buildUpdateMutation(
          { id: 'todo-456' },
          {
            title: 'Updated Title',
            user: { id: 'new-user-id' },
            category: { id: 'new-cat-id' },
          }
        );

        // Assert
        expect(actualMutation).toContain('title: "Updated Title"');
        expect(actualMutation).toContain('user_id: "new-user-id"');
        expect(actualMutation).toContain('category_id: "new-cat-id"');
        validateDABCompliance(actualMutation, true);
      });
    });

    describe('Backward Compatibility', () => {
      it('should still work with full entity objects (existing behavior)', () => {
        // Arrange
        const client = new TestableGraphQLEntityClient<TestSchema, 'Todo'>(
          mockGraphQLClient,
          'Todo'
        );

        // Act - Using full entity objects (current/existing behavior)
        const actualMutation = client.buildCreateMutation({
          title: 'Full Object Todo',
          isCompleted: false,
          priority: 'high',
          type: '',
          priorityLevel: 0,
          user: {
            id: 'user-full-123',
            email: 'test@example.com',
          },
          category: {
            id: 'cat-full-456',
            name: 'Work',
            color: '#ff0000',
            user: { id: 'user-full-123', email: 'test@example.com' },
          },
        });

        // Assert: Should still extract IDs correctly
        expect(actualMutation).toContain('user_id: "user-full-123"');
        expect(actualMutation).toContain('category_id: "cat-full-456"');

        // Extra fields should NOT appear in mutation
        expect(actualMutation).not.toContain('email');
        expect(actualMutation).not.toContain('name');
        expect(actualMutation).not.toContain('color');

        validateDABCompliance(actualMutation, true);
      });
    });
  });
});
