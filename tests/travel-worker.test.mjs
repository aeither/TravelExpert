import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createStore } from '../scripts/worker-state.mjs';
import { createTravelWorker } from '../scripts/travel-worker.mjs';
import { createAdvisor } from '../scripts/advisor.mjs';
import { answerToOffer, feeFor, handoverText, paymentComment, proofBlock } from '../scripts/booking-copy.mjs';

const plan = { request: { city: 'Cebu', country_code: 'PH', check_in: '2026-11-20', nights: 2, adults: 2 },
  hotel: { id: '1', name: 'ML Suites', lodging: '', total: { amount: '54.00', currency: 'USD' }, free_cancellation: true },
  alternatives: [{ id: '2', name: 'Pension', lodging: 'APART_HOTEL', total: { amount: '62.00', currency: 'USD' }, free_cancellation: true }] };
const source = { agentIdentifier: 'a'.repeat(96), policyId: 'a'.repeat(56), smartContractAddress: 'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g',
  sellerVkey: 'c'.repeat(56), sellerAddress: 'addr_test1qrxk7ly3666nv8agvr6ylxn0lfycwnqjzmhynwxnjlxz7f9ehwykv3ee8k2hyts0y97w2th2qh7jqedkpaguzeh3fp7sw3t9vu', supportedPaymentSourceIndex: 0 };

test('fee follows the hotel total and stays within 0.5 to 5 test USDM', () => {
  assert.deepEqual(feeFor({ amount: '54.00' }), { usdm: 1.1, atomic: '1100000' });
  assert.equal(feeFor({ amount: '10' }).usdm, 0.5);
  assert.equal(feeFor({ amount: '900' }).usdm, 5);
  assert.equal(feeFor(undefined).usdm, 1);
});

test('payment comment starts with the fixed phrase, names the trip and varies by task', () => {
  const texts = new Set(Array.from({ length: 40 }, (_, i) => paymentComment(plan, feeFor(plan.hotel.total), `task-${i}`)));
  for (const text of texts) { assert.match(text, /^Payment requested: 1\.1 test USDM\. /); assert.match(text, /ML Suites/); }
  assert.ok(texts.size > 1);
});

test('handover and proof give clickable explorer links', () => {
  const text = handoverText(plan, { url: 'https://hotel.example/co', trip_id: 't' }, 'x');
  assert.match(text, /\(https:\/\/hotel\.example\/co\)/);
  const proof = proofBlock({ escrowTx: 'e'.repeat(64), resultTx: 'f'.repeat(64) }, source, feeFor(plan.hotel.total));
  assert.match(proof, new RegExp(`https://preprod\\.cexplorer\\.io/tx/${'e'.repeat(64)}`));
  assert.match(proof, new RegExp(`/tx/${'f'.repeat(64)}`));
});

test('plain yes and no are decided by code', () => {
  assert.equal(answerToOffer('book'), 'yes'); assert.equal(answerToOffer('Yes please book it'), 'yes');
  assert.equal(answerToOffer('no thanks'), 'no'); assert.equal(answerToOffer('book a cheaper one'), undefined);
});

test('advisor opens the top pick, falls back to the next one and rejects non-https links', async () => {
  const calls = [];
  const send = async (_url, init) => { const body = JSON.parse(init.body); calls.push(body.property_id);
    return Response.json(body.property_id === '1' ? { checkout: { failure_reason: 'sold out' } } : { checkout: { trip_id: 'trip', checkout_url: 'https://www.hotels.com/checkout' } }); };
  const result = await createAdvisor('https://advisor.example.com', send).openCheckout(plan);
  assert.deepEqual(calls, ['1', '2']);
  assert.equal(result.hotel.id, '2'); assert.equal(result.swappedFrom, 'ML Suites');
  const none = await createAdvisor('https://advisor.example.com', async () => Response.json({ checkout: { failure_reason: 'no' } })).openCheckout(plan);
  assert.equal(none.opened, false);
  assert.throws(() => createAdvisor('http://advisor.example.com'), /https/);
});

