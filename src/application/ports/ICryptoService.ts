export interface EncryptedTokenPayload {
  ivHex: string;
  authTagHex: string;
  ciphertextHex: string;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export interface ICryptoService {
  encryptToken(plaintext: string): EncryptedTokenPayload;
  decryptToken(ivHex: string, authTagHex: string, ciphertextHex: string): string;
  verifyHmacSha256(rawBody: Buffer, signatureHeader: string, secret: string): boolean;
  generatePkcePair(): PkcePair;
  generateSecureNonce(lengthBytes?: number): string;
}
