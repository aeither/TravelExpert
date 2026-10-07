import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flightInput, searchFlights } from '../agent/lib/flights.ts';
import { openLedger } from '../scripts/ledger.mjs';

const T = 'task_abcdef12';
const day = n => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const offer = (id, total, stops = 0) => ({ id, total_amount: total, total_currency: 'USD', owner: { name: 'Test Air' }, slices: [{ origin: { iata_code: 'SIN' }, destination: { iata_code: 'CEB' }, duration: 'PT4H30M', segments: Array.from({ length: stops + 1 }, (_, i) => ({ departing_at: `2026-11-08T0${i}:00:00`, arriving_at: '2026-11-08T12:00:00' })) }] });

test('flight input uppercases airport codes and defaults to one adult', () => {
  const parsed = flightInput.parse({ origin: 'sin', destination: 'ceb', departure_date: day(5), task_ref: T });
  assert.equal(parsed.origin, 'SIN'); assert.equal(parsed.adults, 1); assert.deepEqual(parsed.children_ages, []);
  assert.throws(() => flightInput.parse({ origin: 'Singapore', destination: 'CEB', departure_date: day(5), task_ref: T }));
});

test('flights are searched for the whole party, ranked by price, and kept as evidence', async () => {
  let sent;
  const fetcher = async (url, init) => { sent = { url: String(url), body: JSON.parse(init.body) }; return Response.json({ observed_at: 'now', data: { offers: [offer('o2', '300.00', 1), offer('o1', '210.50'), offer('bad', '0')] } }); };
  const ledger = await openLedger(await mkdtemp(join(tmpdir(), 'fl-')));
  const result = await searchFlights({ origin: 'SIN', destination: 'CEB', departure_date: day(5), return_date: day(8), adults: 2, children_ages: [6], task_ref: T }, { fetcher, ledger, env: {} });
  assert.match(sent.url, /\/v1\/flights\/search$/);
  assert.equal(sent.body.slices.length, 2);
  assert.deepEqual(sent.body.slices[1], { origin: 'CEB', destination: 'SIN', departure_date: day(8) });
  assert.deepEqual(sent.body.passengers, [{ type: 'adult' }, { type: 'adult' }, { age: 6 }]);
  assert.deepEqual(result.offers.map(o => o.offer_id), ['o1', 'o2']);
  assert.equal(result.offers[0].total_price, '210.50 USD');
  assert.equal(result.offers[1].slices[0].stops, 1);
  assert.match(result.note, /indicative/);
  const evidence = (await ledger.read(T)).evidence.flights;
  assert.equal(evidence[0].total, 210.5);
  assert.match(evidence[0].summary, /Test Air SIN→CEB, 0 stops/);
});

test('flight errors are explained, never thrown', async () => {
  const base = { origin: 'SIN', destination: 'CEB', adults: 1, children_ages: [], task_ref: T };
  const never = { fetcher: async () => { throw new Error('must not call'); }, env: {} };
  assert.match((await searchFlights({ ...base, departure_date: '2020-01-01' }, never)).error, /after today/);
  assert.match((await searchFlights({ ...base, departure_date: day(5), return_date: day(4) }, never)).error, /return date/);
  assert.match((await searchFlights({ ...base, departure_date: day(5) }, { fetcher: async () => new Response('x', { status: 503 }), env: {} })).error, /HTTP 503/);
  assert.match((await searchFlights({ ...base, departure_date: day(5) }, { fetcher: async () => Response.json({ data: { offers: [] } }), env: {} })).error, /No flight/);
});

test('paid flights go through the paid hop with a flights trip request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fl-'));
  const ledger = await openLedger(join(dir, 'l'));
  let sent;
  const env = { A2A_PAID_SEARCH: '1', MPS_URL: 'https://mps.test/api/v1', MPS_BUYER_TOKEN: 't', A2A_AGENT_IDENTIFIER: 'a'.repeat(60), DATA_DIR: dir };
  const buy = async ({ inputData }) => { sent = JSON.parse(inputData.trip_request_json); return { result: JSON.stringify({ results: { flights: { status: 'ok', data: { offers: [offer('o1', '99.00')] } } } }), journal: { stage: 'completed', quote: {} } }; };
  const result = await searchFlights({ origin: 'SIN', destination: 'CEB', departure_date: day(5), adults: 1, children_ages: [], task_ref: T }, { env, ledger, buy: { buy, ledger, mps: {}, store: { ids: async () => [], read: async () => null } } });
  assert.equal(sent.flights.slices[0].origin, 'SIN');
  assert.match(result.source, /paid via Masumi/);
  assert.equal((await ledger.read(T)).purchases[0].service, 'flight-search');
});