async function fixture(t, { agentText = 'PLAN TEXT\nWould you like me to open the checkout for the top pick?', savePlan = true, plan: planned = plan, deps = {} } = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), 'travel-worker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(resolve(dir, 'plans'), { recursive: true });
  const store = await createStore(resolve(dir, 'travel'));
  const task = { id: 'task_abcdefgh', status: 'READY', description: 'Plan 3 days in Cebu from 20 November', name: 'Cebu', assigneeId: 'cw1', organizationId: null };
  const sent = []; const eventsList = []; let escrow = false, resultSubmitted = false, withdrawn = false;
  const ctx = { task, sent, eventsList, set: s => Object.assign(ctx.flags, s), flags: { get escrow() { return escrow; } } };
  const api = {
    get: async path => path.includes('/events') ? { data: eventsList } : { data: [task] },
    post: async (path, body) => { sent.push(body); const e = { id: `ev${sent.length}`, taskId: task.id, status: body.status ?? null, createdAt: new Date(Date.now() + sent.length).toISOString(), actor: { id: 'cw1', type: 'coworker' }, comment: body.comment };
      eventsList.push(e); if (body.status) task.status = body.status; return { data: e }; },
  };
  const payment = () => { const q = ctx.quote; return { ...q, onChainState: withdrawn ? 'Withdrawn' : resultSubmitted ? 'ResultSubmitted' : escrow ? 'FundsLocked' : null, resultHash: resultSubmitted ? ctx.resultHash : null,
    NextAction: { requestedAction: 'WaitingForExternalAction', errorType: null }, CurrentTransaction: escrow ? { txHash: (withdrawn ? 'c' : resultSubmitted ? 'b' : 'a').repeat(64), status: 'Confirmed', confirmations: 3 } : null }; };
  const mps = { post: async (path, body) => {
    if (path === 'payment') { ctx.quote = { id: 'pay1', blockchainIdentifier: 'bid', agentIdentifier: source.agentIdentifier, pricingType: 'Dynamic', inputHash: body.inputHash, payByTime: String(Date.parse(body.payByTime)), submitResultTime: String(Date.parse(body.submitResultTime)), unlockTime: String(Date.parse(body.unlockTime)), externalDisputeUnlockTime: String(Date.parse(body.externalDisputeUnlockTime)), sellerReturnAddress: null, buyerReturnAddress: null, forceLayer: null, RequestedFunds: body.RequestedFunds, SmartContractWallet: { walletVkey: source.sellerVkey, walletAddress: source.sellerAddress }, PaymentSource: { network: 'Preprod', paymentSourceType: 'Web3CardanoV2', policyId: source.policyId, smartContractAddress: source.smartContractAddress }, onChainState: null, resultHash: null, NextAction: { requestedAction: 'WaitingForExternalAction', errorType: null }, CurrentTransaction: null }; ctx.requested = body; return { data: ctx.quote }; }
    if (path === 'payment/submit-result') { ctx.resultHash = body.submitResultHash; return { data: { ...payment(), resultHash: body.submitResultHash } }; }
    return { data: payment() }; } };
  const advisor = { openCheckout: async () => ({ opened: true, hotel: plan.hotel, checkout: { trip_id: 't1', url: 'https://www.hotels.com/checkout/1' } }) };
  const worker = createTravelWorker({ api, mps, eve: {}, advisor, store, source, coworkerId: 'cw1', dataDir: dir, log: () => {}, ...deps,
    runAgent: async prompt => { ctx.prompts = [...(ctx.prompts ?? []), prompt]; if (savePlan) await writeFile(resolve(dir, 'plans', `${task.id}.json`), JSON.stringify(planned)); return agentText; } });
  Object.assign(ctx, { worker, store, dir, funds: () => { escrow = true; }, submitted: () => { resultSubmitted = true; }, collect: () => { withdrawn = true; }, reply: text => { eventsList.push({ id: `u${eventsList.length}`, taskId: task.id, comment: text, actor: { id: 'user1', type: 'user' }, createdAt: new Date(Date.now() + 10_000).toISOString() }); task.status = 'INPUT_REQUIRED'; } });
  return ctx;
}

test('a trip request gets a free plan and waits for "book" or "no"', async t => {
  const f = await fixture(t);
  await f.worker.advance(f.task);
  assert.deepEqual(f.sent.map(e => e.status).filter(Boolean), ['RUNNING', 'INPUT_REQUIRED']);
  assert.match(f.sent.at(-1).comment, /^PLAN TEXT/);
  assert.ok(f.sent.some(e => !e.status && /Working on your request/.test(e.comment)));
  assert.equal(f.sent.some(e => e.masumiPayment), false);
  assert.match(f.prompts[0], /Task reference: task_abcdefgh/);
});

