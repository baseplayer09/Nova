import { randomUUID } from 'node:crypto';
import { getDatabaseClient, withUserDatabaseContext } from './database.js';
import { decryptText, encryptText } from './encryption.js';
import { getProfileDataKey } from './profile-key.js';

const maxMemoryLength = 2_000;

export type MemoryItem = {
  id: string;
  category: string;
  text: string;
  createdAt: Date;
  approvedAt: Date | null;
};

export type MemoryProposalResult =
  | { status: 'none' }
  | { status: 'blocked'; reason: string }
  | { status: 'pending'; proposal: MemoryItem };

export class MemoryServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'MemoryServiceError';
  }
}

export function extractMemoryCandidate(message: unknown): string | null {
  if (typeof message !== 'string') {
    return null;
  }

  const text = message.trim();
  const intentPattern =
    /^(?:please\s+)?(?:remember(?:\s+(?:that|this))?|(?:please\s+)?don't\s+forget(?:\s+that)?)[\s,:-]+(.+)$/i;
  const match = text.match(intentPattern);
  if (!match) {
    return null;
  }

  const candidate = match[1].trim();
  if (!candidate || /^to\s/i.test(candidate)) {
    return null;
  }
  return candidate;
}

export function isSensitiveMemoryContent(text: string): boolean {
  return (
    /\b(?:passwords?|passcodes?|passphrases?|pins?|security codes?|cvv|cvc|api keys?|access tokens?|private keys?|secrets?)\b/i.test(
      text,
    ) ||
    /\b(?:ssn|social security|passport|national id|government id|driver'?s license|state id|tax id|taxpayer id)\b/i.test(
      text,
    ) ||
    /\b(?:id|identification)\s*(?:number|no\.?|#)?\s*(?:is|:)?\s*[\da-z-]{6,}\b/i.test(
      text,
    ) ||
    /\d(?:[\s.-]*\d){12,18}/.test(text) ||
    /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/.test(text)
  );
}

function memoryAdditionalData(profileId: string, memoryId: string): string {
  return `memory:${profileId}:${memoryId}`;
}

function memoryCategory(text: string): string {
  return /\b(prefer|like|love|hate|favorite|favourite)\b/i.test(text)
    ? 'preference'
    : 'fact';
}

export class MemoryService {
  async proposeFromText(
    profileId: string,
    message: unknown,
  ): Promise<MemoryProposalResult> {
    const candidate = extractMemoryCandidate(message);
    if (candidate === null) {
      return { status: 'none' };
    }
    if (candidate.length > maxMemoryLength) {
      return {
        status: 'blocked',
        reason: 'That memory is too long to save. Keep it under 2,000 characters.',
      };
    }
    if (isSensitiveMemoryContent(candidate)) {
      return {
        status: 'blocked',
        reason:
          "I can't save passwords, PINs, payment details, or government ID information as memories.",
      };
    }

    const id = randomUUID();
    const category = memoryCategory(candidate);
    const createdAt = new Date();
    const dataKey = await getProfileDataKey(profileId);
    const encrypted = encryptText(
      candidate,
      dataKey,
      memoryAdditionalData(profileId, id),
    );
    const prisma = getDatabaseClient();

    await withUserDatabaseContext(prisma, profileId, (transaction) =>
      transaction.memory.create({
        data: {
          id,
          profileId,
          category,
          status: 'pending',
          ciphertext: encrypted.ciphertext,
          nonce: encrypted.nonce,
          authTag: encrypted.authTag,
          createdAt,
        },
      }),
    );

    return {
      status: 'pending',
      proposal: {
        id,
        category,
        text: candidate,
        createdAt,
        approvedAt: null,
      },
    };
  }

  async listPending(profileId: string): Promise<MemoryItem[]> {
    const dataKey = await getProfileDataKey(profileId);
    const prisma = getDatabaseClient();
    const records = await withUserDatabaseContext(prisma, profileId, (transaction) =>
      transaction.memory.findMany({
        where: { profileId, status: 'pending' },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return records.map((record) => this.decryptRecord(profileId, record, dataKey));
  }

  async listApproved(profileId: string, search = ''): Promise<MemoryItem[]> {
    if (search.length > 100) {
      throw new MemoryServiceError('Search text must be 100 characters or fewer.', 400);
    }
    const dataKey = await getProfileDataKey(profileId);
    const prisma = getDatabaseClient();
    const records = await withUserDatabaseContext(prisma, profileId, (transaction) =>
      transaction.memory.findMany({
        where: { profileId, status: 'approved' },
        orderBy: { createdAt: 'desc' },
      }),
    );
    const normalizedSearch = search.trim().toLocaleLowerCase();
    return records
      .map((record) => this.decryptRecord(profileId, record, dataKey))
      .filter((record) =>
        normalizedSearch
          ? record.text.toLocaleLowerCase().includes(normalizedSearch)
          : true,
      );
  }

  async approve(profileId: string, memoryId: string): Promise<MemoryItem> {
    const dataKey = await getProfileDataKey(profileId);
    const prisma = getDatabaseClient();
    const memory = await withUserDatabaseContext(
      prisma,
      profileId,
      async (transaction) => {
        const result = await transaction.memory.updateMany({
          where: { id: memoryId, profileId, status: 'pending' },
          data: { status: 'approved', approvedAt: new Date() },
        });
        if (result.count !== 1) {
          throw new MemoryServiceError('Memory proposal not found.', 404);
        }
        return transaction.memory.findFirst({
          where: { id: memoryId, profileId, status: 'approved' },
        });
      },
    );
    if (!memory) {
      throw new MemoryServiceError('Approved memory could not be loaded.', 500);
    }
    return this.decryptRecord(profileId, memory, dataKey);
  }

  async decline(profileId: string, memoryId: string): Promise<void> {
    const prisma = getDatabaseClient();
    const result = await withUserDatabaseContext(prisma, profileId, (transaction) =>
      transaction.memory.deleteMany({
        where: { id: memoryId, profileId, status: 'pending' },
      }),
    );
    if (result.count !== 1) {
      throw new MemoryServiceError('Memory proposal not found.', 404);
    }
  }

  async deleteApproved(profileId: string, memoryId: string): Promise<void> {
    const prisma = getDatabaseClient();
    const result = await withUserDatabaseContext(prisma, profileId, (transaction) =>
      transaction.memory.deleteMany({
        where: { id: memoryId, profileId, status: 'approved' },
      }),
    );
    if (result.count !== 1) {
      throw new MemoryServiceError('Saved memory not found.', 404);
    }
  }

  private decryptRecord(
    profileId: string,
    record: {
      id: string;
      category: string;
      ciphertext: Uint8Array<ArrayBuffer>;
      nonce: Uint8Array<ArrayBuffer>;
      authTag: Uint8Array<ArrayBuffer>;
      createdAt: Date;
      approvedAt: Date | null;
    },
    dataKey: Buffer,
  ): MemoryItem {
    return {
      id: record.id,
      category: record.category,
      text: decryptText(
        {
          ciphertext: record.ciphertext,
          nonce: record.nonce,
          authTag: record.authTag,
        },
        dataKey,
        memoryAdditionalData(profileId, record.id),
      ),
      createdAt: record.createdAt,
      approvedAt: record.approvedAt,
    };
  }
}
