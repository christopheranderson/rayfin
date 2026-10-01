import { describe, expect, it } from 'vitest';

import { translateStaticHostingAccessError } from '../index.js';

describe('translateStaticHostingAccessError', () => {
  it.each([
    [
      'StaticHostingPostureRequired',
      "Static hosting requires an explicit access posture. Set 'services.staticHosting.anonymousAccess' in your app configuration.",
      "Static hosting requires an explicit access posture. Set 'services.staticHosting.assetAccess' to 'protected' to require Fabric sign-in or 'public' to serve anyone with the link, then deploy again.",
    ],
    [
      'InvalidStaticHostingPosture',
      "Invalid static hosting posture: 'embedded.only' and 'anonymousAccess' cannot both be true.",
      "Invalid static hosting posture: 'services.staticHosting.embedded.only: true' cannot be combined with 'services.staticHosting.assetAccess: public' because an embedded app has no standalone surface to make public.",
    ],
    [
      'STATIC_HOSTING_ACCESS_POSTURE_NOT_RECORDED',
      "Run 'rayfin up' to record 'services.staticHosting.anonymousAccess' before trying again.",
      "The static-hosting access posture has not been recorded. Run 'rayfin up' to record 'services.staticHosting.assetAccess' before trying again.",
    ],
  ])('translates %s to Builder-facing guidance', (code, details, expected) => {
    expect(translateStaticHostingAccessError(details, code)).toBe(expected);
  });

  it('recognizes legacy guidance when the service omits an error code', () => {
    expect(
      translateStaticHostingAccessError(
        "Invalid static hosting posture: 'embedded.only' and 'anonymousAccess' cannot both be true."
      )
    ).toContain('assetAccess: public');
  });

  it('preserves unrelated service errors', () => {
    expect(translateStaticHostingAccessError('Unrelated failure')).toBe(
      'Unrelated failure'
    );
  });
});
