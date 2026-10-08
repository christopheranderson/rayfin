/**
 * @packageDocumentation Tests for the typed Functions API proxy.
 *
 * The only public surface exposed via `client.functions` is the typed
 * proxy returned by {@link createFunctionsApi}. Each schema-defined name
 * resolves to a `FunctionClient` whose `invoke()` performs the network
 * call and surfaces SDK-specific errors.
 */

import { ApiClient, NetworkError } from '@microsoft/rayfin-lib';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { FunctionClient } from '../FunctionClient';
import {
  createFunctionsApi,
  FunctionsError,
  type FunctionInvocationResponse,
} from '../Functions';

// Mock @microsoft/rayfin-lib so we don't actually fetch and so that the
// SDK error classes used below are recognized via instanceof checks.
vi.mock('@microsoft/rayfin-lib', () => {
  const NetworkErrorMock = class NetworkError extends Error {
    override name = 'NetworkError';
    statusCode?: number;
    constructor(message: string, statusCode?: number) {
      super(message);
      this.statusCode = statusCode;
    }
  };

  const SdkErrorMock = class SdkError extends Error {
    override name = 'SdkError';
    code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.code = code;
    }
  };

  return {
    ApiClient: vi
      .fn()
      .mockImplementation((config?: { functionsBaseUrl?: string }) => ({
        post: vi.fn(),
        getFunctionsBaseUrl: vi.fn(() => config?.functionsBaseUrl),
      })),
    NetworkError: NetworkErrorMock,
    SdkError: SdkErrorMock,
    FUNCTIONS_BASE_PATH: 'functions',
    FUNCTIONS_INVOKE_TIMEOUT_MS: 250_000,
  };
});

type TestSchema = {
  helloWorld: {
    input: { firstName: string; lastName: string };
    output: string;
  };
  add: { input: { a: number; b: number }; output: number };
  noInput: { input: void; output: string };
  noInputEmpty: { input: Record<string, never>; output: string };
  // Inputs that collide with InvokeOptions field names, to prove params are
  // never reinterpreted as options.
  echo: {
    input: { timeoutMs: number; label: string };
    output: string;
  };
  // Input whose *only* field collides with an InvokeOptions key, to prove a
  // lone `{ timeoutMs }` argument is still sent as function input.
  onlyTimeout: {
    input: { timeoutMs: number };
    output: string;
  };
};

