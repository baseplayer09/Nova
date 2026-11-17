import { randomBytes } from 'node:crypto';
import { getDatabaseClient, withUserDatabaseContext } from './database.js';
import { decryptText, encryptText, getMemoryKek } from './encryption.js';

const dataKeyLength = 32;

export async function getProfileDataKey(userId: string): Promise<Buffer> {
  const kek = getMemoryKek();
  const kekVersion = process.env.MEMORY_KEK_VERSION ?? 'v1';
  const dataKey = randomBytes(dataKeyLength);
  const wrappedKey = encryptText(dataKey.toString('base64'), kek, userId);
  const prisma = getDatabaseClient();

  const record = await withUserDatabaseContext(
    prisma,
    userId,
    (transaction) =>
      transaction.profileEncryptionKey.upsert({
        where: { profileId: userId },
        create: {
          profileId: userId,
          wrappedDataKey: wrappedKey.ciphertext,
          wrapNonce: wrappedKey.nonce,
          wrapAuthTag: wrappedKey.authTag,
          kekVersion,
        },
        update: {},
      }),
  );

  if (record.kekVersion !== kekVersion) {
    throw new Error('The profile encryption key requires a key rotation.');
  }

  const rawDataKey = Buffer.from(
    decryptText(
      {
        ciphertext: record.wrappedDataKey,
        nonce: record.wrapNonce,
        authTag: record.wrapAuthTag,
      },
      kek,
      userId,
    ),
    'base64',
  );
  if (rawDataKey.length !== dataKeyLength) {
    throw new Error('The stored profile encryption key is invalid.');
  }
  return rawDataKey;
}
