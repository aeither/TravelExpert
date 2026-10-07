import { z } from 'zod';
import { buyService, defaultLedger, paidConfig, paidEnabled, type BuyDeps } from './paid.ts';
import { taskRefSchema } from './hotels.ts';

const ORIGIN_API_URL = (process.env.ORIGIN_API_URL || 'https://origin-api-production-d268.up.railway.app').replace(/\/$/, '');

export const knowledgeInput = z.object({
  destination: z.string().min(2).max(80).describe('City or area, for example Cebu'),
  question: z.string().min(3).max(300).describe('What the traveller wants to know, in their words: seasons, weather patterns, rainy-day ideas, getting around, safety. Include every question they asked; "general overview" if they asked none.'),
  task_ref: taskRefSchema.optional().describe('The task reference from the request, when the request has one'),
});
export type KnowledgeInput = z.infer<typeof knowledgeInput>;
export type KnowledgeDeps = { env?: Record<string, string | undefined>; buy?: BuyDeps; ledger?: any };

// The orchestrator asks the Expert Travel Agency's knowledge desk (a separate agent service) instead of answering from its own memory.
// With A2A_PAID_KNOWLEDGE=1 the desk is hired through Masumi (0.5 test USDM); if that fails, it falls back to the internal key and the ledger says so.
// Destination facts change slowly: reuse a good answer for a few hours, and share one call between identical asks made together.
// Only answers are kept. An error or a thrown failure is forgotten, so the next ask tries again.
const CACHE_MS = 6 * 3_600_000;
const MAX_ENTRIES = 200;
const answers = new Map<string, { at: number; value: any } | Promise<any>>();

export async function destinationInfo(input: Omit<KnowledgeInput, 'question'> & { question?: string }, fetcher: typeof fetch = fetch, key = process.env.ORIGIN_API_KEY, deps: KnowledgeDeps = {}) {
  const env = deps.env ?? process.env;
  const paid = !!input.task_ref && paidEnabled('knowledge', env);
  if (!key && !paid) return { error: 'The knowledge desk is not configured.' };
  const id = `${paid ? input.task_ref : ''}|${input.destination.trim().toLowerCase()}|${(input.question ?? '').trim().toLowerCase()}`;
  const hit = answers.get(id);
  if (hit instanceof Promise) return hit;
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const run = ask(input, fetcher, key, deps, env, paid);
  answers.set(id, run);
  try {
    const value = await run;
    if (!value.error) { answers.set(id, { at: Date.now(), value }); if (answers.size > MAX_ENTRIES) answers.delete(answers.keys().next().value!); } else answers.delete(id);
    return value;
  } catch (error) { answers.delete(id); throw error; }
}

async function ask(input: any, fetcher: typeof fetch, key: string | undefined, deps: KnowledgeDeps, env: Record<string, string | undefined>, paid: boolean): Promise<any> {
  const body = { destination: input.destination, ...(input.question ? { question: input.question } : {}) };
  const ledgerOf = async () => deps.ledger ?? defaultLedger(paidConfig(env)?.ledgerDir ?? `${env.DATA_DIR || '.local'}/ledger`);
  const remember = async (answer: string) => { if (input.task_ref) try { await (await ledgerOf()).addEvidence(input.task_ref, 'knowledge', answer); } catch { /* best effort */ } };
  if (paid) {
    try {
      const bought = await buyService({ taskRef: input.task_ref, service: 'knowledge', inputData: { knowledge_request_json: JSON.stringify(body) } }, { config: paidConfig(env), ...deps.buy });
      const found: any = typeof bought.result === 'string' ? JSON.parse(bought.result) : null;
      if (typeof found?.answer === 'string') { await remember(found.answer); return { source: 'Expert Travel Agency knowledge desk (paid via Masumi)', destination: found.destination, answer: found.answer }; }
    } catch { /* fall back to the internal key below */ }
    if (!key) return { error: 'The knowledge desk could not be hired. Skip the tips section.' };
    try { await (await ledgerOf()).recordPurchase(input.task_ref, { id: `fb${Date.now().toString(36)}`, service: 'knowledge', seller: 'Expert Travel Agency', priceAtomic: '0', status: 'unpaid-fallback' }); } catch { /* best effort */ }
  }
  const response = await fetcher(`${ORIGIN_API_URL}/v1/knowledge`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(70_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body),
  });
  if (!response.ok) return { error: `The knowledge desk answered HTTP ${response.status}. Skip the tips section.` };
  const found: any = await response.json();
  if (typeof found.answer !== 'string') return { error: 'The knowledge desk returned no answer.' };
  await remember(found.answer);
  return { source: 'Expert Travel Agency knowledge desk', destination: found.destination, answer: found.answer };
}
