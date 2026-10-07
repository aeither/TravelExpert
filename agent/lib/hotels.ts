import { resolve } from 'node:path';
import { z } from 'zod';
import { buyFromAgent, createBuyerMps, openA2aStore } from '../../scripts/a2a-buyer.mjs';

const ORIGIN_API_URL = (process.env.ORIGIN_API_URL || 'https://origin-api-production-d268.up.railway.app').replace(/\/$/, '');
const ADVISOR_URL = 'https://expert-travel-advisor-eve.vercel.app';
const HOTEL_BOOK_EXPERT = '67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b103648bcda30c275a2f3349dfbe65ca87ee7674af57314432e5cafa81d000001';

function advisorRequest(body: any) {
  const stays = body?.stays || body || {};
  const city = String(stays.location?.city || '').trim();
  const checkIn = String(stays.check_in_date || '').trim();
  const checkOut = String(stays.check_out_date || '').trim();
  const adults = Number(stays.rooms?.[0]?.adults || 2);
  const property = String(stays.property_id || stays.hotel_id || '').trim();
  if (!city || !checkIn || !checkOut) return '';
  const place = property ? `Book property ${property} in ${city}` : `in ${city}`;
  return `${place} from ${checkIn} to ${checkOut} for ${adults} adults, pay later, free cancellation. Return the hotel list.`;
}
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export const searchInput = z.object({
  city: z.string().min(2).describe('City or area, for example Cebu'),
  country_code: z.string().length(2).describe('ISO 3166-1 alpha-2 country code, for example PH'),
  check_in: day.describe('Check-in date YYYY-MM-DD, after today'),
  nights: z.number().int().min(1).max(13),
  adults: z.number().int().min(1).max(4).default(1),
});

// Paid mode: the Expert Travel Agency is hired through Masumi (1 test USDM per search, paid from our own wallet).
// Payment is code: the model only asks for a search. Fails closed, so a paid search never silently becomes a free one.
const paidConfig = (env = process.env) => env.A2A_PAID_SEARCH === '1' && env.MPS_URL && env.MPS_BUYER_TOKEN
  ? { mpsUrl: env.MPS_URL, token: env.MPS_BUYER_TOKEN, dir: resolve(env.DATA_DIR || '.local', 'a2a'), maxPerHour: Number(env.A2A_MAX_PER_HOUR || 12) } : null;
const searchCache = new Map<string, { at: number; found: any } | Promise<any>>();
const CACHE_MS = 15 * 60_000;

export async function paidStaysSearch(body: object, config = paidConfig(), buy = buyFromAgent): Promise<any> {
  if (!config) throw new Error('Paid search is not configured.');
  const key = JSON.stringify(body);
  const hit = searchCache.get(key);
  if (hit instanceof Promise) return hit;
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.found;
  const run = (async () => {
    const store = await openA2aStore(config.dir);
    const recent = (await Promise.all((await store.ids()).map((id: string) => store.read(id)))).filter((j: any) => j && Date.now() - Date.parse(j.startedAt) < 3_600_000).length;
    if (recent >= config.maxPerHour) throw new Error('Hourly paid-search limit reached.');
    const mps = createBuyerMps({ baseUrl: config.mpsUrl, token: config.token });
    const request = advisorRequest(body);
    const { result } = await buy({ sellerUrl: ADVISOR_URL, agentIdentifier: HOTEL_BOOK_EXPERT,
      inputData: request ? { request } : { trip_request_json: JSON.stringify(body) }, mps, store });
    if (typeof result !== 'string') throw new Error('The paid search returned no result.');
    return JSON.parse(result).results?.stays;
  })();
  searchCache.set(key, run);
  try { const found = await run; searchCache.set(key, { at: Date.now(), found }); return found; }
  catch (error) { searchCache.delete(key); throw error; }
}

export async function payForBooking(plan: any, config = paidConfig(), buy = buyFromAgent) {
  if (!config) throw new Error('Paid booking is not configured.');
  const end = new Date(Date.parse(`${plan.request.check_in}T00:00:00Z`) + plan.request.nights * 86_400_000).toISOString().slice(0, 10);
  const body = { stays: { check_in_date: plan.request.check_in, check_out_date: end, rooms: [{ adults: plan.request.adults }], location: { city: plan.request.city }, property_id: plan.hotel?.id } };
  const store = await openA2aStore(config.dir);
  const mps = createBuyerMps({ baseUrl: config.mpsUrl, token: config.token });
  const bought = await buy({ sellerUrl: ADVISOR_URL, agentIdentifier: HOTEL_BOOK_EXPERT, inputData: { request: advisorRequest(body) }, mps, store });
  const stays = typeof bought.result === 'string' ? JSON.parse(bought.result).results?.stays : null;
  const url = typeof stays?.checkout_url === 'string' && stays.checkout_url.startsWith('https://') ? stays.checkout_url : '';
  if (!url) return { opened: false, failure_reason: 'Expert Travel Advisor did not open a checkout' };
  return { opened: true, checkout: { url, trip_id: null }, txHash: bought.journal?.fundsLockedTx || '', failure_reason: null };
}

export async function searchHotels(input: z.infer<typeof searchInput>, fetcher: typeof fetch = fetch) { return (await searchRaw(input, fetcher)).result; }

// Same search, also returning the raw hotels so save_plan can keep the fields needed to open a checkout later.
export async function searchRaw(input: z.infer<typeof searchInput>, fetcher: typeof fetch = fetch): Promise<{ result: any; raw: any[] }> {
  const today = new Date().toISOString().slice(0, 10);
  if (Number.isNaN(Date.parse(input.check_in)) || input.check_in <= today) return { result: { error: `Check-in must be after today (${today}).` }, raw: [] };
  const body = { check_in_date: input.check_in, check_out_date: addDays(input.check_in, input.nights), rooms: [{ adults: input.adults }],
    location: { city: input.city, country_code: input.country_code.toUpperCase() }, currency: 'USD', guest_nationality: 'US', limit: 20 };
  let found: any;
  if (paidConfig()) {
    try { found = await paidStaysSearch({ stays: body }); }
    catch (error) { return { result: { error: `The paid Expert Travel Advisor search failed: ${String((error as Error).message).slice(0, 120)}.` }, raw: [] }; }
  } else {
    const response = await fetcher(`${ORIGIN_API_URL}/v1/stays/search`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) return { result: { error: `The Expert Travel Agency API answered HTTP ${response.status}. Try again later.` }, raw: [] };
    found = await response.json();
  }
  const priced = (found.data?.hotels ?? []).filter((h: any) => Number(h.cheapest_total?.amount) > 0);
  const hotels = priced.slice(0, 8).map((h: any) => ({
    hotel_id: String(h.id), ...(h.lodging ? { lodging: h.lodging } : {}), name: h.name, total_price: `${Number(h.cheapest_total.amount).toFixed(2)} ${h.cheapest_total.currency}`, nights: input.nights,
    free_cancellation: !!h.rooms?.[0]?.refundable, ...(h.rating ? { guest_rating_out_of_10: h.rating } : {}), ...(h.stars ? { stars: h.stars } : {}),
    ...(typeof h.url === 'string' && h.url.startsWith('https://') ? { checkout_url: h.url } : {}),
  }));
  return { raw: priced, result: hotels.length ? { source: paidConfig() ? 'Expert Travel Advisor (paid via Masumi)' : 'Expert Travel Agency API', observed_at: found.observed_at, hotels } : { error: 'No hotel is available for those dates. Ask for other dates.' } };
}