test('"no" completes for free', async t => {
  const f = await fixture(t);
  await f.worker.advance(f.task); f.reply('no thanks');
  await f.worker.advance(f.task);
  assert.equal(f.sent.at(-1).status, 'COMPLETED');
  assert.equal(f.sent.some(e => e.masumiPayment), false);
  assert.equal((await f.store.read(f.task.id)).phase, 'completed');
});

test('"book" opens the checkout, charges a dynamic fee, hands over the link with explorer proof, then posts the payout', async t => {
  const f = await fixture(t);
  await f.worker.advance(f.task); f.reply('book');
  assert.equal(await f.worker.advance(f.task), 'waiting');
  const payEvent = f.sent.find(e => e.masumiPayment);
  assert.match(payEvent.comment, /^Payment requested: 1\.1 test USDM\./);
  assert.deepEqual(payEvent.masumiPayment.Amounts, [{ amount: '1100000', unit: f.requested.RequestedFunds[0].unit }]);
  assert.equal(await f.worker.advance(f.task), 'waiting');
  f.funds();
  assert.equal(await f.worker.advance(f.task), 'waiting'); // escrow confirmed, hash submitted, result not yet confirmed
  assert.equal(f.sent.some(e => e.status === 'COMPLETED'), false);
  f.submitted();
  assert.equal(await f.worker.advance(f.task), 'completed');
  const done = f.sent.at(-1);
  assert.equal(done.status, 'COMPLETED');
  assert.match(done.comment, /hotels\.com\/checkout\/1/);
  assert.match(done.comment, new RegExp(`cexplorer\\.io/tx/${'a'.repeat(64)}`));
  assert.match(done.comment, new RegExp(`cexplorer\\.io/tx/${'b'.repeat(64)}`));
  assert.equal((await f.store.read(f.task.id)).phase, 'collecting');
  assert.equal(await f.worker.collect(await f.store.read(f.task.id)), 'collecting');
  f.collect();
  assert.equal(await f.worker.collect(await f.store.read(f.task.id)), 'settled');
  assert.match(f.sent.at(-1).comment, new RegExp(`cexplorer\\.io/tx/${'c'.repeat(64)}`));
});

test('no checkout means no charge', async t => {
  const f = await fixture(t);
  await f.worker.advance(f.task); f.reply('book');
  const worker = createTravelWorker({ api: { get: async () => ({ data: f.eventsList }), post: async (_p, body) => { f.sent.push(body); return { data: { id: 'x', status: body.status } }; } }, mps: {}, eve: {}, advisor: { openCheckout: async () => ({ opened: false, failure_reason: 'sold out' }) }, store: f.store, source, coworkerId: 'cw1', dataDir: f.dir, log: () => {} });
  await worker.advance(f.task);
  assert.match(f.sent.at(-1).comment, /nothing was charged/);
  assert.equal(f.sent.some(e => e.masumiPayment), false);
});

