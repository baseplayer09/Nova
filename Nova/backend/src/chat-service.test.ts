import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildChatPrompt,
  ChatService,
  ChatServiceError,
} from './chat-service.js';

test('chat prompt includes recent history in chronological order', () => {
  const prompt = buildChatPrompt(
    [
      { role: 'user', content: 'Remember the project name?' },
      { role: 'assistant', content: 'The project is NOVA.' },
    ],
    'What did I say?',
  );

  assert.equal(
    prompt,
    'Conversation so far:\n' +
      'user: Remember the project name?\n' +
      'assistant: The project is NOVA.\n\n' +
      'User: What did I say?',
  );
});

test('chat prompt keeps the newest history within its size bound', () => {
  const prompt = buildChatPrompt(
    [
      { role: 'user', content: 'old'.repeat(8_000) },
      { role: 'assistant', content: 'recent context' },
    ],
    'Continue',
  );

  assert.equal(prompt.includes('oldoldold'), false);
  assert.equal(prompt.includes('assistant: recent context'), true);
  assert.equal(prompt.endsWith('User: Continue'), true);
  assert.ok(prompt.length <= 20_000);
});

test('chat rejects invalid messages and conversation IDs before database access', async () => {
  const service = new ChatService({
    generateText: async () => 'This provider should not be called.',
  });

  await assert.rejects(
    service.sendMessage(
      'c0a80123-4567-489a-8bcd-ef0123456789',
      'Hello',
      'not-a-uuid',
    ),
    (error: unknown) =>
      error instanceof ChatServiceError && error.statusCode === 400,
  );
  await assert.rejects(
    service.sendMessage('c0a80123-4567-489a-8bcd-ef0123456789', ''),
    (error: unknown) =>
      error instanceof ChatServiceError && error.statusCode === 400,
  );
});
