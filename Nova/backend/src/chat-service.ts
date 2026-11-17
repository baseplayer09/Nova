import { randomUUID } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client.js';
import { getDatabaseClient, withUserDatabaseContext } from './database.js';
import { decryptText, encryptText } from './encryption.js';
import { getProfileDataKey } from './profile-key.js';
import { CloudflareWorkersAiProvider } from './ai/cloudflare-workers-ai-provider.js';
import type { AiProvider } from './ai/ai-provider.js';
import { OpenAiProvider } from './ai/openai-provider.js';

const maxMessageLength = 8_000;
const maxHistoryMessages = 40;
const maxPromptLength = 20_000;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function defaultAiProvider(): AiProvider {
  const provider = process.env.AI_PROVIDER?.trim().toLowerCase() || 'cloudflare';
  switch (provider) {
    case 'cloudflare':
      return new CloudflareWorkersAiProvider();
    case 'openai':
      return new OpenAiProvider();
    default:
      throw new Error('AI_PROVIDER must be "cloudflare" or "openai".');
  }
}

export type ChatTurn = {
  role: 'user' | 'assistant';
  content: string;
};

export type ChatMessageResult = {
  id: string;
  sender: ChatTurn['role'];
  text: string;
  createdAt: Date;
};

export class ChatServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ChatServiceError';
  }
}

export function buildChatPrompt(
  history: ChatTurn[],
  newMessage: string,
): string {
  const promptTurns: ChatTurn[] = [];
  let promptLength = newMessage.length;

  for (const turn of history.slice(-maxHistoryMessages).reverse()) {
    const turnLength = turn.content.length + turn.role.length + 2;
    if (promptLength + turnLength > maxPromptLength) {
      break;
    }
    promptTurns.push(turn);
    promptLength += turnLength;
  }

  promptTurns.reverse();
  const transcript = promptTurns
    .map((turn) => `${turn.role}: ${turn.content}`)
    .join('\n');
  return transcript
    ? `Conversation so far:\n${transcript}\n\nUser: ${newMessage}`
    : newMessage;
}

function messageAdditionalData(
  profileId: string,
  conversationId: string,
  messageId: string,
): string {
  return `message:${profileId}:${conversationId}:${messageId}`;
}

function memorySafeText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ChatServiceError('A message is required.', 400);
  }
  const text = value.trim();
  if (text.length === 0 || text.length > maxMessageLength) {
    throw new ChatServiceError(
      `Messages must contain between 1 and ${maxMessageLength} characters.`,
      400,
    );
  }
  return text;
}

export class ChatService {
  constructor(
    private readonly aiProvider: AiProvider = defaultAiProvider(),
  ) {}

  async sendMessage(
    profileId: string,
    message: unknown,
    requestedConversationId?: string,
  ): Promise<{ conversationId: string; messages: ChatMessageResult[] }> {
    const text = memorySafeText(message);
    if (requestedConversationId !== undefined && !uuidPattern.test(requestedConversationId)) {
      throw new ChatServiceError('The conversation ID is invalid.', 400);
    }
    const conversationId = requestedConversationId ?? randomUUID();
    const dataKey = await getProfileDataKey(profileId);
    const prisma = getDatabaseClient();

    const historyRecords = requestedConversationId
      ? await withUserDatabaseContext(prisma, profileId, async (transaction) => {
          const conversation = await transaction.conversation.findFirst({
            where: { id: conversationId, profileId },
            select: { id: true },
          });
          if (!conversation) {
            throw new ChatServiceError('Conversation not found.', 404);
          }
          return transaction.message.findMany({
            where: { profileId, conversationId },
            orderBy: { createdAt: 'desc' },
            take: maxHistoryMessages,
          });
        })
      : [];

    historyRecords.reverse();
    const history: ChatTurn[] = historyRecords.map((record) => {
      if (record.sender !== 'user' && record.sender !== 'assistant') {
        throw new Error('Stored conversation has an invalid message sender.');
      }
      return {
        role: record.sender,
        content: decryptText(
          {
            ciphertext: record.ciphertext,
            nonce: record.nonce,
            authTag: record.authTag,
          },
          dataKey,
          messageAdditionalData(profileId, conversationId, record.id),
        ),
      };
    });

    const answer = await this.aiProvider.generateText(buildChatPrompt(history, text));
    const userMessage = this.createEncryptedMessage(
      profileId,
      conversationId,
      'user',
      text,
      dataKey,
    );
    const assistantMessage = this.createEncryptedMessage(
      profileId,
      conversationId,
      'assistant',
      answer,
      dataKey,
    );

    await withUserDatabaseContext(prisma, profileId, async (transaction) => {
      if (!requestedConversationId) {
        await transaction.conversation.create({
          data: { id: conversationId, profileId },
        });
      }
      await transaction.message.createMany({
        data: [userMessage.record, assistantMessage.record],
      });
    });

    return {
      conversationId,
      messages: [
        {
          id: userMessage.id,
          sender: 'user',
          text,
          createdAt: userMessage.createdAt,
        },
        {
          id: assistantMessage.id,
          sender: 'assistant',
          text: answer,
          createdAt: assistantMessage.createdAt,
        },
      ],
    };
  }

