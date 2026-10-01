import { describe, expect, it } from 'vitest';

import type { RayfinConfig } from '../../../config/index.js';
import { toRuntimeSettingsServices } from '../index.js';

describe('toRuntimeSettingsServices', () => {
  it.each([
    ['protected', false],
    ['public', true],
  ] as const)(
    'maps %s asset access to anonymousAccess %s',
    (value, expected) => {
      const services = makeServices(value);

      expect(toRuntimeSettingsServices(services)).toEqual({
        auth: { enabled: true },
        staticHosting: {
          enabled: true,
          folder: 'dist',
          anonymousAccess: expected,
        },
      });
      expect(services.staticHosting).toHaveProperty('assetAccess', value);
    }
  );

  it('preserves services without static hosting', () => {
    const services = {
      auth: { enabled: true },
    } as RayfinConfig['services'];

    expect(toRuntimeSettingsServices(services)).toEqual(services);
  });

  it('defaults enabled static hosting to protected when access is absent', () => {
    const services = makeServices();

    expect(toRuntimeSettingsServices(services)).toEqual({
      auth: { enabled: true },
      staticHosting: {
        enabled: true,
        folder: 'dist',
        anonymousAccess: false,
      },
    });
  });

  it('does not add a posture when static hosting is disabled', () => {
    const services = {
      auth: { enabled: true },
      staticHosting: { enabled: false },
    } as RayfinConfig['services'];

    expect(toRuntimeSettingsServices(services)).toEqual(services);
  });

  it.each([false, true])(
    'preserves legacy anonymousAccess %s when assetAccess is absent',
    (anonymousAccess) => {
      const services = withLegacyAnonymousAccess(
        makeServices(),
        anonymousAccess
      );

      expect(toRuntimeSettingsServices(services).staticHosting).toHaveProperty(
        'anonymousAccess',
        anonymousAccess
      );
    }
  );

  it('uses assetAccess instead of a conflicting legacy anonymousAccess', () => {
    const services = withLegacyAnonymousAccess(makeServices('protected'), true);

    expect(toRuntimeSettingsServices(services).staticHosting).toEqual({
      enabled: true,
      folder: 'dist',
      anonymousAccess: false,
    });
  });

  it('rejects unsupported runtime values', () => {
    const services = makeServices('private' as never);

    expect(() => toRuntimeSettingsServices(services)).toThrow(
      /services\.staticHosting\.assetAccess/
    );
  });
});

function makeServices(
  assetAccess?: 'protected' | 'public'
): RayfinConfig['services'] {
  return {
    auth: { enabled: true },
    staticHosting: {
      enabled: true,
      folder: 'dist',
      ...(assetAccess === undefined ? {} : { assetAccess }),
    },
  } as RayfinConfig['services'];
}

function withLegacyAnonymousAccess(
  services: RayfinConfig['services'],
  anonymousAccess: boolean
): RayfinConfig['services'] {
  const legacyServices = services as RayfinConfig['services'] & {
    staticHosting: { anonymousAccess?: boolean };
  };
  legacyServices.staticHosting.anonymousAccess = anonymousAccess;
  return legacyServices;
}
