import { z } from 'zod';

const ORIGIN_API_URL = (process.env.ORIGIN_API_URL || 'https://origin-api-production-d268.up.railway.app').replace(/\/$/, '');

export const knowledgeInput = z.object({
  destination: z.string().min(2).max(80).describe('City or area, for example Cebu'),
  question: z.string().min(3).max(300).optional().describe('A specific question, for example "best month to visit"'),
});

// The orchestrator asks the Expert Travel Agency's knowledge desk (a separate agent service) instead of answering from its own memory.
export async function destinationInfo(input: z.infer<typeof knowledgeInput>, fetcher: typeof fetch = fetch, key = process.env.ORIGIN_API_KEY) {
  if (!key) return { error: 'The knowledge desk is not configured.' };
  const response = await fetcher(`${ORIGIN_API_URL}/v1/knowledge`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(70_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(input),
  });
  if (!response.ok) return { error: `The knowledge desk answered HTTP ${response.status}. Skip the tips section.` };
  const found: any = await response.json();
  return typeof found.answer === 'string' ? { source: 'Expert Travel Agency knowledge desk', destination: found.destination, answer: found.answer } : { error: 'The knowledge desk returned no answer.' };
}
