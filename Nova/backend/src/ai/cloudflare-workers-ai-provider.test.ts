import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CloudflareWorkersAiError,
  CloudflareWorkersAiProvider,
} from './cloudflare-workers-ai-provider.js';
import { novaSystemPrompt } from './ai-provider.js';

test('Cloudflare Workers AI sends NOVA chat messages and returns the model response', async () => {
  let requestUrl = '';
  let requestHeaders = new Headers();
  let requestBody: unknown;
  const provider = new CloudflareWorkersAiProvider(
    'test-account',
    'test-token',
    async (input, init) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        result: { response: '  Hello from NOVA.  ' },
        success: true,
      });
    },
  );

  assert.equal(await provider.generateText('Hello'), 'Hello from NOVA.');
  assert.equal(
    requestUrl,
    'https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/openai/gpt-oss-20b',
  );
  assert.equal(requestHeaders.get('Authorization'), 'Bearer test-token');
  assert.deepEqual(requestBody, {
    messages: [
      { role: 'system', content: novaSystemPrompt },
      { role: 'user', content: 'Hello' },
    ],
    max_tokens: 1200,
  });
});

test('Cloudflare Workers AI reports safe status metadata without exposing error text', async () => {
  const provider = new CloudflareWorkersAiProvider(
    'test-account',
    'test-token',
    async () =>
      Response.json(
        {
          errors: [{ code: 10000, message: 'private upstream details' }],
          success: false,
        },
        {
          status: 401,
          headers: { 'cf-ray': 'test-ray-id' },
        },
      ),
  );

  await assert.rejects(provider.generateText('Hello'), (error: unknown) => {
    assert.ok(error instanceof CloudflareWorkersAiError);
    assert.equal(error.status, 401);
    assert.deepEqual(error.codes, [10000]);
    assert.equal(error.requestId, 'test-ray-id');
    assert.doesNotMatch(error.message, /private upstream details/);
    return true;
  });
});
