import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HomeAssistantService,
  HomeAssistantServiceError,
} from './home-assistant-service.js';

test('Home Assistant rejects missing approval and unapproved actions before database access', async () => {
  const service = new HomeAssistantService();
  await assert.rejects(
    service.performAction(
      'profile-id',
      {
        domain: 'light',
        service: 'turn_on',
        entityId: 'light.kitchen',
        approved: false,
      },
      false,
    ),
    (error: unknown) =>
      error instanceof HomeAssistantServiceError &&
      error.statusCode === 400 &&
      /not approved/.test(error.message),
  );
  await assert.rejects(
    service.performAction(
      'profile-id',
      {
        domain: 'light',
        service: 'turn_on',
        entityId: 'switch.kitchen',
        approved: true,
      },
      false,
    ),
    /invalid or was not approved/,
  );
});

test('locks and alarms require a freshly verified PIN before contacting Home Assistant', async () => {
  const service = new HomeAssistantService(async () => {
    throw new Error('Home Assistant must not be contacted.');
  });
  for (const [domain, serviceName, entityId] of [
    ['lock', 'unlock', 'lock.front_door'],
    ['alarm_control_panel', 'alarm_disarm', 'alarm_control_panel.house'],
  ]) {
    await assert.rejects(
      service.performAction(
        'profile-id',
        { domain, service: serviceName, entityId, approved: true },
        false,
      ),
      (error: unknown) =>
        error instanceof HomeAssistantServiceError &&
        error.statusCode === 403 &&
        /Enter your PIN/.test(error.message),
    );
  }
});

test('Home Assistant connection rejects malformed tokens before network access', async () => {
  let fetchCalled = false;
  const service = new HomeAssistantService(async () => {
    fetchCalled = true;
    throw new Error('No network is expected.');
  });
  await assert.rejects(
    service.connect('profile-id', 'short'),
    /valid Home Assistant access token/,
  );
  assert.equal(fetchCalled, false);
});
