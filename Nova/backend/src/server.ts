import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { APIError } from 'openai';
import {
  AccountDeletionError,
  deleteSupabaseAccount,
  getSupabaseClient,
} from './auth.js';
import { getProfileForUser, type ProfileSummary } from './database.js';
import {
  isValidPin,
  PinAlreadyConfiguredError,
  PinService,
  type PinVerificationResult,
} from './pin.js';
import { ChatService, ChatServiceError } from './chat-service.js';
import { MemoryService, MemoryServiceError } from './memory-service.js';
import {
  GmailService,
  GmailServiceError,
  getGoogleOAuthErrorMessage,
} from './gmail-service.js';
import {
  HomeAssistantService,
  HomeAssistantServiceError,
} from './home-assistant-service.js';
import { RoutineService, RoutineServiceError } from './routine-service.js';

type AuthOptions = {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  fetch?: typeof globalThis.fetch;
  routinesEnabled?: boolean;
  accountDeleter?: (
    userId: string,
    email: string,
    password: string,
  ) => Promise<void>;
  profileReader?: (userId: string) => Promise<ProfileSummary | null>;
  pinService?: Pick<
    PinService,
    'getStatus' | 'setup' | 'verify' | 'refreshUnlockToken'
  >;
  chatService?: Pick<
    ChatService,
    | 'sendMessage'
    | 'listConversations'
    | 'getMessages'
    | 'deleteConversation'
    | 'clearConversations'
  >;
  memoryService?: Pick<
    MemoryService,
    | 'proposeFromText'
    | 'listPending'
    | 'listApproved'
    | 'approve'
    | 'decline'
    | 'deleteApproved'
  >;
  gmailService?: Pick<
    GmailService,
    | 'getStatus'
    | 'startAuthorization'
    | 'completeAuthorization'
    | 'disconnect'
    | 'searchMessages'
    | 'listCalendarEvents'
    | 'createCalendarEvent'
  >;
  homeAssistantService?: Pick<
    HomeAssistantService,
    'getStatus' | 'connect' | 'disconnect' | 'listEntities' | 'performAction'
  >;
  routineService?: Pick<
    RoutineService,
    'list' | 'create' | 'setEnabled' | 'delete' | 'listRuns' | 'runNow'
  >;
};

type SupabaseUser = {
  id: string;
  email?: string;
  created_at?: string;
  user_metadata?: Record<string, unknown>;
};

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(
  request: IncomingMessage,
  response: ServerResponse,
  headers: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let exceedsLimit = false;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > 64 * 1024) {
      exceedsLimit = true;
    } else if (!exceedsLimit) {
      chunks.push(buffer);
    }
  }

  if (exceedsLimit) {
    sendJson(response, 413, { error: 'Request body is too large.' }, headers);
    return null;
  }

  if (chunks.length === 0) {
    return {};
  }

  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    sendJson(response, 400, { error: 'Request body must be valid JSON.' }, headers);
    return null;
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(response, 400, { error: 'Request body must be a JSON object.' }, headers);
    return null;
  }
  return body as Record<string, unknown>;
}

