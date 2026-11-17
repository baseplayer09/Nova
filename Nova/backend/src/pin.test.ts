import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPinUnlockToken,
  isPinUnlockTokenValid,
  isValidPin,
  nextFailedPinAttempt,
  PinService,
} from './pin.js';

const userId = 'c0a80123-4567-489a-8bcd-ef0123456789';
const otherUserId = '12b3d456-7890-4abc-8def-0123456789ab';

test('only six decimal digits are accepted as a PIN', () => {
  assert.equal(isValidPin('012345'), true);
  assert.equal(isValidPin('12345'), false);
  assert.equal(isValidPin('1234567'), false);
  assert.equal(isValidPin('12a456'), false);
  assert.equal(isValidPin(123456), false);
});

test('the fifth failed attempt starts a fifteen-minute lockout', () => {
  const now = 1_800_000_000_000;
  const result = nextFailedPinAttempt(4, now);

  assert.equal(result.failedAttempts, 5);
  assert.equal(result.lockedUntil?.getTime(), now + 15 * 60 * 1000);
  assert.deepEqual(result.result, {
    status: 'locked',
    retryAfterMs: 15 * 60 * 1000,
  });
});

test('failed attempts before lockout report the remaining tries', () => {
  const result = nextFailedPinAttempt(2, 1_800_000_000_000);

  assert.equal(result.failedAttempts, 3);
  assert.equal(result.lockedUntil, null);
  assert.deepEqual(result.result, {
    status: 'invalid',
    attemptsRemaining: 2,
  });
});

test('PIN unlock tokens are signed, user-scoped, and expire after fifteen minutes', () => {
  const pepper = 'a-test-only-pepper-with-at-least-32-characters';
  const now = 1_800_000_000_000;
  const token = createPinUnlockToken(userId, pepper, now);

  assert.equal(isPinUnlockTokenValid(userId, token, pepper, now), true);
  assert.equal(isPinUnlockTokenValid(otherUserId, token, pepper, now), false);
  assert.equal(
    isPinUnlockTokenValid(userId, token, 'a-different-pepper-that-is-also-long', now),
    false,
  );
  assert.equal(isPinUnlockTokenValid(userId, token, pepper, now + 900_000), false);

  const tamperedToken = `${token.slice(0, -1)}x`;
  assert.equal(isPinUnlockTokenValid(userId, tamperedToken, pepper, now), false);
});

test('PIN unlock renewal only accepts a current token for the same profile', () => {
  const pepper = 'a-test-only-pepper-with-at-least-32-characters';
  const now = 1_800_000_000_000;
  const token = createPinUnlockToken(userId, pepper, now);
  const service = new PinService(undefined, () => pepper, () => now);

  assert.equal(service.refreshUnlockToken(userId, token), token);
  assert.equal(service.refreshUnlockToken(otherUserId, token), null);
  assert.equal(service.refreshUnlockToken(userId, 'not-a-token'), null);
  const expiredService = new PinService(
    undefined,
    () => pepper,
    () => now + 15 * 60 * 1000,
  );
  assert.equal(expiredService.refreshUnlockToken(userId, token), null);
});
