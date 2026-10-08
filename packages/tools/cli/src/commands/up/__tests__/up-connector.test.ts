import { describe, expect, it } from 'vitest';

import { resolveConnectorApplyStatus } from '../up-connector.js';

describe('resolveConnectorApplyStatus', () => {
  it("returns 'success' when generation and apply both succeed", () => {
    expect(
      resolveConnectorApplyStatus(
        [{ status: 'generated' }],
        [{ status: 'success' }]
      )
    ).toBe('success');
  });

  it("returns 'partial' when an apply result errored", () => {
    expect(
      resolveConnectorApplyStatus(
        [{ status: 'generated' }],
        [{ status: 'error' }]
      )
    ).toBe('partial');
  });

  it("returns 'partial' when generation errored even though apply results are empty", () => {
    // Regression: a generation error excludes its connector from apply, leaving
    // apply `results` empty. Status must still reflect the failure so automation
    // does not read 'success'.
    expect(resolveConnectorApplyStatus([{ status: 'error' }], [])).toBe(
      'partial'
    );
  });

  it("returns 'success' when a connector was intentionally skipped", () => {
    expect(
      resolveConnectorApplyStatus(
        [{ status: 'skipped' }],
        [{ status: 'skipped' }]
      )
    ).toBe('success');
  });
});