export function createApp(options: AuthOptions = {}) {
  const fetchSupabase = options.fetch ?? globalThis.fetch;
  const routinesEnabled = options.routinesEnabled ?? true;
  const pinService = options.pinService ?? new PinService();
  const chatService = options.chatService ?? new ChatService();
  const memoryService = options.memoryService ?? new MemoryService();
  const gmailService = options.gmailService ?? new GmailService();
  const homeAssistantService =
    options.homeAssistantService ?? new HomeAssistantService();
  const routineService = options.routineService ?? new RoutineService(chatService);

  return createServer(async (request, response) => {
    const corsOrigin = process.env.CORS_ORIGIN ?? '*';
    const headers: Record<string, string> = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers':
        'Authorization, Content-Type, X-Nova-Unlock-Token',
    };

    if (request.method === 'OPTIONS') {
      response.writeHead(204, headers);
      response.end();
      return;
    }

    const url = new URL(request.url ?? '/', 'http://localhost');
    if (
      request.method === 'GET' &&
      (url.pathname === '/health' || url.pathname === '/api/health')
    ) {
      sendJson(response, 200, { status: 'ok' }, headers);
      return;
    }

    const isSessionRequest = request.method === 'GET' && url.pathname === '/api/auth/session';
    const isProfileRequest = request.method === 'GET' && url.pathname === '/api/profile';
    const isStatusRequest = request.method === 'GET' && url.pathname === '/api/auth/status';
    const isSignOutRequest = request.method === 'POST' && url.pathname === '/api/auth/sign-out';
    const isAccountDeleteRequest =
      request.method === 'DELETE' && url.pathname === '/api/account';
    const isSignInRequest = request.method === 'POST' && url.pathname === '/api/auth/sign-in';
    const isSignUpRequest = request.method === 'POST' && url.pathname === '/api/auth/sign-up';
    const isForgotPasswordRequest =
      request.method === 'POST' && url.pathname === '/api/auth/forgot-password';
    const isPinStatusRequest =
      request.method === 'GET' && url.pathname === '/api/pin/status';
    const isPinSetupRequest =
      request.method === 'POST' && url.pathname === '/api/pin/setup';
    const isPinVerifyRequest =
      request.method === 'POST' && url.pathname === '/api/pin/verify';
    const isChatRequest = request.method === 'POST' && url.pathname === '/api/chat';
    const isConversationsRequest =
      request.method === 'GET' && url.pathname === '/api/conversations';
    const isClearConversationsRequest =
      request.method === 'DELETE' && url.pathname === '/api/conversations';
    const isMemoryListRequest =
      request.method === 'GET' && url.pathname === '/api/memories';
    const isPendingMemoryListRequest =
      request.method === 'GET' && url.pathname === '/api/memories/pending';
    const isMemoryExportRequest =
      request.method === 'GET' && url.pathname === '/api/memories/export';
    const memoryApproveMatch = url.pathname.match(
      /^\/api\/memories\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/approve$/i,
    );
    const memoryDeclineMatch = url.pathname.match(
      /^\/api\/memories\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/decline$/i,
    );
    const memoryDeleteMatch = url.pathname.match(
      /^\/api\/memories\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    );
    const isMemoryApproveRequest =
      request.method === 'POST' && memoryApproveMatch !== null;
    const isMemoryDeclineRequest =
      request.method === 'POST' && memoryDeclineMatch !== null;
    const isMemoryDeleteRequest =
      request.method === 'DELETE' && memoryDeleteMatch !== null;
    const isGoogleOAuthCallback =
      request.method === 'GET' &&
      url.pathname === '/api/integrations/google/callback';
    const isGoogleConnectionStatus =
      request.method === 'GET' && url.pathname === '/api/integrations/google';
    const isGoogleConnectionStart =
      request.method === 'POST' &&
      url.pathname === '/api/integrations/google/connect';
    const isGoogleConnectionDelete =
      request.method === 'DELETE' && url.pathname === '/api/integrations/google';
    const isGmailSearch =
      request.method === 'GET' &&
      url.pathname === '/api/integrations/gmail/messages';
    const isCalendarEventList =
      request.method === 'GET' &&
      url.pathname === '/api/integrations/calendar/events';
    const isCalendarEventCreate =
      request.method === 'POST' &&
      url.pathname === '/api/integrations/calendar/events';
    const isHomeAssistantStatus =
      request.method === 'GET' &&
      url.pathname === '/api/integrations/home-assistant';
    const isHomeAssistantConnect =
      request.method === 'POST' &&
      url.pathname === '/api/integrations/home-assistant/connect';
    const isHomeAssistantDisconnect =
      request.method === 'DELETE' &&
      url.pathname === '/api/integrations/home-assistant';
    const isHomeAssistantEntities =
      request.method === 'GET' &&
      url.pathname === '/api/integrations/home-assistant/entities';
    const isHomeAssistantAction =
      request.method === 'POST' &&
      url.pathname === '/api/integrations/home-assistant/actions';
    const isRoutineList =
      request.method === 'GET' && url.pathname === '/api/routines';
    const isRoutineCreate =
      request.method === 'POST' && url.pathname === '/api/routines';
    const isRoutineRuns =
      request.method === 'GET' && url.pathname === '/api/routines/runs';
    const routineEnabledMatch = url.pathname.match(
      /^\/api\/routines\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/enabled$/i,
    );
    const routineDeleteMatch = url.pathname.match(
      /^\/api\/routines\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    );
    const routineRunMatch = url.pathname.match(
      /^\/api\/routines\/runs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/run$/i,
    );
    const isRoutineEnabled =
      request.method === 'POST' && routineEnabledMatch !== null;
    const isRoutineDelete =
      request.method === 'DELETE' && routineDeleteMatch !== null;
    const isRoutineRun =
      request.method === 'POST' && routineRunMatch !== null;
    const conversationMessagesMatch = url.pathname.match(
      /^\/api\/conversations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/messages$/i,
    );
    const conversationDeleteMatch = url.pathname.match(
      /^\/api\/conversations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    );
    const isConversationMessagesRequest =
      request.method === 'GET' && conversationMessagesMatch !== null;
    const isConversationDeleteRequest =
      request.method === 'DELETE' && conversationDeleteMatch !== null;
    const isUserDataRequest =
      isChatRequest ||
      isConversationsRequest ||
      isClearConversationsRequest ||
      isConversationMessagesRequest ||
      isConversationDeleteRequest ||
      isMemoryListRequest ||
      isPendingMemoryListRequest ||
      isMemoryExportRequest ||
      isMemoryApproveRequest ||
      isMemoryDeclineRequest ||
      isMemoryDeleteRequest ||
      isGoogleConnectionStatus ||
      isGoogleConnectionStart ||
      isGoogleConnectionDelete ||
      isGmailSearch ||
      isCalendarEventList ||
      isCalendarEventCreate ||
      isHomeAssistantStatus ||
      isHomeAssistantConnect ||
      isHomeAssistantDisconnect ||
      isHomeAssistantEntities ||
      isHomeAssistantAction ||
      isRoutineList ||
      isRoutineCreate ||
      isRoutineRuns ||
      isRoutineEnabled ||
      isRoutineDelete ||
      isRoutineRun ||
      isAccountDeleteRequest;

    if (isGoogleOAuthCallback) {
      const code = url.searchParams.get('code') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const providerError = url.searchParams.get('error');
      if (providerError) {
        sendJson(
          response,
          400,
          { error: 'Google authorization was not completed.' },
          headers,
        );
        return;
      }
      try {
        const result = await gmailService.completeAuthorization(code, state);
        response.writeHead(302, {
          ...headers,
          Location: result.redirectUrl,
          'Cache-Control': 'no-store',
        });
        response.end();
      } catch (error) {
        sendGmailError(response, error, headers);
      }
      return;
    }

    const isAuthEndpoint =
      isSessionRequest ||
      isProfileRequest ||
      isStatusRequest ||
      isSignOutRequest ||
      isSignInRequest ||
      isSignUpRequest ||
      isForgotPasswordRequest ||
      isPinStatusRequest ||
      isPinSetupRequest ||
      isPinVerifyRequest ||
      isUserDataRequest;

    if (!isAuthEndpoint) {
      sendJson(response, 404, { error: 'Not found' }, headers);
      return;
    }

    if (isSignInRequest || isSignUpRequest || isForgotPasswordRequest) {
      const body = await readJsonBody(request, response, headers);
      if (body === null) {
        return;
      }
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';

      if ((isSignInRequest || isSignUpRequest) && (!email || !password)) {
        sendJson(response, 400, { error: 'Email and password are required.' }, headers);
        return;
      }

      if (isForgotPasswordRequest && !email) {
        sendJson(response, 400, { error: 'Email is required.' }, headers);
        return;
      }

      const client = getSupabaseClient();
      if (!client) {
        sendJson(response, 503, { error: 'Supabase Auth is not configured.' }, headers);
        return;
      }

      try {
        if (isSignInRequest) {
          const { data, error } = await client.auth.signInWithPassword({ email, password });
          if (error) {
            sendJson(response, 401, { error: error.message }, headers);
            return;
          }

          sendJson(
            response,
            200,
            {
              user: {
                id: data.user?.id ?? null,
                email: data.user?.email ?? null,
              },
              session: data.session
                ? {
                    access_token: data.session.access_token,
                    refresh_token: data.session.refresh_token,
                  }
                : null,
            },
            headers,
          );
          return;
        }

        if (isSignUpRequest) {
          const { data, error } = await client.auth.signUp({ email, password });
          if (error) {
            sendJson(response, 400, { error: error.message }, headers);
            return;
          }

          sendJson(
            response,
            200,
            {
              user: data.user ? { id: data.user.id, email: data.user.email ?? null } : null,
            },
            headers,
          );
          return;
        }

        const { error } = await client.auth.resetPasswordForEmail(email);
        if (error) {
          sendJson(response, 400, { error: error.message }, headers);
          return;
        }

        sendJson(response, 200, { message: 'Reset email sent.' }, headers);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Supabase Auth request failed.';
        sendJson(response, 500, { error: message }, headers);
        return;
      }
    }

    const authorization = request.headers.authorization;
    const tokenMatch = authorization?.match(/^Bearer\s+(\S+)$/i);
    if (!tokenMatch) {
      sendJson(response, 401, { error: 'A bearer access token is required.' }, headers);
      return;
    }

    const supabaseUrl = options.supabaseUrl ?? process.env.SUPABASE_URL;
    const supabaseAnonKey = options.supabaseAnonKey ?? process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnonKey) {
      sendJson(response, 503, { error: 'Supabase Auth is not configured.' }, headers);
      return;
    }

    const isSignOut = isSignOutRequest;
    const endpoint = isSignOut ? '/auth/v1/logout' : '/auth/v1/user';
    let supabaseResponse: Response;

    try {
      supabaseResponse = await fetchSupabase(new URL(endpoint, supabaseUrl), {
        method: isSignOut ? 'POST' : 'GET',
        headers: {
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${tokenMatch[1]}`,
        },
      });
    } catch {
      sendJson(response, 502, { error: 'Supabase Auth could not be reached.' }, headers);
      return;
    }

    if (isSignOut) {
      response.writeHead(supabaseResponse.status, headers);
      response.end();
      return;
    }

    if (!supabaseResponse.ok) {
      if (isStatusRequest) {
        sendJson(response, 401, { authenticated: false }, headers);
        return;
      }

      response.writeHead(supabaseResponse.status, headers);
      response.end(JSON.stringify({ error: 'Supabase Auth rejected the token.' }));
      return;
    }

    let user: SupabaseUser | undefined;
    try {
      user = (await supabaseResponse.json()) as SupabaseUser;
    } catch {
      sendJson(response, 502, { error: 'Supabase Auth returned an invalid user.' }, headers);
      return;
    }

    let userDataHeaders = headers;
    if (isUserDataRequest) {
      try {
        const renewedToken = pinService.refreshUnlockToken(
          user.id,
          request.headers['x-nova-unlock-token'],
        );
        if (!renewedToken) {
          sendJson(
            response,
            423,
            {
              error: 'Unlock NOVA with your PIN before accessing profile data.',
              requires_pin: true,
            },
            headers,
          );
          return;
        }
        userDataHeaders = {
          ...headers,
          'Access-Control-Expose-Headers': 'X-Nova-Unlock-Token',
          'X-Nova-Unlock-Token': renewedToken,
        };
      } catch (error) {
        console.error(
          'Failed to validate the profile unlock session.',
          error instanceof Error ? error.message : 'Unknown PIN session error.',
        );
        sendJson(response, 503, { error: 'PIN session validation is unavailable.' }, headers);
        return;
      }
    }

    if (isChatRequest) {
      const body = await readJsonBody(request, response, userDataHeaders);
      if (body === null) {
        return;
      }
      const requestedConversationId = body.conversation_id;
      if (
        requestedConversationId !== undefined &&
        (typeof requestedConversationId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            requestedConversationId,
          ))
      ) {
        sendJson(
          response,
          400,
          { error: 'The conversation ID is invalid.' },
          userDataHeaders,
        );
        return;
      }
      const conversationId =
        typeof requestedConversationId === 'string'
          ? requestedConversationId
          : undefined;
      try {
        const result = await chatService.sendMessage(
          user.id,
          body.message,
          conversationId,
        );
        const memoryProposal = await memoryService.proposeFromText(
          user.id,
          body.message,
        );
        sendJson(response, 200, { ...result, memoryProposal }, userDataHeaders);
      } catch (error) {
        sendChatError(response, error, userDataHeaders);
      }
      return;
    }

    if (isAccountDeleteRequest) {
      const body = await readJsonBody(request, response, userDataHeaders);
      if (body === null) {
        return;
      }
      if (body.confirmation !== 'DELETE') {
        sendJson(
          response,
          400,
          { error: 'Type DELETE to confirm account removal.' },
          userDataHeaders,
        );
        return;
      }
      if (typeof body.password !== 'string' || body.password.length === 0) {
        sendJson(
          response,
          400,
          { error: 'Your current account password is required.' },
          userDataHeaders,
        );
        return;
      }
      if (!user.email) {
        sendJson(
          response,
          400,
          { error: 'The authenticated account does not have an email address.' },
          userDataHeaders,
        );
        return;
      }
      try {
        await (options.accountDeleter ?? deleteSupabaseAccount)(
          user.id,
          user.email,
          body.password,
        );
        sendJson(response, 200, { deleted: true }, userDataHeaders);
      } catch (error) {
        if (error instanceof AccountDeletionError) {
          if (error.reason === 'invalid_credentials') {
            sendJson(
              response,
              401,
              { error: 'The account password is incorrect.' },
              userDataHeaders,
            );
            return;
          }
          if (error.reason === 'not_configured') {
            sendJson(
              response,
              503,
              { error: 'Account deletion is not configured on the backend.' },
              userDataHeaders,
            );
            return;
          }
        }
        console.error('Failed to delete the authenticated NOVA account.');
        sendJson(
          response,
          502,
          { error: 'Supabase could not delete the account. Please try again.' },
          userDataHeaders,
        );
      }
      return;
    }

    if (isConversationsRequest) {
      try {
        sendJson(
          response,
          200,
          { conversations: await chatService.listConversations(user.id) },
          userDataHeaders,
        );
      } catch (error) {
        sendChatError(response, error, userDataHeaders);
      }
      return;
    }

    if (isConversationMessagesRequest && conversationMessagesMatch) {
      try {
        sendJson(
          response,
          200,
          {
            messages: await chatService.getMessages(
              user.id,
              conversationMessagesMatch[1],
            ),
          },
          userDataHeaders,
        );
      } catch (error) {
        sendChatError(response, error, userDataHeaders);
      }
      return;
    }

    if (isConversationDeleteRequest && conversationDeleteMatch) {
      try {
        await chatService.deleteConversation(user.id, conversationDeleteMatch[1]);
        sendJson(response, 200, { deleted: true }, userDataHeaders);
      } catch (error) {
        sendChatError(response, error, userDataHeaders);
      }
      return;
    }

    if (isClearConversationsRequest) {
      try {
        await chatService.clearConversations(user.id);
        sendJson(response, 200, { deleted: true }, userDataHeaders);
      } catch (error) {
        sendChatError(response, error, userDataHeaders);
      }
      return;
    }

    if (isMemoryExportRequest || isMemoryListRequest) {
      try {
        const memories = await memoryService.listApproved(
          user.id,
          isMemoryExportRequest ? '' : url.searchParams.get('search') ?? '',
        );
        sendJson(response, 200, { memories }, userDataHeaders);
      } catch (error) {
        sendMemoryError(response, error, userDataHeaders);
      }
      return;
    }

    if (isPendingMemoryListRequest) {
      try {
        sendJson(
          response,
          200,
          { proposals: await memoryService.listPending(user.id) },
          userDataHeaders,
        );
      } catch (error) {
        sendMemoryError(response, error, userDataHeaders);
      }
      return;
    }

    if (isMemoryApproveRequest && memoryApproveMatch) {
      try {
        sendJson(
          response,
          200,
          { memory: await memoryService.approve(user.id, memoryApproveMatch[1]) },
          userDataHeaders,
        );
      } catch (error) {
        sendMemoryError(response, error, userDataHeaders);
      }
      return;
    }

    if (isMemoryDeclineRequest && memoryDeclineMatch) {
      try {
        await memoryService.decline(user.id, memoryDeclineMatch[1]);
        sendJson(response, 200, { declined: true }, userDataHeaders);
      } catch (error) {
        sendMemoryError(response, error, userDataHeaders);
      }
      return;
    }

    if (isMemoryDeleteRequest && memoryDeleteMatch) {
      try {
        await memoryService.deleteApproved(user.id, memoryDeleteMatch[1]);
        sendJson(response, 200, { deleted: true }, userDataHeaders);
      } catch (error) {
        sendMemoryError(response, error, userDataHeaders);
      }
      return;
    }

    if (isGoogleConnectionStatus) {
      try {
        sendJson(response, 200, await gmailService.getStatus(user.id), userDataHeaders);
      } catch (error) {
        sendGmailError(response, error, userDataHeaders);
      }
      return;
    }

    if (isGoogleConnectionStart) {
      try {
        sendJson(
          response,
          200,
          { authorization_url: gmailService.startAuthorization(user.id) },
          userDataHeaders,
        );
      } catch (error) {
        sendGmailError(response, error, userDataHeaders);
      }
      return;
    }

    if (isGoogleConnectionDelete) {
      try {
        await gmailService.disconnect(user.id);
        sendJson(response, 200, { disconnected: true }, userDataHeaders);
      } catch (error) {
        sendGmailError(response, error, userDataHeaders);
      }
      return;
    }

    if (isGmailSearch) {
      try {
        sendJson(
          response,
          200,
          {
            messages: await gmailService.searchMessages(
              user.id,
              url.searchParams.get('q') ?? '',
            ),
          },
          userDataHeaders,
        );
      } catch (error) {
        sendGmailError(response, error, userDataHeaders);
      }
      return;
    }

    if (isCalendarEventList) {
      try {
        sendJson(
          response,
          200,
          {
            events: await gmailService.listCalendarEvents(
              user.id,
              url.searchParams.get('timeMin') ?? '',
              url.searchParams.get('timeMax') ?? '',
            ),
          },
          userDataHeaders,
        );
      } catch (error) {
        sendGmailError(response, error, userDataHeaders);
      }
      return;
    }

    if (isCalendarEventCreate) {
      const body = await readJsonBody(request, response, userDataHeaders);
      if (body === null) {
        return;
      }
      if (body.approved !== true) {
        sendJson(
          response,
          400,
          { error: 'Confirm the calendar event before creating it.' },
          userDataHeaders,
        );
        return;
      }
      if (
        typeof body.title !== 'string' ||
        typeof body.start !== 'string' ||
        typeof body.end !== 'string' ||
        (body.location !== undefined && typeof body.location !== 'string')
      ) {
        sendJson(
          response,
          400,
          { error: 'Calendar event title, start, and end are required.' },
          userDataHeaders,
        );
        return;
      }
      try {
        sendJson(
          response,
          201,
          {
            event: await gmailService.createCalendarEvent(user.id, {
              title: body.title,
              start: body.start,
              end: body.end,
              location: body.location,
            }),
          },
          userDataHeaders,
        );
      } catch (error) {
        sendGmailError(response, error, userDataHeaders);
      }
      return;
    }

    if (isHomeAssistantStatus) {
      try {
        sendJson(
          response,
          200,
          await homeAssistantService.getStatus(user.id),
          userDataHeaders,
        );
      } catch (error) {
        sendHomeAssistantError(response, error, userDataHeaders);
      }
      return;
    }

    if (isHomeAssistantConnect) {
      const body = await readJsonBody(request, response, userDataHeaders);
      if (body === null) {
        return;
      }
      if (typeof body.token !== 'string') {
        sendJson(
          response,
          400,
          { error: 'A Home Assistant access token is required.' },
          userDataHeaders,
        );
        return;
      }
      try {
        await homeAssistantService.connect(user.id, body.token);
        sendJson(response, 200, { connected: true }, userDataHeaders);
      } catch (error) {
        sendHomeAssistantError(response, error, userDataHeaders);
      }
      return;
    }

    if (isHomeAssistantDisconnect) {
      try {
        await homeAssistantService.disconnect(user.id);
        sendJson(response, 200, { disconnected: true }, userDataHeaders);
      } catch (error) {
        sendHomeAssistantError(response, error, userDataHeaders);
      }
      return;
    }

    if (isHomeAssistantEntities) {
      try {
        sendJson(
          response,
          200,
          { entities: await homeAssistantService.listEntities(user.id) },
          userDataHeaders,
        );
      } catch (error) {
        sendHomeAssistantError(response, error, userDataHeaders);
      }
      return;
    }

    if (isHomeAssistantAction) {
      const body = await readJsonBody(request, response, userDataHeaders);
      if (body === null) {
        return;
      }
      if (
        typeof body.domain !== 'string' ||
        typeof body.service !== 'string' ||
        typeof body.entity_id !== 'string' ||
        body.approved !== true ||
        (body.media_content_id !== undefined &&
          typeof body.media_content_id !== 'string')
      ) {
        sendJson(
          response,
          400,
          {
            error:
              'Home Assistant action details must be valid and explicitly approved.',
          },
          userDataHeaders,
        );
        return;
      }

      const requiresPin =
        body.domain === 'lock' || body.domain === 'alarm_control_panel';
      const actionPin = isValidPin(body.pin) ? body.pin : undefined;
      if (requiresPin && actionPin === undefined) {
        sendJson(
          response,
          400,
          { error: 'Enter your six-digit PIN for this high-risk action.' },
          userDataHeaders,
        );
        return;
      }
      let pinVerified = false;
      if (requiresPin && actionPin !== undefined) {
        try {
          const result = await pinService.verify(user.id, actionPin);
          if (result.status === 'invalid') {
            sendJson(
              response,
              401,
              {
                verified: false,
                attempts_remaining: result.attemptsRemaining,
              },
              userDataHeaders,
            );
            return;
          }
          if (result.status === 'locked') {
            sendJson(
              response,
              423,
              {
                verified: false,
                retry_after_seconds: Math.ceil(result.retryAfterMs / 1000),
              },
              userDataHeaders,
            );
            return;
          }
          if (result.status !== 'verified') {
            sendJson(
              response,
              409,
              { error: 'Set up a PIN before using this action.' },
              userDataHeaders,
            );
            return;
          }
          pinVerified = true;
        } catch (error) {
          console.error(
            'Failed to verify the PIN for a Home Assistant action.',
            error instanceof Error ? error.name : 'Unknown PIN error.',
          );
          sendJson(
            response,
            503,
            { error: 'PIN verification is unavailable.' },
            userDataHeaders,
          );
          return;
        }
      }

      try {
        sendJson(
          response,
          200,
          await homeAssistantService.performAction(
            user.id,
            {
              domain: body.domain,
              service: body.service,
              entityId: body.entity_id,
              approved: body.approved,
              ...(typeof body.media_content_id === 'string'
                ? {
                    mediaContentId: body.media_content_id,
                    mediaContentType: 'music',
                  }
                : {}),
            },
            pinVerified,
          ),
          userDataHeaders,
        );
      } catch (error) {
        sendHomeAssistantError(response, error, userDataHeaders);
      }
      return;
    }

    if (
      !routinesEnabled &&
      (isRoutineList ||
        isRoutineCreate ||
        isRoutineRuns ||
        isRoutineEnabled ||
        isRoutineDelete ||
        isRoutineRun)
    ) {
      sendJson(
        response,
        503,
        { error: 'Unattended routines are temporarily unavailable on this hosting plan.' },
        userDataHeaders,
      );
      return;
    }

    if (isRoutineList) {
      try {
        sendJson(
          response,
          200,
          { routines: await routineService.list(user.id) },
          userDataHeaders,
        );
      } catch (error) {
        sendRoutineError(response, error, userDataHeaders);
      }
      return;
    }

    if (isRoutineCreate) {
      const body = await readJsonBody(request, response, userDataHeaders);
      if (body === null) {
        return;
      }
      try {
        sendJson(
          response,
          201,
          {
            routine: await routineService.create(user.id, {
              title: body.title,
              prompt: body.prompt,
              timezone: body.timezone,
              localTime: body.local_time,
              scheduleDays: body.schedule_days,
            }),
          },
          userDataHeaders,
        );
      } catch (error) {
        sendRoutineError(response, error, userDataHeaders);
      }
      return;
    }

    if (isRoutineRuns) {
      try {
        sendJson(
          response,
          200,
          { runs: await routineService.listRuns(user.id) },
          userDataHeaders,
        );
      } catch (error) {
        sendRoutineError(response, error, userDataHeaders);
      }
      return;
    }

    if (isRoutineEnabled && routineEnabledMatch) {
      const body = await readJsonBody(request, response, userDataHeaders);
      if (body === null) {
        return;
      }
      if (typeof body.enabled !== 'boolean') {
        sendJson(
          response,
          400,
          { error: 'Choose whether this routine is enabled.' },
          userDataHeaders,
        );
        return;
      }
      try {
        sendJson(
          response,
          200,
          {
            routine: await routineService.setEnabled(
              user.id,
              routineEnabledMatch[1],
              body.enabled,
            ),
          },
          userDataHeaders,
        );
      } catch (error) {
        sendRoutineError(response, error, userDataHeaders);
      }
      return;
    }

    if (isRoutineDelete && routineDeleteMatch) {
      try {
        await routineService.delete(user.id, routineDeleteMatch[1]);
        sendJson(response, 200, { deleted: true }, userDataHeaders);
      } catch (error) {
        sendRoutineError(response, error, userDataHeaders);
      }
      return;
    }

    if (isRoutineRun && routineRunMatch) {
      const body = await readJsonBody(request, response, userDataHeaders);
      if (body === null) {
        return;
      }
      if (body.approved !== true) {
        sendJson(
          response,
          400,
          { error: 'Review and approve this routine before running it.' },
          userDataHeaders,
        );
        return;
      }
      try {
        sendJson(
          response,
          200,
          await routineService.runNow(
            user.id,
            routineRunMatch[1],
            body.approved,
          ),
          userDataHeaders,
        );
      } catch (error) {
        sendRoutineError(response, error, userDataHeaders);
      }
      return;
    }

    if (isPinStatusRequest) {
      try {
        sendJson(response, 200, await pinService.getStatus(user.id), headers);
      } catch (error) {
        console.error(
          'Failed to read the authenticated profile PIN status.',
          error instanceof Error ? error.message : 'Unknown PIN storage error.',
        );
        sendJson(response, 503, { error: 'PIN storage is unavailable.' }, headers);
      }
      return;
    }

    if (isPinSetupRequest || isPinVerifyRequest) {
      const body = await readJsonBody(request, response, headers);
      if (body === null) {
        return;
      }
      if (!isValidPin(body.pin)) {
        sendJson(response, 400, { error: 'PIN must contain exactly six digits.' }, headers);
        return;
      }

      try {
        if (isPinSetupRequest) {
          const unlockToken = await pinService.setup(user.id, body.pin);
          sendJson(
            response,
            201,
            { configured: true, unlock_token: unlockToken },
            headers,
          );
          return;
        }

        const result = await pinService.verify(user.id, body.pin);
        sendJson(response, pinResultStatusCode(result), pinResultBody(result), headers);
      } catch (error) {
        if (error instanceof PinAlreadyConfiguredError) {
          sendJson(response, 409, { error: 'A PIN is already configured.' }, headers);
          return;
        }

        console.error(
          'Failed to update or verify the authenticated profile PIN.',
          error instanceof Error ? error.message : 'Unknown PIN storage error.',
        );
        sendJson(response, 503, { error: 'PIN service is unavailable.' }, headers);
      }
      return;
    }

    if (isProfileRequest) {
      let profile: ProfileSummary | null;
      try {
        profile = await (options.profileReader ?? getProfileForUser)(user.id);
      } catch (error) {
        console.error(
          'Failed to load the authenticated profile from the database.',
          error instanceof Error ? error.message : 'Unknown database error.',
        );
        sendJson(response, 503, { error: 'Profile storage is unavailable.' }, headers);
        return;
      }

      if (!profile) {
        sendJson(response, 404, { error: 'Profile not found.' }, headers);
        return;
      }

      sendJson(
        response,
        200,
        {
          id: user.id,
          email: user.email,
          metadata: user.user_metadata ?? {},
          display_name: profile.displayName,
          created_at: profile.createdAt.toISOString(),
        },
        headers,
      );
      return;
    }

    if (isStatusRequest) {
      sendJson(
        response,
        200,
        {
          authenticated: true,
          user: {
            id: user.id,
            email: user.email,
          },
        },
        headers,
      );
      return;
    }

    const responseBody = {
      user: {
        id: user.id,
        email: user.email,
        created_at: user.created_at,
        user_metadata: user.user_metadata ?? {},
      },
    };

    sendJson(response, 200, responseBody, headers);
  });
}

function pinResultStatusCode(result: PinVerificationResult): number {
  switch (result.status) {
    case 'verified':
      return 200;
    case 'invalid':
      return 401;
    case 'locked':
      return 423;
    case 'not-configured':
      return 409;
  }
}

function pinResultBody(
  result: PinVerificationResult,
): Record<string, unknown> {
  switch (result.status) {
    case 'verified':
      return { verified: true, unlock_token: result.unlockToken };
    case 'invalid':
      return { verified: false, attempts_remaining: result.attemptsRemaining };
    case 'locked':
      return {
        verified: false,
        retry_after_seconds: Math.ceil(result.retryAfterMs / 1000),
      };
    case 'not-configured':
      return { error: 'PIN is not configured for this profile.' };
  }
}

function sendChatError(
  response: ServerResponse,
  error: unknown,
  headers: Record<string, string>,
): void {
  if (error instanceof ChatServiceError) {
    sendJson(response, error.statusCode, { error: error.message }, headers);
    return;
  }
  if (error instanceof MemoryServiceError) {
    sendJson(response, error.statusCode, { error: error.message }, headers);
    return;
  }
  if (
    error instanceof Error &&
    (error.message === 'OPENAI_API_KEY is not configured.' ||
      error.message === 'MEMORY_KEK is not configured.' ||
      error.message === 'MEMORY_KEK must be a base64-encoded 32-byte key.')
  ) {
    sendJson(response, 503, { error: error.message }, headers);
    return;
  }

  const diagnostic =
    error instanceof Error
      ? {
          name: error.name,
          stack: error.stack?.split('\n').slice(1, 7),
          ...(error instanceof APIError
            ? {
                status: error.status,
                code: error.code,
                type: error.type,
                requestId: error.requestID,
              }
            : {}),
        }
      : { name: 'Unknown error.' };
  console.error('Chat request failed.', diagnostic);
  sendJson(response, 502, { error: 'The chat request could not be completed.' }, headers);
}

function sendMemoryError(
  response: ServerResponse,
  error: unknown,
  headers: Record<string, string>,
): void {
  if (error instanceof MemoryServiceError) {
    sendJson(response, error.statusCode, { error: error.message }, headers);
    return;
  }
  if (
    error instanceof Error &&
    (error.message === 'MEMORY_KEK is not configured.' ||
      error.message === 'MEMORY_KEK must be a base64-encoded 32-byte key.')
  ) {
    sendJson(response, 503, { error: error.message }, headers);
    return;
  }

  console.error(
    'Memory request failed.',
    error instanceof Error ? error.name : 'Unknown error.',
  );
  sendJson(response, 503, { error: 'Memory storage is unavailable.' }, headers);
}

function sendGmailError(
  response: ServerResponse,
  error: unknown,
  headers: Record<string, string>,
): void {
  if (error instanceof GmailServiceError) {
    sendJson(response, error.statusCode, { error: error.message }, headers);
    return;
  }
  console.error(
    'Google integration request failed.',
    error instanceof Error ? error.name : 'Unknown error.',
  );
  sendJson(
    response,
    502,
    { error: getGoogleOAuthErrorMessage(error) },
    headers,
  );
}

function sendHomeAssistantError(
  response: ServerResponse,
  error: unknown,
  headers: Record<string, string>,
): void {
  if (error instanceof HomeAssistantServiceError) {
    sendJson(response, error.statusCode, { error: error.message }, headers);
    return;
  }
  console.error(
    'Home Assistant request failed.',
    error instanceof Error ? error.name : 'Unknown error.',
  );
  sendJson(
    response,
    503,
    { error: 'Home Assistant is unavailable. Check its connection settings.' },
    headers,
  );
}

function sendRoutineError(
  response: ServerResponse,
  error: unknown,
  headers: Record<string, string>,
): void {
  if (error instanceof RoutineServiceError) {
    sendJson(response, error.statusCode, { error: error.message }, headers);
    return;
  }
  if (error instanceof ChatServiceError) {
    sendJson(response, error.statusCode, { error: error.message }, headers);
    return;
  }
  console.error(
    'Routine request failed.',
    error instanceof Error ? error.name : 'Unknown routine error.',
  );
  sendJson(response, 503, { error: 'The routine service is unavailable.' }, headers);
}
