import { describe, expect, it } from 'vitest';

import {
  resolveConnectorCollisionFailureState,
  resolveUpStatus,
} from '../up.js';

describe('resolveUpStatus', () => {
  it("returns 'success' when no connectors failed", () => {
    expect(resolveUpStatus([])).toBe('success');
  });

  it("returns 'partial' when a single connector failed", () => {
    expect(resolveUpStatus(['inventory'])).toBe('partial');
  });

  it("returns 'partial' when multiple connectors failed", () => {
    expect(resolveUpStatus(['inventory', 'catalog'])).toBe('partial');
  });

  it('produces partial structured state for connector collisions in JSON output', () => {
    const collisionMessage =
      'Duplicate GraphQL type names detected across connectors: Product';
    const state = resolveConnectorCollisionFailureState(
      ['inventory', 'orders'],
      ['archive'],
      collisionMessage
    );

    expect(resolveUpStatus(state.failedConnectorNames)).toBe('partial');
    expect(state.failedConnectorNames).toEqual([
      'archive',
      'inventory',
      'orders',
    ]);
    expect(state.steps).toEqual({
      'connector:inventory': {
        duration: '—',
        status: 'error',
        error: collisionMessage,
      },
      'connector:orders': {
        duration: '—',
        status: 'error',
        error: collisionMessage,
      },
    });
  });
});
