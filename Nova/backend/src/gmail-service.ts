import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getDatabaseClient, withUserDatabaseContext } from './database.js';
import { decryptText, encryptText } from './encryption.js';
import { getProfileDataKey } from './profile-key.js';

const providerName = 'google';
const gmailReadOnlyScope = 'https://www.googleapis.com/auth/gmail.readonly';
const calendarEventsScope =
  'https://www.googleapis.com/auth/calendar.events';
const oauthStateLifetimeMs = 10 * 60 * 1000;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type GoogleOAuthClaims = {
  userId: string;
  issuedAt: number;
  nonce: string;
};

type GmailMessageSummary = {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
};

export type GoogleCalendarEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  location: string;
};

type GoogleOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  appOrigin: string;
};

type ConnectedAccountRecord = {
  id: string;
  profileId: string;
  provider: string;
  encryptedRefreshToken: Uint8Array<ArrayBuffer>;
  tokenNonce: Uint8Array<ArrayBuffer>;
  tokenAuthTag: Uint8Array<ArrayBuffer>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export class GmailServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'GmailServiceError';
  }
}

function getOAuthConfig(): GoogleOAuthConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  const appOrigin = process.env.NOVA_APP_ORIGIN;
  if (!clientId || !clientSecret || !redirectUri || !appOrigin) {
    throw new GmailServiceError('Google OAuth is not configured.', 503);
  }

  let redirect: URL;
  let app: URL;
  try {
    redirect = new URL(redirectUri);
    app = new URL(appOrigin);
  } catch {
    throw new GmailServiceError('Google OAuth URLs are invalid.', 503);
  }
  if (
    (redirect.protocol !== 'https:' &&
      !(redirect.protocol === 'http:' && redirect.hostname === 'localhost')) ||
    (app.protocol !== 'https:' &&
      !(app.protocol === 'http:' && app.hostname === 'localhost')) ||
    app.pathname !== '/' ||
    app.search ||
    app.hash
  ) {
    throw new GmailServiceError(
      'Google OAuth requires an HTTPS callback and a valid app origin.',
      503,
    );
  }
  return {
    clientId,
    clientSecret,
    redirectUri: redirect.toString(),
    appOrigin: app.origin,
  };
}

function signState(payload: string, clientSecret: string): Buffer {
  return createHmac('sha256', clientSecret)
    .update(`NOVA_GOOGLE_OAUTH_V1:${payload}`)
    .digest();
}

