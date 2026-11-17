import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const aesKeyLength = 32;
const gcmNonceLength = 12;

export type EncryptedText = {
  ciphertext: Uint8Array<ArrayBuffer>;
  nonce: Uint8Array<ArrayBuffer>;
  authTag: Uint8Array<ArrayBuffer>;
};

export function decodeMemoryKek(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey.trim(), 'base64');
  if (key.length !== aesKeyLength) {
    throw new Error('MEMORY_KEK must be a base64-encoded 32-byte key.');
  }
  return key;
}

export function getMemoryKek(): Buffer {
  const encodedKey = process.env.MEMORY_KEK;
  if (!encodedKey) {
    throw new Error('MEMORY_KEK is not configured.');
  }
  return decodeMemoryKek(encodedKey);
}

export function newDataKey(): Buffer {
  return randomBytes(aesKeyLength);
}

export function encryptText(
  plaintext: string,
  key: Buffer,
  additionalData: string,
): EncryptedText {
  validateKey(key);
  const nonce = Uint8Array.from(randomBytes(gcmNonceLength));
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(additionalData, 'utf8'));
  const ciphertext = Uint8Array.from(
    Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]),
  );
  return {
    ciphertext,
    nonce,
    authTag: Uint8Array.from(cipher.getAuthTag()),
  };
}

export function decryptText(
  encrypted: EncryptedText,
  key: Buffer,
  additionalData: string,
): string {
  validateKey(key);
  if (encrypted.nonce.length !== gcmNonceLength || encrypted.authTag.length !== 16) {
    throw new Error('Encrypted data has an invalid nonce or authentication tag.');
  }

  const decipher = createDecipheriv('aes-256-gcm', key, encrypted.nonce);
  decipher.setAAD(Buffer.from(additionalData, 'utf8'));
  decipher.setAuthTag(Buffer.from(encrypted.authTag));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext)),
    decipher.final(),
  ]).toString('utf8');
}

function validateKey(key: Buffer): void {
  if (key.length !== aesKeyLength) {
    throw new Error('AES-256-GCM requires a 32-byte key.');
  }
}
