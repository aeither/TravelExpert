// Hotel booking through the Expert Travel Agency (origin-api): LiteAPI prebook + book with an idempotency key,
// explicit confirmation and a price cap. Code decides every step; the model never sees this module.
import { createHash } from 'node:crypto';

const PRICE_WINDOW = 1.1; // refuse a refreshed price more than 10% above the plan
const CAP_MARGIN = 1.02; // the booking cap sits just above the refreshed price
const REQUEST_MS = 90_000;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const money = value => (Math.round(value * 100) / 100).toFixed(2);

// The same task and hotel always map to the same key, so a repeated request returns the saved booking instead of booking twice.
export const bookingKey = (taskId, hotelId) => `te-${createHash('sha256').update(`${taskId}:${hotelId}`).digest('hex').slice(0, 40)}`;

// "book under Maria Santos" names the guest. Otherwise the configured default guest is used.
export function guestFromRequest(text, fallback) {
  const match = /\bunder\s+(\p{Lu}[\p{L}'-]+)\s+(\p{Lu}[\p{L}'-]+(?:\s+\p{Lu}[\p{L}'-]+)*)/u.exec(String(text ?? ''));
  return match ? { given_name: match[1], family_name: match[2], email: fallback.email } : fallback;
}

export function createOriginBooker({ baseUrl, apiKey, guest, fetch: send = fetch }) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(base.hostname)) throw new Error('ORIGIN_API_URL must be https.');
  if (!apiKey) throw new Error('ORIGIN_API_KEY is not set.');
  const call = async (path, body, headers = {}) => {
    const response = await send(new URL(path, base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(REQUEST_MS),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, ...headers }, body: JSON.stringify(body) });
    return { response, payload: await response.json().catch(() => ({})) };
  };

  // Dry run before any money moves: the offer must still exist at a price close to the plan, with the same cancellation terms.
  async function check(plan, hotel = plan.hotel) {
    const { request } = plan;
    try {
      const { response, payload } = await call('/v1/stays/search', {
        check_in_date: request.check_in, check_out_date: addDays(request.check_in, request.nights),
        rooms: [{ adults: request.adults, ...(request.children_ages?.length ? { children_ages: request.children_ages } : {}) }],
        location: { city: request.city, country_code: String(request.country_code).toUpperCase() }, currency: hotel.total?.currency ?? 'USD', guest_nationality: 'US',
        hotel_ids: [String(hotel.id)], provider: 'liteapi', limit: 1 });
      if (!response.ok) return { ok: false, reason: `the hotel search answered HTTP ${response.status}` };
      const found = (payload.data?.hotels ?? []).find(h => String(h.id) === String(hotel.id));
      if (!found) return { ok: false, reason: 'the hotel is no longer available for these dates' };
      const rooms = (found.rooms ?? []).filter(r => r.offer_id && Number(r.total?.amount) > 0 && (!hotel.free_cancellation || r.refundable));
      if (!rooms.length) return { ok: false, reason: hotel.free_cancellation ? 'no room with free cancellation is left' : 'no room is left' };
      const offer = rooms.sort((a, b) => Number(a.total.amount) - Number(b.total.amount))[0];
      if (Number(offer.total.amount) > Number(hotel.total?.amount) * PRICE_WINDOW) return { ok: false, reason: `the price rose to ${offer.total.amount} ${offer.total.currency}` };
      return { ok: true, offer, hotel: { ...hotel, total: offer.total } };
    } catch (error) { return { ok: false, reason: `the hotel search did not answer (${String(error?.message ?? error).slice(0, 60)})` }; }
  }

  // `definite` tells the caller whether the supplier definitely did not book (true) or the outcome is unknown (false).
  async function book({ taskId, hotel, offer, total, guest: who = guest }) {
    const cap = money(Number(total.amount) * CAP_MARGIN);
    let result;
    try {
      result = await call('/v1/stays/bookings', {
        offer_id: offer.offer_id, confirm: true, max_total: { amount: cap, currency: total.currency },
        // One lead guest per room: LiteAPI rejects several guests that share a room (verified live 2026-10-07).
        guests: [{ given_name: who.given_name, family_name: who.family_name, email: who.email, occupancy_number: 1 }],
      }, { 'idempotency-key': bookingKey(taskId, hotel.id) });
    } catch (error) { throw Object.assign(new Error(`The booking outcome is unknown (${String(error?.message ?? error).slice(0, 80)}).`), { definite: false, code: 'UNKNOWN' }); }
    const { response, payload } = result;
    if (!response.ok) {
      const code = payload?.error?.code ?? `HTTP_${response.status}`;
      throw Object.assign(new Error(payload?.error?.message ?? `The booking was rejected (${code}).`), { definite: (response.status >= 400 && response.status < 500) || (code === 'UPSTREAM_REJECTED' && payload?.error?.details?.state === 'failed'), code });
    }
    const data = payload.data ?? payload;
    if (!data?.id) throw Object.assign(new Error('The booking answer had no booking id.'), { definite: false, code: 'NO_BOOKING_ID' });
    return { id: String(data.id), status: data.status ?? null, confirmation_code: data.confirmation_code ?? null, hotel: data.hotel ?? hotel.name, checkin: data.checkin ?? null, checkout: data.checkout ?? null,
      total: data.total ?? total, sandbox: data.sandbox !== false, operation_id: data.operation_id ?? null };
  }
  return { check, book, guest };
}