export function createGoogleOAuthState(
  userId: string,
  clientSecret: string,
  now = Date.now(),
): string {
  if (!uuidPattern.test(userId) || clientSecret.length < 32) {
    throw new Error('A valid profile and Google OAuth secret are required.');
  }
  const claims: GoogleOAuthClaims = {
    userId,
    issuedAt: now,
    nonce: randomBytes(16).toString('base64url'),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${signState(payload, clientSecret).toString('base64url')}`;
}

export function verifyGoogleOAuthState(
  state: string,
  clientSecret: string,
  now = Date.now(),
): GoogleOAuthClaims | null {
  if (state.length > 2048 || clientSecret.length < 32) {
    return null;
  }
  const [payload, encodedSignature, ...extraParts] = state.split('.');
  if (!payload || !encodedSignature || extraParts.length > 0) {
    return null;
  }
  const supplied = Buffer.from(encodedSignature, 'base64url');
  const expected = signState(payload, clientSecret);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return null;
  }

  let claims: Partial<GoogleOAuthClaims>;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
  if (
    typeof claims.userId !== 'string' ||
    !uuidPattern.test(claims.userId) ||
    typeof claims.issuedAt !== 'number' ||
    claims.issuedAt > now ||
    now - claims.issuedAt >= oauthStateLifetimeMs ||
    typeof claims.nonce !== 'string' ||
    Buffer.from(claims.nonce, 'base64url').length !== 16
  ) {
    return null;
  }
  return claims as GoogleOAuthClaims;
}

function tokenAdditionalData(profileId: string): string {
  return `connected-account:${profileId}:${providerName}:refresh-token`;
}

function getRefreshToken(record: ConnectedAccountRecord, profileId: string, key: Buffer) {
  if (record.profileId !== profileId || record.provider !== providerName) {
    throw new Error('The stored Google account is invalid.');
  }
  return decryptText(
    {
      ciphertext: record.encryptedRefreshToken,
      nonce: record.tokenNonce,
      authTag: record.tokenAuthTag,
    },
    key,
    tokenAdditionalData(profileId),
  );
}

function getGoogleOAuthError(error: unknown): string {
  if (error instanceof GmailServiceError) {
    return error.message;
  }
  if (error instanceof Error && error.message === 'MEMORY_KEK is not configured.') {
    return 'Encrypted account storage is not configured.';
  }
  return 'Google could not complete the request. Please try again.';
}

export function getGoogleOAuthErrorMessage(error: unknown): string {
  return getGoogleOAuthError(error);
}

export class GmailService {
  constructor(
    private readonly fetcher: typeof globalThis.fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {}

  getStatus(profileId: string): Promise<{ connected: boolean }> {
    const prisma = getDatabaseClient();
    return withUserDatabaseContext(prisma, profileId, async (transaction) => {
      const account = await transaction.connectedAccount.findUnique({
        where: {
          profileId_provider: { profileId, provider: providerName },
        },
        select: { id: true },
      });
      return { connected: account !== null };
    });
  }

  startAuthorization(profileId: string): string {
    const config = getOAuthConfig();
    const state = createGoogleOAuthState(
      profileId,
      config.clientSecret,
      this.now(),
    );
    const authorizationUrl = new URL(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    authorizationUrl.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: `openid email ${gmailReadOnlyScope} ${calendarEventsScope}`,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    }).toString();
    return authorizationUrl.toString();
  }

  async completeAuthorization(
    code: string,
    state: string,
  ): Promise<{ redirectUrl: string }> {
    const config = getOAuthConfig();
    const claims = verifyGoogleOAuthState(state, config.clientSecret, this.now());
    if (!claims) {
      throw new GmailServiceError('The Google authorization state is invalid or expired.', 400);
    }
    if (!code || code.length > 4096) {
      throw new GmailServiceError('The Google authorization code is invalid.', 400);
    }

    const tokenResponse = await this.fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokenBody = await this.readJsonResponse(tokenResponse, 'Google token exchange');
    const refreshToken = tokenBody.refresh_token;
    const grantedScopes =
      typeof tokenBody.scope === 'string' ? tokenBody.scope.split(' ') : [];
    if (
      typeof refreshToken !== 'string' ||
      typeof tokenBody.access_token !== 'string' ||
      !grantedScopes.includes(gmailReadOnlyScope) ||
      !grantedScopes.includes(calendarEventsScope)
    ) {
      throw new GmailServiceError(
        'Google did not grant the required Gmail and Calendar permissions. Disconnect and reconnect.',
        502,
      );
    }

    const key = await getProfileDataKey(claims.userId);
    const encryptedToken = encryptText(
      refreshToken,
      key,
      tokenAdditionalData(claims.userId),
    );
    const prisma = getDatabaseClient();
    await withUserDatabaseContext(prisma, claims.userId, (transaction) =>
      transaction.connectedAccount.upsert({
        where: {
          profileId_provider: {
            profileId: claims.userId,
            provider: providerName,
          },
        },
        create: {
          profileId: claims.userId,
          provider: providerName,
          encryptedRefreshToken: encryptedToken.ciphertext,
          tokenNonce: encryptedToken.nonce,
          tokenAuthTag: encryptedToken.authTag,
        },
        update: {
          encryptedRefreshToken: encryptedToken.ciphertext,
          tokenNonce: encryptedToken.nonce,
          tokenAuthTag: encryptedToken.authTag,
          updatedAt: new Date(this.now()),
        },
      }),
    );

    return { redirectUrl: `${config.appOrigin}/?gmail=connected` };
  }

  async disconnect(profileId: string): Promise<void> {
    let refreshToken: string | null = null;
    try {
      refreshToken = await this.loadRefreshToken(profileId);
    } catch (error) {
      if (!(error instanceof GmailServiceError && error.statusCode === 409)) {
        throw error;
      }
    }

    const prisma = getDatabaseClient();
    await withUserDatabaseContext(prisma, profileId, (transaction) =>
      transaction.connectedAccount.deleteMany({
        where: { profileId, provider: providerName },
      }),
    );

    if (refreshToken) {
      let revokeResponse: Response;
      try {
        revokeResponse = await this.fetcher(
          'https://oauth2.googleapis.com/revoke',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: refreshToken }),
          },
        );
      } catch {
        throw new GmailServiceError(
          'Gmail was disconnected from NOVA, but Google could not be reached to revoke access. Remove NOVA from your Google Account security settings.',
          502,
        );
      }
      if (!revokeResponse.ok) {
        throw new GmailServiceError(
          'Gmail was disconnected from NOVA, but Google could not revoke access. Remove NOVA from your Google Account security settings.',
          502,
        );
      }
    }
  }

  async searchMessages(
    profileId: string,
    query: string,
  ): Promise<GmailMessageSummary[]> {
    if (query.length > 200) {
      throw new GmailServiceError('Gmail search text must be 200 characters or fewer.', 400);
    }
    const refreshToken = await this.loadRefreshToken(profileId);
    const accessToken = await this.refreshAccessToken(refreshToken);
    const searchUrl = new URL(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages',
    );
    searchUrl.search = new URLSearchParams({
      maxResults: '10',
      ...(query.trim() ? { q: query.trim() } : {}),
    }).toString();
    const listResponse = await this.fetcher(searchUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const listBody = await this.readJsonResponse(listResponse, 'Gmail search');
    const messageRecords = Array.isArray(listBody.messages)
      ? listBody.messages.slice(0, 10)
      : [];
    return Promise.all(
      messageRecords.map(async (item): Promise<GmailMessageSummary> => {
        const record = asRecord(item);
        if (!record || typeof record.id !== 'string') {
          throw new GmailServiceError('Gmail returned an invalid message reference.', 502);
        }
        const detailUrl = new URL(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(record.id)}`,
        );
        detailUrl.searchParams.set('format', 'metadata');
        detailUrl.searchParams.append('metadataHeaders', 'Subject');
        detailUrl.searchParams.append('metadataHeaders', 'From');
        detailUrl.searchParams.append('metadataHeaders', 'Date');
        const detailResponse = await this.fetcher(detailUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const detail = await this.readJsonResponse(detailResponse, 'Gmail message read');
        const payload = asRecord(detail.payload);
        const headers = Array.isArray(payload?.headers)
          ? payload.headers
          : [];
        const header = (name: string): string => {
          for (const headerItem of headers) {
            const headerRecord = asRecord(headerItem);
            if (
              typeof headerRecord?.name === 'string' &&
              headerRecord.name.toLowerCase() === name.toLowerCase() &&
              typeof headerRecord.value === 'string'
            ) {
              return headerRecord.value;
            }
          }
          return '';
        };
        return {
          id: record.id,
          subject: header('Subject') || '(no subject)',
          from: header('From'),
          date: header('Date'),
          snippet: typeof detail.snippet === 'string' ? detail.snippet : '',
        };
      }),
    );
  }

  async listCalendarEvents(
    profileId: string,
    timeMin: string,
    timeMax: string,
  ): Promise<GoogleCalendarEvent[]> {
    const start = Date.parse(timeMin);
    const end = Date.parse(timeMax);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start >= end ||
      end - start > 31 * 24 * 60 * 60 * 1000
    ) {
      throw new GmailServiceError(
        'Calendar date range must be valid and no longer than 31 days.',
        400,
      );
    }

    const refreshToken = await this.loadRefreshToken(profileId);
    const accessToken = await this.refreshAccessToken(refreshToken);
    const eventsUrl = new URL(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    );
    eventsUrl.search = new URLSearchParams({
      timeMin: new Date(start).toISOString(),
      timeMax: new Date(end).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '50',
    }).toString();
    const response = await this.fetcher(eventsUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = await this.readJsonResponse(response, 'Google Calendar event list');
    const items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
    return items.map((item) => {
      const event = asRecord(item);
      const eventStart = asRecord(event?.start);
      const eventEnd = asRecord(event?.end);
      const eventId = event?.id;
      const startValue = eventStart?.dateTime ?? eventStart?.date;
      const endValue = eventEnd?.dateTime ?? eventEnd?.date;
      if (
        typeof eventId !== 'string' ||
        typeof startValue !== 'string' ||
        typeof endValue !== 'string'
      ) {
        throw new GmailServiceError(
          'Google Calendar returned an invalid event.',
          502,
        );
      }
      return {
        id: eventId,
        title: typeof event?.summary === 'string' ? event.summary : '(no title)',
        start: startValue,
        end: endValue,
        location: typeof event?.location === 'string' ? event.location : '',
      };
    });
  }

  async createCalendarEvent(
    profileId: string,
    input: { title: string; start: string; end: string; location?: string },
  ): Promise<GoogleCalendarEvent> {
    const title = input.title.trim();
    const start = Date.parse(input.start);
    const end = Date.parse(input.end);
    if (
      !title ||
      title.length > 200 ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start >= end ||
      end - start > 31 * 24 * 60 * 60 * 1000 ||
      (input.location?.length ?? 0) > 500
    ) {
      throw new GmailServiceError('The calendar event details are invalid.', 400);
    }

    const refreshToken = await this.loadRefreshToken(profileId);
    const accessToken = await this.refreshAccessToken(refreshToken);
    const response = await this.fetcher(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          summary: title,
          start: { dateTime: new Date(start).toISOString() },
          end: { dateTime: new Date(end).toISOString() },
          ...(input.location?.trim()
            ? { location: input.location.trim() }
            : {}),
        }),
      },
    );
    const body = await this.readJsonResponse(response, 'Google Calendar event creation');
    const eventId = body.id;
    const eventStart = asRecord(body.start);
    const eventEnd = asRecord(body.end);
    const startValue = eventStart?.dateTime ?? eventStart?.date;
    const endValue = eventEnd?.dateTime ?? eventEnd?.date;
    if (
      typeof eventId !== 'string' ||
      typeof startValue !== 'string' ||
      typeof endValue !== 'string'
    ) {
      throw new GmailServiceError(
        'Google Calendar returned an invalid created event.',
        502,
      );
    }
    return {
      id: eventId,
      title: typeof body.summary === 'string' ? body.summary : title,
      start: startValue,
      end: endValue,
      location: typeof body.location === 'string' ? body.location : '',
    };
  }

  private async loadRefreshToken(profileId: string): Promise<string> {
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
      throw new GmailServiceError('Connect your Google account first.', 409);
    }
    const key = await getProfileDataKey(profileId);
    return getRefreshToken(account, profileId, key);
  }

  private async refreshAccessToken(refreshToken: string): Promise<string> {
    const config = getOAuthConfig();
    const response = await this.fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const tokenBody = await this.readJsonResponse(response, 'Google token refresh');
    if (typeof tokenBody.access_token !== 'string') {
      throw new GmailServiceError('Google did not return a usable access token.', 502);
    }
    return tokenBody.access_token;
  }

  private async readJsonResponse(
    response: Response,
    operation: string,
  ): Promise<Record<string, unknown>> {
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new GmailServiceError(`${operation} returned invalid JSON.`, 502);
      }
      throw error;
    }
    if (!response.ok) {
      const status = response.status === 401 ? 409 : 502;
      throw new GmailServiceError(
        response.status === 401
          ? 'Google authorization expired. Disconnect and reconnect your account.'
          : `${operation} failed with status ${response.status}.`,
        status,
      );
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new GmailServiceError(`${operation} returned an invalid response.`, 502);
    }
    const result = asRecord(body);
    if (!result) {
      throw new GmailServiceError(`${operation} returned an invalid response.`, 502);
    }
    return result;
  }
}
