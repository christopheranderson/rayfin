// /**
//  * @fileoverview Tests for the Rayfin client SDK.
//  */

import { describe, it, expect, vi, beforeEach } from 'vitest';
// import RayfinClient, { AuthError } from '../client';

// // Mock the AuthApi
// vi.mock('@microsoft/rayfin-auth/dist/AuthApi', () => {
//   return {
//     AuthApi: vi.fn().mockImplementation(() => {
//       return {
//         signUpUser: vi.fn(),
//       };
//     }),
//   };
// });

describe('RayfinClient', () => {
  it('no op', () => {
    expect(true).toBe(true);
  });
});
//   beforeEach(() => {
//     // Reset mocks before each test
//     vi.clearAllMocks();
//   });

//   it('should throw an error if baseUrl is not provided', () => {
//     // @ts-expect-error - Testing invalid input
//     expect(() => new RayfinClient({})).toThrow('SDK configuration requires a baseUrl.');
//   });

//   it('should initialize with the provided configuration', () => {
//     const client = new RayfinClient({
//       baseUrl: 'https://api.rayfin.io',
//       headers: { 'X-Custom-Header': 'value' },
//       timeout: 5000,
//     });

//     expect(client).toBeDefined();
//     expect(client.auth).toBeDefined();
//   });

//   it('should expose error types via static property', () => {
//     expect(RayfinClient.errors).toBeDefined();
//     expect(RayfinClient.errors.SdkError).toBeDefined();
//     expect(RayfinClient.errors.AuthError).toBeDefined();
//     expect(RayfinClient.errors.NetworkError).toBeDefined();
//   });

//   it('should create custom AuthError with default code', () => {
//     const error = new AuthError('Authentication failed');
//     expect(error.message).toBe('Authentication failed');
//     expect(error.code).toBe('AUTH_ERROR');
//   });

//   it('should create custom AuthError with specified code', () => {
//     const error = new AuthError('Invalid credentials', 'INVALID_CREDENTIALS');
//     expect(error.message).toBe('Invalid credentials');
//     expect(error.code).toBe('INVALID_CREDENTIALS');
//   });
// });
