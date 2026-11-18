import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from './server.js';
import { createVercelHandler } from './vercel-handler.js';

test('Vercel handler forwards requests and maps its health endpoint', async () => {
  const server = createServer(createVercelHandler(createApp()));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  } finally {
    server.close();
    await once(server, 'close');
  }
});
