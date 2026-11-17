import { createHmac, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { getDatabaseClient, withUserDatabaseContext } from './database.js';

const pinPattern = /^\d{6}$/;
const maxFailedAttempts = 5;
const lockoutDurationMs = 15 * 60 * 1000;
const unlockTokenLifetimeMs = 15 * 60 * 1000;
const unlockTokenVersion = 1;
const userIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PinCredentialRecord = {
  pin_hash: string;
  failed_attempts: number;
  locked_until: Date | null;
};

export type PinVerificationResult =
  | { status: 'verified'; unlockToken: string }
  | { status: 'invalid'; attemptsRemaining: number }
  | { status: 'locked'; retryAfterMs: number }
  | { status: 'not-configured' };

export class PinAlreadyConfiguredError extends Error {
  constructor() {
    super('A PIN is already configured for this profile.');
    this.name = 'PinAlreadyConfiguredError';
  }
}

export function isValidPin(pin: unknown): pin is string {
  return typeof pin === 'string' && pinPattern.test(pin);
}

export function createPinUnlockToken(
  userId: string,
  pepper: string,
  now: number,
): string {
  if (!userIdPattern.test(userId)) {
    throw new Error('A valid user ID is required to create an unlock session.');
  }
  const payload = Buffer.from(
    JSON.stringify({
      version: unlockTokenVersion,
      userId,
      issuedAt: now,
      expiresAt: now + unlockTokenLifetimeMs,
    }),
  ).toString('base64url');
  const signature = signUnlockPayload(payload, pepper);
  return `${payload}.${signature}`;
}

export function isPinUnlockTokenValid(
  userId: string,
  token: string,
  pepper: string,
  now: number,
): boolean {
  if (!userIdPattern.test(userId) || token.length > 2048) {
    return false;
  }

  const [payload, encodedSignature, ...extraParts] = token.split('.');
  if (!payload || !encodedSignature || extraParts.length > 0) {
    return false;
  }

  const suppliedSignature = Buffer.from(encodedSignature, 'base64url');
  const expectedSignature = Buffer.from(
    signUnlockPayload(payload, pepper),
    'base64url',
  );
  if (
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    return false;
  }

  let claims: {
    version?: unknown;
    userId?: unknown;
    issuedAt?: unknown;
    expiresAt?: unknown;
  };
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      return false;
    }
    throw error;
  }

  return (
    claims.version === unlockTokenVersion &&
    claims.userId === userId &&
    typeof claims.issuedAt === 'number' &&
    typeof claims.expiresAt === 'number' &&
    claims.issuedAt <= now &&
    claims.expiresAt > now &&
    claims.expiresAt - claims.issuedAt === unlockTokenLifetimeMs
  );
}

function signUnlockPayload(payload: string, pepper: string): string {
  const key = createHmac('sha256', 'NOVA_PIN_UNLOCK_V1').update(pepper).digest();
  return createHmac('sha256', key).update(payload).digest('base64url');
}

export function nextFailedPinAttempt(
  previousAttempts: number,
  now: number,
): {
  failedAttempts: number;
  lockedUntil: Date | null;
  result: Extract<PinVerificationResult, { status: 'invalid' | 'locked' }>;
} {
  const failedAttempts = previousAttempts + 1;
  if (failedAttempts >= maxFailedAttempts) {
    return {
      failedAttempts,
      lockedUntil: new Date(now + lockoutDurationMs),
      result: { status: 'locked', retryAfterMs: lockoutDurationMs },
    };
  }

  return {
    failedAttempts,
    lockedUntil: null,
    result: {
      status: 'invalid',
      attemptsRemaining: maxFailedAttempts - failedAttempts,
    },
  };
}

function getPinPepper(): string {
  const pepper = process.env.PIN_PEPPER;
  if (!pepper || pepper.length < 32) {
    throw new Error('PIN_PEPPER must be configured with at least 32 characters.');
  }
  return pepper;
}

function credentialExistsError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

export class PinService {
  constructor(
    private readonly getClient: () => PrismaClient = getDatabaseClient,
    private readonly getPepper: () => string = getPinPepper,
    private readonly now: () => number = Date.now,
  ) {}

  async getStatus(userId: string): Promise<{ configured: boolean }> {
    const prisma = this.getClient();
    return withUserDatabaseContext(prisma, userId, async (transaction) => {
      const credential = await transaction.pinCredential.findUnique({
        where: { profileId: userId },
        select: { profileId: true },
      });
      return { configured: credential !== null };
    });
  }

  async setup(userId: string, pin: string): Promise<string> {
    if (!isValidPin(pin)) {
      throw new TypeError('PIN must contain exactly six digits.');
    }

    const hash = await argon2.hash(`${pin}${this.getPepper()}`, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    const prisma = this.getClient();

    try {
      await withUserDatabaseContext(prisma, userId, async (transaction) => {
        await transaction.pinCredential.create({
          data: { profileId: userId, pinHash: hash },
        });
      });
    } catch (error) {
      if (credentialExistsError(error)) {
        throw new PinAlreadyConfiguredError();
      }
      throw error;
    }

    const verification = await this.verify(userId, pin);
    if (verification.status !== 'verified') {
      throw new Error('The newly created PIN could not be verified.');
    }
    return verification.unlockToken;
  }

  async verify(userId: string, pin: string): Promise<PinVerificationResult> {
    if (!isValidPin(pin)) {
      throw new TypeError('PIN must contain exactly six digits.');
    }

    const prisma = this.getClient();
    const pepper = this.getPepper();

    return withUserDatabaseContext(prisma, userId, async (transaction) => {
      const credentials = await transaction.$queryRaw<PinCredentialRecord[]>`
        SELECT pin_hash, failed_attempts, locked_until
        FROM public.pin_credentials
        WHERE profile_id = ${userId}::uuid
        FOR UPDATE
      `;
      const credential = credentials[0];
      if (!credential) {
        return { status: 'not-configured' };
      }

      const now = this.now();
      if (credential.locked_until && credential.locked_until.getTime() > now) {
        return {
          status: 'locked',
          retryAfterMs: credential.locked_until.getTime() - now,
        };
      }

      const previousAttempts =
        credential.locked_until && credential.locked_until.getTime() <= now
          ? 0
          : credential.failed_attempts;
      const isCorrect = await argon2.verify(
        credential.pin_hash,
        `${pin}${pepper}`,
      );

      if (isCorrect) {
        await transaction.pinCredential.update({
          where: { profileId: userId },
          data: { failedAttempts: 0, lockedUntil: null },
        });
        return {
          status: 'verified',
          unlockToken: createPinUnlockToken(userId, pepper, now),
        };
      }

      const failedAttempt = nextFailedPinAttempt(previousAttempts, now);

      await transaction.pinCredential.update({
        where: { profileId: userId },
        data: {
          failedAttempts: failedAttempt.failedAttempts,
          lockedUntil: failedAttempt.lockedUntil,
        },
      });

      return failedAttempt.result;
    });
  }

  refreshUnlockToken(userId: string, token: unknown): string | null {
    if (typeof token !== 'string') {
      return null;
    }

    const pepper = this.getPepper();
    const now = this.now();
    if (!isPinUnlockTokenValid(userId, token, pepper, now)) {
      return null;
    }
    return createPinUnlockToken(userId, pepper, now);
  }
}
