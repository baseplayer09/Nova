import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractMemoryCandidate,
  isSensitiveMemoryContent,
  MemoryService,
} from './memory-service.js';

test('only explicit remember requests create a memory candidate', () => {
  assert.equal(
    extractMemoryCandidate('Remember that I prefer tea.'),
    'I prefer tea.',
  );
  assert.equal(
    extractMemoryCandidate("Please don't forget: my meeting is on Friday."),
    'my meeting is on Friday.',
  );
  assert.equal(extractMemoryCandidate('I prefer tea.'), null);
  assert.equal(extractMemoryCandidate('Remember to call my doctor.'), null);
});

test('sensitive password, payment, and government ID details are blocked', () => {
  assert.equal(
    isSensitiveMemoryContent('My password is hunter2.'),
    true,
  );
  assert.equal(
    isSensitiveMemoryContent('My card is 4111 1111 1111 1111.'),
    true,
  );
  assert.equal(
    isSensitiveMemoryContent('My SSN is 123-45-6789.'),
    true,
  );
  assert.equal(
    isSensitiveMemoryContent('My ID number is 123456789.'),
    true,
  );
  assert.equal(isSensitiveMemoryContent('Remember my passwords.'), true);
  assert.equal(isSensitiveMemoryContent('I prefer tea.'), false);
});

test('blocked or absent proposals do not access the database', async () => {
  const service = new MemoryService();

  assert.deepEqual(await service.proposeFromText('not-a-uuid', 'Hello'), {
    status: 'none',
  });
  assert.deepEqual(
    await service.proposeFromText(
      'not-a-uuid',
      'Remember my password is hunter2.',
    ),
    {
      status: 'blocked',
      reason:
        "I can't save passwords, PINs, payment details, or government ID information as memories.",
    },
  );
});
