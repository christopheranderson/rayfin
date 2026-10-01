/**
 * @packageDocumentation Guards the Docker dev stack's server-side feature gates.
 *
 * The storage controller sits behind two independent filters:
 * `RequireServiceEnabled(Storage)` reads `Storage:Enabled`, and
 * `ExperimentalFeature(EnableStorage)` reads `FeatureFlags:EnableStorage`. The
 * experimental filter runs first and answers 404 when its flag is off, so a
 * stack that sets only the service flag starts up advertising storage and then
 * rejects every `rayfin dev storage apply` — while the CLI reports the 404 as
 * an out-of-date webservice.
 */
import { describe, expect, it, vi } from 'vitest';

import type { RayfinConfig } from '../../../types/config.js';
import { generateDevEnvVariables } from '../docker-lifecycle.js';

vi.mock('../../../utils/env-file-utils.js', () => ({
  readEnvFile: vi.fn(async () => []),
}));

vi.mock('../../../utils/docker-utils.js', () => ({
  allocateServicePorts: vi.fn(async () => ({})),
  getDockerComposeFile: vi.fn(() => 'docker-compose.yml'),
  runDockerCompose: vi.fn(),
}));

function configWith(storageEnabled: boolean | undefined): RayfinConfig {
  return {
    id: 'app',
    name: 'app',
    services: {
      auth: { enabled: true },
      data: { enabled: true },
      ...(storageEnabled === undefined
        ? {}
        : { storage: { enabled: storageEnabled } }),
    },
  } as unknown as RayfinConfig;
}

async function envFor(storageEnabled: boolean | undefined) {
  const vars = await generateDevEnvVariables(
    configWith(storageEnabled),
    [],
    // A healthy existing stack short-circuits port allocation, keeping this
    // test to the variables it is actually about.
    {} as never,
    '/tmp/project/rayfin'
  );
  return new Map(vars.map((entry) => [entry.key, entry.value]));
}

describe('generateDevEnvVariables storage gates', () => {
  it('opens both gates when the project declares storage', async () => {
    const env = await envFor(true);

    expect(env.get('Storage__Enabled')).toBe('true');
    expect(env.get('FeatureFlags__EnableStorage')).toBe('true');
  });

  it('keeps both gates shut when storage is declared off', async () => {
    const env = await envFor(false);

    expect(env.get('Storage__Enabled')).toBe('false');
    expect(env.get('FeatureFlags__EnableStorage')).toBe('false');
  });

  it('keeps both gates shut when the project omits storage entirely', async () => {
    const env = await envFor(undefined);

    expect(env.get('Storage__Enabled')).toBe('false');
    expect(env.get('FeatureFlags__EnableStorage')).toBe('false');
  });

  it('never enables the service without its experimental gate', async () => {
    // The specific broken combination: service on, feature gate off. That is
    // the stack that 404s on every apply, so it must be unreachable.
    for (const declared of [true, false, undefined]) {
      const env = await envFor(declared);
      const service = env.get('Storage__Enabled');
      const gate = env.get('FeatureFlags__EnableStorage');
      expect(gate).toBeDefined();
      expect(gate).toBe(service);
    }
  });
});
