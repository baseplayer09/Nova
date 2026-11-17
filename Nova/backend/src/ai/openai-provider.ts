import OpenAI from 'openai';
import { novaSystemPrompt, type AiProvider } from './ai-provider.js';

export class OpenAiProvider implements AiProvider {
  async generateText(prompt: string): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not configured.');
    }

    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: novaSystemPrompt },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1200,
    });

    const answer = response.choices[0]?.message.content?.trim();
    if (!answer) {
      throw new Error('The AI provider returned an empty response.');
    }
    return answer;
  }
}