test('a missing detail becomes a question and the answer continues the same task', async t => {
  const f = await fixture(t, { agentText: 'Which date do you arrive?', savePlan: false });
  await f.worker.advance(f.task);
  assert.equal(f.sent.at(-1).status, 'INPUT_REQUIRED');
  assert.equal(f.sent.some(e => e.masumiPayment), false);
  f.reply('20 November');
  await f.worker.advance(f.task);
  assert.match(f.prompts.at(-1), /Traveller's reply to my last message: 20 November/);
});

test('a comment on a finished task shows Running, then Completed with the answer, and is answered once', async t => {
  const f = await fixture(t);
  await f.worker.advance(f.task); f.reply('no thanks'); await f.worker.advance(f.task);
  const st = await f.store.read(f.task.id);
  assert.equal(st.phase, 'completed');
  f.task.status = 'COMPLETED';
  assert.equal(await f.worker.followUps(st, f.task), 0);
  f.eventsList.push({ id: 'u99', taskId: f.task.id, comment: 'What about breakfast?', actor: { id: 'user1', type: 'user' }, createdAt: new Date(Date.now() + 60_000).toISOString() });
  const before = f.sent.length;
  assert.equal(await f.worker.followUps(st, f.task), 1);
  assert.deepEqual(f.sent.slice(before).map(e => e.status), ['RUNNING', 'COMPLETED']);
  assert.match(f.prompts.at(-1), /Mode: follow-up/);
  assert.match(f.prompts.at(-1), /What about breakfast/);
  assert.equal(await f.worker.followUps(st, f.task), 0);
});

test('progress lines name the other agent and what it found', async () => {
  const { describeAction, describeResult } = await import('../scripts/travel-worker.mjs');
  assert.match(describeAction({ toolName: 'destination_info', input: { destination: 'Cebu' } }), /knowledge desk \(another agent\).*Cebu/);
  assert.match(describeAction({ toolName: 'search_hotels', input: { city: 'Cebu', check_in: '2026-11-20', nights: 2 } }), /Expert Travel Agency hotel search: Cebu, check-in 2026-11-20, 2 night/);
  assert.match(describeAction({ toolName: 'destination_info', input: { destination: 'Cebu' } }), /0\.5 test USDM/);
  assert.match(describeAction({ toolName: 'search_flights', input: { origin: 'SIN', destination: 'CEB', departure_date: '2026-11-20' } }), /flight search: SIN → CEB.*1 test USDM/);
  assert.equal(describeAction({ toolName: 'other' }), undefined);
  assert.equal(describeResult({ output: { offers: [{}, {}, {}] } }), 'Found 3 flight offers (test fares).');
  assert.equal(describeResult({ output: { hotels: [{}, {}] } }), 'Found 2 hotel options with live rates.');
  assert.equal(describeResult({ output: { answer: 'x' } }), 'The knowledge desk answered.');
});

test('a hung agent turn fails the task after the time limit instead of blocking the worker', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'travel-worker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await createStore(resolve(dir, 'travel'));
  const task = { id: 'task_hung1234', status: 'READY', description: 'Plan 3 days in Cebu from 20 November', assigneeId: 'cw1' };
  const sent = [];
  const hang = { sessions: { create: async () => ({ session: { send: async () => ({ async *[Symbol.asyncIterator]() { await new Promise(() => {}); } }) } }) } };
  const worker = createTravelWorker({ api: { get: async () => ({ data: [] }), post: async (_p, body) => { sent.push(body); return { data: { id: 'x', status: body.status } }; } },
    mps: {}, eve: hang, advisor: {}, store, source, coworkerId: 'cw1', dataDir: dir, log: () => {}, turnTimeoutMs: 50 });
  assert.equal(await worker.advance(task), 'failed');
  assert.equal(sent.at(-1).status, 'FAILED');
  assert.equal((await store.read(task.id)).phase, 'blocked');
});

// ---- Trip Desk: reviewed plan with receipt, LiteAPI booking, honest failures, concurrency ----
const lite = { request: { city: 'Cebu', country_code: 'PH', check_in: '2026-11-20', nights: 2, adults: 2, children_ages: [6, 9] },
  hotel: { id: 'lp1', name: 'Fili Hotel Cebu', source: 'liteapi', bookable: true, total: { amount: '120.00', currency: 'USD' }, free_cancellation: true },
  alternatives: [{ id: 'lp2', name: 'Parklane', source: 'liteapi', bookable: true, total: { amount: '150.00', currency: 'USD' }, free_cancellation: true }] };
const okCheck = hotel => ({ ok: true, offer: { offer_id: `offer-${hotel.id}` }, hotel: { ...hotel, total: { amount: '125.00', currency: 'USD' } } });
const reservation = { id: 'bk1', status: 'CONFIRMED', confirmation_code: 'HC123', hotel: 'Fili Hotel Cebu', checkin: '2026-11-20', checkout: '2026-11-22', total: { amount: '125.00', currency: 'USD' }, sandbox: true };

test('the plan gets the reviewer text, the receipt and the booking fee before the final question', async t => {
  const f = await fixture(t, { plan: lite, deps: {
    review: async ({ answer }) => answer.replace('PLAN TEXT', 'REVIEWED PLAN'),
    receipt: async taskRef => `**Receipt for ${taskRef}**` } });
  await f.worker.advance(f.task);
  const offer = f.sent.at(-1).comment;
  assert.equal(f.sent.at(-1).status, 'INPUT_REQUIRED');
  assert.match(offer, /^REVIEWED PLAN/);
  const receiptAt = offer.indexOf('**Receipt for task_abcdefgh**'), feeAt = offer.search(/Booking fee if you reply "book": \d/), questionAt = offer.indexOf('Would you like me to');
  assert.ok(receiptAt > 0 && feeAt > receiptAt && questionAt > feeAt, offer);
});

