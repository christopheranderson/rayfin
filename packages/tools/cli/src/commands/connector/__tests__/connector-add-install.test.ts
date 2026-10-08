/**
 * Contract test for the install guidance `rayfin connector add` emits.
 *
 * `connector add` scaffolds files that import packages the app does not
 * declare. An unversioned `npm install` follows npm dist-tags, which lag the
 * published release, so it resolves to an older connector that hard-pins its
 * own `@microsoft/rayfin-data` and leaves two Rayfin version lines in one app.
 * These tests pin the guarantee that the emitted command is always versioned.
 */

import type { ConnectorType } from '@microsoft/rayfin-tools-common/_internal/config';
import { CONNECTOR_CATALOG } from '@microsoft/rayfin-tools-common/_internal/config';
import { describe, expect, it } from 'vitest';

import { getPackageVersion } from '../../../utils/version.js';
import { pinnedPackageSpecs } from '../connector-add.js';

const TYPES = Object.keys(CONNECTOR_CATALOG) as ConnectorType[];

describe('pinnedPackageSpecs', () => {
  it.each(TYPES)('pins every package for %s', (type) => {
    const specs = pinnedPackageSpecs(type);
    const version = getPackageVersion();

    expect(specs.length).toBe(CONNECTOR_CATALOG[type].clientPackages.length);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(spec).toContain('@');
      expect(spec.endsWith(`@${version}`)).toBe(true);
    }
  });

  it.each(TYPES)(
    'names exactly the packages the %s scaffold imports',
    (type) => {
      const names = pinnedPackageSpecs(type).map((spec) =>
        spec.slice(0, spec.lastIndexOf('@'))
      );
      expect(names).toEqual(
        CONNECTOR_CATALOG[type].clientPackages.map((pkg) => pkg.name)
      );
    }
  );

  // The whole point of the fix: no spec may resolve through a dist-tag.
  it('never emits an unversioned spec', () => {
    for (const type of TYPES) {
      for (const spec of pinnedPackageSpecs(type)) {
        // Scoped names start with '@', so a pinned spec has two.
        expect(spec.split('@').length).toBe(3);
      }
    }
  });

  // Kusto imports its marker and config type from its own package, and the
  // generated app wiring imports the shared runtime types, so both are pinned.
  it('pins the Kusto marker and the shared runtime package', () => {
    expect(pinnedPackageSpecs('kusto')).toEqual([
      `@microsoft/rayfin-connector-kusto@${getPackageVersion()}`,
      `@microsoft/rayfin-connectors@${getPackageVersion()}`,
    ]);
  });
});
