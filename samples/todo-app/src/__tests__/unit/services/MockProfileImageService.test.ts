import { describe, it, expect, beforeEach } from 'vitest';

import { LocalStorageService } from '../../../services/mock/LocalStorageService';
import { MockProfileImageService } from '../../../services/mock/MockProfileImageService';

describe('MockProfileImageService', () => {
  let storageService: LocalStorageService;
  let profileImageService: MockProfileImageService;

  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
    storageService = new LocalStorageService();
    profileImageService = new MockProfileImageService(storageService);
  });

  it('should validate image files correctly', () => {
    // Valid image file
    const validFile = new File(['fake image data'], 'test.jpg', {
      type: 'image/jpeg',
    });
    const validResult = profileImageService.validateImageFile(validFile);
    expect(validResult.isValid).toBe(true);
    expect(validResult.error).toBeUndefined();

    // Invalid file type
    const invalidFile = new File(['fake data'], 'test.txt', {
      type: 'text/plain',
    });
    const invalidResult = profileImageService.validateImageFile(invalidFile);
    expect(invalidResult.isValid).toBe(false);
    expect(invalidResult.error).toContain('valid image file');

    // File too large (create a fake large file)
    const largeFile = new File(['x'.repeat(3 * 1024 * 1024)], 'large.jpg', {
      type: 'image/jpeg',
    });
    const largeResult = profileImageService.validateImageFile(largeFile);
    expect(largeResult.isValid).toBe(false);
    expect(largeResult.error).toContain('2MB');
  });

  it('should return default avatar', () => {
    const defaultAvatar = profileImageService.getDefaultAvatar();
    expect(defaultAvatar).toContain('data:image/svg+xml;base64,');
  });

  it('should return null for non-existent user profile image', async () => {
    const result =
      await profileImageService.getProfileImage('non-existent-user');
    expect(result).toBeNull();
  });

  // deleteProfileImage behavior removed; deletion via profile image service is no longer supported

  it('should upload and retrieve profile image (mock)', async () => {
    const userId = 'test-user-123';
    const file = new File(['fake image data'], 'test.jpg', {
      type: 'image/jpeg',
    });

    // Upload image
    const imageUrl = await profileImageService.uploadProfileImage(userId, file);
    expect(imageUrl).toContain('data:image/jpeg;base64,');

    // Retrieve image
    const retrievedUrl = await profileImageService.getProfileImage(userId);
    expect(retrievedUrl).toBe(imageUrl);

    // Deletion no longer supported; ensure latest image remains retrievable
    const stillThere = await profileImageService.getProfileImage(userId);
    expect(stillThere).toBe(imageUrl);
  });
});
