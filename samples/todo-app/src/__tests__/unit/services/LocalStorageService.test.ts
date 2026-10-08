import { describe, it, expect } from 'vitest';

import { LocalStorageService } from '../../../services/mock/LocalStorageService';

describe('LocalStorageService', () => {
  it('should set and get values correctly', () => {
    const service = new LocalStorageService();
    const testData = { message: 'Hello, World!' };

    service.set('test-key', testData);
    const retrieved = service.get('test-key');

    expect(retrieved).toEqual(testData);
  });

  it('should return null for non-existent keys', () => {
    const service = new LocalStorageService();
    const result = service.get('non-existent');

    expect(result).toBeNull();
  });
});
