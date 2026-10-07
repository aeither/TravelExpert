import test from 'node:test';
import assert from 'node:assert/strict';
import { createOriginBooker, bookingKey, guestFromRequest } from '../scripts/origin-booking.mjs';
import { createAdvisor } from '../scripts/advisor.mjs';

const plan = { request: { city: 'Cebu', country_code: 'PH', check_in: '2026-11-20', nights: 2, adults: 2, children_ages: [6, 9] },
  hotel: { id: 'lp1', name: 'Fili Hotel Cebu', source: 'liteapi', bookable: true, total: { amount: '120.00', currency: 'USD' }, free_cancellation: true },
  alternatives: [{ id: 'lp2', name: 'Parklane', source: 'liteapi', bookable: true, total: { amount: '150.00', currency: 'USD' }, free_cancellation: true }] };
const search = hotels => ({ provider: 'liteapi', data: { hotels } });
const room = (offer, total, refundable = true) => ({ offer_id: offer, board: 'RO', total: { amount: total, currency: 'USD' }, refundable });
const config = { baseUrl: 'https://origin.example.com', apiKey: 'k'.repeat(24), guest: { given_name: 'Alex', family_name: 'Traveller', email: 'alex@example.com' } };

test('bookingKey is stable, safe and tied to the task and hotel', () => {
  assert.equal(bookingKey('task_abcdefgh', 'lp1'), bookingKey('task_abcdefgh', 'lp1'));
  assert.notEqual(bookingKey('task_abcdefgh', 'lp1'), bookingKey('task_abcdefgh', 'lp2'));
  assert.match(bookingKey('task_abcdefgh', 'lp1'), /^[A-Za-z0-9_-]{8,128}$/);
});

test('guest name comes from "under <name>" in the request, else the configured default', () => {
  assert.deepEqual(guestFromRequest('Plan Cebu, book under Maria Santos', config.guest), { given_name: 'Maria', family_name: 'Santos', email: 'alex@example.com' });
  assert.deepEqual(guestFromRequest('Plan Cebu', config.guest), config.guest);
});

test('check refreshes the offer with hotel_ids, picks the cheapest refundable room and enforces the price window', async () => {
  const calls = [];
  const send = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.authorization });
    return Response.json(search([{ id: 'lp1', name: 'Fili Hotel Cebu', rooms: [room('offer-cheap-nonref', '100.00', false), room('offer-ok', '125.00'), room('offer-dear', '300.00')] }])); };
  const booker = createOriginBooker({ ...config, fetch: send });
  const result = await booker.check(plan);
  assert.equal(result.ok, true);
  assert.equal(result.offer.offer_id, 'offer-ok');
  assert.equal(result.hotel.total.amount, '125.00');
  assert.equal(calls[0].url, 'https://origin.example.com/v1/stays/search');
  assert.deepEqual(calls[0].body.hotel_ids, ['lp1']);
  assert.equal(calls[0].body.provider, 'liteapi');
  assert.deepEqual(calls[0].body.rooms, [{ adults: 2, children_ages: [6, 9] }]);
  assert.equal(calls[0].body.check_out_date, '2026-11-22');
  assert.equal(calls[0].auth, `Bearer ${config.apiKey}`);
});

test('check refuses a price jump above 10 percent or a lost free cancellation', async () => {
  const jump = createOriginBooker({ ...config, fetch: async () => Response.json(search([{ id: 'lp1', rooms: [room('o', '140.00')] }])) });
  const a = await jump.check(plan);
  assert.equal(a.ok, false); assert.match(a.reason, /price/i);
  const lost = createOriginBooker({ ...config, fetch: async () => Response.json(search([{ id: 'lp1', rooms: [room('o', '120.00', false)] }])) });
  const b = await lost.check(plan);
  assert.equal(b.ok, false); assert.match(b.reason, /cancellation/i);
  const gone = createOriginBooker({ ...config, fetch: async () => Response.json(search([])) });
  assert.equal((await gone.check(plan)).ok, false);
});

