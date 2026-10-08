import { beforeEach, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom';

// Set mock mode for tests so AuthSettingsProvider uses mock settings
// This must be set before any component imports that use getServiceMode()
vi.stubEnv('VITE_SERVICE_MODE', 'mock');

beforeEach(() => {
  // Mock localStorage with actual storage functionality
  const storage: Record<string, string> = {};
  const localStorageMock = {
    getItem: vi.fn((key: string) => storage[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      storage[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete storage[key];
    }),
    clear: vi.fn(() => {
      Object.keys(storage).forEach((key) => delete storage[key]);
    }),
    length: 0,
    key: vi.fn(),
  };

  Object.defineProperty(window, 'localStorage', {
    value: localStorageMock,
    writable: true,
  });

  // Mock crypto.randomUUID
  Object.defineProperty(global, 'crypto', {
    value: {
      randomUUID: vi.fn(
        () => 'test-uuid-' + Math.random().toString(36).substr(2, 9)
      ),
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});
