import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const ZAI_ORIGIN = 'https://api.z.ai';
export function zaiFetch(url, init) {
  const target = new URL(url instanceof Request ? url.url : url);
  if (target.origin !== ZAI_ORIGIN) throw new Error(`Unexpected model host: ${target.origin}`);
  const key = process.env.ZAI_API_KEY;
  if (!key) throw new Error('ZAI_API_KEY is not set');
  const headers = new Headers(init?.headers ?? (url instanceof Request ? url.headers : undefined));
  headers.set('authorization', `Bearer ${key}`);
  return fetch(url, { ...init, headers, redirect: 'error' });
}
export const zai = createOpenAICompatible({
  name: 'zai', baseURL: `${ZAI_ORIGIN}/api/coding/paas/v4`, fetch: zaiFetch,
});
