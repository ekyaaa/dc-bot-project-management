import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { CryptoService, CryptoError } from '../../src/infrastructure/crypto/crypto.js';

describe('Crypto Layer: AES-256-GCM, Constant-Time HMAC, and PKCE', () => {
  const validHexKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const validBufferKey = Buffer.from(validHexKey, 'hex');
  const validUtf8Key = '12345678901234567890123456789012'; // exactly 32 bytes

  describe('Key Validation & Construction', () => {
    it('initializes with valid 64-hex key, 32-byte Buffer, and 32-byte UTF8 string', () => {
      expect(() => new CryptoService(validHexKey)).not.toThrow();
      expect(() => new CryptoService(validBufferKey)).not.toThrow();
      expect(() => new CryptoService(validUtf8Key)).not.toThrow();
    });

    it('rejects keys with invalid lengths or types', () => {
      expect(() => new CryptoService('short-key')).toThrow(CryptoError);
      expect(() => new CryptoService(Buffer.alloc(16))).toThrow(CryptoError);
      expect(() => new CryptoService('z'.repeat(64))).toThrow(CryptoError);
      expect(() => new CryptoService(12345 as unknown as string)).toThrow(CryptoError);
    });
  });

  describe('AES-256-GCM Token Encryption & Decryption', () => {
    const service = new CryptoService(validHexKey);

    it('encrypts and decrypts OAuth tokens reliably with exact match', () => {
      const plaintext = 'gho_16DigitsAndLettersUserTokenExample_XYZ123';
      const encrypted = service.encryptToken(plaintext);

      expect(encrypted.ivHex).toHaveLength(24); // 12 bytes
      expect(encrypted.authTagHex).toHaveLength(32); // 16 bytes
      expect(encrypted.ciphertextHex.length).toBeGreaterThan(0);

      const decrypted = service.decryptToken(
        encrypted.ivHex,
        encrypted.authTagHex,
        encrypted.ciphertextHex,
      );
      expect(decrypted).toBe(plaintext);
    });

    it('ensures distinct IV and ciphertext for identical plaintexts across invocations', () => {
      const plaintext = 'constant-user-token';
      const enc1 = service.encryptToken(plaintext);
      const enc2 = service.encryptToken(plaintext);

      expect(enc1.ivHex).not.toBe(enc2.ivHex);
      expect(enc1.ciphertextHex).not.toBe(enc2.ciphertextHex);

      expect(service.decryptToken(enc1.ivHex, enc1.authTagHex, enc1.ciphertextHex)).toBe(plaintext);
      expect(service.decryptToken(enc2.ivHex, enc2.authTagHex, enc2.ciphertextHex)).toBe(plaintext);
    });

    it('detects tampering and throws CryptoError on corrupted ciphertext', () => {
      const encrypted = service.encryptToken('my-secret-token');
      // Flip last character in ciphertext hex
      const corruptedCipher =
        encrypted.ciphertextHex.slice(0, -1) +
        (encrypted.ciphertextHex.endsWith('a') ? 'b' : 'a');

      expect(() =>
        service.decryptToken(encrypted.ivHex, encrypted.authTagHex, corruptedCipher),
      ).toThrow(CryptoError);
      expect(() =>
        service.decryptToken(encrypted.ivHex, encrypted.authTagHex, corruptedCipher),
      ).toThrow(/authentication tag mismatch or corrupted ciphertext/);
    });

    it('detects tampering on corrupted auth tag', () => {
      const encrypted = service.encryptToken('my-secret-token');
      const corruptedTag =
        encrypted.authTagHex.slice(0, -1) + (encrypted.authTagHex.endsWith('a') ? 'b' : 'a');

      expect(() =>
        service.decryptToken(encrypted.ivHex, corruptedTag, encrypted.ciphertextHex),
      ).toThrow(CryptoError);
    });

    it('detects tampering on corrupted IV', () => {
      const encrypted = service.encryptToken('my-secret-token');
      const corruptedIv =
        encrypted.ivHex.slice(0, -1) + (encrypted.ivHex.endsWith('a') ? 'b' : 'a');

      expect(() =>
        service.decryptToken(corruptedIv, encrypted.authTagHex, encrypted.ciphertextHex),
      ).toThrow(CryptoError);
    });

    it('fails decryption when attempted with a different encryption key', () => {
      const otherKey = crypto.randomBytes(32).toString('hex');
      const otherService = new CryptoService(otherKey);

      const encrypted = service.encryptToken('original-secret');
      expect(() =>
        otherService.decryptToken(
          encrypted.ivHex,
          encrypted.authTagHex,
          encrypted.ciphertextHex,
        ),
      ).toThrow(CryptoError);
    });

    it('serializes and deserializes payloads for storage cleanly', () => {
      const payload = {
        ivHex: 'a'.repeat(24),
        authTagHex: 'b'.repeat(32),
        ciphertextHex: 'c'.repeat(40),
      };

      const serialized = CryptoService.serialize(payload);
      expect(serialized).toBe(`${payload.ivHex}:${payload.authTagHex}:${payload.ciphertextHex}`);

      const deserialized = CryptoService.deserialize(serialized);
      expect(deserialized).toEqual(payload);

      expect(() => CryptoService.deserialize('invalid:format')).toThrow(CryptoError);
    });
  });

  describe('Constant-Time HMAC SHA-256 Webhook Verification', () => {
    const service = new CryptoService(validHexKey);
    const webhookSecret = 'wh_secret_super_secure_987654';
    const rawPayload = Buffer.from(JSON.stringify({ action: 'opened', issue: { number: 42 } }));

    const validSignature =
      'sha256=' +
      crypto.createHmac('sha256', webhookSecret).update(rawPayload).digest('hex');

    it('verifies genuine HMAC signatures accurately', () => {
      expect(service.verifyHmacSha256(rawPayload, validSignature, webhookSecret)).toBe(true);
    });

    it('rejects tampered payloads', () => {
      const tamperedPayload = Buffer.from(
        JSON.stringify({ action: 'opened', issue: { number: 43 } }),
      );
      expect(service.verifyHmacSha256(tamperedPayload, validSignature, webhookSecret)).toBe(false);
    });

    it('rejects incorrect webhook secret', () => {
      expect(service.verifyHmacSha256(rawPayload, validSignature, 'wrong_secret')).toBe(false);
    });

    it('rejects headers with missing sha256= prefix', () => {
      const bareHash = validSignature.slice(7);
      expect(service.verifyHmacSha256(rawPayload, bareHash, webhookSecret)).toBe(false);
    });

    it('rejects truncated, oversized, or malformed signature headers safely without exceptions', () => {
      expect(service.verifyHmacSha256(rawPayload, 'sha256=short', webhookSecret)).toBe(false);
      expect(service.verifyHmacSha256(rawPayload, 'sha256=' + 'a'.repeat(65), webhookSecret)).toBe(false);
      expect(service.verifyHmacSha256(rawPayload, 'sha256=' + 'z'.repeat(64), webhookSecret)).toBe(false);
      expect(service.verifyHmacSha256(rawPayload, '', webhookSecret)).toBe(false);
      expect(service.verifyHmacSha256('not-a-buffer' as unknown as Buffer, validSignature, webhookSecret)).toBe(false);
    });
  });

  describe('PKCE S256 Pair & Secure Nonce Generation', () => {
    const service = new CryptoService(validHexKey);

    it('generates compliant RFC 7636 S256 PKCE pair', () => {
      const { verifier, challenge } = service.generatePkcePair();

      expect(verifier).toHaveLength(43); // 32 bytes base64url = 43 chars
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);

      const expectedChallenge = crypto
        .createHash('sha256')
        .update(verifier)
        .digest('base64url');
      expect(challenge).toBe(expectedChallenge);
    });

    it('generates secure random nonces with zero collisions', () => {
      const nonces = new Set<string>();
      const iterations = 100;

      for (let i = 0; i < iterations; i++) {
        const nonce = service.generateSecureNonce();
        expect(nonce).toHaveLength(64); // 32 bytes hex = 64 chars
        expect(nonce).toMatch(/^[0-9a-f]{64}$/);
        nonces.add(nonce);
      }

      expect(nonces.size).toBe(iterations);
    });
  });
});