  async listConversations(profileId: string) {
    const prisma = getDatabaseClient();
    return withUserDatabaseContext(prisma, profileId, (transaction) =>
      transaction.conversation.findMany({
        where: { profileId },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
  }

  async getMessages(
    profileId: string,
    conversationId: string,
  ): Promise<ChatMessageResult[]> {
    const dataKey = await getProfileDataKey(profileId);
    const prisma = getDatabaseClient();
    const records = await withUserDatabaseContext(
      prisma,
      profileId,
      async (transaction) => {
        const conversation = await transaction.conversation.findFirst({
          where: { id: conversationId, profileId },
          select: { id: true },
        });
        if (!conversation) {
          throw new ChatServiceError('Conversation not found.', 404);
        }
        return transaction.message.findMany({
          where: { profileId, conversationId },
          orderBy: { createdAt: 'asc' },
        });
      },
    );

    return records.map((record) => {
      if (record.sender !== 'user' && record.sender !== 'assistant') {
        throw new Error('Stored conversation has an invalid message sender.');
      }
      return {
        id: record.id,
        sender: record.sender,
        text: decryptText(
          {
            ciphertext: record.ciphertext,
            nonce: record.nonce,
            authTag: record.authTag,
          },
          dataKey,
          messageAdditionalData(profileId, conversationId, record.id),
        ),
        createdAt: record.createdAt,
      };
    });
  }

  async deleteConversation(profileId: string, conversationId: string): Promise<void> {
    const prisma = getDatabaseClient();
    const result = await withUserDatabaseContext(prisma, profileId, (transaction) =>
      transaction.conversation.deleteMany({
        where: { id: conversationId, profileId },
      }),
    );
    if (result.count === 0) {
      throw new ChatServiceError('Conversation not found.', 404);
    }
  }

  async clearConversations(profileId: string): Promise<void> {
    const prisma = getDatabaseClient();
    await withUserDatabaseContext(prisma, profileId, (transaction) =>
      transaction.conversation.deleteMany({ where: { profileId } }),
    );
  }

  private createEncryptedMessage(
    profileId: string,
    conversationId: string,
    sender: ChatTurn['role'],
    text: string,
    dataKey: Buffer,
  ): {
    id: string;
    createdAt: Date;
    record: Prisma.MessageCreateManyInput;
  } {
    const id = randomUUID();
    const createdAt = new Date();
    const encrypted = encryptText(
      text,
      dataKey,
      messageAdditionalData(profileId, conversationId, id),
    );

    return {
      id,
      createdAt,
      record: {
        id,
        profileId,
        conversationId,
        sender,
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        authTag: encrypted.authTag,
        createdAt,
      },
    };
  }
}
