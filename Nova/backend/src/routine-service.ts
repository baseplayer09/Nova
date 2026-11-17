import { randomUUID } from 'node:crypto';
import { getDatabaseClient, withUserDatabaseContext } from './database.js';
import { decryptText, encryptText } from './encryption.js';
import { getProfileDataKey } from './profile-key.js';
import { ChatService } from './chat-service.js';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
const dayValues = new Set([1, 2, 3, 4, 5, 6, 7]);

type RoutineSchedule = {
  timezone: string;
  localTime: string;
  scheduleDays: number[];
};

type RoutineRecord = {
  id: string;
  promptCiphertext: Uint8Array<ArrayBuffer>;
  promptNonce: Uint8Array<ArrayBuffer>;
  promptAuthTag: Uint8Array<ArrayBuffer>;
};

export class RoutineServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'RoutineServiceError';
  }
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) {
      return false;
    }
    throw error;
  }
}

function zonedParts(
  date: Date,
  timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, Number(part.value)]));
  return {
    year: values.get('year')!,
    month: values.get('month')!,
    day: values.get('day')!,
    hour: values.get('hour')!,
    minute: values.get('minute')!,
  };
}

function localDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date | null {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const actual = zonedParts(new Date(guess), timezone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    );
    const difference = target - actualAsUtc;
    if (difference === 0) {
      return new Date(guess);
    }
    guess += difference;
  }
  return null;
}

export function nextRoutineRunAt(
  schedule: RoutineSchedule,
  now: Date,
): Date {
  const time = timePattern.exec(schedule.localTime);
  if (
    !time ||
    schedule.scheduleDays.length === 0 ||
    schedule.scheduleDays.some((day) => !dayValues.has(day)) ||
    new Set(schedule.scheduleDays).size !== schedule.scheduleDays.length ||
    !isValidTimezone(schedule.timezone)
  ) {
    throw new RoutineServiceError('The routine schedule is invalid.', 400);
  }

  const localNow = zonedParts(now, schedule.timezone);
  const start = Date.UTC(localNow.year, localNow.month - 1, localNow.day);
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  for (let offset = 0; offset <= 14; offset += 1) {
    const date = new Date(start + offset * 24 * 60 * 60 * 1000);
    const weekday = date.getUTCDay() || 7;
    if (!schedule.scheduleDays.includes(weekday)) {
      continue;
    }
    const candidate = localDateTimeToUtc(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      hour,
      minute,
      schedule.timezone,
    );
    if (candidate && candidate.getTime() > now.getTime()) {
      return candidate;
    }
  }
  throw new RoutineServiceError('Could not calculate the next routine run.', 400);
}

function promptAdditionalData(profileId: string, routineId: string): string {
  return `routine:${profileId}:${routineId}:prompt`;
}

export class RoutineService {
  constructor(
    private readonly chatService: Pick<ChatService, 'sendMessage'> =
      new ChatService(),
  ) {}

