import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { buyFromAgent, createBuyerMps, openA2aStore } from '../../scripts/a2a-buyer.mjs';
import { openLedger } from '../../scripts/ledger.mjs';

// Every paid hop (hotel search, flight search, knowledge desk, plan audit) goes through buyService.
// Payment is code: the model only asks for the work. The governor refuses a hop that would pass the task's spend cap,
// and every purchase is written to the task ledger before and after, so the receipt can prove it.
export type Service = 'hotel-search' | 'flight-search' | 'knowledge' | 'audit';
const USDM_UNIT = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
export const PRICES: Record<Service, string> = { 'hotel-search': '1000000', 'flight-search': '1000000', knowledge: '500000', audit: '500000' };
const FLAGS: Record<Service, string> = { 'hotel-search': 'A2A_PAID_SEARCH', 'flight-search': 'A2A_PAID_SEARCH', knowledge: 'A2A_PAID_KNOWLEDGE', audit: 'A2A_AUDIT' };
const DEFAULT_SELLER = 'https://origin-api-production-d268.up.railway.app';
const CACHE_MS = 15 * 60_000;

export type PaidConfig = { mpsUrl: string; token: string; sellerUrl: string; agentIdentifier: string; auditSellerUrl?: string; auditAgentIdentifier?: string;
  dir: string; ledgerDir: string; capAtomic: bigint; maxPerHour: number };

export function paidConfig(env: Record<string, string | undefined> = process.env): PaidConfig | null {
  if (!env.MPS_URL || !env.MPS_BUYER_TOKEN || !env.A2A_AGENT_IDENTIFIER) return null;
  const data = resolve(env.DATA_DIR || '.local');
  return { mpsUrl: env.MPS_URL, token: env.MPS_BUYER_TOKEN, sellerUrl: env.ORIGIN_API_URL || DEFAULT_SELLER, agentIdentifier: env.A2A_AGENT_IDENTIFIER,
    ...(env.A2A_AUDIT_URL && env.A2A_AUDIT_AGENT_IDENTIFIER ? { auditSellerUrl: env.A2A_AUDIT_URL, auditAgentIdentifier: env.A2A_AUDIT_AGENT_IDENTIFIER } : {}),
    dir: resolve(data, 'a2a'), ledgerDir: resolve(data, 'ledger'), capAtomic: BigInt(env.A2A_TASK_CAP_ATOMIC || '4000000'), maxPerHour: Number(env.A2A_MAX_PER_HOUR || 12) };
}
export const paidEnabled = (service: Service, env: Record<string, string | undefined> = process.env) => env[FLAGS[service]] === '1' && !!paidConfig(env);

const ledgers = new Map<string, Promise<any>>();
export const defaultLedger = (dir: string) => { if (!ledgers.has(dir)) ledgers.set(dir, openLedger(dir)); return ledgers.get(dir)!; };
const cache = new Map<string, { at: number; value: any } | Promise<any>>();

export type BuyOptions = { taskRef: string; service: Service; inputData: Record<string, string>; amounts?: { unit: string; amount: string }[] };
export type BuyDeps = { config?: PaidConfig | null; buy?: typeof buyFromAgent; ledger?: any; mps?: any; store?: any; pollMs?: number };
export type BuyResult = { result: string | null; journal: any; purchase: any };

export async function buyService(options: BuyOptions, deps: BuyDeps = {}): Promise<BuyResult> {
  const config = deps.config === undefined ? paidConfig() : deps.config;
  if (!config) throw new Error('Paid search is not configured.');
  const { taskRef, service, inputData } = options;
  const amounts = options.amounts ?? [{ unit: USDM_UNIT, amount: PRICES[service] }];
  const key = `${taskRef}|${service}|${JSON.stringify(inputData)}`;
  const hit = cache.get(key);
  if (hit instanceof Promise) return hit;
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const run = purchase(config, taskRef, service, inputData, amounts, deps);
  cache.set(key, run);
  try { const value = await run; if (value.result === null) cache.delete(key); else cache.set(key, { at: Date.now(), value }); return value; }
  catch (error) { cache.delete(key); throw error; }
}
export const clearPaidCache = () => cache.clear();

async function purchase(config: PaidConfig, taskRef: string, service: Service, inputData: Record<string, string>, amounts: { unit: string; amount: string }[], deps: BuyDeps): Promise<BuyResult> {
  const ledger = deps.ledger ?? await defaultLedger(config.ledgerDir);
  const store = deps.store ?? await openA2aStore(config.dir);
  const price = amounts.reduce((sum, a) => sum + BigInt(a.amount), 0n);
  const id = randomBytes(6).toString('hex'), journalId = `a2a_${id}`;
  const useAudit = service === 'audit' && config.auditSellerUrl && config.auditAgentIdentifier;
  const seller = useAudit ? 'Trip Auditor' : 'Expert Travel Agency';
  const entry = { id, service, seller, priceAtomic: price.toString(), journalId };
  // Governor: this task may not buy beyond its cap, whatever the model asks for.
  if ((await ledger.spent(taskRef)) + price > config.capAtomic) {
    await ledger.recordPurchase(taskRef, { ...entry, status: 'failed', note: 'Task spend cap reached.' });
    throw new Error('This task has reached its spending cap. No more agents can be hired for it.');
  }
  const recent = (await Promise.all((await store.ids()).map((name: string) => store.read(name)))).filter((j: any) => j && Date.now() - Date.parse(j.startedAt) < 3_600_000).length;
  if (recent >= config.maxPerHour) throw new Error('Hourly paid-search limit reached.');
  await ledger.recordPurchase(taskRef, { ...entry, status: 'started' });
  const mps = deps.mps ?? createBuyerMps({ baseUrl: config.mpsUrl, token: config.token });
  let outcome: { journal: any; result: string | null };
  try {
    outcome = await (deps.buy ?? buyFromAgent)({ sellerUrl: useAudit ? config.auditSellerUrl : config.sellerUrl, agentIdentifier: useAudit ? config.auditAgentIdentifier : config.agentIdentifier,
      inputData, amounts, maxAmount: price, mps, store, journalId, ...(deps.pollMs ? { pollMs: deps.pollMs } : {}) });
  } catch (error) {
    await ledger.updatePurchase(taskRef, id, { status: 'failed', note: String((error as Error).message).slice(0, 160) });
    throw error;
  }
  const { journal, result } = outcome;
  const stage = journal?.stage;
  const updated = await ledger.updatePurchase(taskRef, id, {
    status: stage === 'completed' ? 'completed' : stage === 'refund-requested' ? 'refund-requested' : 'failed',
    jobId: journal?.jobId, blockchainIdentifier: journal?.quote?.blockchainIdentifier, escrowTx: journal?.fundsLockedTx,
    resultTx: journal?.transactions?.result ?? undefined, resultHash: journal?.resultHash ?? undefined });
  return { result: typeof result === 'string' ? result : null, journal, purchase: updated };
}
