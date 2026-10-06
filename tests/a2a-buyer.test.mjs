import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buyFromAgent, createBuyerMps, openA2aStore, validateSellerQuote } from '../scripts/a2a-buyer.mjs';

const AGENT = 'a'.repeat(60);
const future = s => Math.floor(Date.now() / 1000) + s;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakes({ completeAfter = 0, purchaseFails = false } = {}) {
  const calls = [];
  let polls = 0;
  const seller = async (url, init = {}) => {
    const path = new URL(url).pathname; calls.push(`seller ${path}`);
    if (path === '/availability') return json({ status: 'available' });
    if (path === '/start_job') {
      const body = JSON.parse(init.body);
      return json({ job_id: 'job1', blockchainIdentifier: 'bid', agentIdentifier: AGENT, sellerVKey: 'vk', identifierFromPurchaser: body.identifier_from_purchaser,
        input_hash: createHash('sha256').update(`${body.identifier_from_purchaser};${JSON.stringify(body.input_data)}`).digest('hex'), payByTime: future(600), submitResultTime: future(1200), unlockTime: future(1800), externalDisputeUnlockTime: future(2400) });
    }
    if (path === '/status') return json(++polls > completeAfter ? { status: 'completed', result: 'hotel plan' } : { status: 'running' });
    throw new Error(path);
  };
  const mpsFetch = async (url, init) => {
    const path = new URL(url).pathname.replace('/api/v1/', ''); calls.push(`mps ${path}`);
    if (path === 'purchase') return purchaseFails ? json({}, 500) : json({ data: { id: 'p1' } });
    if (path === 'purchase/resolve-blockchain-identifier') return json({ data: { id: 'p1', onChainState: 'FundsLocked', CurrentTransaction: { status: 'Confirmed', txHash: 'tx' } } });
    throw new Error(path);
  };
  const mps = createBuyerMps({ baseUrl: 'https://mps.test/api/v1', token: 't', fetch: mpsFetch });
  return { calls, seller, mps };
}

test('pays once and returns the seller result', async () => {
  const f = fakes(); const store = await openA2aStore(await mkdtemp(join(tmpdir(), 'a2a-')));
  const { journal, result } = await buyFromAgent({ sellerUrl: 'https://seller.test', agentIdentifier: AGENT, inputData: { request: 'x' }, mps: f.mps, store, fetch: f.seller, pollMs: 1 });
  assert.equal(result, 'hotel plan');
  assert.equal(journal.stage, 'completed');
  assert.equal(f.calls.filter(c => c === 'mps purchase').length, 1);
});

test('a restart after purchase-sending finds the purchase instead of paying again', async () => {
  const f = fakes(); const store = await openA2aStore(await mkdtemp(join(tmpdir(), 'a2a-')));
  await buyFromAgent({ sellerUrl: 'https://seller.test', agentIdentifier: AGENT, inputData: { request: 'x' }, mps: f.mps, store, fetch: f.seller, pollMs: 1, journalId: 'a2a_1' });
  const j = await store.read('a2a_1'); j.stage = 'purchase-sending'; delete j.result; await store.save(j);
  f.calls.length = 0;
  const { journal } = await buyFromAgent({ sellerUrl: 'https://seller.test', agentIdentifier: AGENT, inputData: { request: 'x' }, mps: f.mps, store, fetch: f.seller, pollMs: 1, journalId: 'a2a_1' });
  assert.equal(journal.stage, 'completed');
  assert.equal(f.calls.filter(c => c === 'mps purchase').length, 0);
});

test('an unknown purchase outcome is flagged and never retried', async () => {
  const f = fakes({ purchaseFails: true }); const store = await openA2aStore(await mkdtemp(join(tmpdir(), 'a2a-')));
  await assert.rejects(buyFromAgent({ sellerUrl: 'https://seller.test', agentIdentifier: AGENT, inputData: {}, mps: f.mps, store, fetch: f.seller, pollMs: 1, journalId: 'a2a_2' }), /Inspect MPS/);
  await assert.rejects(buyFromAgent({ sellerUrl: 'https://seller.test', agentIdentifier: AGENT, inputData: {}, mps: f.mps, store, fetch: f.seller, pollMs: 1, journalId: 'a2a_2' }), /requires inspection/);
});

test('quote validation rejects wrong agent, overspend and bad deadlines', () => {
  const base = { blockchainIdentifier: 'b', agentIdentifier: AGENT, identifierFromPurchaser: 'n', sellerVKey: 'vk', payByTime: future(60), submitResultTime: future(120), unlockTime: future(180), externalDisputeUnlockTime: future(240) };
  const ok = { agentIdentifier: AGENT, nonce: 'n', amounts: [{ unit: '', amount: '1000000' }] };
  assert.ok(validateSellerQuote(base, ok));
  assert.throws(() => validateSellerQuote(base, { ...ok, agentIdentifier: 'b'.repeat(60) }), /different agent/);
  assert.throws(() => validateSellerQuote(base, { ...ok, amounts: [{ unit: '', amount: '9999999' }] }), /spending cap/);
  assert.throws(() => validateSellerQuote({ ...base, payByTime: future(-5) }, ok), /inconsistent/);
  assert.throws(() => validateSellerQuote(base, { ...ok, amounts: [{ unit: 'abc', amount: '1' }] }), /Only test USDM/);
});

test('a 404 right after the purchase is treated as pending, not as failure', async () => {
  const f = fakes(); let n = 0;
  const mps = createBuyerMps({ baseUrl: 'https://mps.test/api/v1', token: 't', fetch: async (url, init) => {
    const path = new URL(url).pathname.replace('/api/v1/', '');
    if (path === 'purchase') return json({ data: { id: 'p1' } });
    if (++n < 3) return json({}, 404);
    return json({ data: { onChainState: 'FundsLocked', CurrentTransaction: { status: 'Confirmed', txHash: 'tx' } } });
  } });
  const store = await openA2aStore(await mkdtemp(join(tmpdir(), 'a2a-')));
  const { journal } = await buyFromAgent({ sellerUrl: 'https://seller.test', agentIdentifier: AGENT, inputData: {}, mps, store, fetch: f.seller, pollMs: 1 });
  assert.equal(journal.stage, 'completed');
});
