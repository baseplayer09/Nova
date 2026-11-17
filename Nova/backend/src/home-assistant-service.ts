import { getDatabaseClient, withUserDatabaseContext } from './database.js';
import { decryptText, encryptText } from './encryption.js';
import { getProfileDataKey } from './profile-key.js';

const providerName = 'home_assistant';
const allowedServices = new Map<string, Set<string>>([
  ['light', new Set(['turn_on', 'turn_off'])],
  ['switch', new Set(['turn_on', 'turn_off'])],
  ['cover', new Set(['open_cover', 'close_cover'])],
  ['lock', new Set(['lock', 'unlock'])],
  [
    'alarm_control_panel',
    new Set(['alarm_arm_away', 'alarm_arm_home', 'alarm_disarm']),
  ],
  [
    'media_player',
    new Set(['play_media', 'media_play', 'media_pause', 'media_stop']),
  ],
]);
const highRiskDomains = new Set(['lock', 'alarm_control_panel']);
const entityIdPattern = /^[a-z0-9_]+\.[a-z0-9_]+$/i;

type ConnectedAccountRecord = {
  id: string;
  profileId: string;
  provider: string;
  encryptedRefreshToken: Uint8Array<ArrayBuffer>;
  tokenNonce: Uint8Array<ArrayBuffer>;
  tokenAuthTag: Uint8Array<ArrayBuffer>;
};

export type HomeAssistantEntity = {
  entityId: string;
  name: string;
  state: string;
};

export class HomeAssistantServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'HomeAssistantServiceError';
  }
}