  async list(profileId: string) {
    const prisma = getDatabaseClient();
    return withUserDatabaseContext(prisma, profileId, (transaction) =>
      transaction.routine.findMany({
        where: { profileId },
        select: {
          id: true,
          title: true,
          timezone: true,
          localTime: true,
          scheduleDays: true,
          nextRunAt: true,
          enabled: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
  }

  async create(
    profileId: string,
    input: {
      title: unknown;
      prompt: unknown;
      timezone: unknown;
      localTime: unknown;
      scheduleDays: unknown;
    },
  ) {
    if (
      typeof input.title !== 'string' ||
      typeof input.prompt !== 'string' ||
      typeof input.timezone !== 'string' ||
      typeof input.localTime !== 'string' ||
      !Array.isArray(input.scheduleDays) ||
      !input.scheduleDays.every(
        (day: unknown): day is number => Number.isInteger(day),
      )
    ) {
      throw new RoutineServiceError('Routine details are invalid.', 400);
    }
    const title = input.title.trim();
    const prompt = input.prompt.trim();
    const schedule = {
      timezone: input.timezone,
      localTime: input.localTime,
      scheduleDays: input.scheduleDays,
    };
    if (!title || title.length > 80 || !prompt || prompt.length > 2000) {
      throw new RoutineServiceError(
        'Routine names must be 1–80 characters and instructions 1–2000 characters.',
        400,
      );
    }
    const nextRunAt = nextRoutineRunAt(schedule, new Date());
    const id = randomUUID();
    const key = await getProfileDataKey(profileId);
    const encryptedPrompt = encryptText(
      prompt,
      key,
      promptAdditionalData(profileId, id),
    );
    const prisma = getDatabaseClient();
    return withUserDatabaseContext(prisma, profileId, async (transaction) => {
      const routineCount = await transaction.routine.count({
        where: { profileId },
      });
      if (routineCount >= 50) {
        throw new RoutineServiceError(
          'A profile can have at most 50 routines.',
          409,
        );
      }
      return transaction.routine.create({
        data: {
          id,
          profileId,
          title,
          promptCiphertext: encryptedPrompt.ciphertext,
          promptNonce: encryptedPrompt.nonce,
          promptAuthTag: encryptedPrompt.authTag,
          timezone: schedule.timezone,
          localTime: schedule.localTime,
          scheduleDays: schedule.scheduleDays,
          nextRunAt,
        },
        select: {
          id: true,
          title: true,
          timezone: true,
          localTime: true,
          scheduleDays: true,
          nextRunAt: true,
          enabled: true,
          createdAt: true,
        },
      });
    });
  }

  async setEnabled(profileId: string, routineId: string, enabled: boolean) {
    if (!uuidPattern.test(routineId)) {
      throw new RoutineServiceError('The routine ID is invalid.', 400);
    }
    const prisma = getDatabaseClient();
    return withUserDatabaseContext(prisma, profileId, async (transaction) => {
      const routine = await transaction.routine.findFirst({
        where: { id: routineId, profileId },
        select: { id: true, timezone: true, localTime: true, scheduleDays: true },
      });
      if (!routine) {
        throw new RoutineServiceError('Routine not found.', 404);
      }
      const nextRunAt = enabled
        ? nextRoutineRunAt(routine, new Date())
        : null;
      return transaction.routine.update({
        where: { id: routineId },
        data: { enabled, nextRunAt, updatedAt: new Date() },
        select: {
          id: true,
          title: true,
          timezone: true,
          localTime: true,
          scheduleDays: true,
          nextRunAt: true,
          enabled: true,
          createdAt: true,
        },
      });
    });
  }

  async delete(profileId: string, routineId: string): Promise<void> {
    if (!uuidPattern.test(routineId)) {
      throw new RoutineServiceError('The routine ID is invalid.', 400);
    }
    const prisma = getDatabaseClient();
    const result = await withUserDatabaseContext(
      prisma,
      profileId,
      (transaction) =>
        transaction.routine.deleteMany({
          where: { id: routineId, profileId },
        }),
    );
    if (result.count === 0) {
      throw new RoutineServiceError('Routine not found.', 404);
    }
  }

  async listRuns(profileId: string) {
    const prisma = getDatabaseClient();
    const records = await withUserDatabaseContext(prisma, profileId, (transaction) =>
      transaction.routineRun.findMany({
        where: { profileId },
        select: {
          id: true,
          routineId: true,
          scheduledFor: true,
          status: true,
          createdAt: true,
          completedAt: true,
          routine: {
            select: {
              title: true,
              id: true,
              promptCiphertext: true,
              promptNonce: true,
              promptAuthTag: true,
            },
          },
        },
        orderBy: { scheduledFor: 'desc' },
        take: 50,
      }),
    );
    if (records.length === 0) {
      return [];
    }
    const key = await getProfileDataKey(profileId);
    return records.map((record) => ({
      id: record.id,
      routineId: record.routineId,
      title: record.routine.title,
      prompt: decryptText(
        {
          ciphertext: record.routine.promptCiphertext,
          nonce: record.routine.promptNonce,
          authTag: record.routine.promptAuthTag,
        },
        key,
        promptAdditionalData(profileId, record.routine.id),
      ),
      scheduledFor: record.scheduledFor,
      status: record.status,
    }));
  }

  async runNow(
    profileId: string,
    runId: string,
    approved: boolean,
  ) {
    if (!uuidPattern.test(runId)) {
      throw new RoutineServiceError('The routine run ID is invalid.', 400);
    }
    if (!approved) {
      throw new RoutineServiceError(
        'Review and approve this routine before running it.',
        400,
      );
    }
    const prisma = getDatabaseClient();
    const claimed = await withUserDatabaseContext(
      prisma,
      profileId,
      async (transaction) => {
        const run = await transaction.routineRun.findFirst({
          where: { id: runId, profileId, status: 'pending' },
          select: {
            id: true,
            routine: {
              select: {
                id: true,
                profileId: true,
                promptCiphertext: true,
                promptNonce: true,
                promptAuthTag: true,
              },
            },
          },
        });
        if (!run) {
          throw new RoutineServiceError(
            'This routine run is no longer waiting for approval.',
            409,
          );
        }
        const updated = await transaction.routineRun.updateMany({
          where: { id: run.id, profileId, status: 'pending' },
          data: { status: 'running', startedAt: new Date() },
        });
        if (updated.count !== 1) {
          throw new RoutineServiceError(
            'This routine run is already being handled.',
            409,
          );
        }
        return { runId: run.id, routine: run.routine as RoutineRecord };
      },
    );

    let reply: Awaited<ReturnType<ChatService['sendMessage']>>;
    try {
      const key = await getProfileDataKey(profileId);
      const prompt = decryptText(
        {
          ciphertext: claimed.routine.promptCiphertext,
          nonce: claimed.routine.promptNonce,
          authTag: claimed.routine.promptAuthTag,
        },
        key,
        promptAdditionalData(profileId, claimed.routine.id),
      );
      reply = await this.chatService.sendMessage(profileId, prompt);
    } catch (error) {
      try {
        await withUserDatabaseContext(prisma, profileId, (transaction) =>
          transaction.routineRun.updateMany({
            where: { id: claimed.runId, status: 'running' },
            data: { status: 'pending', startedAt: null },
          }),
        );
      } catch (resetError) {
        console.error(
          'A failed routine run could not be returned to pending approval.',
          resetError instanceof Error ? resetError.name : 'Unknown database error.',
        );
      }
      throw error;
    }
    await withUserDatabaseContext(prisma, profileId, (transaction) =>
      transaction.routineRun.update({
        where: { id: claimed.runId },
        data: {
          status: 'completed',
          startedAt: null,
          completedAt: new Date(),
        },
      }),
    );
    return reply;
  }
}

let schedulerTimer: NodeJS.Timeout | undefined;
let schedulerIsRunning = false;

export function startRoutineScheduler(
  intervalMs = 30_000,
): () => void {
  if (schedulerTimer) {
    return () => {};
  }
  const tick = async () => {
    if (schedulerIsRunning) {
      return;
    }
    schedulerIsRunning = true;
    try {
      const prisma = getDatabaseClient();
      const result = await prisma.$transaction(async (transaction) => {
        await transaction.$executeRaw`SET LOCAL ROLE nova_app`;
        return transaction.$queryRaw<Array<{ queued: number }>>`
          SELECT public.nova_queue_due_routine_runs() AS queued
        `;
      });
      const queued = result[0]?.queued ?? 0;
      if (queued > 0) {
        console.info(`Queued ${queued} routine run(s) for user approval.`);
      }
    } catch (error) {
      console.error(
        'The routine scheduler could not queue due runs.',
        error instanceof Error ? error.name : 'Unknown database error.',
      );
    } finally {
      schedulerIsRunning = false;
    }
  };

  void tick();
  schedulerTimer = setInterval(() => void tick(), intervalMs);
  schedulerTimer.unref();
  return () => {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = undefined;
    }
  };
}
