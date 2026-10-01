import { describe, expect, it } from 'vitest';

import type { FabricCapacity } from '../capacity.js';
import {
  isSelectablePaidCapacity,
  isTrialCapacity,
  isUsableCapacity,
  PREMIUM_CAPACITY_SKUS,
} from '../capacity.js';

const capacity = (
  id: string,
  overrides: Partial<FabricCapacity> = {}
): FabricCapacity => ({
  id,
  displayName: id,
  sku: 'F2',
  state: 'Active',
  ...overrides,
});

describe('isUsableCapacity', () => {
  it('accepts active F, trial, and P1-P5 capacity', () => {
    expect(isUsableCapacity(capacity('f'))).toBe(true);
    expect(
      isUsableCapacity(capacity('trial', { sku: 'FT1', type: 'Trial' }))
    ).toBe(true);
    expect(isUsableCapacity(capacity('p1', { sku: 'P1' }))).toBe(true);
    expect(isUsableCapacity(capacity('p5', { sku: 'P5' }))).toBe(true);
    expect(isUsableCapacity(capacity('p6', { sku: 'P6' }))).toBe(false);
    expect(isUsableCapacity(capacity('paused', { state: 'Paused' }))).toBe(
      false
    );
  });

  it('rejects active SKUs outside the explicit allowlists', () => {
    expect(isUsableCapacity(capacity('future', { sku: 'FX9' }))).toBe(false);
    expect(isUsableCapacity(capacity('odd', { sku: 'F3' }))).toBe(false);
    expect(isUsableCapacity(capacity('largest', { sku: 'F2048' }))).toBe(true);
    expect(
      isUsableCapacity(
        capacity('futurePremium', { sku: 'P9', state: 'Active' })
      )
    ).toBe(false);
  });
});

describe('isTrialCapacity', () => {
  it('identifies trial capacities by type or trial SKU', () => {
    expect(
      isTrialCapacity(capacity('typed', { type: 'FabricTrialCapacity' }))
    ).toBe(true);
    expect(isTrialCapacity(capacity('sku', { sku: 'FTL64' }))).toBe(true);
    expect(isTrialCapacity(capacity('paid', { sku: 'F2' }))).toBe(false);
    expect(
      isTrialCapacity(
        capacity('paused', {
          sku: 'FT1',
          type: 'Trial',
          state: 'Paused',
        })
      )
    ).toBe(false);
  });

  it('honors a caller-supplied trial SKU list', () => {
    expect(isTrialCapacity(capacity('custom', { sku: 'FX9' }), ['FX9'])).toBe(
      true
    );
    expect(isTrialCapacity(capacity('sku', { sku: 'FTL64' }), ['FX9'])).toBe(
      false
    );
  });
});

describe('isSelectablePaidCapacity', () => {
  it('accepts every supported premium SKU', () => {
    for (const sku of PREMIUM_CAPACITY_SKUS) {
      expect(isSelectablePaidCapacity(capacity(sku, { sku }))).toBe(true);
    }
  });

  it('rejects trials, non-allowlisted SKUs, and inactive capacity', () => {
    expect(
      isSelectablePaidCapacity(
        capacity('trial', { sku: 'FT1', type: 'FabricTrialCapacity' })
      )
    ).toBe(false);
    expect(isSelectablePaidCapacity(capacity('f1', { sku: 'F1' }))).toBe(false);
    expect(isSelectablePaidCapacity(capacity('f3', { sku: 'F3' }))).toBe(false);
    expect(isSelectablePaidCapacity(capacity('p6', { sku: 'P6' }))).toBe(false);
    expect(
      isSelectablePaidCapacity(
        capacity('paused', {
          sku: 'F2',
          type: 'FSkuCapacity',
          state: 'Paused',
        })
      )
    ).toBe(false);
    expect(
      isSelectablePaidCapacity(
        capacity('unknown', { sku: 'A1', type: 'FutureCapacity' })
      )
    ).toBe(false);
  });
});
