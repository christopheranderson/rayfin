import { InvocationContext } from '@microsoft/rayfin-tools-common/_internal/telemetry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setCurrentContext } from '../../telemetry/context-store.js';
import {
  fabricFetch,
  postFabricJson,
  postJson,
  throwIfNotOk,
  wrapConnectionError,
} from '../http-client.js';
import { HttpError } from '../retry-utils.js';

const emptyHeaders = {
  get: vi.fn().mockReturnValue(null),
};

// Mock fetch globally
const fetchMock = vi.fn();
global.fetch = fetchMock;

describe('http-client', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    setCurrentContext(undefined);
  });

  describe('fabricFetch', () => {
    it('records the response activity ID and returns the original response', async () => {
      const response = new Response(null, {
        headers: { 'x-ms-root-activity-id': 'activity-1' },
      });
      fetchMock.mockResolvedValueOnce(response);
      const context = new InvocationContext('rayfin-cli', '1.0.0');
      setCurrentContext(context);

      await expect(fabricFetch('https://api.fabric.test/v1')).resolves.toBe(
        response
      );
      expect(
        context.finalize({
          osType: 'linux',
          osVersion: 'test',
          nodeVersion: 'test',
        }).properties?.fabric_activity_ids
      ).toBe('["activity-1"]');
    });
  });

  describe('postJson', () => {
    it('should send POST with JSON content-type', async () => {
      fetchMock.mockResolvedValue({ ok: true });

      await postJson({ url: 'http://localhost/api', body: { key: 'value' } });

      expect(fetchMock).toHaveBeenCalledWith('http://localhost/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"key":"value"}',
      });
    });

    it('should include Authorization header when provided', async () => {
      fetchMock.mockResolvedValue({ ok: true });

      await postJson({
        url: 'http://localhost/api',
        body: {},
        authorizationHeader: 'Bearer token123',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost/api',
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer token123',
          },
        })
      );
    });

    it('should merge extra headers', async () => {
      fetchMock.mockResolvedValue({ ok: true });

      await postJson({
        url: 'http://localhost/api',
        body: {},
        extraHeaders: { 'X-Correlation-ID': 'abc-123' },
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost/api',
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
            'X-Correlation-ID': 'abc-123',
          },
        })
      );
    });

    it('does not record response activity for a local JSON request', async () => {
      const response = new Response(null, {
        headers: { 'x-ms-root-activity-id': 'local-activity' },
      });
      fetchMock.mockResolvedValueOnce(response);
      const context = new InvocationContext('rayfin-cli', '1.0.0');
      setCurrentContext(context);

      await postJson({ url: 'http://localhost/api', body: {} });

      expect(
        context.finalize({
          osType: 'linux',
          osVersion: 'test',
          nodeVersion: 'test',
        }).properties
      ).toBeUndefined();
    });

    it('records response activity for a Fabric JSON request', async () => {
      const response = new Response(null, {
        headers: { RequestId: 'request-1' },
      });
      fetchMock.mockResolvedValueOnce(response);
      const context = new InvocationContext('rayfin-cli', '1.0.0');
      setCurrentContext(context);

      await postFabricJson({ url: 'https://api.fabric.test/v1', body: {} });

      expect(
        context.finalize({
          osType: 'linux',
          osVersion: 'test',
          nodeVersion: 'test',
        }).properties?.fabric_activity_ids
      ).toBe('["request-1"]');
    });
  });

  describe('throwIfNotOk', () => {
    it('should return body text on success', async () => {
      const response = {
        ok: true,
        text: () => Promise.resolve('success body'),
      } as Response;

      const result = await throwIfNotOk(response, 'Test error');

      expect(result).toBe('success body');
    });

    it('should throw with status and statusText on error', async () => {
      const response = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: emptyHeaders,
        text: () => Promise.resolve('raw error text'),
      } as unknown as Response;

      await expect(throwIfNotOk(response, 'Server error')).rejects.toThrow(
        'Server error: 500 Internal Server Error\n   Details: raw error text'
      );

      await expect(
        throwIfNotOk(response, 'Server error')
      ).rejects.toMatchObject({
        name: 'HttpError',
        statusCode: 500,
      });
      await expect(
        throwIfNotOk(response, 'Server error')
      ).rejects.toBeInstanceOf(HttpError);
    });

    it('should extract message from JSON error body', async () => {
      const response = {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        headers: emptyHeaders,
        text: () =>
          Promise.resolve(JSON.stringify({ message: 'Invalid input' })),
      } as unknown as Response;

      await expect(throwIfNotOk(response, 'API error')).rejects.toThrow(
        'API error: 400 Bad Request\n   Details: Invalid input'
      );
    });

    it('should transform extracted details using the service error code', async () => {
      const response = {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        headers: emptyHeaders,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              error: {
                code: 'StaticHostingPostureRequired',
                message: 'Legacy guidance',
              },
            })
          ),
      } as unknown as Response;

      await expect(
        throwIfNotOk(
          response,
          'API error',
          (details, code) => `${code}: ${details}`
        )
      ).rejects.toThrow(
        'API error: 400 Bad Request\n   Details: StaticHostingPostureRequired: Legacy guidance'
      );
    });

    it('should extract error field from JSON error body', async () => {
      const response = {
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        headers: emptyHeaders,
        text: () =>
          Promise.resolve(
            JSON.stringify({ error: 'Validation failed for field X' })
          ),
      } as unknown as Response;

      await expect(throwIfNotOk(response, 'Validation')).rejects.toThrow(
        'Validation: 422 Unprocessable Entity\n   Details: Validation failed for field X'
      );
    });

    it('should handle missing statusText', async () => {
      const response = {
        ok: false,
        status: 500,
        statusText: '',
        headers: emptyHeaders,
        text: () => Promise.resolve('error details'),
      } as unknown as Response;

      await expect(throwIfNotOk(response, 'Error')).rejects.toThrow(
        'Error: 500\n   Details: error details'
      );
    });

    it('should handle empty error body', async () => {
      const response = {
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        headers: emptyHeaders,
        text: () => Promise.resolve(''),
      } as unknown as Response;

      await expect(throwIfNotOk(response, 'Gateway')).rejects.toThrow(
        'Gateway: 502 Bad Gateway'
      );
    });
  });

  describe('wrapConnectionError', () => {
    it('should wrap ECONNREFUSED for local endpoints', () => {
      const error = new Error('connect ECONNREFUSED 127.0.0.1:5168');

      expect(() =>
        wrapConnectionError(error, 'http://localhost:5168/api/test')
      ).toThrow(
        "Cannot connect to Rayfin server at http://localhost:5168/api/test\n💡 Make sure the Rayfin server is running (try 'rayfin dev')"
      );
    });

    it('should wrap ECONNREFUSED for remote endpoints', () => {
      const error = new Error('connect ECONNREFUSED');

      expect(() =>
        wrapConnectionError(error, 'https://remote.example.com/api/test')
      ).toThrow(
        'Cannot connect to Rayfin server at https://remote.example.com/api/test\n💡 Check if the remote endpoint is accessible and healthy'
      );
    });

    it('should re-throw non-connection errors unchanged', () => {
      const error = new Error('Validation failed');

      expect(() =>
        wrapConnectionError(error, 'http://localhost:5168/api/test')
      ).toThrow('Validation failed');
    });

    it('should re-throw non-Error values', () => {
      expect(() =>
        wrapConnectionError('string error', 'http://localhost:5168/api/test')
      ).toThrow('string error');
    });
  });
});
