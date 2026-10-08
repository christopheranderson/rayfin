import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import { describe, expect, it } from 'vitest';

import { assertStaticHostingAccessSupported } from '../commands/staticHostingAccess';

describe('assertStaticHostingAccessSupported', () => {
  it('allows legacy projects without assetAccess', () => {
    expect(() =>
      assertStaticHostingAccessSupported(makeConfig(undefined))
    ).not.toThrow();
  });

  it('allows projects with static hosting disabled', () => {
    expect(() =>
      assertStaticHostingAccessSupported(makeConfig('protected', false))
    ).not.toThrow();
  });

  it.each(['protected', 'public'] as const)(
    'directs %s projects to the CLI before deployment',
    (assetAccess) => {
      expect(() =>
        assertStaticHostingAccessSupported(makeConfig(assetAccess))
      ).toThrow(/Run `rayfin up` in a terminal/);
    }
  );
});

function makeConfig(
  assetAccess: 'protected' | 'public' | undefined,
  enabled = true
): RayfinConfig {
  return {
    id: 'test-project',
    name: 'Test project',
    version: '1.0.0',
    services: {
      auth: { enabled: true },
      data: { enabled: false },
      storage: { enabled: false },
      staticHosting: {
        enabled,
        folder: 'dist',
        ...(assetAccess === undefined ? {} : { assetAccess }),
      },
    },
  };
}
