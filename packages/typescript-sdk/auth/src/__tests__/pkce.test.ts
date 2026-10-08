import { describe, it, expect } from 'vitest';

import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
} from '../pkce';

describe('PKCE Utilities', () => {
  describe('generateCodeVerifier', () => {
    it('should generate a 43-character base64url string', () => {
      const verifier = generateCodeVerifier();
      // 32 bytes encoded as base64url = 43 characters (no padding)
      expect(verifier).toHaveLength(43);
    });

    it('should only contain base64url-safe characters', () => {
      const verifier = generateCodeVerifier();
      // Base64URL uses A-Z, a-z, 0-9, -, _
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('should generate unique values on each call', () => {
      const verifier1 = generateCodeVerifier();
      const verifier2 = generateCodeVerifier();
      const verifier3 = generateCodeVerifier();

      expect(verifier1).not.toBe(verifier2);
      expect(verifier2).not.toBe(verifier3);
      expect(verifier1).not.toBe(verifier3);
    });

    it('should not contain padding characters', () => {
      const verifier = generateCodeVerifier();
      expect(verifier).not.toContain('=');
    });

    it('should not contain standard base64 characters + or /', () => {
      // Generate multiple to increase confidence
      for (let i = 0; i < 10; i++) {
        const verifier = generateCodeVerifier();
        expect(verifier).not.toContain('+');
        expect(verifier).not.toContain('/');
      }
    });
  });

  describe('generateCodeChallenge', () => {
    it('should generate a 43-character base64url string', async () => {
      const verifier = generateCodeVerifier();
      const challenge = await generateCodeChallenge(verifier);
      // SHA-256 produces 32 bytes, which encodes to 43 base64url characters
      expect(challenge).toHaveLength(43);
    });

    it('should only contain base64url-safe characters', async () => {
      const verifier = generateCodeVerifier();
      const challenge = await generateCodeChallenge(verifier);
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('should produce the same challenge for the same verifier', async () => {
      const verifier = 'test-verifier-1234567890';
      const challenge1 = await generateCodeChallenge(verifier);
      const challenge2 = await generateCodeChallenge(verifier);
      expect(challenge1).toBe(challenge2);
    });

    it('should produce different challenges for different verifiers', async () => {
      const verifier1 = generateCodeVerifier();
      const verifier2 = generateCodeVerifier();
      const challenge1 = await generateCodeChallenge(verifier1);
      const challenge2 = await generateCodeChallenge(verifier2);
      expect(challenge1).not.toBe(challenge2);
    });

    it('should not contain padding characters', async () => {
      const verifier = generateCodeVerifier();
      const challenge = await generateCodeChallenge(verifier);
      expect(challenge).not.toContain('=');
    });

    // RFC 7636 Appendix B test vector
    it('should produce correct challenge for known test vector', async () => {
      // Using a known verifier to verify the SHA-256 implementation
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const challenge = await generateCodeChallenge(verifier);
      // This is the expected SHA-256 of the verifier, base64url encoded
      expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    });
  });

  describe('generateState', () => {
    it('should generate a 22-character base64url string', () => {
      const state = generateState();
      // 16 bytes encoded as base64url = 22 characters (no padding)
      expect(state).toHaveLength(22);
    });

    it('should only contain base64url-safe characters', () => {
      const state = generateState();
      expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('should generate unique values on each call', () => {
      const state1 = generateState();
      const state2 = generateState();
      const state3 = generateState();

      expect(state1).not.toBe(state2);
      expect(state2).not.toBe(state3);
      expect(state1).not.toBe(state3);
    });

    it('should not contain padding characters', () => {
      const state = generateState();
      expect(state).not.toContain('=');
    });
  });
});
