import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const OPENROUTER_ORIGIN = 'https://openrouter.ai';
export function openrouterFetch(url, init) {
  const target = new URL(url instanceof Request ? url.url : url);
  if (target.origin !== OPENROUTER_ORIGIN) throw new Error(`Unexpected model host: ${target.origin}`);
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set');
  const headers = new Headers(init?.headers ?? (url instanceof Request ? url.headers : undefined));
  headers.set('authorization', `Bearer ${key}`);
  return fetch(url, { ...init, headers, redirect: 'error' });
}
export const openrouter = createOpenAICompatible({
  name: 'openrouter', baseURL: `${OPENROUTER_ORIGIN}/api/v1`, fetch: openrouterFetch,
});
export const MODEL_ID = () => process.env.OPENROUTER_MODEL || 'openrouter/free';
