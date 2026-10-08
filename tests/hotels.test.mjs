import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchHotels, clearHotelCaches } from '../agent/lib/hotels.ts';
import { clearPaidCache } from '../agent/lib/paid.ts';
import { openLedger } from '../scripts/ledger.mjs';
import { savePlan } from '../agent/tools/save_plan.ts';

const tomorrow = () => new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
const TASK = 'task_abcdef12';
const input = (extra = {}) => ({ city: 'Cebu', country_code: 'ph', check_in: tomorrow(), nights: 2, adults: 2, children_ages: [], ...extra });
const room = (offer, total, refundable = true, board = 'Room only') => ({ offer_id: offer, board, refundable, total: { amount: total, currency: 'USD' } });
const liteapi = hotels => ({ provider: 'liteapi', observed_at: 'now', data: { hotels } });
const lite = (id, name, total, rating, rooms) => ({ id, name, stars: 4, rating, address: `${name} street`, cheapest_total: { amount: total, currency: 'USD' }, rooms: rooms ?? [room(`offer-${id}`, total)] });
const ledgerFor = async () => openLedger(await mkdtemp(join(tmpdir(), 'ledger-')));
const env = { DATA_DIR: '/nonexistent' };

test('hotel search sends the family and asks provider auto; LiteAPI hotels are bookable and ranked', async () => {
  clearHotelCaches();
  let call;
  const fetcher = async (url, init) => { if (!init?.method) return new Response('no', { status: 404 }); call = { url, body: JSON.parse(init.body) };
    return Response.json(liteapi([lite('1', 'Pricey', '400.00', 9.5), lite('2', 'Value', '180.00', 8.4), lite('3', 'Rough', '120.00', 5)])); };
  const ledger = await ledgerFor();
  const result = await searchHotels(input({ children_ages: [6, 9], task_ref: TASK }), { fetcher, ledger, env });
  assert.match(call.url, /\/v1\/stays\/search$/);
  assert.equal(call.body.provider, 'auto');
  assert.deepEqual(call.body.rooms, [{ adults: 2, children_ages: [6, 9] }]);
  assert.equal(call.body.location.country_code, 'PH');
  assert.deepEqual(result.hotels.map(h => h.name), ['Value', 'Pricey', 'Rough']);
  assert.equal(result.hotels[0].bookable, true);
  assert.equal(result.hotels[0].source, 'liteapi');
  assert.equal(result.hotels[0].offer_id, 'offer-2');
  assert.equal(result.hotels[0].total_price, '180.00 USD');
  assert.equal(result.hotels[0].nightly_price, '90.00 USD');
  assert.match(result.occupancy_note, /2 adults and 2 children/);
  const evidence = (await ledger.read(TASK)).evidence.hotels;
  assert.equal(evidence.length, 3);
  assert.deepEqual(evidence[0], { name: 'Value', total: 180, nightly: 90, currency: 'USD', free_cancellation: true, source: 'liteapi' });
});

test('the nightly budget is enforced in code and explained when nothing fits', async () => {
  clearHotelCaches();
  const fetcher = async (url, init) => Response.json(liteapi([lite('1', 'A', '400.00', 9), lite('2', 'B', '180.00', 8)]));
  const ok = await searchHotels(input({ budget_per_night: 100 }), { fetcher, env });
  assert.deepEqual(ok.hotels.map(h => h.name), ['B']);
  assert.equal(ok.dropped_over_budget, 1);
  const none = await searchHotels(input({ budget_per_night: 50 }), { fetcher, env });
  assert.match(none.error, /No hotel fits 50 USD per night.*cheapest is B at 90.00 USD/);
});

test('Advisor hotels are listed as not bookable, keep their link, and children are flagged as not priced', async () => {
  clearHotelCaches();
  const fetcher = async () => Response.json({ provider: 'advisor', data: { hotels: [{ id: '110', lodging: 'APART_HOTEL', name: 'Moonlight', url: 'https://hotels.example/m', nightly: { amount: '34.00', currency: 'USD' }, cheapest_total: { amount: '170.00', currency: 'USD' }, rooms: [{ offer_id: '110', refundable: true, total: { amount: '170.00', currency: 'USD' } }] },
    { id: '111', name: 'Bad link', url: 'javascript:alert(1)', cheapest_total: { amount: '60', currency: 'USD' }, rooms: [{ refundable: false }] }, { id: '112', name: 'Free?', cheapest_total: { amount: '0', currency: 'USD' }, rooms: [] }] } });
  const result = await searchHotels(input({ nights: 5, children_ages: [6] }), { fetcher, env });
  assert.deepEqual(result.hotels.map(h => h.name), ['Moonlight', 'Bad link']);
  assert.equal(result.hotels[0].bookable, false);
  assert.equal(result.hotels[0].source, 'advisor');
  assert.equal(result.hotels[0].checkout_url, 'https://hotels.example/m');
  assert.equal(result.hotels[1].checkout_url, undefined);
  assert.equal(result.hotels[0].nightly_price, '34.00 USD');
  assert.match(result.occupancy_note, /adults only/);
});

