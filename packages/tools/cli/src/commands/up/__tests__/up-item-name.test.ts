import { describe, expect, it } from 'vitest';

import { CliHandledError } from '../../../errors.js';
import { resolveItemName } from '../up-item-name.js';

describe('resolveItemName', () => {
  it('prefers the recorded name over the project fallback', () => {
    expect(
      resolveItemName({
        recordedItemName: 'existing-backend',
        hasRecordedItemId: true,
        fallbackItemName: 'project-id',
        mode: 'plain',
      })
    ).toBe('existing-backend');
  });

  it('accepts a case-insensitive override that matches the recorded name', () => {
    expect(
      resolveItemName({
        explicitItemName: 'EXISTING-BACKEND',
        recordedItemName: 'existing-backend',
        hasRecordedItemId: true,
        fallbackItemName: 'project-id',
        mode: 'plain',
      })
    ).toBe('existing-backend');
  });

  it('rejects a conflicting override', () => {
    expect(() =>
      resolveItemName({
        explicitItemName: 'different-backend',
        recordedItemName: 'existing-backend',
        hasRecordedItemId: true,
        fallbackItemName: 'project-id',
        mode: 'plain',
      })
    ).toThrow(CliHandledError);
  });
});