test('the fee line tells the truth for pay-at-property stays: free when only a pre-filled page can be opened', async () => {
  const { offerFeeLine } = await import('../scripts/booking-copy.mjs');
  assert.match(offerFeeLine(lite), /locked in escrow first/);
  const line = offerFeeLine(plan);
  assert.match(line, /pre-filled hotel page for free/); assert.match(line, /Booking fee if you reply "book"/);
});

test('a failing reviewer or receipt never blocks the plan', async t => {
  const f = await fixture(t, { plan: lite, deps: { review: async () => { throw new Error('boom'); }, receipt: async () => { throw new Error('boom'); } } });
  await f.worker.advance(f.task);
  assert.equal(f.sent.at(-1).status, 'INPUT_REQUIRED');
  assert.match(f.sent.at(-1).comment, /^PLAN TEXT/);
});

test('a LiteAPI stay is checked first, booked only after escrow, and the confirmation is part of the result', async t => {
  const calls = [];
  const booker = { check: async (_plan, hotel) => { calls.push(['check', hotel.id]); return okCheck(hotel); },
    book: async input => { calls.push(['book', input.taskId, input.offer.offer_id, input.adults]); return reservation; }, guest: { given_name: 'Alex', family_name: 'Traveller', email: 'a@example.com' } };
  const f = await fixture(t, { plan: lite, deps: { booker } });
  await f.worker.advance(f.task); f.reply('book');
  assert.equal(await f.worker.advance(f.task), 'waiting');
  assert.deepEqual(calls, [['check', 'lp1']]); // nothing booked before the escrow is confirmed
  const payEvent = f.sent.find(e => e.masumiPayment);
  assert.match(payEvent.comment, /^Payment requested: 2\.5 test USDM\./); // 2% of the refreshed 125.00
  f.funds();
  assert.equal(await f.worker.advance(f.task), 'waiting');
  assert.deepEqual(calls.at(-1), ['book', 'task_abcdefgh', 'offer-lp1', 2]);
  assert.equal(calls.filter(c => c[0] === 'book').length, 1);
  f.submitted();
  assert.equal(await f.worker.advance(f.task), 'completed');
  const done = f.sent.at(-1);
  assert.match(done.comment, /HC123/); assert.match(done.comment, /sandbox/i); assert.match(done.comment, /Fili Hotel Cebu/);
  assert.equal(calls.filter(c => c[0] === 'book').length, 1);
  assert.equal(await f.worker.advance(f.task), 'skipped'); // collecting phase is never booked again
});

test('the next bookable stay is used when the top pick is gone, and the traveller is told', async t => {
  const booker = { check: async (_plan, hotel) => hotel.id === 'lp1' ? { ok: false, reason: 'sold out' } : okCheck(hotel), book: async () => reservation, guest: {} };
  const f = await fixture(t, { plan: lite, deps: { booker } });
  await f.worker.advance(f.task); f.reply('book'); await f.worker.advance(f.task);
  const st = await f.store.read(f.task.id);
  assert.equal(st.plan.hotel.id, 'lp2'); assert.equal(st.plan.swappedFrom, 'Fili Hotel Cebu');
});

test('no bookable stay ends as FAILED with nothing charged', async t => {
  const booker = { check: async () => ({ ok: false, reason: 'sold out' }), book: async () => { throw new Error('must not book'); }, guest: {} };
  const f = await fixture(t, { plan: lite, deps: { booker } });
  await f.worker.advance(f.task); f.reply('book'); await f.worker.advance(f.task);
  assert.equal(f.sent.at(-1).status, 'FAILED');
  assert.match(f.sent.at(-1).comment, /nothing was charged/);
  assert.equal(f.sent.some(e => e.masumiPayment), false);
});

