import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../generated/prisma/client.js';

export type ProfileSummary = {
  id: string;
  displayName: string | null;
  createdAt: Date;
};

export interface RlsTransaction {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let prismaClient: PrismaClient | undefined;

export async function setUserRlsContext(
  transaction: RlsTransaction,
  userId: string,
): Promise<void> {
  if (!uuidPattern.test(userId)) {
    throw new Error('A valid Supabase user ID is required for database access.');
  }

  const claims = JSON.stringify({
    sub: userId,
    role: 'authenticated',
    aud: 'authenticated',
  });

  await transaction.$queryRaw`
    SELECT set_config('request.jwt.claim.sub', ${userId}, true)
  `;
  await transaction.$queryRaw`
    SELECT set_config('request.jwt.claims', ${claims}, true)
  `;
  await transaction.$executeRaw`SET LOCAL ROLE nova_app`;
}

export async function withUserDatabaseContext<T>(
  prisma: PrismaClient,
  userId: string,
  work: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (transaction) => {
    await setUserRlsContext(transaction, userId);
    return work(transaction);
  });
}

export function getDatabaseClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not configured.');
  }

  prismaClient ??= new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  return prismaClient;
}

export async function getProfileForUser(userId: string): Promise<ProfileSummary | null> {
  const prisma = getDatabaseClient();
  return withUserDatabaseContext(prisma, userId, (transaction) =>
    transaction.profile.findUnique({
      where: { id: userId },
      select: { id: true, displayName: true, createdAt: true },
    }),
  );
}
