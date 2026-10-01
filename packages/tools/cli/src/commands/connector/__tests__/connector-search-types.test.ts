/**
 * Regression cover for the `--type` filter on `connector search`.
 *
 * The filter feeds the discovery engines, which read an **empty array** as "no
 * filter" and enable every `discoverable` provider. So a `--type` list that
 * parses to nothing must come back as `undefined` (absent), never `[]`, or the
 * authoring gate is bypassed and search offers sources that `connector add`
 * then refuses.
 */

import { describe, expect, it } from 'vitest';

import { OUTPUT_MODE } from '../../../utils/output-mode.js';
import { parseTypeFilter } from '../connector-search.js';

const MODE = OUTPUT_MODE.Plain;

describe('connector search --type parsing', () => {
  it('treats a missing flag as no filter', () => {
    expect(parseTypeFilter(undefined, MODE)).toBeUndefined();
  });

  it('treats an empty value as no filter', () => {
    expect(parseTypeFilter('', MODE)).toBeUndefined();
  });

  it.each([',', ',,', ' , ', '  '])(
    'treats %j as no filter rather than an empty type list',
    (raw) => {
      // `[]` would reach the engine as "search everything", which is exactly
      // the leak the gate exists to close.
      const parsed = parseTypeFilter(raw, MODE);

      expect(parsed).toBeUndefined();
      expect(parsed).not.toEqual([]);
    }
  );

  it('keeps a real single type', () => {
    expect(parseTypeFilter('fabric-warehouse', MODE)).toEqual([
      'fabric-warehouse',
    ]);
  });

  it('keeps a real list and ignores padding and empty slots', () => {
    expect(
      parseTypeFilter(' fabric-warehouse , ,fabric-sqldatabase ', MODE)
    ).toEqual(['fabric-warehouse', 'fabric-sqldatabase']);
  });

  it('rejects a type held back for this release', () => {
    expect(() => parseTypeFilter('kusto', MODE)).toThrow(
      /not available in this release/u
    );
  });
  it('rejects an inherited object key without throwing a TypeError', () => {
    // `constructor` is `in` the catalog but is not a connector; it used to be
    // cast to a ConnectorType and crash the gated branch.
    expect(() => parseTypeFilter('constructor', MODE)).toThrow(
      /Unknown connector type/u
    );
  });

  it('rejects an unknown type as a typo', () => {
    expect(() => parseTypeFilter('fabric-warehose', MODE)).toThrow(
      /Unknown connector type/u
    );
  });
});
