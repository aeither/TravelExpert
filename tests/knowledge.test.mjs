import test from 'node:test';
import assert from 'node:assert/strict';
import { destinationInfo } from '../agent/lib/knowledge.ts';

const ok = answer => async () => Response.json({ destination: 'Cebu', answer });

test('the knowledge desk answer is reused for the same question, even when asked at the same time', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return Response.json({ destination: 'Cebu', answer: 'Go in January.' }); };
  const [a, b] = await Promise.all([destinationInfo({ destination: 'Cebu-A' }, fetcher, 'k'), destinationInfo({ destination: ' cebu-a ' }, fetcher, 'k')]);
  const c = await destinationInfo({ destination: 'Cebu-A' }, fetcher, 'k');
  assert.equal(calls, 1);
  assert.equal(a.answer, 'Go in January.'); assert.deepEqual(b, a); assert.deepEqual(c, a);
});

test('different questions are not mixed up', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({ destination: 'Cebu', answer: `a${calls}` }); };
  const a = await destinationInfo({ destination: 'Bohol-B', question: 'best month?' }, fetcher, 'k');
  const b = await destinationInfo({ destination: 'Bohol-B', question: 'getting around?' }, fetcher, 'k');
  assert.notEqual(a.answer, b.answer); assert.equal(calls, 2);
});

test('failures are never cached, so the next ask tries again', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return calls === 1 ? new Response('no', { status: 502 }) : ok('fine')(); };
  assert.match((await destinationInfo({ destination: 'Palawan-C' }, fetcher, 'k')).error, /HTTP 502/);
  assert.equal((await destinationInfo({ destination: 'Palawan-C' }, fetcher, 'k')).answer, 'fine');
  const thrown = async () => { throw new Error('network'); };
  await assert.rejects(destinationInfo({ destination: 'Siargao-D' }, thrown, 'k'));
  assert.equal((await destinationInfo({ destination: 'Siargao-D' }, ok('later'), 'k')).answer, 'later');
});

// Paid knowledge desk: hired through Masumi per task, with the internal key as a labelled fallback.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger } from '../scripts/ledger.mjs';
import { knowledgeInput } from '../agent/lib/knowledge.ts';

const paidEnv = { A2A_PAID_KNOWLEDGE: '1', MPS_URL: 'https://mps.test/api/v1', MPS_BUYER_TOKEN: 't', A2A_AGENT_IDENTIFIER: 'a'.repeat(60), DATA_DIR: '/tmp/none' };
const journal = { stage: 'completed', quote: { blockchainIdentifier: 'b' } };

test('the tool input needs a question, so the traveller\'s own questions reach the desk', () => {
  assert.throws(() => knowledgeInput.parse({ destination: 'Cebu' }));
  assert.equal(knowledgeInput.parse({ destination: 'Cebu', question: 'rainy day ideas?', task_ref: 'task_abcdef12' }).question, 'rainy day ideas?');
});

test('with paid knowledge on, the desk is hired once per task and the answer becomes evidence', async () => {
  const ledger = await openLedger(await mkdtemp(join(tmpdir(), 'kn-')));
  let sent, bought = 0;
  const buy = async ({ inputData, amounts }) => { bought++; sent = { inputData, amounts }; return { result: JSON.stringify({ destination: 'Siargao', answer: 'Rainy season runs to December; try the museum.' }), journal }; };
  const deps = { env: paidEnv, ledger, buy: { buy, ledger, mps: {}, store: { ids: async () => [], read: async () => null } } };
  const input = { destination: 'Siargao-P', question: 'rainy day with kids?', task_ref: 'task_paid12345' };
  const a = await destinationInfo(input, async () => { throw new Error('must not use the key'); }, undefined, deps);
  const b = await destinationInfo(input, async () => { throw new Error('must not use the key'); }, undefined, deps);
  assert.equal(bought, 1);
  assert.equal(a.answer, 'Rainy season runs to December; try the museum.');
  assert.match(a.source, /paid via Masumi/);
  assert.deepEqual(b, a);
  assert.deepEqual(JSON.parse(sent.inputData.knowledge_request_json), { destination: 'Siargao-P', question: 'rainy day with kids?' });
  assert.deepEqual(sent.amounts.map(x => x.amount), ['500000']);
  const saved = await ledger.read('task_paid12345');
  assert.deepEqual(saved.evidence.knowledge, ['Rainy season runs to December; try the museum.']);
  assert.equal(saved.purchases[0].service, 'knowledge');
});

test('if the paid hire fails the desk answers through the internal key and the ledger says it was unpaid', async () => {
  const ledger = await openLedger(await mkdtemp(join(tmpdir(), 'kn-')));
  const deps = { env: paidEnv, ledger, buy: { buy: async () => { throw new Error('mps down'); }, ledger, mps: {}, store: { ids: async () => [], read: async () => null } } };
  const out = await destinationInfo({ destination: 'Bali-Q', question: 'best month?', task_ref: 'task_fallback12' }, ok('Go in May.'), 'k', deps);
  assert.equal(out.answer, 'Go in May.');
  assert.doesNotMatch(out.source, /paid/);
  const { purchases, evidence } = await ledger.read('task_fallback12');
  assert.deepEqual(purchases.map(p => p.status), ['failed', 'unpaid-fallback']);
  assert.deepEqual(evidence.knowledge, ['Go in May.']);
  assert.match((await destinationInfo({ destination: 'Bali-R', question: 'x y z', task_ref: 'task_nokey12345' }, ok('x'), undefined, { env: paidEnv, ledger, buy: { buy: async () => { throw new Error('down'); }, ledger, mps: {}, store: { ids: async () => [], read: async () => null } } })).error, /could not be hired/);
});

test('free mode sends the question to the knowledge route with the bearer key', async () => {
  let call;
  const fetcher = async (url, init) => { call = { url: String(url), init, body: JSON.parse(init.body) }; return Response.json({ destination: 'Cebu', answer: 'ok' }); };
  await destinationInfo({ destination: 'Cebu-Z', question: 'rainy day?' }, fetcher, 'sekret', { env: {} });
  assert.match(call.url, /\/v1\/knowledge$/);
  assert.equal(call.init.headers.authorization, 'Bearer sekret');
  assert.deepEqual(call.body, { destination: 'Cebu-Z', question: 'rainy day?' });
});
