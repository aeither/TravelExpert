import { z } from 'zod';
import { buyService, defaultLedger, paidConfig, paidEnabled, type BuyDeps } from './paid.ts';
import { rankStays } from './rank.ts';

const ORIGIN_API_URL = (process.env.ORIGIN_API_URL || 'https://origin-api-production-d268.up.railway.app').replace(/\/$/, '');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const taskRefSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);

export const searchInput = z.object({
  city: z.string().min(2).describe('City or area, for example Cebu'),
  country_code: z.string().length(2).describe('ISO 3166-1 alpha-2 country code, for example PH'),
  check_in: day.describe('Check-in date YYYY-MM-DD, after today'),
  nights: z.number().int().min(1).max(13),
  adults: z.number().int().min(1).max(4).default(1),
  children_ages: z.array(z.number().int().min(0).max(17)).max(6).default([]).describe('Ages of the children travelling, empty when none'),
  budget_per_night: z.number().positive().max(10_000).optional().describe('The traveller\'s budget cap per night in USD, when they gave one'),
  task_ref: taskRefSchema.optional().describe('The task reference from the request, when the request has one'),
});
export type SearchInput = z.infer<typeof searchInput>;

export type Deps = { fetcher?: typeof fetch; ledger?: any; env?: Record<string, string | undefined>; buy?: BuyDeps; now?: () => number };
type Hotel = { id: string; lodging: string; source: string; offer_id?: string; bookable: boolean; name: string; stars: number | null; rating: number | null; total: number; nightly: number; currency: string;
  board: string | null; free_cancellation: boolean; address: string | null; checkout_url?: string; review_highlights?: { pros: string[]; cons: string[] } | null; children_allowed?: boolean | null };

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const money = (amount: number, currency: string) => `${amount.toFixed(2)} ${currency}`;

// One hotel from the origin API: LiteAPI hotels have bookable offers, Advisor hotels are pay-at-property listings.
function normalize(h: any, source: string, nights: number): Hotel | null {
  const cheapest = num(h.cheapest_total?.amount), currency = String(h.cheapest_total?.currency ?? 'USD');
  const views = (Array.isArray(h.rooms) ? h.rooms : []).map((r: any) => ({ r, total: num(r.total?.amount) ?? cheapest })).filter((v: any) => v.total && v.total > 0);
  views.sort((a: any, b: any) => Number(!!b.r.refundable) - Number(!!a.r.refundable) || a.total - b.total);
  const best = views[0];
  const total = best?.total ?? cheapest;
  if (!total || total <= 0) return null;
  const offer = best?.r?.offer_id ? String(best.r.offer_id) : undefined;
  return { id: String(h.id), lodging: h.lodging ?? '', source, ...(offer ? { offer_id: offer } : {}), bookable: source === 'liteapi' && !!offer, name: String(h.name ?? `Hotel ${h.id}`).trim(),
    stars: num(h.stars), rating: num(h.rating) || null, total, nightly: num(h.nightly?.amount) ?? total / nights, currency, board: best?.r?.board ?? null,
    free_cancellation: !!(best ? best.r.refundable : h.rooms?.[0]?.refundable), address: h.address ?? null,
    ...(typeof h.url === 'string' && h.url.startsWith('https://') ? { checkout_url: h.url } : {}) };
}

// Free hotel details (review highlights, children policy) for the best few LiteAPI hotels.
const detailCache = new Map<string, { at: number; value: any }>();
async function details(id: string, fetcher: typeof fetch, key?: string) {
  const hit = detailCache.get(id);
  if (hit && Date.now() - hit.at < 600_000) return hit.value;
  try {
    const response = await fetcher(`${ORIGIN_API_URL}/v1/stays/hotels/${encodeURIComponent(id)}`, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: key ? { authorization: `Bearer ${key}` } : {} });
    if (!response.ok) return null;
    const body: any = await response.json(), d = body.data ?? body;
    const value = { review_highlights: d.review_highlights ?? null, children_allowed: typeof d.children_allowed === 'boolean' ? d.children_allowed : null, address: d.address ?? null };
    detailCache.set(id, { at: Date.now(), value }); return value;
  } catch { return null; }
}

export function clearHotelCaches() { detailCache.clear(); }

export async function searchHotels(input: SearchInput, deps: Deps = {}) {
  return (await searchRaw(input, deps)).result;
}

