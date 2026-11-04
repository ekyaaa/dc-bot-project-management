import crypto from 'node:crypto';
import type {
  ICryptoService,
  EncryptedTokenPayload,
  PkcePair,
} from '../../application/ports/ICryptoService.js';

export { EncryptedTokenPayload, PkcePair };

export class CryptoError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'CryptoError';
  }
}

export class CryptoService implements ICryptoService {
  private readonly encryptionKey: Buffer;

  /**
   * @param rawKey 32-byte Buffer, or 64-character hex string, or 32-character utf-8 string.
   */
  constructor(rawKey: Buffer | string) {
    if (Buffer.isBuffer(rawKey)) {
      if (rawKey.length !== 32) {
        throw new CryptoError(`Token encryption key must be exactly 32 bytes (got ${rawKey.length} bytes).`);
      }
      this.encryptionKey = rawKey;
    } else if (typeof rawKey === 'string') {
      const trimmed = rawKey.trim();
      if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        this.encryptionKey = Buffer.from(trimmed, 'hex');
      } else if (Buffer.byteLength(trimmed, 'utf8') === 32) {
        this.encryptionKey = Buffer.from(trimmed, 'utf8');
      } else {
        throw new CryptoError(
          `Token encryption key string must be 64 hex characters or 32 UTF-8 bytes (got length ${trimmed.length}).`,
        );
      }
    } else {
      throw new CryptoError('Token encryption key must be a Buffer or string.');
    }
  }

  /**
   * Encrypts plaintext token using AES-256-GCM.
   * Generates a unique 12-byte IV per invocation and extracts a 16-byte auth tag.
   */
  public encryptToken(plaintext: string): EncryptedTokenPayload {
    if (typeof plaintext !== 'string') {
      throw new CryptoError('Plaintext token must be a string.');
    }

    try {
      const iv = crypto.randomBytes(12); // Standard 96-bit nonce for AES-GCM
      const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);

      let ciphertextHex = cipher.update(plaintext, 'utf8', 'hex');
      ciphertextHex += cipher.final('hex');

      const authTag = cipher.getAuthTag(); // 16 bytes (128 bits)

      return {
        ivHex: iv.toString('hex'),
        authTagHex: authTag.toString('hex'),
        ciphertextHex,
      };
    } catch (error) {
      throw new CryptoError('Failed to encrypt token.', error);
    }
  }

  /**
   * Decrypts ciphertext using AES-256-GCM.
   * Verifies the 16-byte auth tag in constant time; throws CryptoError if tampered.
   */
  public decryptToken(ivHex: string, authTagHex: string, ciphertextHex: string): string {
    if (!ivHex || !authTagHex || !ciphertextHex) {
      throw new CryptoError('Missing required decryption parameters (iv, authTag, ciphertext).');
    }

    // Validate parameter lengths and hex format
    if (ivHex.length !== 24 || !/^[0-9a-fA-F]{24}$/.test(ivHex)) {
      throw new CryptoError('Invalid IV length or format: must be 24 hex characters (12 bytes).');
    }
    if (authTagHex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(authTagHex)) {
      throw new CryptoError('Invalid auth tag length or format: must be 32 hex characters (16 bytes).');
    }
    if (!/^[0-9a-fA-F]*$/.test(ciphertextHex)) {
      throw new CryptoError('Invalid ciphertext format: must be valid hex.');
    }

    try {
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);

      decipher.setAuthTag(authTag);

      let plaintext = decipher.update(ciphertextHex, 'hex', 'utf8');
      plaintext += decipher.final('utf8');

      return plaintext;
    } catch (error) {
      // OpenSSL raises "Unsupported state or unable to authenticate data" on tampering
      throw new CryptoError('Decryption failed: authentication tag mismatch or corrupted ciphertext.', error);
    }
  }

  /**
   * Verifies GitHub X-Hub-Signature-256 in constant time.
   * Guarantees safe comparison without leaking timing data or raising exceptions on malformed input.
   */
  public verifyHmacSha256(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
    if (!Buffer.isBuffer(rawBody)) {
      return false;
    }
    if (typeof signatureHeader !== 'string' || typeof secret !== 'string') {
      return false;
    }
    if (!signatureHeader.startsWith('sha256=')) {
      return false;
    }

    const providedHex = signatureHeader.slice(7).trim();
    if (providedHex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(providedHex)) {
      return false;
    }

    try {
      const expectedHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

      const bufProvided = Buffer.from(providedHex, 'hex');
      const bufExpected = Buffer.from(expectedHex, 'hex');

      // Crucial: timingSafeEqual throws RangeError if buffer lengths differ
      if (bufProvided.length !== 32 || bufExpected.length !== 32) {
        return false;
      }

      return crypto.timingSafeEqual(bufProvided, bufExpected);
    } catch {
      return false;
    }
  }

  /**
   * Generates RFC 7636 PKCE pair:
   * - verifier: 32 random bytes encoded as base64url (43 characters)
   * - challenge: SHA-256 hash of verifier encoded as base64url
   */
  public generatePkcePair(): PkcePair {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
  }

  /**
   * Generates a cryptographically secure random hexadecimal nonce.
   * Default lengthBytes is 32 (producing a 64-hex-character string).
   */
  public generateSecureNonce(lengthBytes: number = 32): string {
    const bytes = Math.max(16, Math.min(lengthBytes, 128));
    return crypto.randomBytes(bytes).toString('hex');
  }

  /**
   * Helper to serialize EncryptedTokenPayload into a single DB string: ivHex:authTagHex:ciphertextHex
   */
  public static serialize(payload: EncryptedTokenPayload): string {
    return `${payload.ivHex}:${payload.authTagHex}:${payload.ciphertextHex}`;
  }

  /**
   * Helper to deserialize a single DB string back into EncryptedTokenPayload.
   */
  public static deserialize(serialized: string): EncryptedTokenPayload {
    const parts = serialized.split(':');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      throw new CryptoError('Malformed encrypted token string format.');
    }
    return {
      ivHex: parts[0],
      authTagHex: parts[1],
      ciphertextHex: parts[2],
    };
  }
}