function getBaseUrl(): URL {
  const configured = process.env.HOME_ASSISTANT_URL;
  if (!configured) {
    throw new HomeAssistantServiceError(
      'Home Assistant is not configured on the backend.',
      503,
    );
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(configured);
  } catch {
    throw new HomeAssistantServiceError(
      'The configured Home Assistant URL is invalid.',
      503,
    );
  }
  if (
    (baseUrl.protocol !== 'https:' &&
      !(baseUrl.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname))) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new HomeAssistantServiceError(
      'Home Assistant must use HTTPS and a URL without credentials or query parameters.',
      503,
    );
  }
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, '')}/`;
  return baseUrl;
}

function entityTokenData(profileId: string): string {
  return `connected-account:${profileId}:${providerName}:token`;
}

function readEntity(value: unknown): HomeAssistantEntity | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const entityId = record.entity_id;
  const state = record.state;
  const attributes = record.attributes;
  if (typeof entityId !== 'string' || typeof state !== 'string') {
    return null;
  }
  const name =
    attributes !== null &&
    typeof attributes === 'object' &&
    typeof (attributes as Record<string, unknown>).friendly_name === 'string'
      ? ((attributes as Record<string, string>).friendly_name ?? entityId)
      : entityId;
  return { entityId, name, state };
}

export class HomeAssistantService {
  constructor(private readonly fetcher: typeof globalThis.fetch = globalThis.fetch) {}

  async getStatus(profileId: string): Promise<{ connected: boolean }> {
    const prisma = getDatabaseClient();
    const account = await withUserDatabaseContext(
      prisma,
      profileId,
      (transaction) =>
        transaction.connectedAccount.findUnique({
          where: {
            profileId_provider: { profileId, provider: providerName },
          },
          select: { id: true },
        }),
    );
    return { connected: account !== null };
  }

  async connect(profileId: string, token: string): Promise<void> {
    const cleanToken = token.trim();
    if (cleanToken.length < 20 || cleanToken.length > 4096) {
      throw new HomeAssistantServiceError(
        'Enter a valid Home Assistant access token.',
        400,
      );
    }

    const baseUrl = getBaseUrl();
    const response = await this.request(
      new URL('api/', baseUrl),
      cleanToken,
      { method: 'GET' },
    );
    if (!response.ok) {
      throw new HomeAssistantServiceError(
        'Home Assistant rejected the connection. Check the URL and token.',
        response.status === 401 ? 401 : 502,
      );
    }

    const key = await getProfileDataKey(profileId);
    const encryptedToken = encryptText(
      cleanToken,
      key,
      entityTokenData(profileId),
    );
    const prisma = getDatabaseClient();
    await withUserDatabaseContext(prisma, profileId, (transaction) =>
      transaction.connectedAccount.upsert({
        where: {
          profileId_provider: { profileId, provider: providerName },
        },
        create: {
          profileId,
          provider: providerName,
          encryptedRefreshToken: encryptedToken.ciphertext,
          tokenNonce: encryptedToken.nonce,
          tokenAuthTag: encryptedToken.authTag,
        },
        update: {
          encryptedRefreshToken: encryptedToken.ciphertext,
          tokenNonce: encryptedToken.nonce,
          tokenAuthTag: encryptedToken.authTag,
          updatedAt: new Date(),
        },
      }),
    );
  }

  async disconnect(profileId: string): Promise<void> {
    const prisma = getDatabaseClient();
    await withUserDatabaseContext(prisma, profileId, (transaction) =>
      transaction.connectedAccount.deleteMany({
        where: { profileId, provider: providerName },
      }),
    );
  }

  async listEntities(profileId: string): Promise<HomeAssistantEntity[]> {
    const token = await this.loadToken(profileId);
    const response = await this.request(
      new URL('api/states', getBaseUrl()),
      token,
      { method: 'GET' },
    );
    const body = await this.readJson(response, 'Home Assistant states');
    if (!Array.isArray(body)) {
      throw new HomeAssistantServiceError(
        'Home Assistant returned an invalid entity list.',
        502,
      );
    }
    return body
      .slice(0, 1000)
      .map(readEntity)
      .filter((entity): entity is HomeAssistantEntity => entity !== null);
  }

  async performAction(
    profileId: string,
    input: {
      domain: string;
      service: string;
      entityId: string;
      approved: boolean;
      mediaContentId?: string;
      mediaContentType?: string;
    },
    pinVerified: boolean,
  ): Promise<{ completed: true }> {
    const services = allowedServices.get(input.domain);
    const requiresPin = highRiskDomains.has(input.domain);
    if (
      !input.approved ||
      !services?.has(input.service) ||
      !entityIdPattern.test(input.entityId) ||
      input.entityId.split('.')[0] !== input.domain ||
      (requiresPin && !pinVerified)
    ) {
      throw new HomeAssistantServiceError(
        requiresPin && !pinVerified
          ? 'Enter your PIN to approve this high-risk action.'
          : 'This Home Assistant action is invalid or was not approved.',
        requiresPin && !pinVerified ? 403 : 400,
      );
    }
    if (
      input.domain === 'media_player' &&
      input.service === 'play_media' &&
      (typeof input.mediaContentId !== 'string' ||
        !input.mediaContentId.trim() ||
        input.mediaContentId.length > 200 ||
        input.mediaContentType !== 'music')
    ) {
      throw new HomeAssistantServiceError(
        'Enter a music search or title before playback.',
        400,
      );
    }

    const token = await this.loadToken(profileId);
    const actionBody = {
      entity_id: input.entityId,
      ...(input.domain === 'media_player' &&
      input.service === 'play_media' &&
      input.mediaContentId
        ? {
            media_content_id: input.mediaContentId.trim(),
            media_content_type: 'music',
          }
        : {}),
    };
    const response = await this.request(
      new URL(`api/services/${input.domain}/${input.service}`, getBaseUrl()),
      token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(actionBody),
      },
    );
    if (!response.ok) {
      throw new HomeAssistantServiceError(
        'Home Assistant could not complete the approved action.',
        response.status === 401 ? 401 : 502,
      );
    }
    return { completed: true };
  }

  private async loadToken(profileId: string): Promise<string> {
    const prisma = getDatabaseClient();
    const account = await withUserDatabaseContext(
      prisma,
      profileId,
      (transaction) =>
        transaction.connectedAccount.findUnique({
          where: {
            profileId_provider: { profileId, provider: providerName },
          },
        }),
    );
    if (!account) {
      throw new HomeAssistantServiceError(
        'Connect Home Assistant first.',
        409,
      );
    }
    const record = account as ConnectedAccountRecord;
    if (record.profileId !== profileId || record.provider !== providerName) {
      throw new HomeAssistantServiceError(
        'The stored Home Assistant connection is invalid.',
        500,
      );
    }
    const key = await getProfileDataKey(profileId);
    return decryptText(
      {
        ciphertext: record.encryptedRefreshToken,
        nonce: record.tokenNonce,
        authTag: record.tokenAuthTag,
      },
      key,
      entityTokenData(profileId),
    );
  }

  private async request(
    url: URL,
    token: string,
    init: RequestInit,
  ): Promise<Response> {
    try {
      return await this.fetcher(url, {
        ...init,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new HomeAssistantServiceError(
        'Home Assistant could not be reached. Check the backend connection.',
        502,
      );
    }
  }

  private async readJson(
    response: Response,
    operation: string,
  ): Promise<unknown> {
    if (!response.ok) {
      throw new HomeAssistantServiceError(
        `${operation} failed with status ${response.status}.`,
        response.status === 401 ? 401 : 502,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new HomeAssistantServiceError(
        `${operation} returned invalid JSON.`,
        502,
      );
    }
  }
}
