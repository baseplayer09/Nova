import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from './server.js';

export function createVercelHandler(
  app = createApp({ routinesEnabled: false }),
) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    if (request.method === 'GET') {
      const requestUrl = new URL(request.url ?? '/', 'http://localhost');
      if (requestUrl.pathname === '/api/health') {
        request.url = `/health${requestUrl.search}`;
      }
    }

    app.emit('request', request, response);
  };
}