describe('createFunctionsApi', () => {
  let mockApiClient: ApiClient;
  let fns: ReturnType<typeof createFunctionsApi<TestSchema>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiClient = new ApiClient({
      baseUrl: 'https://api.rayfin.io',
      publishableKey: 'pk-test-key-12345678',
    });
    fns = createFunctionsApi<TestSchema>(mockApiClient);
  });

  it('exposes named function clients as properties', () => {
    expect(fns.helloWorld).toBeInstanceOf(FunctionClient);
    expect(fns.add).toBeInstanceOf(FunctionClient);
    expect(typeof fns.helloWorld.invoke).toBe('function');
  });

  it('caches function clients across accesses', () => {
    const first = fns.helloWorld;
    const second = fns.helloWorld;
    expect(first).toBe(second);
  });

  it('invokes a typed function and returns the typed output', async () => {
    const mockResponse: FunctionInvocationResponse<string> = {
      functionName: 'helloWorld',
      invocationId: 'inv-1',
      status: 'Success',
      output: 'Hello, Ada Lovelace!',
      errors: [],
    };
    (mockApiClient.post as any).mockResolvedValue(mockResponse);

    const result = await fns.helloWorld.invoke({
      firstName: 'Ada',
      lastName: 'Lovelace',
    });

    expect(result).toBe('Hello, Ada Lovelace!');
    expect(mockApiClient.post).toHaveBeenCalledWith(
      'functions/helloWorld/invoke',
      { firstName: 'Ada', lastName: 'Lovelace' },
      { headers: undefined, timeout: 250_000 }
    );
  });

  it('auto-parses JSON-encoded output strings', async () => {
    const mockResponse = {
      functionName: 'add',
      invocationId: 'inv-2',
      status: 'Success',
      output: '{"output":42}',
      errors: [],
    };
    (mockApiClient.post as any).mockResolvedValue(mockResponse);

    const result = await fns.add.invoke({ a: 20, b: 22 });

    expect(result).toBe(42);
  });

  it('throws FunctionsError when the response carries errors', async () => {
    const mockResponse = {
      functionName: 'helloWorld',
      invocationId: 'inv-3',
      status: 'Failed',
      output: '',
      errors: ['Something went wrong'],
    };
    (mockApiClient.post as any).mockResolvedValue(mockResponse);

    await expect(
      fns.helloWorld.invoke({ firstName: 'A', lastName: 'B' })
    ).rejects.toThrow('Function invocation failed: Something went wrong');
  });

  it('surfaces ResponseTooLarge envelopes without retrying', async () => {
    const error = {
      errorCode: 'ResponseTooLarge',
      message: "Function's response size is larger than the 30 megabyte limit.",
      properties: {},
    };
    vi.mocked(mockApiClient.post).mockResolvedValue({
      functionName: 'helloWorld',
      invocationId: 'oversized-invocation-id',
      status: 'ResponseTooLarge',
      output: '',
      errors: [error],
    });

    await expect(
      fns.helloWorld.invoke({ firstName: 'A', lastName: 'B' })
    ).rejects.toMatchObject({
      code: 'FUNCTION_EXECUTION_ERROR',
      message: `Function invocation failed: ${JSON.stringify(error)}`,
    });
    expect(mockApiClient.post).toHaveBeenCalledTimes(1);
  });

  it('throws FunctionsError when the response status is not success', async () => {
    const mockResponse: FunctionInvocationResponse<string> = {
      functionName: 'helloWorld',
      invocationId: 'inv-4',
      status: 'Failed',
      output: '',
      errors: [],
    };
    (mockApiClient.post as any).mockResolvedValue(mockResponse);

    await expect(
      fns.helloWorld.invoke({ firstName: 'A', lastName: 'B' })
    ).rejects.toThrow('Function invocation failed with status: Failed');
  });

  it('propagates NetworkError unchanged', async () => {
    const networkError = new NetworkError('Network error', 500);
    (mockApiClient.post as any).mockRejectedValue(networkError);

    await expect(
      fns.helloWorld.invoke({ firstName: 'A', lastName: 'B' })
    ).rejects.toThrow('Network error');
  });

  it('wraps unknown errors in a FunctionsError', async () => {
    (mockApiClient.post as any).mockRejectedValue(new Error('Unknown error'));

    await expect(
      fns.helloWorld.invoke({ firstName: 'A', lastName: 'B' })
    ).rejects.toBeInstanceOf(FunctionsError);
  });

  it('supports zero-input functions', async () => {
    const mockResponse: FunctionInvocationResponse<string> = {
      functionName: 'noInput',
      invocationId: 'inv-5',
      status: 'Success',
      output: 'ok',
      errors: [],
    };
    (mockApiClient.post as any).mockResolvedValue(mockResponse);

    const result = await fns.noInput.invoke();

    expect(result).toBe('ok');
    expect(mockApiClient.post).toHaveBeenCalledWith(
      'functions/noInput/invoke',
      {},
      { headers: undefined, timeout: 250_000 }
    );
  });

  it('supports zero-input functions with empty object schema', async () => {
    const mockResponse: FunctionInvocationResponse<string> = {
      functionName: 'noInputEmpty',
      invocationId: 'inv-6',
      status: 'Success',
      output: 'ok',
      errors: [],
    };
    (mockApiClient.post as any).mockResolvedValue(mockResponse);

    const result = await fns.noInputEmpty.invoke();

    expect(result).toBe('ok');
    expect(mockApiClient.post).toHaveBeenCalledWith(
      'functions/noInputEmpty/invoke',
      {},
      { headers: undefined, timeout: 250_000 }
    );
  });

  it('sends function input verbatim even when it collides with option field names', async () => {
    const mockResponse: FunctionInvocationResponse<string> = {
      functionName: 'echo',
      invocationId: 'inv-echo-1',
      status: 'Success',
      output: 'ok',
      errors: [],
    };
    (mockApiClient.post as any).mockResolvedValue(mockResponse);

    // A single-arg call whose params include a field named like an option
    // (`timeoutMs`) alongside a real field must be treated as function
    // input, not InvokeOptions, because not every key is `headers`.
    const result = await fns.echo.invoke({
      timeoutMs: 5000,
      label: 'abc',
    });

    expect(result).toBe('ok');
    expect(mockApiClient.post).toHaveBeenCalledWith(
      'functions/echo/invoke',
      { timeoutMs: 5000, label: 'abc' },
      { headers: undefined, timeout: 250_000 }
    );
  });

  it('applies a per-call timeout override passed as the options argument', async () => {
    const mockResponse: FunctionInvocationResponse<string> = {
      functionName: 'helloWorld',
      invocationId: 'inv-opt-1',
      status: 'Success',
      output: 'Hello, Ada Lovelace!',
      errors: [],
    };
    (mockApiClient.post as any).mockResolvedValue(mockResponse);

    await fns.helloWorld.invoke(
      { firstName: 'Ada', lastName: 'Lovelace' },
      { timeoutMs: 1000, headers: { 'x-trace': 'abc' } }
    );

    expect(mockApiClient.post).toHaveBeenCalledWith(
      'functions/helloWorld/invoke',
      { firstName: 'Ada', lastName: 'Lovelace' },
      { headers: { 'x-trace': 'abc' }, timeout: 1000 }
    );
  });

  it('clamps a per-call timeout override above the 250s ceiling', async () => {
    const mockResponse: FunctionInvocationResponse<string> = {
      functionName: 'helloWorld',
      invocationId: 'inv-clamp-1',
      status: 'Success',
      output: 'Hello, Ada Lovelace!',
      errors: [],
    };
    (mockApiClient.post as any).mockResolvedValue(mockResponse);

    // The server aborts at 250s, so a larger client timeout is clamped down.
    await fns.helloWorld.invoke(
      { firstName: 'Ada', lastName: 'Lovelace' },
      { timeoutMs: 999_000 }
    );

    expect(mockApiClient.post).toHaveBeenCalledWith(
      'functions/helloWorld/invoke',
      { firstName: 'Ada', lastName: 'Lovelace' },
      { headers: undefined, timeout: 250_000 }
    );
  });

  it('falls back to the default for a non-positive timeout override', async () => {
    const mockResponse: FunctionInvocationResponse<string> = {
      functionName: 'helloWorld',
      invocationId: 'inv-clamp-2',
      status: 'Success',
      output: 'Hello, Ada Lovelace!',
      errors: [],
    };
    (mockApiClient.post as any).mockResolvedValue(mockResponse);

    await fns.helloWorld.invoke(
      { firstName: 'Ada', lastName: 'Lovelace' },
      { timeoutMs: 0 }
    );

    expect(mockApiClient.post).toHaveBeenCalledWith(
      'functions/helloWorld/invoke',
      { firstName: 'Ada', lastName: 'Lovelace' },
      { headers: undefined, timeout: 250_000 }
    );
  });

  it('sends a lone options-shaped input as params, not options', async () => {
    const mockResponse: FunctionInvocationResponse<string> = {
      functionName: 'onlyTimeout',
      invocationId: 'inv-only-1',
      status: 'Success',
      output: 'ok',
      errors: [],
    };
    (mockApiClient.post as any).mockResolvedValue(mockResponse);

    // A function whose entire input is `{ timeoutMs }` must have the
    // single argument sent verbatim as params (with the default timeout), not
    // reinterpreted as InvokeOptions.
    const result = await fns.onlyTimeout.invoke({ timeoutMs: 5000 });

    expect(result).toBe('ok');
    expect(mockApiClient.post).toHaveBeenCalledWith(
      'functions/onlyTimeout/invoke',
      { timeoutMs: 5000 },
      { headers: undefined, timeout: 250_000 }
    );
  });

  it('applies headers for a no-input function passed in the second slot', async () => {
    const mockResponse: FunctionInvocationResponse<string> = {
      functionName: 'noInput',
      invocationId: 'inv-headers-1',
      status: 'Success',
      output: 'ok',
      errors: [],
    };
    (mockApiClient.post as any).mockResolvedValue(mockResponse);

    await fns.noInput.invoke(undefined, { headers: { 'x-trace': 'abc' } });

    expect(mockApiClient.post).toHaveBeenCalledWith(
      'functions/noInput/invoke',
      {},
      { headers: { 'x-trace': 'abc' }, timeout: 250_000 }
    );
  });

  it("accepts a no-input function's per-call timeout in the second slot", async () => {
    const mockResponse: FunctionInvocationResponse<string> = {
      functionName: 'noInput',
      invocationId: 'inv-opt-2',
      status: 'Success',
      output: 'ok',
      errors: [],
    };
    (mockApiClient.post as any).mockResolvedValue(mockResponse);

    await fns.noInput.invoke(undefined, { timeoutMs: 1000 });

    expect(mockApiClient.post).toHaveBeenCalledWith(
      'functions/noInput/invoke',
      {},
      { headers: undefined, timeout: 1000 }
    );
  });

  it('routes invokes to functionsBaseUrl when configured (local-debug path)', async () => {
    const localApiClient = new ApiClient({
      baseUrl: 'https://api.rayfin.io',
      publishableKey: 'pk-test-key-12345678',
      functionsBaseUrl: 'http://localhost:7071',
    });
    const localFns = createFunctionsApi<TestSchema>(localApiClient);

    const mockResponse: FunctionInvocationResponse<string> = {
      functionName: 'helloWorld',
      invocationId: 'inv-local-1',
      status: 'Success',
      output: 'Hello, Ada!',
      errors: [],
    };
    (localApiClient.post as any).mockResolvedValue(mockResponse);

    await localFns.helloWorld.invoke({
      firstName: 'Ada',
      lastName: 'Lovelace',
    });

    expect(localApiClient.post).toHaveBeenCalledWith(
      'http://localhost:7071/api/helloWorld',
      { firstName: 'Ada', lastName: 'Lovelace' },
      { headers: undefined, timeout: 250_000 }
    );
  });
});
