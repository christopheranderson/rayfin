import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { GraphQLClient } from '../graphql/GraphQLClient';
import { GraphQLEntityClient } from '../graphql/GraphQLEntityClient';

// Test entity types
type User = {
  id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  created_at?: Date;
};

type Organization = {
  id: string;
  name: string;
  description?: string;
  is_private: boolean;
};

type TestSchema = {
  User: User;
  Organization: Organization;
};

describe('GraphQLEntityClient', () => {
  let mockGraphQLClient: GraphQLClient;
  let userClient: GraphQLEntityClient<TestSchema, 'User'>;

  beforeEach(() => {
    // Create a mock GraphQL client
    mockGraphQLClient = {
      query: vi.fn(),
      mutation: vi.fn(),
      request: vi.fn(),
    } as any;

    userClient = new GraphQLEntityClient(mockGraphQLClient, 'User');
  });

  describe('Query Builder Methods', () => {
    it('should create query builder with select', () => {
      const builder = userClient.select(['id', 'email', 'full_name']);
      expect(builder).toBeInstanceOf(Object);
      expect(typeof builder.execute).toBe('function');
      expect(typeof builder.where).toBe('function');
    });

    it('should create query builder with where', () => {
      const builder = userClient.where({ is_active: true });
      expect(builder).toBeInstanceOf(Object);
      expect(typeof builder.execute).toBe('function');
      expect(typeof builder.select).toBe('function');
    });

    it('should create query builder with orderBy', () => {
      const builder = userClient.orderBy({ created_at: 'desc' });
      expect(builder).toBeInstanceOf(Object);
      expect(typeof builder.execute).toBe('function');
    });

    it('should create query builder with first', () => {
      const builder = userClient.first(10);
      expect(builder).toBeInstanceOf(Object);
      expect(typeof builder.execute).toBe('function');
    });
  });

  describe('Mutation Methods', () => {
    it('should create a new entity', async () => {
      const mockUser: User = {
        id: '1',
        email: 'test@example.com',
        full_name: 'Test User',
        is_active: true,
        created_at: new Date(),
      };

      (mockGraphQLClient.mutation as any).mockResolvedValue({
        createUser: mockUser,
      });

      const input = {
        email: 'test@example.com',
        full_name: 'Test User',
        is_active: true,
      };

      const result = await userClient.create(input);

      expect(mockGraphQLClient.mutation).toHaveBeenCalledWith(
        expect.stringContaining('createUser(item:')
      );
      expect(result).toEqual(mockUser);
    });

    it('should update an existing entity', async () => {
      const mockUser: User = {
        id: '1',
        email: 'test@example.com',
        full_name: 'Updated User',
        is_active: true,
        created_at: new Date(),
      };

      (mockGraphQLClient.mutation as any).mockResolvedValue({
        updateUser: mockUser,
      });

      const where = { id: '1' };
      const data = { full_name: 'Updated User' };

      const result = await userClient.update(where, data);

      expect(mockGraphQLClient.mutation).toHaveBeenCalledWith(
        expect.stringContaining('updateUser(')
      );
      expect(result).toEqual(mockUser);
    });

    it('should delete an entity', async () => {
      const mockUser: User = {
        id: '1',
        email: 'test@example.com',
        full_name: 'Test User',
        is_active: false,
        created_at: new Date(),
      };

      (mockGraphQLClient.mutation as any).mockResolvedValue({
        deleteUser: mockUser,
      });

      const where = { id: '1' };

      const result = await userClient.delete(where);

      expect(mockGraphQLClient.mutation).toHaveBeenCalledWith(
        expect.stringContaining('deleteUser(id:')
      );
      expect(result).toEqual(mockUser);
    });

    it('should upsert an entity (update existing)', async () => {
      const mockUser: User = {
        id: '1',
        email: 'test@example.com',
        full_name: 'Updated User',
        is_active: true,
        created_at: new Date(),
      };

      (mockGraphQLClient.query as any).mockResolvedValue({
        data: { user_by_pk: { id: '1' } },
      });
      (mockGraphQLClient.mutation as any).mockResolvedValue({
        updateUser: mockUser,
      });

      const where = { id: '1' };
      const createData = {
        email: 'test@example.com',
        full_name: 'New User',
        is_active: true,
      };
      const updateData = { full_name: 'Updated User' };

      const result = await userClient.upsert(where, createData, updateData);

      // Should try update first
      expect(mockGraphQLClient.mutation).toHaveBeenCalledWith(
        expect.stringContaining('updateUser(')
      );
      expect(result).toEqual(mockUser);
    });

    it('should upsert an entity (create new when update fails)', async () => {
      const mockUser: User = {
        id: '2',
        email: 'test@example.com',
        full_name: 'New User',
        is_active: true,
        created_at: new Date(),
      };

      (mockGraphQLClient.query as any).mockResolvedValue({
        data: { user_by_pk: null },
      });
      (mockGraphQLClient.mutation as any).mockResolvedValue({
        createUser: mockUser,
      });

      const where = { id: '1' };
      const createData = {
        email: 'test@example.com',
        full_name: 'New User',
        is_active: true,
      };
      const updateData = { full_name: 'Updated User' };

      const result = await userClient.upsert(where, createData, updateData);

      // Should create when findById returns null
      expect(mockGraphQLClient.mutation).toHaveBeenCalledTimes(1);
      expect(mockGraphQLClient.mutation).toHaveBeenCalledWith(
        expect.stringContaining('createUser(')
      );
      expect(result).toEqual(mockUser);
    });
  });

  describe('Query Methods', () => {
    it('findMany applies filter and returns item', async () => {
      const mockUsers = [{ id: 1, email: 'a@example.com' }];
      (mockGraphQLClient.query as any).mockResolvedValue({
        data: { users: { items: mockUsers } },
      });

      const result = await userClient.findMany({ id: { eq: 1 } } as any);

      expect(mockGraphQLClient.query).toHaveBeenCalledWith(
        expect.stringContaining('filter: { id: { eq: 1 } }')
      );
      expect(result).toEqual(mockUsers);
    });

    it('findMany applies filter and returns items', async () => {
      const mockUsers = [
        { id: 1, email: 'a@example.com' },
        { id: 2, email: 'a@example.com' },
      ];
      (mockGraphQLClient.query as any).mockResolvedValue({
        data: { users: { items: mockUsers } },
      });

      const result = await userClient.findMany({
        email: { eq: 'a@example.com' },
      } as any);

      expect(mockGraphQLClient.query).toHaveBeenCalledWith(
        expect.stringContaining('filter: { email: { eq: "a@example.com" } }')
      );
      expect(result).toEqual(mockUsers);
    });

    it('findFirst adds first: 1 and returns first item', async () => {
      const mockUsers = [{ id: 1 }, { id: 2 }];
      (mockGraphQLClient.query as any).mockResolvedValue({
        data: { users: { items: mockUsers } },
      });

      const result = await userClient.findFirst({ id: { eq: 1 } } as any);

      expect(mockGraphQLClient.query).toHaveBeenCalledWith(
        expect.stringContaining('first: 1')
      );
      expect(result).toEqual(mockUsers[0]);
    });

    it('findById builds _by_pk query with string id', async () => {
      const mockUser = { id: '42' };
      (mockGraphQLClient.query as any).mockResolvedValue({
        data: { user_by_pk: mockUser },
      });

      const result = await userClient.findById('42');

      expect(mockGraphQLClient.query).toHaveBeenCalledWith(
        expect.stringContaining('user_by_pk')
      );
      expect(mockGraphQLClient.query).toHaveBeenCalledWith(
        expect.stringContaining('id: "42"')
      );
      expect(result).toEqual(mockUser);
    });
  });

  describe('Relationship ID Handling', () => {
    it('should handle relationship objects with lowercase id', async () => {
      const client = userClient as any;
      const mockData = {
        name: 'Test',
        organization: { id: 123, name: 'Test Org' },
      };

      const result = client.formatMutationInput(mockData);
      expect(result).toBe('{ name: "Test", organization_id: 123 }');
    });

    describe('cli-minor-fixes: foreign-key dedupe gating', () => {
      const originalFlags = process.env.RAYFIN_FEATURE_FLAGS;

      afterEach(() => {
        vi.unstubAllGlobals();
        if (originalFlags === undefined) {
          delete process.env.RAYFIN_FEATURE_FLAGS;
        } else {
          process.env.RAYFIN_FEATURE_FLAGS = originalFlags;
        }
      });

      it.each([
        {
          organization_id: 123,
          organization: { id: 456 },
        },
        {
          organization: { id: 456 },
          organization_id: 123,
        },
      ])(
        'prefers relationship objects over explicit foreign keys when the flag is on',
        async (mockData) => {
          process.env.RAYFIN_FEATURE_FLAGS = 'cli-minor-fixes';
          const client = userClient as any;

          const result = client.formatMutationInput(mockData);
          const defaultFields = client.getDefaultFields(mockData);

          expect(result.match(/organization_id:/g)).toHaveLength(1);
          expect(result).toContain('organization_id: 456');
          expect(defaultFields.match(/organization_id/g)).toHaveLength(1);
        }
      );

      it('emits the duplicate foreign key when the flag is off', async () => {
        delete process.env.RAYFIN_FEATURE_FLAGS;
        const client = userClient as any;
        const mockData = {
          organization_id: 123,
          organization: { id: 456 },
        };

        const result = client.formatMutationInput(mockData);

        // Without the flag, the explicit FK and the relationship-derived FK
        // both render, reproducing the DAB "only one input field" failure.
        expect(result.match(/organization_id:/g)).toHaveLength(2);
      });

      it('keeps mutation formatting available in browser runtimes', () => {
        vi.stubGlobal('process', undefined);
        const client = userClient as any;

        expect(() =>
          client.formatMutationInput({ email: 'test@example.com' })
        ).not.toThrow();
      });
    });

    it('should handle relationship objects with uppercase Id', async () => {
      const client = userClient as any;
      const mockData = {
        name: 'Test',
        organization: { Id: 456, name: 'Test Org' },
      };

      const result = client.formatMutationInput(mockData);
      expect(result).toBe('{ name: "Test", organization_id: 456 }');
    });

    it('should skip relationship objects without ID field', async () => {
      const client = userClient as any;
      const mockData = {
        name: 'Test',
        organization: { name: 'Test Org' }, // No id or Id field - not treated as relationship
      };

      // Should skip the organization object since it's not a valid relationship
      const result = client.formatMutationInput(mockData);
      expect(result).toBe('{ name: "Test" }');
    });

    it('should handle mixed case field names in relationships', async () => {
      const client = userClient as any;
      const mockData = {
        Name: 'Test User', // Uppercase field
        email_address: 'test@example.com', // Snake case
        IsActive: true, // Pascal case
        organization: { Id: 456, Name: 'Test Org' }, // Mixed case relationship
      };

      const result = client.formatMutationInput(mockData);
      expect(result).toBe(
        '{ Name: "Test User", email_address: "test@example.com", IsActive: true, organization_id: 456 }'
      );
    });

    it('should handle edge case field naming patterns', async () => {
      const client = userClient as any;
      const mockData = {
        // Numbers in field names (like Todo_categoryTWO example)
        NAME_2: 'Category Name',
        field_123: 'Field with number',
        user2user_mapping: 'User to user',

        // Mixed case within words (like colorFORYOU example)
        colorFORYOU: '#FF0000',
        nameForAPI: 'API Name',
        dataFromDB: 'Database data',

        // All caps with underscores
        USER_ID: 'user123',
        CREATED_AT: '2025-01-01',
        API_KEY: 'secret123',

        // Leading/trailing underscores
        _id: 'internal_id',
        name_: 'trailing_underscore',
        __internalField: 'double_underscore',

        // Multiple underscores
        user__profile: 'double_underscore_sep',
        item___id: 'triple_underscore_sep',

        // Relationship with edge case naming
        category_2: { Id: 789, NAME_2: 'Category' },
      };

      const result = client.formatMutationInput(mockData);
      expect(result).toContain('NAME_2: "Category Name"');
      expect(result).toContain('field_123: "Field with number"');
      expect(result).toContain('user2user_mapping: "User to user"');
      expect(result).toContain('colorFORYOU: "#FF0000"');
      expect(result).toContain('nameForAPI: "API Name"');
      expect(result).toContain('dataFromDB: "Database data"');
      expect(result).toContain('USER_ID: "user123"');
      expect(result).toContain('CREATED_AT: "2025-01-01"');
      expect(result).toContain('API_KEY: "secret123"');
      expect(result).toContain('_id: "internal_id"');
      expect(result).toContain('name_: "trailing_underscore"');
      expect(result).toContain('__internalField: "double_underscore"');
      expect(result).toContain('user__profile: "double_underscore_sep"');
      expect(result).toContain('item___id: "triple_underscore_sep"');
      expect(result).toContain('category_2_id: 789');
    });

    it('should generate default fields with edge case naming patterns', async () => {
      const client = userClient as any;
      const mockData = {
        // Todo_categoryTWO pattern examples
        Id: 'category123',
        NAME_2: 'Category Name',
        colorFORYOU: '#FF0000',

        // Other edge cases
        field_123: 'numbered field',
        _leadingUnderscore: 'leading',
        trailingUnderscore_: 'trailing',
        CAPS_FIELD: 'all caps',
        mixedCASEfield: 'mixed within word',

        // Relationships with edge case names
        user_profile_2: { Id: 456, USER_NAME: 'TestUser' },
        categoryFORAPI: { id: 789, api_name: 'API Category' },
      };

      const result = client.getDefaultFields(mockData);

      // Should include all field names as-is, preserving exact casing
      expect(result).toContain('Id');
      expect(result).toContain('NAME_2');
      expect(result).toContain('colorFORYOU');
      expect(result).toContain('field_123');
      expect(result).toContain('_leadingUnderscore');
      expect(result).toContain('trailingUnderscore_');
      expect(result).toContain('CAPS_FIELD');
      expect(result).toContain('mixedCASEfield');
      expect(result).toContain('user_profile_2_id');
      expect(result).toContain('categoryFORAPI_id');
    });

    it('should generate default fields with mixed case naming', async () => {
      const client = userClient as any;
      const mockData = {
        UserName: 'testuser', // Pascal case
        email_address: 'test@example.com', // Snake case
        is_active: true, // Snake case
        CreatedAt: new Date(), // Pascal case
        department: { Id: 123, Name: 'Engineering' }, // Relationship with mixed case
      };

      const result = client.getDefaultFields(mockData);
      expect(result).toContain(
        'id\n          UserName\n          email_address\n          is_active\n          CreatedAt\n          department_id'
      );
    });
  });

  describe('Case-Insensitive Entity Names', () => {
    it('should handle Pascal case entity names', async () => {
      const pascalClient = new GraphQLEntityClient(
        mockGraphQLClient,
        'UserAccount' as any
      );
      const client = pascalClient as any;

      const createMutation = client.buildCreateMutationString({ name: 'test' });
      expect(createMutation).toContain('createUserAccount(');

      const updateMutation = client.buildUpdateMutationString(
        { id: '1' },
        { name: 'updated' }
      );
      expect(updateMutation).toContain('updateUserAccount(');

      const deleteMutation = client.buildDeleteMutationString({ id: '1' });
      expect(deleteMutation).toContain('deleteUserAccount(');
    });

    it('should handle snake_case entity names', async () => {
      const snakeClient = new GraphQLEntityClient(
        mockGraphQLClient,
        'user_profile' as any
      );
      const client = snakeClient as any;

      const createMutation = client.buildCreateMutationString({ name: 'test' });
      expect(createMutation).toContain('createuser_profile(');

      const updateMutation = client.buildUpdateMutationString(
        { id: '1' },
        { name: 'updated' }
      );
      expect(updateMutation).toContain('updateuser_profile(');

      const deleteMutation = client.buildDeleteMutationString({ id: '1' });
      expect(deleteMutation).toContain('deleteuser_profile(');
    });

    it('should handle UPPERCASE entity names', async () => {
      const upperClient = new GraphQLEntityClient(
        mockGraphQLClient,
        'CUSTOMER' as any
      );
      const client = upperClient as any;

      const createMutation = client.buildCreateMutationString({ name: 'test' });
      expect(createMutation).toContain('createCUSTOMER(');
    });

    it('should handle entity names with numbers and mixed casing', async () => {
      // Todo_categoryTWO pattern
      const category2Client = new GraphQLEntityClient(
        mockGraphQLClient,
        'Todo_categoryTWO' as any
      );
      const client2 = category2Client as any;

      const createMutation2 = client2.buildCreateMutationString({
        name: 'test',
      });
      expect(createMutation2).toContain('createTodo_categoryTWO(');

      // Mixed case with numbers
      const userV2Client = new GraphQLEntityClient(
        mockGraphQLClient,
        'UserV2Profile' as any
      );
      const clientV2 = userV2Client as any;

      const createMutationV2 = clientV2.buildCreateMutationString({
        name: 'test',
      });
      expect(createMutationV2).toContain('createUserV2Profile(');

      // All caps with numbers
      const apiV3Client = new GraphQLEntityClient(
        mockGraphQLClient,
        'API_V3_ENDPOINT' as any
      );
      const clientV3 = apiV3Client as any;

      const createMutationV3 = clientV3.buildCreateMutationString({
        name: 'test',
      });
      expect(createMutationV3).toContain('createAPI_V3_ENDPOINT(');
    });

    it('should handle entity names with special patterns', async () => {
      // Leading underscore
      const underscoreClient = new GraphQLEntityClient(
        mockGraphQLClient,
        '_InternalEntity' as any
      );
      const underscoreClientInstance = underscoreClient as any;

      const underscoreMutation =
        underscoreClientInstance.buildCreateMutationString({ name: 'test' });
      expect(underscoreMutation).toContain('create_InternalEntity(');

      // Multiple underscores (like database table names)
      const multiUnderscoreClient = new GraphQLEntityClient(
        mockGraphQLClient,
        'user__profile__data' as any
      );
      const multiClientInstance = multiUnderscoreClient as any;

      const multiMutation = multiClientInstance.buildCreateMutationString({
        name: 'test',
      });
      expect(multiMutation).toContain('createuser__profile__data(');

      // Mixed case like colorFORYOU pattern
      const mixedClient = new GraphQLEntityClient(
        mockGraphQLClient,
        'dataFORapi' as any
      );
      const mixedClientInstance = mixedClient as any;

      const mixedMutation = mixedClientInstance.buildCreateMutationString({
        name: 'test',
      });
      expect(mixedMutation).toContain('createdataFORapi(');
    });
  });

  describe('Error Handling', () => {
    it('should throw error when mutation result cannot be extracted', async () => {
      (mockGraphQLClient.mutation as any).mockResolvedValue({
        // Wrong structure - no createUser field
        wrongField: { id: '1' },
      });

      const input = {
        email: 'test@example.com',
        full_name: 'Test User',
        is_active: true,
      };

      await expect(userClient.create(input)).rejects.toThrow(
        'Failed to extract result from createUser mutation'
      );
    });

    it('should extract id from where clause', async () => {
      const client = userClient as any;

      expect(client.extractId({ id: 'abc-123' })).toBe('abc-123');
    });
  });
});
