import { novaSystemPrompt, type AiProvider } from './ai-provider.js';

const model = '@cf/openai/gpt-oss-20b';

type CloudflareResponse = {
  result?: unknown;
  success?: unknown;
  errors?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getErrorCodes(errors: unknown): number[] {
  if (!Array.isArray(errors)) {
    return [];
  }
  return errors.flatMap((error) =>
    isRecord(error) && typeof error.code === 'number' ? [error.code] : [],
  );
}

export class CloudflareWorkersAiError extends Error {
  constructor(
    readonly status: number,
    readonly codes: number[],
    readonly requestId: string | null,
  ) {
    super('Cloudflare Workers AI request failed.');
    this.name = 'CloudflareWorkersAiError';
  }
}

export class CloudflareWorkersAiProvider implements AiProvider {
  constructor(
    private readonly accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
    private readonly apiToken = process.env.CLOUDFLARE_API_TOKEN,
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {}

  async generateText(prompt: string): Promise<string> {
    const accountId = this.accountId?.trim();
    const apiToken = this.apiToken?.trim();
    if (!accountId) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID is not configured.');
    }
    if (!apiToken) {
      throw new Error('CLOUDFLARE_API_TOKEN is not configured.');
    }

    const response = await this.fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: novaSystemPrompt },
            { role: 'user', content: prompt },
          ],
          max_tokens: 1200,
        }),
      },
    );

    let payload: CloudflareResponse;
    try {
      const body: unknown = await response.json();
      if (!isRecord(body)) {
        throw new Error('Cloudflare Workers AI returned an invalid response.');
      }
      payload = body;
    } catch {
      throw new CloudflareWorkersAiError(
        response.status,
        [],
        response.headers.get('cf-ray'),
      );
    }

    if (!response.ok || payload?.success === false) {
      throw new CloudflareWorkersAiError(
        response.status,
        getErrorCodes(payload?.errors),
        response.headers.get('cf-ray'),
      );
    }

    const result = payload?.result;
    const answer =
      isRecord(result) && typeof result.response === 'string'
        ? result.response.trim()
        : '';
    if (!answer) {
      throw new Error('Cloudflare Workers AI returned an empty response.');
    }
    return answer;
  }
}
