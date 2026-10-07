import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buyService, clearPaidCache, paidConfig, paidEnabled, PRICES } from '../agent/lib/paid.ts';
import { openLedger } from '../scripts/ledger.mjs';

const T = 'task_abcdef12';
const env = { MPS_URL: 'https://mps.test/api/v1', MPS_BUYER_TOKEN: 't', A2A_AGENT_IDENTIFIER: 'a'.repeat(60), DATA_DIR: '/tmp/x' };
const done = (extra = {}) => ({ result: '{"ok":true}', journal: { stage: 'completed', jobId: 'job1', fundsLockedTx: 'esc', transactions: { payment: 'esc', result: 'res' }, resultHash: 'h', quote: { blockchainIdentifier: 'bid' }, ...extra } });
async function fixture(buy, over = {}) {
  clearPaidCache();
  const dir = await mkdtemp(join(tmpdir(), 'paid-'));
  const ledger = await openLedger(join(dir, 'l'));
  const config = { mpsUrl: env.MPS_URL, token: 't', sellerUrl: 'https://seller.test', agentIdentifier: 'a'.repeat(60), dir, ledgerDir: join(dir, 'l'), capAtomic: 2_000_000n, maxPerHour: 12, ...over };
  return { ledger, deps: { config, buy, ledger, mps: {}, store: { ids: async () => [], read: async () => null } } };
}

test('config and per-service flags come from the environment', () => {
  assert.equal(paidConfig({}), null);
  assert.equal(paidConfig(env).capAtomic, 4_000_000n);
  assert.equal(paidConfig({ ...env, A2A_TASK_CAP_ATOMIC: '3000000' }).capAtomic, 3_000_000n);
  assert.equal(paidEnabled('hotel-search', { ...env, A2A_PAID_SEARCH: '1' }), true);
  assert.equal(paidEnabled('knowledge', { ...env, A2A_PAID_SEARCH: '1' }), false);
  assert.equal(paidEnabled('knowledge', { ...env, A2A_PAID_KNOWLEDGE: '1' }), true);
  assert.equal(paidEnabled('audit', { ...env, A2A_AUDIT: '1' }), true);
  assert.equal(paidEnabled('audit', { A2A_AUDIT: '1' }), false);
});

test('buyService resolves with result, journal and the ledger entry, with the right price and seller input', async () => {
  let call;
  const { ledger, deps } = await fixture(async options => { call = options; return done(); });
  const out = await buyService({ taskRef: T, service: 'knowledge', inputData: { knowledge_request_json: '{}' } }, deps);
  assert.equal(out.result, '{"ok":true}');
  assert.equal(out.journal.stage, 'completed');
  assert.equal(out.purchase.status, 'completed');
  assert.deepEqual({ escrowTx: out.purchase.escrowTx, resultTx: out.purchase.resultTx, resultHash: out.purchase.resultHash, jobId: out.purchase.jobId, blockchainIdentifier: out.purchase.blockchainIdentifier }, { escrowTx: 'esc', resultTx: 'res', resultHash: 'h', jobId: 'job1', blockchainIdentifier: 'bid' });
  assert.equal(out.purchase.priceAtomic, PRICES.knowledge);
  assert.deepEqual(call.amounts.map(a => a.amount), ['500000']);
  assert.equal(call.maxAmount, 500_000n);
  assert.equal(call.sellerUrl, 'https://seller.test');
  assert.equal((await ledger.read(T)).purchases.length, 1);
});

test('the same request in the same task is bought once; another task buys again', async () => {
  let bought = 0;
  const { deps } = await fixture(async () => { bought++; return done(); });
  const ask = taskRef => buyService({ taskRef, service: 'hotel-search', inputData: { trip_request_json: '{"a":1}' } }, deps);
  const [a, b] = await Promise.all([ask(T), ask(T)]);
  assert.equal(a, b);
  await ask(T);
  assert.equal(bought, 1);
  await ask('task_second123');
  assert.equal(bought, 2);
});

test('the governor refuses a hop that would pass the task cap and records the refusal', async () => {
  let bought = 0;
  const { ledger, deps } = await fixture(async () => { bought++; return done(); }, { capAtomic: 1_800_000n });
  await buyService({ taskRef: T, service: 'hotel-search', inputData: { x: '1' } }, deps);
  await buyService({ taskRef: T, service: 'knowledge', inputData: { x: '2' } }, deps);
  await assert.rejects(buyService({ taskRef: T, service: 'audit', inputData: { x: '3' } }, deps), /spending cap/);
  assert.equal(bought, 2);
  const purchases = (await ledger.read(T)).purchases;
  assert.equal(purchases.at(-1).status, 'failed');
  assert.match(purchases.at(-1).note, /cap/);
  assert.equal(await ledger.spent(T), 1_500_000n);
});

test('a failed purchase is marked failed in the ledger, forgotten by the cache, and a refund shows as refund-requested', async () => {
  let n = 0;
  const { ledger, deps } = await fixture(async () => { n++; if (n === 1) throw new Error('Purchase outcome unknown'); return { result: null, journal: { stage: 'refund-requested', quote: { blockchainIdentifier: 'b' } } }; });
  const input = { taskRef: T, service: 'knowledge', inputData: { x: '1' } };
  await assert.rejects(buyService(input, deps), /outcome unknown/);
  const refund = await buyService(input, deps);
  assert.equal(refund.result, null);
  assert.equal(refund.purchase.status, 'refund-requested');
  const again = await buyService(input, deps);
  assert.equal(n, 3);
  assert.deepEqual((await ledger.read(T)).purchases.map(p => p.status), ['failed', 'refund-requested', 'refund-requested']);
  assert.equal(again.result, null);
});

test('the audit hop uses the separate auditor identity when one is configured; the hourly limit holds', async () => {
  let call;
  const { deps } = await fixture(async options => { call = options; return done(); }, { auditSellerUrl: 'https://auditor.test', auditAgentIdentifier: 'b'.repeat(60) });
  const out = await buyService({ taskRef: T, service: 'audit', inputData: { audit_request_json: '{}' } }, deps);
  assert.equal(call.sellerUrl, 'https://auditor.test');
  assert.equal(call.agentIdentifier, 'b'.repeat(60));
  assert.equal(out.purchase.seller, 'Trip Auditor');
  const busy = await fixture(async () => done(), { maxPerHour: 1 });
  busy.deps.store = { ids: async () => ['j'], read: async () => ({ startedAt: new Date().toISOString() }) };
  await assert.rejects(buyService({ taskRef: T, service: 'knowledge', inputData: { x: '1' } }, busy.deps), /Hourly/);
  await assert.rejects(buyService({ taskRef: T, service: 'knowledge', inputData: {} }, { config: null }), /not configured/);
});
