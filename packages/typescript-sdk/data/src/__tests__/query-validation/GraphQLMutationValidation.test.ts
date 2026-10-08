/* eslint-disable no-useless-escape */
import { describe, it, expect, vi } from 'vitest';

import type { GraphQLClient } from '../../graphql/GraphQLClient';
import { GraphQLEntityClient } from '../../graphql/GraphQLEntityClient';

import { TestableGraphQLEntityClient } from './TestableGraphQLEntityClient';
import { compareQueries, validateDABCompliance } from './query-utils';
import type { TestSchema } from './sample-models';

describe('GraphQL Mutation Validation', () => {
  const mockGraphQLClient: GraphQLClient = {
    query: vi.fn(),
    mutation: vi.fn(),
    request: vi.fn(),
  } as any;

  describe('Create Mutations', () => {
    it('should generate correct DAB-compliant create mutation with basic fields', () => {
      // Arrange
      const client = new TestableGraphQLEntityClient<TestSchema, 'Todo'>(
        mockGraphQLClient,
        'Todo'
      );

      // Act
      const actualMutation = client.buildCreateMutation({
        title: 'Test Todo',
        isCompleted: false,
        priority: 'high',
        type: 'todo',
        priorityLevel: 1,
        user: {
          id: '00000000-0000-0000-0000-000000000000',
          email: 'test@example.com',
        },
      });

      // Expected DAB-compliant GraphQL mutation
      const expectedMutation = `
        mutation {
          createTodo(item: { title: "Test Todo", isCompleted: false, priority: "high", type: "todo", priorityLevel: 1, user_id: "00000000-0000-0000-0000-000000000000" }) {
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
      validateDABCompliance(actualMutation, true); // true = isMutation

      // Additional specific assertions
      expect(actualMutation).toContain('createTodo('); // mixed case entity name
      expect(actualMutation).toContain('isCompleted: false'); // boolean as unquoted value
      expect(actualMutation).toContain('priority: "high"'); // string values properly quoted
      expect(actualMutation).toContain('title: "Test Todo"'); // string with spaces
    });

    it('should generate correct create mutation with all field types', () => {
      // Arrange
      const client = new TestableGraphQLEntityClient<TestSchema, 'Todo'>(
        mockGraphQLClient,
        'Todo'
      );
      const testDate = new Date('2024-01-01T00:00:00.000Z');

      // Act
      const actualMutation = client.buildCreateMutation({
        title: 'Complex Todo',
        description: 'A detailed description',
        isCompleted: true,
        priority: 'medium',
        type: 'todo',
        priorityLevel: 2,
        dueDate: testDate,
        user: {
          id: '00000000-0000-0000-0000-000000000000',
          email: 'test@example.com',
        },
        category: {
          id: '00000000-0000-0000-0000-000000000001',
          name: 'Test Category',
          color: '#ff0000',
          user: {
            id: '00000000-0000-0000-0000-000000000000',
            email: 'test@example.com',
          },
        },
      });

      // Expected mutation with all types
      const expectedMutation = `
        mutation {
          createTodo(item: { title: "Complex Todo", description: "A detailed description", isCompleted: true, priority: "medium", type: "todo", priorityLevel: 2, dueDate: "2024-01-01T00:00:00.000Z", user_id: "00000000-0000-0000-0000-000000000000", category_id: "00000000-0000-0000-0000-000000000001" }) {
            id
            title
            description
            isCompleted
            priority
            type
            priorityLevel
            dueDate
            user_id
            category_id
          }
        }
      `.trim();

      // Assert
      compareQueries(actualMutation, expectedMutation);
      validateDABCompliance(actualMutation, true); // true = isMutation

      // Type-specific assertions
      expect(actualMutation).toContain('isCompleted: true'); // boolean true as unquoted value
      expect(actualMutation).toContain('dueDate: "2024-01-01T00:00:00.000Z"'); // Date as ISO string
      expect(actualMutation).toContain('description: "A detailed description"'); // optional field
    });

    it('should handle special characters and escaping in create mutation', () => {
      // Arrange
      const client = new TestableGraphQLEntityClient<TestSchema, 'Todo'>(
        mockGraphQLClient,
        'Todo'
      );

      // Act
      const actualMutation = client.buildCreateMutation({
        title: 'Todo with "quotes" and special chars',
        description: 'Description with quotes and text',
        isCompleted: false,
        priority: 'low',
        type: 'todo',
        priorityLevel: 3,
        user: {
          id: '00000000-0000-0000-0000-000000000000',
          email: 'test@example.com',
        },
      });

      // Expected mutation with escaped characters
      const expectedMutation = `
        mutation {
          createTodo(item: { title: "Todo with \\\"quotes\\\" and special chars", description: "Description with quotes and text", isCompleted: false, priority: "low", type: "todo", priorityLevel: 3, user_id: "00000000-0000-0000-0000-000000000000" }) {
            id
            title
            description
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
      validateDABCompliance(actualMutation, true); // true = isMutation

      // Escaping assertions
      expect(actualMutation).toContain('\\"quotes\\"'); // escaped quotes
    });

    it('should handle undefined values in create mutation', () => {
      // Arrange
      const client = new TestableGraphQLEntityClient<TestSchema, 'Todo'>(
        mockGraphQLClient,
        'Todo'
      );

      // Act
      const actualMutation = client.buildCreateMutation({
        title: 'Todo with optional fields',
        // description and dueDate are optional, so can be omitted
        isCompleted: false,
        priority: 'medium',
        type: 'todo',
        priorityLevel: 4,
        user: {
          id: '00000000-0000-0000-0000-000000000000',
          email: 'test@example.com',
        },
      });

      // Expected mutation with optional fields omitted
      const expectedMutation = `
        mutation {
          createTodo(item: { title: "Todo with optional fields", isCompleted: false, priority: "medium", type: "todo", priorityLevel: 4, user_id: "00000000-0000-0000-0000-000000000000" }) {
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
      validateDABCompliance(actualMutation, true); // true = isMutation

      // Optional field handling assertions
      expect(actualMutation).not.toContain('description:'); // optional field omitted
      expect(actualMutation).not.toContain('dueDate:'); // optional field omitted
    });

    it('should serialize null values as null (not "null") in create mutation', () => {
      const client = new TestableGraphQLEntityClient<TestSchema, 'Todo'>(
        mockGraphQLClient,
        'Todo'
      );

      const actualMutation = client.buildCreateMutation({
        title: 'Todo with nulls',
        description: null as any,
        dueDate: null as any,
        isCompleted: false,
        priority: 'low',
        type: 'todo',
        priorityLevel: 5,
        user: {
          id: '00000000-0000-0000-0000-000000000000',
          email: 'test@example.com',
        },
        category: null as any,
      });

      expect(actualMutation).toContain('description: null');
      expect(actualMutation).toContain('dueDate: null');
      expect(actualMutation).toContain('category: null');
      expect(actualMutation).not.toContain('"null"');
    });
  });

  describe('Update Mutations', () => {
    it('should generate correct DAB-compliant update mutation with string ID', () => {
      // Arrange
      const client = new TestableGraphQLEntityClient<TestSchema, 'Todo'>(
        mockGraphQLClient,
        'Todo'
      );

      // Act
      const actualMutation = client.buildUpdateMutation(
        { id: 'todo-123' },
        {
          title: 'Updated Todo',
          isCompleted: true,
          priority: 'low',
        }
      );

      // Expected update mutation
      const expectedMutation = `
        mutation {
          updateTodo(
            id: "todo-123",
            item: { title: "Updated Todo", isCompleted: true, priority: "low" }
          ) {
            id
            title
            isCompleted
            priority
          }
        }
      `.trim();

      // Assert
      compareQueries(actualMutation, expectedMutation);
      validateDABCompliance(actualMutation, true); // true = isMutation

      // Update-specific assertions
      expect(actualMutation).toContain('updateTodo('); // mixed case entity name
      expect(actualMutation).toContain('id: "todo-123"'); // string ID quoted
      expect(actualMutation).toContain('isCompleted: true'); // boolean as unquoted value
    });

    it('should generate correct update mutation with string ID (alternative format)', () => {
      // Arrange
      const client = new TestableGraphQLEntityClient<TestSchema, 'Todo'>(
        mockGraphQLClient,
        'Todo'
      );

      // Act
      const actualMutation = client.buildUpdateMutation(
        { id: '12345' }, // Use string ID to match Todo model
        {
          title: 'Updated with string ID',
          isCompleted: false,
        }
      );

      // Expected mutation with string ID
      const expectedMutation = `
        mutation {
          updateTodo(
            id: "12345",
            item: { title: "Updated with string ID", isCompleted: false }
          ) {
            id
            title
            isCompleted
          }
        }
      `.trim();

      // Assert
      compareQueries(actualMutation, expectedMutation);
      validateDABCompliance(actualMutation, true); // true = isMutation

      // String ID assertions
      expect(actualMutation).toContain('id: "12345"'); // string ID quoted
      expect(actualMutation).not.toContain('id: 12345'); // should not be unquoted
    });

    it('should generate correct update mutation with partial data', () => {
      // Arrange
      const client = new TestableGraphQLEntityClient<TestSchema, 'Todo'>(
        mockGraphQLClient,
        'Todo'
      );

      // Act
      const actualMutation = client.buildUpdateMutation(
        { id: 'todo-456' },
        {
          isCompleted: true, // Only updating completion status
        }
      );

      // Expected partial update mutation
      const expectedMutation = `
        mutation {
          updateTodo(
            id: "todo-456",
            item: { isCompleted: true }
          ) {
            id
            isCompleted
          }
        }
      `.trim();

      // Assert
      compareQueries(actualMutation, expectedMutation);
      validateDABCompliance(actualMutation, true); // true = isMutation

      // Partial update assertions
      expect(actualMutation).toContain('item: { isCompleted: true }'); // only the updated field
    });

    it('should generate correct update mutation with complex data types', () => {
      // Arrange
      const client = new TestableGraphQLEntityClient<TestSchema, 'Todo'>(
        mockGraphQLClient,
        'Todo'
      );
      const testDate = new Date('2024-12-31T23:59:59.999Z');

      // Act
      const actualMutation = client.buildUpdateMutation(
        { id: 'todo-789' },
        {
          title: 'Updated Complex Todo',
          description: 'New description',
          isCompleted: false,
          priority: 'high',
          dueDate: testDate,
        }
      );

      // Expected complex update mutation
      const expectedMutation = `
        mutation {
          updateTodo(
            id: "todo-789",
            item: { title: "Updated Complex Todo", description: "New description", isCompleted: false, priority: "high", dueDate: "2024-12-31T23:59:59.999Z" }
          ) {
            id
            title
            description
            isCompleted
            priority
            dueDate
          }
        }
      `.trim();

      // Assert
      compareQueries(actualMutation, expectedMutation);
      validateDABCompliance(actualMutation, true); // true = isMutation

      // Complex data assertions
      expect(actualMutation).toContain('dueDate: "2024-12-31T23:59:59.999Z"'); // Date formatting
      expect(actualMutation).toContain('priority: "high"'); // enum value
    });
  });

  describe('Delete Mutations', () => {
    it('should generate correct DAB-compliant delete mutation with string ID', () => {
      // Arrange
      const client = new TestableGraphQLEntityClient<TestSchema, 'Todo'>(
        mockGraphQLClient,
        'Todo'
      );

      // Act
      const actualMutation = client.buildDeleteMutation({
        id: 'todo-delete-123',
      });

      // Expected delete mutation
      const expectedMutation = `
        mutation {
          deleteTodo(id: "todo-delete-123") {
            id
          }
        }
      `.trim();

      // Assert
      compareQueries(actualMutation, expectedMutation);
      validateDABCompliance(actualMutation, true); // true = isMutation

      // Delete-specific assertions
      expect(actualMutation).toContain('deleteTodo('); // mixed case entity name
      expect(actualMutation).toContain('id: "todo-delete-123"'); // string ID quoted
      expect(actualMutation).toContain('{\n          id\n        }'); // only returns id
    });

    it('should generate correct delete mutation with string ID (alternative format)', () => {
      // Arrange
      const client = new TestableGraphQLEntityClient<TestSchema, 'Todo'>(
        mockGraphQLClient,
        'Todo'
      );

      // Act
      const actualMutation = client.buildDeleteMutation({ id: '99999' }); // Use string ID

      // Expected delete mutation with string ID
      const expectedMutation = `
        mutation {
          deleteTodo(id: "99999") {
            id
          }
        }
      `.trim();

      // Assert
      compareQueries(actualMutation, expectedMutation);
      validateDABCompliance(actualMutation, true); // true = isMutation

      // String ID assertions
      expect(actualMutation).toContain('id: "99999"'); // string ID quoted
      expect(actualMutation).not.toContain('id: 99999'); // should not be unquoted
    });
  });

  describe('Upsert Mutations', () => {
    it('should upsert via update when update succeeds', async () => {
      const mockClient: GraphQLClient = {
        query: vi.fn().mockResolvedValue({
          data: {
            todo_by_pk: { id: '1' },
          },
        }),
        mutation: vi.fn().mockResolvedValue({ updateTodo: { id: '1' } }),
        request: vi.fn(),
      } as any;

      const client = new GraphQLEntityClient<TestSchema, 'Todo'>(
        mockClient,
        'Todo'
      );

      const result = await client.upsert(
        { id: '1' },
        { title: 'create' } as any,
        { title: 'update' } as any
      );

      expect(mockClient.mutation).toHaveBeenCalledTimes(1);
      expect(mockClient.mutation).toHaveBeenCalledWith(
        expect.stringContaining('updateTodo')
      );
      expect(result).toEqual({ id: '1' });
    });

    it("should create when findById throws 'not found' error", async () => {
      const mockClient: GraphQLClient = {
        query: vi.fn().mockRejectedValueOnce(new Error('not found')),
        mutation: vi.fn().mockResolvedValue({ createTodo: { id: '2' } }),
        request: vi.fn(),
      } as any;

      const client = new GraphQLEntityClient<TestSchema, 'Todo'>(
        mockClient,
        'Todo'
      );

      const result = await client.upsert(
        { id: '2' },
        { title: 'create' } as any,
        { title: 'update' } as any
      );

      expect(mockClient.mutation).toHaveBeenCalledTimes(1);
      expect(mockClient.mutation).toHaveBeenCalledWith(
        expect.stringContaining('createTodo')
      );
      expect(result).toEqual({ id: '2' });
    });

    it('should fallback to create when update does not find existing record', async () => {
      const mockClient: GraphQLClient = {
        query: vi.fn().mockResolvedValue({
          data: {
            todo_by_pk: null,
          },
        }),
        mutation: vi.fn().mockResolvedValue({ createTodo: { id: '2' } }),
        request: vi.fn(),
      } as any;

      const client = new GraphQLEntityClient<TestSchema, 'Todo'>(
        mockClient,
        'Todo'
      );

      const result = await client.upsert(
        { id: '2' },
        { title: 'create' } as any,
        { title: 'update' } as any
      );

      expect(mockClient.mutation).toHaveBeenCalledTimes(1);
      expect(mockClient.mutation).toHaveBeenCalledWith(
        expect.stringContaining('createTodo')
      );
      expect(result).toEqual({ id: '2' });
    });
  });

  describe('Category Entity Mutations', () => {
    it('should generate correct create mutation for Category entity', () => {
      // Arrange
      const client = new TestableGraphQLEntityClient<TestSchema, 'Category'>(
        mockGraphQLClient,
        'Category'
      );

      // Act
      const actualMutation = client.buildCreateMutation({
        name: 'Work',
        color: '#FF5733',
        user: {
          id: '00000000-0000-0000-0000-000000000000',
          email: 'test@example.com',
        },
      });

      // Expected Category create mutation
      const expectedMutation = `
        mutation {
          createCategory(item: { name: "Work", color: "#FF5733", user_id: "00000000-0000-0000-0000-000000000000" }) {
            id
            name
            color
            user_id
          }
        }
      `.trim();

      // Assert
      compareQueries(actualMutation, expectedMutation);
      validateDABCompliance(actualMutation, true); // true = isMutation

      // Category-specific assertions
      expect(actualMutation).toContain('createCategory('); // mixed case entity name
      expect(actualMutation).toContain('color: "#FF5733"'); // hex color value
    });

    it('should generate correct update mutation for Category entity', () => {
      // Arrange
      const client = new TestableGraphQLEntityClient<TestSchema, 'Category'>(
        mockGraphQLClient,
        'Category'
      );

      // Act
      const actualMutation = client.buildUpdateMutation(
        { id: 'cat-001' },
        {
          name: 'Updated Work',
          color: '#00FF00',
        }
      );

      // Expected Category update mutation
      const expectedMutation = `
        mutation {
          updateCategory(
            id: "cat-001",
            item: { name: "Updated Work", color: "#00FF00" }
          ) {
            id
            name
            color
          }
        }
      `.trim();

      // Assert
      compareQueries(actualMutation, expectedMutation);
      validateDABCompliance(actualMutation, true); // true = isMutation

      // Category update assertions
      expect(actualMutation).toContain('updateCategory('); // mixed case entity name
    });
  });

  describe('Helper Method Testing', () => {
    it('should format mutation input correctly', () => {
      // Arrange
      const client = new TestableGraphQLEntityClient<TestSchema, 'Todo'>(
        mockGraphQLClient,
        'Todo'
      );

      // Act - Test with raw input to bypass TypeScript typing
      const formattedInput = client.formatMutationInputForTesting({
        title: 'Test',
        isCompleted: true,
        priority: 'high',
        count: 42, // Extra field for testing number handling
        dueDate: new Date('2024-01-01T00:00:00.000Z'),
        description: null, // Test null handling at runtime level
        user: {
          id: '00000000-0000-0000-0000-000000000000',
          email: 'test@example.com',
        },
      });

      // Expected formatted input
      const expectedInput =
        '{ title: "Test", isCompleted: true, priority: "high", count: 42, dueDate: "2024-01-01T00:00:00.000Z", description: null, user_id: "00000000-0000-0000-0000-000000000000" }';

      // Assert
      expect(formattedInput).toBe(expectedInput);
    });

    it('should get default fields correctly', () => {
      // Arrange
      const client = new TestableGraphQLEntityClient<TestSchema, 'Todo'>(
        mockGraphQLClient,
        'Todo'
      );

      // Act
      const defaultFields = client.getDefaultFieldsForTesting({
        title: 'Test',
        isCompleted: false,
        priority: 'medium',
        user: {
          id: '00000000-0000-0000-0000-000000000000',
          email: 'test@example.com',
        },
      });

      // Expected fields (id should be first)
      const expectedFields =
        'id\n          title\n          isCompleted\n          priority\n          user_id';

      // Assert
      expect(defaultFields).toBe(expectedFields);
    });

    it('should extract ID from where clause correctly', () => {
      // Arrange
      const client = new TestableGraphQLEntityClient<TestSchema, 'Todo'>(
        mockGraphQLClient,
        'Todo'
      );

      // Act & Assert
      expect(client.extractIdForTesting({ id: 'test-123' })).toBe('test-123');
      expect(client.extractIdForTesting({ id: '456' })).toBe('456');
    });

    it('should extract id from where clause', () => {
      // Arrange
      const client = new TestableGraphQLEntityClient<TestSchema, 'Todo'>(
        mockGraphQLClient,
        'Todo'
      );

      // Act & Assert
      expect(client.extractIdForTesting({ id: 'abc-123' })).toBe('abc-123');
    });
  });
});