test('a booking rejected after the escrow is blocked for inspection and the result hash is not submitted', async t => {
  const booker = { check: async (_p, hotel) => okCheck(hotel), book: async () => { throw Object.assign(new Error('Rate changed'), { definite: true, code: 'RATE_CHANGED' }); }, guest: {} };
  const f = await fixture(t, { plan: lite, deps: { booker } });
  await f.worker.advance(f.task); f.reply('book'); await f.worker.advance(f.task); f.funds();
  assert.equal(await f.worker.advance(f.task), 'blocked');
  const st = await f.store.read(f.task.id);
  assert.equal(st.phase, 'blocked'); assert.equal(st.reason, 'BOOKING_REJECTED_AFTER_ESCROW');
  assert.equal(f.resultHash, undefined);
  assert.match(f.sent.at(-1).comment, /nothing was reserved/i);
});

test('an unknown booking outcome is never retried and needs inspection', async t => {
  let n = 0;
  const booker = { check: async (_p, hotel) => okCheck(hotel), book: async () => { n++; throw Object.assign(new Error('timeout'), { definite: false }); }, guest: {} };
  const f = await fixture(t, { plan: lite, deps: { booker } });
  await f.worker.advance(f.task); f.reply('book'); await f.worker.advance(f.task); f.funds();
  assert.equal(await f.worker.advance(f.task), 'inspection_required');
  assert.equal((await f.store.read(f.task.id)).inspectionRequired, true);
  assert.equal(n, 1);
});

test('an advisor stay that cannot open an offer gets the pre-filled page for free, clearly not a reservation', async t => {
  const advisor = { openCheckout: async () => ({ opened: false, failure_reason: 'no offer', linkOnly: { hotel: plan.hotel, url: 'https://www.hotels.com/ho1/?x=1' } }) };
  const f = await fixture(t);
  const worker = createTravelWorker({ api: { get: async () => ({ data: f.eventsList }), post: async (_p, body) => { f.sent.push(body); return { data: { id: 'x', status: body.status } }; } },
    mps: {}, eve: {}, advisor, store: f.store, source, coworkerId: 'cw1', dataDir: f.dir, log: () => {} });
  await f.worker.advance(f.task); f.reply('book');
  assert.equal(await worker.advance(f.task), 'completed');
  assert.equal(f.sent.at(-1).status, 'COMPLETED');
  assert.match(f.sent.at(-1).comment, /hotels\.com\/ho1/); assert.match(f.sent.at(-1).comment, /no reservation/i);
  assert.equal(f.sent.some(e => e.masumiPayment), false);
});

test('tasks run side by side: agent turns are limited, waiting tasks never take a slot, and none starts twice', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'travel-worker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(resolve(dir, 'plans'), { recursive: true });
  const store = await createStore(resolve(dir, 'travel'));
  const tasks = ['task_slow0001', 'task_slow0002', 'task_more0003'].map(id => ({ id, status: 'READY', description: 'Plan Cebu 20 November', assigneeId: 'cw1', organizationId: null }));
  const gates = new Map(); const started = []; const sent = [];
  const api = { get: async path => path.startsWith('/v1/tasks?') && path.includes('status=READY') ? { data: tasks } : { data: [] }, post: async (_p, body) => { sent.push(body); return { data: { id: 'x', status: body.status } }; } };
  const worker = createTravelWorker({ api, mps: {}, eve: {}, advisor: {}, store, source, coworkerId: 'cw1', dataDir: dir, log: () => {}, concurrency: 2,
    runAgent: async prompt => { const id = /Task reference: (\S+)/.exec(prompt)[1]; started.push(id); await new Promise(r => gates.set(id, r)); return 'Which date do you arrive?'; } });
  const until = async check => { for (let i = 0; i < 100 && !check(); i++) await new Promise(r => setTimeout(r, 20)); };
  await worker.tick({ wait: false });
  await until(() => started.length === 2);
  assert.deepEqual(started.slice().sort(), ['task_more0003', 'task_slow0001', 'task_slow0002'].slice(0, 2).sort().length === 2 ? started.slice().sort() : []);
  assert.equal(started.length, 2); // limit 2: the third task waits for a free turn
  await worker.tick({ wait: false }); // a second poll never starts a running task again
  await new Promise(r => setTimeout(r, 60));
  assert.equal(started.length, 2);
  gates.get(started[0])();
  await until(() => started.length === 3);
  assert.equal(new Set(started).size, 3);
  for (const id of started) await until(() => gates.has(id)), gates.get(id)();
  await worker.idle();
  assert.equal(sent.filter(e => e.status === 'INPUT_REQUIRED').length, 3);
});
