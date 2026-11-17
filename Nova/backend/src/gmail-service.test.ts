import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGoogleOAuthState,
  GmailService,
  verifyGoogleOAuthState,
} from './gmail-service.js';

const userId = 'c0a80123-4567-489a-8bcd-ef0123456789';
const secret = 'a-google-client-secret-that-is-long-enough';

test('Google OAuth state is signed, profile-scoped, and expires after ten minutes', () => {
  const now = 1_800_000_000_000;
  const state = createGoogleOAuthState(userId, secret, now);

  assert.equal(verifyGoogleOAuthState(state, secret, now)?.userId, userId);
  assert.equal(verifyGoogleOAuthState(state, 'a-different-google-client-secret', now), null);
  assert.equal(verifyGoogleOAuthState(`${state}tampered`, secret, now), null);
  assert.equal(
    verifyGoogleOAuthState(state, secret, now + 10 * 60 * 1000),
    null,
  );
  assert.equal(verifyGoogleOAuthState(state, secret, now - 1), null);
});

test('Google authorization requests only Gmail read and calendar event scopes', () => {
  const previous = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI,
    appOrigin: process.env.NOVA_APP_ORIGIN,
  };
  process.env.GOOGLE_CLIENT_ID = 'google-client-id';
  process.env.GOOGLE_CLIENT_SECRET = secret;
  process.env.GOOGLE_OAUTH_REDIRECT_URI =
    'https://api.nova.example/api/integrations/google/callback';
  process.env.NOVA_APP_ORIGIN = 'https://nova.example';

  try {
    const url = new URL(
      new GmailService(async () => {
        throw new Error('No network is expected.');
      }).startAuthorization(userId),
    );
    const scopes = url.searchParams.get('scope')?.split(' ') ?? [];
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.equal(
      url.pathname,
      '/o/oauth2/v2/auth',
    );
    assert.deepEqual(scopes, [
      'openid',
      'email',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.events',
    ]);
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.ok(
      verifyGoogleOAuthState(
        url.searchParams.get('state') ?? '',
        secret,
      ),
    );
    assert.equal(scopes.some((scope) => /gmail\.(send|modify|compose)/.test(scope)), false);
  } finally {
    const restore = (
      key: string,
      value: string | undefined,
    ) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    };
    restore('GOOGLE_CLIENT_ID', previous.clientId);
    restore('GOOGLE_CLIENT_SECRET', previous.clientSecret);
    restore('GOOGLE_OAUTH_REDIRECT_URI', previous.redirectUri);
    restore('NOVA_APP_ORIGIN', previous.appOrigin);
  }
});

test('calendar APIs reject invalid dates and event details before database access', async () => {
  const service = new GmailService();
  await assert.rejects(
    service.listCalendarEvents(userId, 'not-a-date', 'also-not-a-date'),
    /Calendar date range must be valid/,
  );
  await assert.rejects(
    service.listCalendarEvents(
      userId,
      '2025-01-01T00:00:00.000Z',
      '2025-03-01T00:00:00.000Z',
    ),
    /Calendar date range must be valid/,
  );
  await assert.rejects(
    service.createCalendarEvent(userId, {
      title: 'Invalid event',
      start: '2025-01-02T10:00:00.000Z',
      end: '2025-01-02T09:00:00.000Z',
    }),
    /calendar event details are invalid/,
  );
});
