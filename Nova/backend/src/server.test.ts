import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { APIError } from 'openai';
import { createApp } from './server.js';

test('GET /health returns a successful status', async () => {
  const server = createApp();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('GET /api/auth/session rejects a missing bearer token', async () => {
  const server = createApp();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/session`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'A bearer access token is required.' });
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('POST /api/auth/sign-in rejects missing email and password', async () => {
  const server = createApp();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Email and password are required.' });
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('session bootstrap forwards the bearer token and returns the user profile', async () => {
  let receivedAuthorization: string | undefined;
  const server = createApp({
    supabaseUrl: 'https://nova.supabase.co',
    supabaseAnonKey: 'test-anon-key',
    fetch: async (_input, init) => {
      receivedAuthorization = new Headers(init?.headers).get('Authorization') ?? undefined;
      return Response.json({
        id: 'user-123',
        email: 'nova@example.com',
        created_at: '2026-01-01T00:00:00Z',
        user_metadata: { display_name: 'Nova' },
      });
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/session`, {
      headers: { Authorization: 'Bearer access-token' },
    });

    assert.equal(response.status, 200);
    assert.equal(receivedAuthorization, 'Bearer access-token');
    assert.deepEqual(await response.json(), {
      user: {
        id: 'user-123',
        email: 'nova@example.com',
        created_at: '2026-01-01T00:00:00Z',
        user_metadata: { display_name: 'Nova' },
      },
    });
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('GET /api/profile returns the authenticated user profile from the database', async () => {
  const userId = 'c0a80123-4567-489a-8bcd-ef0123456789';
  const createdAt = new Date('2026-01-01T00:00:00Z');
  let requestedProfileId: string | undefined;
  const server = createApp({
    supabaseUrl: 'https://nova.supabase.co',
    supabaseAnonKey: 'test-anon-key',
    fetch: async () =>
      Response.json({
        id: userId,
        email: 'nova@example.com',
        user_metadata: { display_name: 'Old metadata value' },
      }),
    profileReader: async (profileId) => {
      requestedProfileId = profileId;
      return { id: userId, displayName: 'Nova', createdAt };
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/profile`, {
      headers: { Authorization: 'Bearer access-token' },
    });

    assert.equal(response.status, 200);
    assert.equal(requestedProfileId, userId);
    assert.deepEqual(await response.json(), {
      id: userId,
      email: 'nova@example.com',
      metadata: { display_name: 'Old metadata value' },
      display_name: 'Nova',
      created_at: createdAt.toISOString(),
    });
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('PIN routes require a verified account and use its profile ID', async () => {
  const userId = 'c0a80123-4567-489a-8bcd-ef0123456789';
  const calls: Array<{ operation: string; userId: string; pin?: string }> = [];
  const server = createApp({
    supabaseUrl: 'https://nova.supabase.co',
    supabaseAnonKey: 'test-anon-key',
    fetch: async () => Response.json({ id: userId, email: 'nova@example.com' }),
    pinService: {
      getStatus: async (profileId) => {
        calls.push({ operation: 'status', userId: profileId });
        return { configured: false };
      },
      setup: async (profileId, pin) => {
        calls.push({ operation: 'setup', userId: profileId, pin });
        return 'setup-unlock-token';
      },
      verify: async (profileId, pin) => {
        calls.push({ operation: 'verify', userId: profileId, pin });
        return pin === '654321'
          ? { status: 'invalid', attemptsRemaining: 3 }
          : { status: 'verified', unlockToken: 'verified-unlock-token' };
      },
      refreshUnlockToken: () => null,
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const status = await fetch(`http://127.0.0.1:${address.port}/api/pin/status`, {
      headers: { Authorization: 'Bearer access-token' },
    });
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { configured: false });

    const setup = await fetch(`http://127.0.0.1:${address.port}/api/pin/setup`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pin: '001234' }),
    });
    assert.equal(setup.status, 201);
    assert.deepEqual(await setup.json(), {
      configured: true,
      unlock_token: 'setup-unlock-token',
    });

    const verify = await fetch(`http://127.0.0.1:${address.port}/api/pin/verify`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pin: '654321' }),
    });
    assert.equal(verify.status, 401);
    assert.deepEqual(await verify.json(), {
      verified: false,
      attempts_remaining: 3,
    });

    const verified = await fetch(
      `http://127.0.0.1:${address.port}/api/pin/verify`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer access-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ pin: '001234' }),
      },
    );
    assert.equal(verified.status, 200);
    assert.deepEqual(await verified.json(), {
      verified: true,
      unlock_token: 'verified-unlock-token',
    });

    assert.deepEqual(calls, [
      { operation: 'status', userId },
      { operation: 'setup', userId, pin: '001234' },
      { operation: 'verify', userId, pin: '654321' },
      { operation: 'verify', userId, pin: '001234' },
    ]);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('PIN setup rejects invalid PINs before calling the PIN service', async () => {
  let calledPinService = false;
  const userId = 'c0a80123-4567-489a-8bcd-ef0123456789';
  const server = createApp({
    supabaseUrl: 'https://nova.supabase.co',
    supabaseAnonKey: 'test-anon-key',
    fetch: async () => Response.json({ id: userId }),
    pinService: {
      getStatus: async () => ({ configured: false }),
      setup: async () => {
        calledPinService = true;
        return 'setup-unlock-token';
      },
      verify: async () => ({
        status: 'verified',
        unlockToken: 'verified-unlock-token',
      }),
      refreshUnlockToken: () => null,
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/pin/setup`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pin: '12345' }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'PIN must contain exactly six digits.',
    });
    assert.equal(calledPinService, false);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('chat requests require and renew a matching PIN unlock session', async () => {
  const userId = 'c0a80123-4567-489a-8bcd-ef0123456789';
  let chatCallCount = 0;
  let failChatRequest = false;
  const server = createApp({
    supabaseUrl: 'https://nova.supabase.co',
    supabaseAnonKey: 'test-anon-key',
    fetch: async () => Response.json({ id: userId }),
    pinService: {
      getStatus: async () => ({ configured: true }),
      setup: async () => 'setup-unlock-token',
      verify: async () => ({
        status: 'verified',
        unlockToken: 'verified-unlock-token',
      }),
      refreshUnlockToken: (_profileId, token) =>
        token === 'valid-unlock-token' ? 'renewed-unlock-token' : null,
    },
    chatService: {
      sendMessage: async () => {
        chatCallCount += 1;
        if (failChatRequest) {
          throw new APIError(
            401,
            {
              code: 'invalid_api_key',
              message: 'private upstream details',
              type: 'authentication_error',
            },
            'private upstream details',
            new Headers({ 'x-request-id': 'req_test' }),
          );
        }
        return { conversationId: 'conversation-id', messages: [] };
      },
      listConversations: async () => [],
      getMessages: async () => [],
      deleteConversation: async () => {},
      clearConversations: async () => {},
    },
    memoryService: {
      proposeFromText: async (_profileId, message) =>
        message === 'Remember that I prefer tea.'
          ? {
              status: 'pending',
              proposal: {
                id: 'memory-id',
                category: 'preference',
                text: 'I prefer tea.',
                createdAt: new Date('2025-01-01T00:00:00.000Z'),
                approvedAt: null,
              },
            }
          : { status: 'none' },
      listPending: async () => [],
      listApproved: async () => [],
      approve: async () => {
        throw new Error('Not used in this test.');
      },
      decline: async () => {},
      deleteApproved: async () => {},
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const requestUrl = `http://127.0.0.1:${address.port}/api/chat`;
    const locked = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: 'Hello' }),
    });
    assert.equal(locked.status, 423);
    assert.equal(chatCallCount, 0);

    const unlocked = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
        'X-Nova-Unlock-Token': 'valid-unlock-token',
      },
      body: JSON.stringify({ message: 'Hello' }),
    });
    assert.equal(unlocked.status, 200);
    assert.equal(unlocked.headers.get('X-Nova-Unlock-Token'), 'renewed-unlock-token');
    assert.deepEqual(await unlocked.json(), {
      conversationId: 'conversation-id',
      messages: [],
      memoryProposal: { status: 'none' },
    });
    assert.equal(chatCallCount, 1);

    const proposalResponse = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
        'X-Nova-Unlock-Token': 'valid-unlock-token',
      },
      body: JSON.stringify({ message: 'Remember that I prefer tea.' }),
    });
    assert.deepEqual(await proposalResponse.json(), {
      conversationId: 'conversation-id',
      messages: [],
      memoryProposal: {
        status: 'pending',
        proposal: {
          id: 'memory-id',
          category: 'preference',
          text: 'I prefer tea.',
          createdAt: '2025-01-01T00:00:00.000Z',
          approvedAt: null,
        },
      },
    });
    assert.equal(chatCallCount, 2);

    const invalidJson = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
        'X-Nova-Unlock-Token': 'valid-unlock-token',
      },
      body: '{',
    });
    assert.equal(invalidJson.status, 400);
    assert.deepEqual(await invalidJson.json(), {
      error: 'Request body must be valid JSON.',
    });
    assert.equal(chatCallCount, 2);

    failChatRequest = true;
    const loggedArguments: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      loggedArguments.push(args);
    };
    try {
      const failedChat = await fetch(requestUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer access-token',
          'Content-Type': 'application/json',
          'X-Nova-Unlock-Token': 'valid-unlock-token',
        },
        body: JSON.stringify({ message: 'Hello' }),
      });
      assert.equal(failedChat.status, 502);
      assert.deepEqual(await failedChat.json(), {
        error: 'The chat request could not be completed.',
      });
    } finally {
      console.error = originalConsoleError;
    }
    const loggedOutput = JSON.stringify(loggedArguments);
    assert.match(loggedOutput, /Chat request failed/);
    assert.match(loggedOutput, /sendMessage/);
    assert.match(loggedOutput, /"status":401/);
    assert.match(loggedOutput, /"code":"invalid_api_key"/);
    assert.match(loggedOutput, /"type":"authentication_error"/);
    assert.match(loggedOutput, /"requestId":"req_test"/);
    assert.doesNotMatch(loggedOutput, /private upstream details/);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('conversation history and deletion routes call the user-scoped chat service', async () => {
  const userId = 'c0a80123-4567-489a-8bcd-ef0123456789';
  const conversationId = '123e4567-e89b-42d3-a456-426614174000';
  const calls: string[] = [];
  const server = createApp({
    supabaseUrl: 'https://nova.supabase.co',
    supabaseAnonKey: 'test-anon-key',
    fetch: async () => Response.json({ id: userId }),
    pinService: {
      getStatus: async () => ({ configured: true }),
      setup: async () => 'setup-unlock-token',
      verify: async () => ({
        status: 'verified',
        unlockToken: 'verified-unlock-token',
      }),
      refreshUnlockToken: (_profileId, token) =>
        token === 'valid-unlock-token' ? 'renewed-unlock-token' : null,
    },
    chatService: {
      sendMessage: async () => ({ conversationId, messages: [] }),
      listConversations: async (profileId) => {
        calls.push(`list:${profileId}`);
        return [{ id: conversationId, createdAt: new Date('2025-01-01T00:00:00.000Z') }];
      },
      getMessages: async (profileId, id) => {
        calls.push(`messages:${profileId}:${id}`);
        return [];
      },
      deleteConversation: async (profileId, id) => {
        calls.push(`delete:${profileId}:${id}`);
      },
      clearConversations: async (profileId) => {
        calls.push(`clear:${profileId}`);
      },
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const request = (path: string, method = 'GET') =>
      fetch(`http://127.0.0.1:${address.port}${path}`, {
        method,
        headers: {
          Authorization: 'Bearer access-token',
          'X-Nova-Unlock-Token': 'valid-unlock-token',
        },
      });

    const listResponse = await request('/api/conversations');
    assert.equal(listResponse.status, 200);
    assert.equal(
      listResponse.headers.get('X-Nova-Unlock-Token'),
      'renewed-unlock-token',
    );
    assert.deepEqual(await listResponse.json(), {
      conversations: [
        { id: conversationId, createdAt: '2025-01-01T00:00:00.000Z' },
      ],
    });

    const messagesResponse = await request(
      `/api/conversations/${conversationId}/messages`,
    );
    assert.deepEqual(await messagesResponse.json(), { messages: [] });
    assert.equal(
      (await request(`/api/conversations/${conversationId}`, 'DELETE')).status,
      200,
    );
    assert.equal((await request('/api/conversations', 'DELETE')).status, 200);
    assert.deepEqual(calls, [
      `list:${userId}`,
      `messages:${userId}:${conversationId}`,
      `delete:${userId}:${conversationId}`,
      `clear:${userId}`,
    ]);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('account deletion requires the PIN grant and explicit confirmation', async () => {
  const userId = 'c0a80123-4567-489a-8bcd-ef0123456789';
  const calls: Array<{ userId: string; email: string; password: string }> = [];
  const server = createApp({
    supabaseUrl: 'https://nova.supabase.co',
    supabaseAnonKey: 'test-anon-key',
    fetch: async () => Response.json({ id: userId, email: 'nova@example.com' }),
    pinService: {
      getStatus: async () => ({ configured: true }),
      setup: async () => 'setup-unlock-token',
      verify: async () => ({
        status: 'verified',
        unlockToken: 'verified-unlock-token',
      }),
      refreshUnlockToken: (_profileId, token) =>
        token === 'valid-unlock-token' ? 'renewed-unlock-token' : null,
    },
    accountDeleter: async (accountId, email, password) => {
      calls.push({ userId: accountId, email, password });
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const url = `http://127.0.0.1:${address.port}/api/account`;
    const headers = {
      Authorization: 'Bearer access-token',
      'Content-Type': 'application/json',
      'X-Nova-Unlock-Token': 'valid-unlock-token',
    };
    const unconfirmed = await fetch(url, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ password: 'password', confirmation: 'delete' }),
    });
    assert.equal(unconfirmed.status, 400);
    assert.deepEqual(await unconfirmed.json(), {
      error: 'Type DELETE to confirm account removal.',
    });
    assert.deepEqual(calls, []);

    const deleted = await fetch(url, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ password: 'password', confirmation: 'DELETE' }),
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { deleted: true });
    assert.deepEqual(calls, [
      { userId, email: 'nova@example.com', password: 'password' },
    ]);

    const locked = await fetch(url, {
      method: 'DELETE',
      headers: { ...headers, 'X-Nova-Unlock-Token': 'invalid-token' },
      body: JSON.stringify({ password: 'password', confirmation: 'DELETE' }),
    });
    assert.equal(locked.status, 423);
    assert.equal(calls.length, 1);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('memory list, approval, decline, export, and deletion routes require the PIN grant', async () => {
  const userId = 'c0a80123-4567-489a-8bcd-ef0123456789';
  const memoryId = '123e4567-e89b-42d3-a456-426614174000';
  const calls: string[] = [];
  const server = createApp({
    supabaseUrl: 'https://nova.supabase.co',
    supabaseAnonKey: 'test-anon-key',
    fetch: async () => Response.json({ id: userId }),
    pinService: {
      getStatus: async () => ({ configured: true }),
      setup: async () => 'setup-unlock-token',
      verify: async () => ({
        status: 'verified',
        unlockToken: 'verified-unlock-token',
      }),
      refreshUnlockToken: (_profileId, token) =>
        token === 'valid-unlock-token' ? 'renewed-unlock-token' : null,
    },
    chatService: {
      sendMessage: async () => ({ conversationId: 'conversation-id', messages: [] }),
      listConversations: async () => [],
      getMessages: async () => [],
      deleteConversation: async () => {},
      clearConversations: async () => {},
    },
    memoryService: {
      proposeFromText: async () => ({ status: 'none' }),
      listPending: async (profileId) => {
        calls.push(`pending:${profileId}`);
        return [];
      },
      listApproved: async (profileId, search) => {
        calls.push(`approved:${profileId}:${search}`);
        return [];
      },
      approve: async (profileId, id) => {
        calls.push(`approve:${profileId}:${id}`);
        return {
          id,
          category: 'preference',
          text: 'I prefer tea.',
          createdAt: new Date('2025-01-01T00:00:00.000Z'),
          approvedAt: new Date('2025-01-01T00:00:00.000Z'),
        };
      },
      decline: async (profileId, id) => {
        calls.push(`decline:${profileId}:${id}`);
      },
      deleteApproved: async (profileId, id) => {
        calls.push(`delete:${profileId}:${id}`);
      },
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const request = (
      path: string,
      method = 'GET',
      unlockToken: string | null = 'valid-unlock-token',
    ) =>
      fetch(`http://127.0.0.1:${address.port}${path}`, {
        method,
        headers: {
          Authorization: 'Bearer access-token',
          ...(unlockToken
            ? { 'X-Nova-Unlock-Token': unlockToken }
            : {}),
        },
      });

    const lockedResponse = await request('/api/memories/pending', 'GET', null);
    assert.equal(lockedResponse.status, 423);
    assert.equal(calls.length, 0);

    assert.equal((await request('/api/memories?search=tea')).status, 200);
    assert.equal((await request('/api/memories/pending')).status, 200);
    assert.equal((await request('/api/memories/export')).status, 200);
    assert.equal((await request(`/api/memories/${memoryId}/approve`, 'POST')).status, 200);
    assert.equal((await request(`/api/memories/${memoryId}/decline`, 'POST')).status, 200);
    assert.equal((await request(`/api/memories/${memoryId}`, 'DELETE')).status, 200);
    assert.deepEqual(calls, [
      `approved:${userId}:tea`,
      `pending:${userId}`,
      `approved:${userId}:`,
      `approve:${userId}:${memoryId}`,
      `decline:${userId}:${memoryId}`,
      `delete:${userId}:${memoryId}`,
    ]);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('Google connection and Gmail search routes require PIN authorization', async () => {
  const userId = 'c0a80123-4567-489a-8bcd-ef0123456789';
  const calls: string[] = [];
  const server = createApp({
    supabaseUrl: 'https://nova.supabase.co',
    supabaseAnonKey: 'test-anon-key',
    fetch: async () => Response.json({ id: userId }),
    pinService: {
      getStatus: async () => ({ configured: true }),
      setup: async () => 'setup-unlock-token',
      verify: async () => ({
        status: 'verified',
        unlockToken: 'verified-unlock-token',
      }),
      refreshUnlockToken: (_profileId, token) =>
        token === 'valid-unlock-token' ? 'renewed-unlock-token' : null,
    },
    chatService: {
      sendMessage: async () => ({ conversationId: 'conversation-id', messages: [] }),
      listConversations: async () => [],
      getMessages: async () => [],
      deleteConversation: async () => {},
      clearConversations: async () => {},
    },
    gmailService: {
      getStatus: async (profileId) => {
        calls.push(`status:${profileId}`);
        return { connected: true };
      },
      startAuthorization: (profileId) => {
        calls.push(`connect:${profileId}`);
        return 'https://accounts.google.com/o/oauth2/v2/auth?scope=gmail.readonly';
      },
      completeAuthorization: async (code, state) => {
        calls.push(`callback:${code}:${state}`);
        return { redirectUrl: 'https://nova.example/?gmail=connected' };
      },
      disconnect: async (profileId) => {
        calls.push(`disconnect:${profileId}`);
      },
      searchMessages: async (profileId, query) => {
        calls.push(`search:${profileId}:${query}`);
        return [
          {
            id: 'gmail-message',
            subject: 'Design review',
            from: 'person@example.com',
            date: 'Mon, 1 Jan 2025 09:00:00 +0000',
            snippet: 'Review moved to Friday.',
          },
        ];
      },
      listCalendarEvents: async (profileId, timeMin, timeMax) => {
        calls.push(`calendar:${profileId}:${timeMin}:${timeMax}`);
        return [
          {
            id: 'calendar-event',
            title: 'Design review',
            start: '2025-01-01T10:00:00.000Z',
            end: '2025-01-01T10:30:00.000Z',
            location: 'Studio',
          },
        ];
      },
      createCalendarEvent: async (profileId, event) => {
        calls.push(`calendar-create:${profileId}:${event.title}`);
        return {
          id: 'created-event',
          title: event.title,
          start: event.start,
          end: event.end,
          location: event.location ?? '',
        };
      },
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const request = (path: string, method = 'GET', withPin = true) =>
      fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: 'Bearer access-token',
          ...(withPin ? { 'X-Nova-Unlock-Token': 'valid-unlock-token' } : {}),
        },
      });

    assert.equal(
      (await request('/api/integrations/google', 'GET', false)).status,
      423,
    );
    const status = await request('/api/integrations/google');
    assert.deepEqual(await status.json(), { connected: true });

    const connect = await request('/api/integrations/google/connect', 'POST');
    assert.deepEqual(await connect.json(), {
      authorization_url:
        'https://accounts.google.com/o/oauth2/v2/auth?scope=gmail.readonly',
    });

    const search = await request(
      '/api/integrations/gmail/messages?q=from%3Amanager%40example.com',
    );
    assert.deepEqual(await search.json(), {
      messages: [
        {
          id: 'gmail-message',
          subject: 'Design review',
          from: 'person@example.com',
          date: 'Mon, 1 Jan 2025 09:00:00 +0000',
          snippet: 'Review moved to Friday.',
        },
      ],
    });
    const timeMin = '2025-01-01T00:00:00.000Z';
    const timeMax = '2025-01-08T00:00:00.000Z';
    const calendar = await request(
      `/api/integrations/calendar/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`,
    );
    assert.deepEqual(await calendar.json(), {
      events: [
        {
          id: 'calendar-event',
          title: 'Design review',
          start: '2025-01-01T10:00:00.000Z',
          end: '2025-01-01T10:30:00.000Z',
          location: 'Studio',
        },
      ],
    });

    const unapprovedCreate = await fetch(
      `${baseUrl}/api/integrations/calendar/events`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer access-token',
          'Content-Type': 'application/json',
          'X-Nova-Unlock-Token': 'valid-unlock-token',
        },
        body: JSON.stringify({
          title: 'Review',
          start: timeMin,
          end: timeMax,
          approved: false,
        }),
      },
    );
    assert.equal(unapprovedCreate.status, 400);
    const create = await fetch(`${baseUrl}/api/integrations/calendar/events`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
        'X-Nova-Unlock-Token': 'valid-unlock-token',
      },
      body: JSON.stringify({
        title: 'Planning',
        start: timeMin,
        end: timeMax,
        approved: true,
      }),
    });
    assert.equal(create.status, 201);
    assert.deepEqual(await create.json(), {
      event: {
        id: 'created-event',
        title: 'Planning',
        start: timeMin,
        end: timeMax,
        location: '',
      },
    });
    assert.equal((await request('/api/integrations/google', 'DELETE')).status, 200);

    const callback = await fetch(
      `${baseUrl}/api/integrations/google/callback?code=auth-code&state=signed-state`,
      { redirect: 'manual' },
    );
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), 'https://nova.example/?gmail=connected');
    assert.deepEqual(calls, [
      `status:${userId}`,
      `connect:${userId}`,
      `search:${userId}:from:manager@example.com`,
      `calendar:${userId}:${timeMin}:${timeMax}`,
      `calendar-create:${userId}:Planning`,
      `disconnect:${userId}`,
      'callback:auth-code:signed-state',
    ]);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('Home Assistant actions require explicit approval and an immediate PIN check for locks and alarms', async () => {
  const userId = 'c0a80123-4567-489a-8bcd-ef0123456789';
  const verifiedPins: string[] = [];
  const actions: Array<{ domain: string; entityId: string; pinVerified: boolean }> = [];
  const server = createApp({
    supabaseUrl: 'https://nova.supabase.co',
    supabaseAnonKey: 'test-anon-key',
    fetch: async () => Response.json({ id: userId }),
    pinService: {
      getStatus: async () => ({ configured: true }),
      setup: async () => 'setup-unlock-token',
      verify: async (_profileId, pin) => {
        verifiedPins.push(pin);
        return pin === '123456'
          ? { status: 'verified', unlockToken: 'fresh-unlock-token' }
          : { status: 'invalid', attemptsRemaining: 3 };
      },
      refreshUnlockToken: (_profileId, token) =>
        token === 'valid-unlock-token' ? 'renewed-unlock-token' : null,
    },
    homeAssistantService: {
      getStatus: async () => ({ connected: true }),
      connect: async () => {},
      disconnect: async () => {},
      listEntities: async () => [
        {
          entityId: 'lock.front_door',
          name: 'Front door',
          state: 'locked',
        },
      ],
      performAction: async (_profileId, input, pinVerified) => {
        actions.push({
          domain: input.domain,
          entityId: input.entityId,
          pinVerified,
        });
        return { completed: true };
      },
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const url = `http://127.0.0.1:${address.port}/api/integrations/home-assistant`;
    const headers = {
      Authorization: 'Bearer access-token',
      'Content-Type': 'application/json',
      'X-Nova-Unlock-Token': 'valid-unlock-token',
    };
    const status = await fetch(url, { headers });
    assert.deepEqual(await status.json(), { connected: true });

    const entities = await fetch(`${url}/entities`, { headers });
    assert.deepEqual(await entities.json(), {
      entities: [
        { entityId: 'lock.front_door', name: 'Front door', state: 'locked' },
      ],
    });

    const unapproved = await fetch(`${url}/actions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        domain: 'light',
        service: 'turn_off',
        entity_id: 'light.kitchen',
        approved: false,
      }),
    });
    assert.equal(unapproved.status, 400);
    assert.deepEqual(actions, []);

    const wrongPin = await fetch(`${url}/actions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        domain: 'lock',
        service: 'unlock',
        entity_id: 'lock.front_door',
        approved: true,
        pin: '654321',
      }),
    });
    assert.equal(wrongPin.status, 401);
    assert.deepEqual(actions, []);

    const unlock = await fetch(`${url}/actions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        domain: 'lock',
        service: 'unlock',
        entity_id: 'lock.front_door',
        approved: true,
        pin: '123456',
      }),
    });
    assert.deepEqual(await unlock.json(), { completed: true });
    assert.deepEqual(verifiedPins, ['654321', '123456']);
    assert.deepEqual(actions, [
      {
        domain: 'lock',
        entityId: 'lock.front_door',
        pinVerified: true,
      },
    ]);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('routine endpoints require a PIN grant and explicit approval to run a task', async () => {
  const userId = 'c0a80123-4567-489a-8bcd-ef0123456789';
  const calls: string[] = [];
  const routineResult = {
    id: 'routine-id',
    title: 'Morning briefing',
    timezone: 'UTC',
    localTime: '07:30',
    scheduleDays: [1, 2, 3, 4, 5],
    nextRunAt: new Date('2025-01-06T07:30:00Z'),
    enabled: true,
    createdAt: new Date('2025-01-01T00:00:00Z'),
  };
  const server = createApp({
    supabaseUrl: 'https://nova.supabase.co',
    supabaseAnonKey: 'test-anon-key',
    fetch: async () => Response.json({ id: userId }),
    pinService: {
      getStatus: async () => ({ configured: true }),
      setup: async () => 'setup-unlock-token',
      verify: async () => ({
        status: 'verified',
        unlockToken: 'fresh-unlock-token',
      }),
      refreshUnlockToken: (_profileId, token) =>
        token === 'valid-unlock-token' ? 'renewed-unlock-token' : null,
    },
    routineService: {
      list: async (profileId) => {
        calls.push(`list:${profileId}`);
        return [routineResult];
      },
      create: async (profileId, input) => {
        calls.push(`create:${profileId}:${String(input.title)}`);
        return { ...routineResult, title: String(input.title) };
      },
      setEnabled: async () => {
        throw new Error('Not expected in this test.');
      },
      delete: async () => {},
      listRuns: async (profileId) => {
        calls.push(`runs:${profileId}`);
        return [];
      },
      runNow: async (profileId, runId, approved) => {
        calls.push(`run:${profileId}:${runId}:${approved}`);
        return {
          conversationId: 'conversation-id',
          messages: [],
        };
      },
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const url = `http://127.0.0.1:${address.port}/api/routines`;
    const headers = {
      Authorization: 'Bearer access-token',
      'Content-Type': 'application/json',
      'X-Nova-Unlock-Token': 'valid-unlock-token',
    };
    const list = await fetch(url, { headers });
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), {
      routines: [
        {
          ...routineResult,
          nextRunAt: routineResult.nextRunAt.toISOString(),
          createdAt: routineResult.createdAt.toISOString(),
        },
      ],
    });

    const noUnlock = await fetch(url, {
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
      },
    });
    assert.equal(noUnlock.status, 423);

    const create = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: 'Morning briefing',
        prompt: 'Summarize my calendar.',
        timezone: 'UTC',
        local_time: '07:30',
        schedule_days: [1, 2, 3, 4, 5],
      }),
    });
    assert.equal(create.status, 201);

    const unapproved = await fetch(
      `${url}/runs/123e4567-e89b-42d3-a456-426614174000/run`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ approved: false }),
      },
    );
    assert.equal(unapproved.status, 400);

    const run = await fetch(
      `${url}/runs/123e4567-e89b-42d3-a456-426614174000/run`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ approved: true }),
      },
    );
    assert.equal(run.status, 200);
    assert.deepEqual(await run.json(), {
      conversationId: 'conversation-id',
      messages: [],
    });
    assert.deepEqual(calls, [
      `list:${userId}`,
      `create:${userId}:Morning briefing`,
      `run:${userId}:123e4567-e89b-42d3-a456-426614174000:true`,
    ]);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('auth status relays an invalid-token status and sign-out forwards the token', async () => {
  const forwardedRequests: Array<{ url: string; method: string; authorization: string | null }> =
    [];
  const server = createApp({
    supabaseUrl: 'https://nova.supabase.co',
    supabaseAnonKey: 'test-anon-key',
    fetch: async (input, init) => {
      forwardedRequests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        authorization: new Headers(init?.headers).get('Authorization'),
      });
      return new Response(null, { status: 401 });
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const status = await fetch(`http://127.0.0.1:${address.port}/api/auth/status`, {
      headers: { Authorization: 'Bearer expired-token' },
    });
    assert.equal(status.status, 401);
    assert.deepEqual(await status.json(), { authenticated: false });

    const signOut = await fetch(
      `http://127.0.0.1:${address.port}/api/auth/sign-out`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer access-token' },
      },
    );
    assert.equal(signOut.status, 401);
    assert.deepEqual(forwardedRequests, [
      {
        url: 'https://nova.supabase.co/auth/v1/user',
        method: 'GET',
        authorization: 'Bearer expired-token',
      },
      {
        url: 'https://nova.supabase.co/auth/v1/logout',
        method: 'POST',
        authorization: 'Bearer access-token',
      },
    ]);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('auth endpoints reject missing bearer tokens without calling Supabase', async () => {
  let calledSupabase = false;
  const server = createApp({
    supabaseUrl: 'https://nova.supabase.co',
    supabaseAnonKey: 'test-anon-key',
    fetch: async () => {
      calledSupabase = true;
      return Response.json({});
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/session`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: 'A bearer access token is required.',
    });
    assert.equal(calledSupabase, false);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
