import test from 'node:test';
import assert from 'node:assert/strict';
import { searchHotels } from '../agent/lib/hotels.ts';

const tomorrow = () => new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
const input = () => ({ city: 'Cebu', country_code: 'ph', check_in: tomorrow(), nights: 2, adults: 2 });

test('hotel search calls the Expert Travel Agency API and keeps only priced hotels with https links', async () => {
  let call;
  const fetcher = async (url, init) => { call = { url, body: JSON.parse(init.body) }; return Response.json({ observed_at: 'now', data: { hotels: [
    { name: 'A', url: 'https://hotels.example/a', cheapest_total: { amount: '54.00', currency: 'USD' }, rooms: [{ refundable: true }], rating: 8.4 },
    { name: 'B', url: 'javascript:alert(1)', cheapest_total: { amount: '60', currency: 'USD' }, rooms: [{ refundable: false }] },
    { name: 'C', cheapest_total: { amount: '0', currency: 'USD' }, rooms: [] },
  ] } }); };
  const result = await searchHotels(input(), fetcher);
  assert.match(call.url, /\/v1\/stays\/search$/);
  assert.equal(call.body.location.country_code, 'PH');
  assert.equal(call.body.rooms[0].adults, 2);
  assert.deepEqual(result.hotels.map(h => h.name), ['A', 'B']);
  assert.equal(result.hotels[0].checkout_url, 'https://hotels.example/a');
  assert.equal(result.hotels[1].checkout_url, undefined);
  assert.equal(result.hotels[0].free_cancellation, true);
});

test('past check-in and upstream failures return an error the agent can explain', async () => {
  assert.match((await searchHotels({ ...input(), check_in: '2020-01-01' }, async () => { throw new Error('must not call'); })).error, /after today/);
  assert.match((await searchHotels(input(), async () => new Response('x', { status: 502 }))).error, /HTTP 502/);
  assert.match((await searchHotels(input(), async () => Response.json({ data: { hotels: [] } }))).error, /No hotel/);
});

test('paid mode buys the search once, caches it, and fails closed', async () => {
  const { paidStaysSearch } = await import('../agent/lib/hotels.ts');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'paid-'));
  const config = { mpsUrl: 'https://mps.test/api/v1', token: 't', agentIdentifier: 'a'.repeat(60), dir, maxPerHour: 12 };
  let bought = 0;
  const buy = async ({ inputData }) => { bought++; return { result: JSON.stringify({ results: { stays: { data: { hotels: [{ id: '1' }] }, seen: inputData } } }) }; };
  const first = await paidStaysSearch({ stays: { x: 1 } }, config, buy);
  const again = await paidStaysSearch({ stays: { x: 1 } }, config, buy);
  assert.equal(first.data.hotels[0].id, '1');
  assert.equal(again, first);
  assert.equal(bought, 1);
  await assert.rejects(paidStaysSearch({ stays: { x: 2 } }, config, async () => ({ result: null })), /no result/);
  await assert.rejects(paidStaysSearch({}, null), /not configured/);
});
