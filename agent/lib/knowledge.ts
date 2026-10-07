import { z } from 'zod';

const ORIGIN_API_URL = (process.env.ORIGIN_API_URL || 'https://origin-api-production-d268.up.railway.app').replace(/\/$/, '');

export const knowledgeInput = z.object({
  destination: z.string().min(2).max(80).describe('City or area, for example Cebu'),
  question: z.string().min(3).max(300).optional().describe('A specific question, for example "best month to visit"'),
});

// The orchestrator asks the Expert Travel Agency's knowledge desk (a separate agent service) instead of answering from its own memory.
// Destination facts change slowly: reuse a good answer for a few hours, and share one call between identical asks made together.
// Only answers are kept. An error or a thrown failure is forgotten, so the next ask tries again.
const CACHE_MS = 6 * 3_600_000;
const MAX_ENTRIES = 200;
const answers = new Map<string, { at: number; value: any } | Promise<any>>();

export async function destinationInfo(input: z.infer<typeof knowledgeInput>, fetcher: typeof fetch = fetch, key = process.env.ORIGIN_API_KEY) {
  if (!key) return { error: 'The knowledge desk is not configured.' };
  const id = `${input.destination.trim().toLowerCase()}|${(input.question ?? '').trim().toLowerCase()}`;
  const hit = answers.get(id);
  if (hit instanceof Promise) return hit;
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const run = ask(input, fetcher, key);
  answers.set(id, run);
  try {
    const value = await run;
    if (!value.error) { answers.set(id, { at: Date.now(), value }); if (answers.size > MAX_ENTRIES) answers.delete(answers.keys().next().value!); } else answers.delete(id);
    return value;
  } catch (error) { answers.delete(id); throw error; }
}

async function ask(input: z.infer<typeof knowledgeInput>, fetcher: typeof fetch, key: string): Promise<any> {
  const response = await fetcher(`${ORIGIN_API_URL}/v1/knowledge`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(70_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(input),
  });
  if (!response.ok) return { error: `The knowledge desk answered HTTP ${response.status}. Skip the tips section.` };
  const found: any = await response.json();
  return typeof found.answer === 'string' ? { source: 'Expert Travel Agency knowledge desk', destination: found.destination, answer: found.answer } : { error: 'The knowledge desk returned no answer.' };
}
