import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RAYFIN_ENV_CONFIG_VARS,
  bootstrapEnvironmentConfig,
} from '../index.js';

// Derived from the single source of truth so this test stays in sync
// if the env-var set ever changes.
const ENV_KEYS = RAYFIN_ENV_CONFIG_VARS.map(({ envVar }) => envVar);

// Bootstrap (and these tests) are Node-only; narrow `process` and its
// Node-only sub-fields once since the package's universal ambient
// declaration types them as possibly undefined.
const proc = process!;
const procEnv = proc.env;
type WritableStream = { write(message: string): boolean };
const procStderr: WritableStream = proc.stderr!;
// Tests pin stdout to ensure bootstrap NEVER writes there — since
// `--json` commands emit a single JSON document on stdout, any
// bootstrap chatter on stdout would corrupt it.
const procStdout: WritableStream = (
  proc as unknown as { stdout: WritableStream }
).stdout;

describe('bootstrapEnvironmentConfig', () => {
  let tempHome: string;
  let configDir: string;
  let savedEnv: Record<string, string | undefined>;
  // vi.spyOn's overloads are picky about method-typed targets; use the
  // narrow MockInstance shape we actually need (the tests only call
  // `toHaveBeenCalled[With]` and `mockRestore`).
  type WriteSpy = {
    mockRestore(): void;
    mock: { calls: unknown[][] };
  };
  let stderrSpy: WriteSpy;
  let stdoutSpy: WriteSpy;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'rayfin-bootstrap-'));
    configDir = join(tempHome, '.rayfin');
    await mkdir(configDir, { recursive: true, mode: 0o700 });

    savedEnv = {};
    for (const k of ENV_KEYS) {
      savedEnv[k] = procEnv[k];
      delete procEnv[k];
    }

    stderrSpy = vi
      .spyOn(procStderr, 'write' as never)
      .mockImplementation(() => true) as unknown as WriteSpy;
    stdoutSpy = vi
      .spyOn(procStdout, 'write' as never)
      .mockImplementation(() => true) as unknown as WriteSpy;
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) {
        delete procEnv[k];
      } else {
        procEnv[k] = savedEnv[k];
      }
    }
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    await rm(tempHome, { recursive: true, force: true });
  });

  it('is a silent no-op when auth.json is missing', () => {
    expect(() => bootstrapEnvironmentConfig({ configDir })).not.toThrow();

    for (const k of ENV_KEYS) {
      expect(procEnv[k]).toBeUndefined();
    }
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('warns to stderr and does not hydrate when auth.json contains malformed JSON', async () => {
    await writeFile(join(configDir, 'auth.json'), 'not-json', 'utf8');

    expect(() => bootstrapEnvironmentConfig({ configDir })).not.toThrow();

    for (const k of ENV_KEYS) {
      expect(procEnv[k]).toBeUndefined();
    }
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not parse auth state')
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('hydrates without writing to stdout or stderr in the happy path', async () => {
    await writeFile(
      join(configDir, 'auth.json'),
      JSON.stringify({
        identityType: 'user',
        environmentConfig: {
          authorityHost: 'https://login.example.invalid',
          clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        },
      }),
      'utf8'
    );

    bootstrapEnvironmentConfig({ configDir });

    expect(procEnv['RAYFIN_AUTHORITY_HOST']).toBe(
      'https://login.example.invalid'
    );
    expect(procEnv['RAYFIN_CLIENT_ID']).toBe(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    );
    // Per-invocation log noise is intentionally suppressed; only the
    // user-misconfiguration warnings ever go to stderr.
    expect(stderrSpy).not.toHaveBeenCalled();
    // Critical: must never pollute stdout, which carries --json output.
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('hydrates only the present environmentConfig sub-fields', async () => {
    await writeFile(
      join(configDir, 'auth.json'),
      JSON.stringify({
        identityType: 'user',
        environmentConfig: {
          authorityHost: 'https://login.example.invalid',
          clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          // fabricScope, fabricApiUrl, and fabricPortalUrl intentionally omitted
        },
      }),
      'utf8'
    );

    bootstrapEnvironmentConfig({ configDir });

    expect(procEnv['RAYFIN_AUTHORITY_HOST']).toBe(
      'https://login.example.invalid'
    );
    expect(procEnv['RAYFIN_CLIENT_ID']).toBe(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    );
    expect(procEnv['RAYFIN_FABRIC_SCOPE']).toBeUndefined();
    expect(procEnv['RAYFIN_FABRIC_API_URL']).toBeUndefined();
    expect(procEnv['RAYFIN_FABRIC_PORTAL_URL']).toBeUndefined();
  });

  it('does not overwrite explicit shell-exported env vars', async () => {
    procEnv['RAYFIN_CLIENT_ID'] = 'shell-supplied-id';

    await writeFile(
      join(configDir, 'auth.json'),
      JSON.stringify({
        identityType: 'user',
        environmentConfig: {
          authorityHost: 'https://login.example.invalid',
          clientId: 'persisted-id',
          fabricScope: 'https://example.invalid/.default',
          fabricApiUrl: 'https://api.example.invalid/v1',
          fabricPortalUrl: 'https://portal.example.invalid/',
        },
      }),
      'utf8'
    );

    bootstrapEnvironmentConfig({ configDir });

    // Shell value preserved.
    expect(procEnv['RAYFIN_CLIENT_ID']).toBe('shell-supplied-id');
    // Other fields hydrated normally.
    expect(procEnv['RAYFIN_AUTHORITY_HOST']).toBe(
      'https://login.example.invalid'
    );
    expect(procEnv['RAYFIN_FABRIC_SCOPE']).toBe(
      'https://example.invalid/.default'
    );
    expect(procEnv['RAYFIN_FABRIC_API_URL']).toBe(
      'https://api.example.invalid/v1'
    );
    expect(procEnv['RAYFIN_FABRIC_PORTAL_URL']).toBe(
      'https://portal.example.invalid/'
    );
  });

  it('does not hydrate when environmentConfig is absent from auth.json', async () => {
    await writeFile(
      join(configDir, 'auth.json'),
      JSON.stringify({
        identityType: 'user',
        tenantId: 'some-tenant',
      }),
      'utf8'
    );

    bootstrapEnvironmentConfig({ configDir });

    for (const k of ENV_KEYS) {
      expect(procEnv[k]).toBeUndefined();
    }
  });

  it('ignores unknown environmentConfig sub-fields without erroring', async () => {
    await writeFile(
      join(configDir, 'auth.json'),
      JSON.stringify({
        identityType: 'user',
        environmentConfig: {
          authorityHost: 'https://login.example.invalid',
          futureKnobThatDoesNotExist: 'whatever',
        },
      }),
      'utf8'
    );

    expect(() => bootstrapEnvironmentConfig({ configDir })).not.toThrow();
    expect(procEnv['RAYFIN_AUTHORITY_HOST']).toBe(
      'https://login.example.invalid'
    );
  });
});
