/**
 * Vitest setup file
 * Mocks ora spinner to avoid console output during tests
 */
import { vi } from 'vitest';

// Mock ora to prevent spinner output during tests
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    text: '',
  })),
}));