test('review highlights and the children policy come from the free hotel details; a hotel that forbids kids is dropped', async () => {
  clearHotelCaches();
  const seen = [];
  const fetcher = async (url, init) => {
    if (init?.method === 'POST') return Response.json(liteapi([lite('1', 'NoKids', '100.00', 9), lite('2', 'Family', '140.00', 8.6)]));
    seen.push([String(url), init.headers.authorization]);
    return Response.json({ data: String(url).endsWith('/1') ? { children_allowed: false, review_highlights: { pros: ['quiet'], cons: [] } } : { children_allowed: true, review_highlights: { pros: ['pool'], cons: ['small rooms'] } } });
  };
  const result = await searchHotels(input({ children_ages: [6] }), { fetcher, env: { ...env, ORIGIN_API_KEY: 'k' } });
  assert.deepEqual(result.hotels.map(h => h.name), ['Family']);
  assert.deepEqual(result.hotels[0].review_highlights, { pros: ['pool'], cons: ['small rooms'] });
  assert.equal(result.hotels[0].children_allowed, true);
  assert.equal(seen[0][1], 'Bearer k');
});

test('past check-in and upstream failures return an error the agent can explain', async () => {
  assert.match((await searchHotels(input({ check_in: '2020-01-01' }), { fetcher: async () => { throw new Error('must not call'); } })).error, /after today/);
  assert.match((await searchHotels(input(), { fetcher: async () => new Response('x', { status: 502 }) })).error, /HTTP 502/);
  assert.match((await searchHotels(input(), { fetcher: async () => Response.json(liteapi([])) })).error, /No hotel/);
});

test('paid mode buys the search once per task, records it, and fails closed', async () => {
  clearHotelCaches(); clearPaidCache();
  const dir = await mkdtemp(join(tmpdir(), 'paid-'));
  const config = { mpsUrl: 'https://mps.test/api/v1', token: 't', sellerUrl: 'https://seller.test', agentIdentifier: 'a'.repeat(60), dir, ledgerDir: dir, capAtomic: 4_000_000n, maxPerHour: 12 };
  const ledger = await openLedger(dir + '/l');
  let bought = 0, sent;
  const buy = async ({ inputData }) => { bought++; sent = JSON.parse(inputData.trip_request_json);
    return { result: JSON.stringify({ results: { stays: liteapi([lite('1', 'Paid hotel', '90.00', 8.5)]) } }), journal: { stage: 'completed', jobId: 'j', fundsLockedTx: 'e1', transactions: { result: 'r1' }, quote: { blockchainIdentifier: 'bid' } } }; };
  const paidEnv = { A2A_PAID_SEARCH: '1', MPS_URL: 'https://mps.test/api/v1', MPS_BUYER_TOKEN: 't', A2A_AGENT_IDENTIFIER: 'a'.repeat(60), DATA_DIR: dir };
  const deps = { env: paidEnv, ledger, buy: { buy, ledger, store: { ids: async () => [], read: async () => null }, mps: {} } };
  const first = await searchHotels(input({ task_ref: TASK }), deps);
  const again = await searchHotels(input({ task_ref: TASK }), deps);
  assert.equal(first.hotels[0].name, 'Paid hotel');
  assert.match(first.source, /paid via Masumi/);
  assert.equal(again.hotels[0].name, 'Paid hotel');
  assert.equal(bought, 1);
  assert.equal(sent.stays.provider, 'auto');
  const purchases = (await ledger.read(TASK)).purchases;
  assert.equal(purchases.length, 1);
  assert.equal(purchases[0].status, 'completed');
  assert.equal(purchases[0].escrowTx, 'e1');
  assert.equal(purchases[0].resultTx, 'r1');
  const failing = { ...deps, buy: { ...deps.buy, buy: async () => ({ result: null, journal: { stage: 'refund-requested' } }) } };
  assert.match((await searchHotels(input({ task_ref: 'task_other123' }), failing)).error, /paid Expert Travel Agency search failed/);
});

test('save_plan keeps the picked hotel with its offer, source and the family', async () => {
  clearHotelCaches();
  const dir = await mkdtemp(join(tmpdir(), 'plans-'));
  const fetcher = async () => Response.json(liteapi([lite('1', 'Top', '160.00', 9), lite('2', 'Alt', '200.00', 8.2)]));
  const saved = await savePlan({ ...input({ children_ages: [6, 9], budget_per_night: 150 }), task_ref: TASK, hotel_id: '1' }, dir, { fetcher, env });
  assert.deepEqual(saved, { saved: true, hotel: 'Top', total: '160.00 USD', source: 'liteapi', bookable: true });
  const plan = JSON.parse(await readFile(join(dir, `${TASK}.json`), 'utf8'));
  assert.equal(plan.hotel.offer_id, 'offer-1');
  assert.equal(plan.hotel.bookable, true);
  assert.deepEqual(plan.request.children_ages, [6, 9]);
  assert.equal(plan.request.budget_per_night, 150);
  assert.equal(plan.alternatives[0].name, 'Alt');
  assert.match((await savePlan({ ...input(), task_ref: TASK, hotel_id: 'nope' }, dir, { fetcher, env })).error, /not in the search results/);
});

test('save_plan records the searched hotels as audit evidence even when search_hotels ran without a task reference', async () => {
  clearHotelCaches();
  const dir = await mkdtemp(join(tmpdir(), 'plans-'));
  const ledger = await ledgerFor();
  const fetcher = async () => Response.json(liteapi([lite('1', 'Top', '160.00', 9), lite('2', 'Alt', '200.00', 8.2)]));
  await searchHotels(input(), { fetcher, ledger, env });
  assert.equal((await ledger.read(TASK)).evidence.hotels.length, 0);
  await savePlan({ ...input(), task_ref: TASK, hotel_id: '1' }, dir, { fetcher, ledger, env });
  assert.deepEqual((await ledger.read(TASK)).evidence.hotels.map(h => h.name), ['Top', 'Alt']);
});
