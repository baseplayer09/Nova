import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  decodeMemoryKek,
  decryptText,
  encryptText,
  newDataKey,
} from './encryption.js';

test('AES-256-GCM encrypts and decrypts UTF-8 text with associated data', () => {
  const key = newDataKey();
  const aad = 'profile:conversation:message';
  const plaintext = 'Keep my preferences private. Привет.';
  const encrypted = encryptText(plaintext, key, aad);

  assert.notEqual(Buffer.from(encrypted.ciphertext).toString('utf8'), plaintext);
  assert.equal(decryptText(encrypted, key, aad), plaintext);
});

test('AES-256-GCM rejects ciphertext moved to another record or altered', () => {
  const key = newDataKey();
  const encrypted = encryptText('private text', key, 'profile-a:memory-1');

  assert.throws(
    () => decryptText(encrypted, key, 'profile-b:memory-1'),
    /Unsupported state|auth/i,
  );
  assert.throws(
    () =>
      decryptText(
        {
          ...encrypted,
          ciphertext: Uint8Array.from([...encrypted.ciphertext, 1]),
        },
        key,
        'profile-a:memory-1',
      ),
    /Unsupported state|auth/i,
  );
});

test('the memory KEK decoder accepts exactly 32-byte base64 keys', () => {
  const encoded = randomBytes(32).toString('base64');
  assert.equal(decodeMemoryKek(encoded).length, 32);
  assert.throws(() => decodeMemoryKek('not-a-32-byte-key'), /32-byte key/);
});