test('book sends an idempotency key, confirm and a max_total just above the checked price', async () => {
  const seen = [];
  const send = async (url, init) => { seen.push({ url: String(url), init, body: JSON.parse(init.body) });
    return Response.json({ provider: 'liteapi', environment: 'sandbox', data: { id: 'bk1', status: 'CONFIRMED', confirmation_code: 'HC123', hotel: 'Fili Hotel Cebu', checkin: '2026-11-20', checkout: '2026-11-22', total: { amount: '125.00', currency: 'USD' }, sandbox: true } }); };
  const booker = createOriginBooker({ ...config, fetch: send });
  const out = await booker.book({ taskId: 'task_abcdefgh', hotel: plan.hotel, offer: { offer_id: 'offer-ok' }, total: { amount: '125.00', currency: 'USD' }, guest: config.guest, adults: 2 });
  assert.equal(out.id, 'bk1'); assert.equal(out.confirmation_code, 'HC123'); assert.equal(out.sandbox, true);
  assert.equal(seen[0].url, 'https://origin.example.com/v1/stays/bookings');
  assert.equal(seen[0].init.headers['idempotency-key'], bookingKey('task_abcdefgh', 'lp1'));
  assert.equal(seen[0].body.confirm, true);
  assert.equal(seen[0].body.offer_id, 'offer-ok');
  assert.equal(seen[0].body.max_total.currency, 'USD');
  assert.ok(Number(seen[0].body.max_total.amount) >= 125 && Number(seen[0].body.max_total.amount) <= 140);
  assert.equal(seen[0].body.guests.length, 2);
});

test('book reports a definite rejection as retryable=false and a timeout as unknown', async () => {
  const rejected = createOriginBooker({ ...config, fetch: async () => Response.json({ error: { code: 'PRICE_OVER_BUDGET', message: 'over' } }, { status: 409 }) });
  await assert.rejects(rejected.book({ taskId: 'task_abcdefgh', hotel: plan.hotel, offer: { offer_id: 'o' }, total: { amount: '1', currency: 'USD' }, guest: config.guest, adults: 1 }), e => e.definite === true && e.code === 'PRICE_OVER_BUDGET');
  const unknown = createOriginBooker({ ...config, fetch: async () => { throw new Error('socket hang up'); } });
  await assert.rejects(unknown.book({ taskId: 'task_abcdefgh', hotel: plan.hotel, offer: { offer_id: 'o' }, total: { amount: '1', currency: 'USD' }, guest: config.guest, adults: 1 }), e => e.definite === false);
});

test('advisor understands the deployed shape: a pre-filled page without an offer is a link-only handover', async () => {
  const deployed = { status: 'completed', action: 'checkout', stays: [{ property_id: '9', name: 'Moonlight', url: 'https://www.hotels.com/ho1/?x=1' }], checkout_error: 'The selected stay has no offer to open' };
  const advisor = createAdvisor('https://advisor.example.com', async () => Response.json(deployed));
  const single = await advisor.checkout({ destination: 'Siargao', check_in: '2026-11-08', check_out: '2026-11-10', adults: 2, property_id: '9' });
  assert.equal(single.opened, false); assert.equal(single.linkOnly, true); assert.equal(single.url, 'https://www.hotels.com/ho1/?x=1');
  const result = await advisor.openCheckout({ request: { city: 'Siargao', check_in: '2026-11-08', nights: 2, adults: 2 }, hotel: { id: '9', name: 'Moonlight' }, alternatives: [] });
  assert.equal(result.opened, false); assert.equal(result.linkOnly.url, 'https://www.hotels.com/ho1/?x=1'); assert.equal(result.linkOnly.hotel.id, '9');
});

test('advisor still opens a real checkout in the old shape and prefers it over a link', async () => {
  const advisor = createAdvisor('https://advisor.example.com', async () => Response.json({ checkout: { trip_id: 't', checkout_url: 'https://www.hotels.com/co' } }));
  const result = await advisor.openCheckout({ request: { city: 'X', check_in: '2026-11-08', nights: 1, adults: 1 }, hotel: { id: '1', name: 'A' }, alternatives: [] });
  assert.equal(result.opened, true); assert.equal(result.checkout.url, 'https://www.hotels.com/co');
});