// Same search, also returning the ranked hotels so save_plan can keep the fields needed to book later.
export async function searchRaw(input: SearchInput, deps: Deps = {}): Promise<{ result: any; raw: Hotel[] }> {
  const env = deps.env ?? process.env, fetcher = deps.fetcher ?? fetch;
  const today = new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10);
  if (Number.isNaN(Date.parse(input.check_in)) || input.check_in <= today) return { result: { error: `Check-in must be after today (${today}).` }, raw: [] };
  const children = input.children_ages ?? [];
  const body = { check_in_date: input.check_in, check_out_date: addDays(input.check_in, input.nights), rooms: [{ adults: input.adults, ...(children.length ? { children_ages: children } : {}) }],
    location: { city: input.city, country_code: input.country_code.toUpperCase() }, currency: 'USD', guest_nationality: 'US', limit: 20, provider: 'auto' };
  const paid = !!input.task_ref && paidEnabled('hotel-search', env);
  let found: any;
  if (paid) {
    try {
      const bought = await buyService({ taskRef: input.task_ref!, service: 'hotel-search', inputData: { trip_request_json: JSON.stringify({ stays: body }) } }, { config: paidConfig(env), ...deps.buy });
      if (typeof bought.result !== 'string') throw new Error('The paid search returned no result.');
      found = JSON.parse(bought.result).results?.stays;
      if (!found || found.status === 'error') throw new Error(found?.error?.message ?? 'The paid search returned no stays.');
    } catch (error) { return { result: { error: `The paid Expert Travel Agency search failed: ${String((error as Error).message).slice(0, 120)}.` }, raw: [] }; }
  } else {
    const response = await fetcher(`${ORIGIN_API_URL}/v1/stays/search`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) return { result: { error: `The Expert Travel Agency API answered HTTP ${response.status}. Try again later.` }, raw: [] };
    found = await response.json();
  }
  const source = String(found.provider ?? 'advisor');
  const all = (found.data?.hotels ?? []).map((h: any) => normalize(h, source, input.nights)).filter(Boolean) as Hotel[];
  const first = rankStays(all, { budget_per_night: input.budget_per_night, children: children.length });
  let ranking = first;
  const key = env.ORIGIN_API_KEY;
  if (source === 'liteapi' && key) {
    for (const h of ranking.ranked.slice(0, 3)) {
      const d = await details(h.id, fetcher, key);
      if (d) { h.review_highlights = d.review_highlights; h.children_allowed = d.children_allowed; h.address = h.address ?? d.address; }
    }
  }
  const second = rankStays(first.ranked, { children: children.length });
  ranking = { ranked: second.ranked, dropped_over_budget: first.dropped_over_budget, dropped_children: first.dropped_children + second.dropped_children };
  const hotels = ranking.ranked;
  // Every search that belongs to a task leaves its results in the task ledger, whichever tool ran it: the audit checks the plan against them.
  if (input.task_ref && hotels.length) {
    try {
      const ledger = deps.ledger ?? await defaultLedger(paidConfig(env)?.ledgerDir ?? `${env.DATA_DIR || '.local'}/ledger`);
      for (const h of hotels.slice(0, 8)) await ledger.addEvidence(input.task_ref, 'hotels', { name: h.name, total: h.total, nightly: Number(h.nightly.toFixed(2)), currency: h.currency, free_cancellation: h.free_cancellation, source: h.source });
    } catch { /* evidence is best effort */ }
  }
  if (!hotels.length) {
    const cheapest = [...all].sort((a, b) => a.nightly - b.nightly)[0];
    const budgetMiss = input.budget_per_night !== undefined && cheapest && ranking.dropped_children === 0 && all.length > 0;
    return { raw: [], result: { error: budgetMiss
      ? `No hotel fits ${input.budget_per_night} USD per night with these travellers. The cheapest is ${cheapest.name} at ${cheapest.nightly.toFixed(2)} ${cheapest.currency} per night. Tell the traveller and offer it as an option.`
      : all.length ? 'The hotels found do not accept children. Ask for other dates or another area.' : 'No hotel is available for those dates. Ask for other dates.' } };
  }
  const occupancy = `${input.adults} adult${input.adults === 1 ? '' : 's'}${children.length ? ` and ${children.length} child${children.length === 1 ? '' : 'ren'} (ages ${children.join(', ')})` : ''}`;
  return { raw: hotels, result: { source: paid ? `Expert Travel Agency (paid via Masumi, ${source})` : `Expert Travel Agency API (${source})`, observed_at: found.observed_at,
    party: occupancy, occupancy_note: children.length && source !== 'liteapi' ? 'This supplier prices adults only: say that children are not included in the price.' : `Priced for ${occupancy}.`,
    ...(input.budget_per_night ? { budget_per_night: input.budget_per_night, dropped_over_budget: ranking.dropped_over_budget } : {}),
    hotels: hotels.slice(0, 8).map(h => ({ hotel_id: h.id, ...(h.offer_id ? { offer_id: h.offer_id } : {}), source: h.source, bookable: h.bookable, name: h.name, ...(h.stars ? { stars: h.stars } : {}), ...(h.rating ? { rating: h.rating } : {}),
      total_price: money(h.total, h.currency), nightly_price: money(h.nightly, h.currency), nights: input.nights, ...(h.board ? { board: h.board } : {}), free_cancellation: h.free_cancellation,
      ...(h.address ? { address: h.address } : {}), ...(h.review_highlights ? { review_highlights: h.review_highlights } : {}), ...(typeof h.children_allowed === 'boolean' ? { children_allowed: h.children_allowed } : {}),
      ...(h.checkout_url ? { checkout_url: h.checkout_url } : {}) })) } };
}
