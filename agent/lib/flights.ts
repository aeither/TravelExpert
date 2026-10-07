import { z } from 'zod';
import { buyService, defaultLedger, paidConfig, paidEnabled, type BuyDeps } from './paid.ts';
import { taskRefSchema, type Deps } from './hotels.ts';

const ORIGIN_API_URL = (process.env.ORIGIN_API_URL || 'https://origin-api-production-d268.up.railway.app').replace(/\/$/, '');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const iata = z.string().regex(/^[A-Za-z]{3}$/).transform(v => v.toUpperCase());

export const flightInput = z.object({
  origin: iata.describe('Departure airport IATA code, for example SIN'),
  destination: iata.describe('Arrival airport IATA code, for example CEB'),
  departure_date: day.describe('Departure date YYYY-MM-DD, after today'),
  return_date: day.optional().describe('Return date YYYY-MM-DD for a round trip'),
  adults: z.number().int().min(1).max(4).default(1),
  children_ages: z.array(z.number().int().min(0).max(17)).max(5).default([]),
  task_ref: taskRefSchema.describe('The task reference from the request'),
});
export type FlightInput = z.infer<typeof flightInput>;

const minutes = (iso: unknown) => { const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?$/.exec(String(iso ?? '')); return m ? Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : null; };

function summarize(offer: any) {
  const slices = (offer.slices ?? []).map((s: any) => { const seg = s.segments ?? []; return { route: `${s.origin?.iata_code ?? '?'}→${s.destination?.iata_code ?? '?'}`, departs_at: seg[0]?.departing_at ?? null, arrives_at: seg.at(-1)?.arriving_at ?? null, stops: Math.max(seg.length - 1, 0), duration_minutes: minutes(s.duration) }; });
  return { offer_id: offer.id, airline: offer.owner?.name ?? null, total_price: `${Number(offer.total_amount).toFixed(2)} ${offer.total_currency}`, total: Number(offer.total_amount), currency: String(offer.total_currency), slices };
}

export async function searchFlights(input: FlightInput, deps: Deps = {}) {
  const env = deps.env ?? process.env, fetcher = deps.fetcher ?? fetch;
  const today = new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10);
  if (Number.isNaN(Date.parse(input.departure_date)) || input.departure_date <= today) return { error: `Departure must be after today (${today}).` };
  if (input.return_date && input.return_date <= input.departure_date) return { error: 'The return date must be after the departure date.' };
  const body = { slices: [{ origin: input.origin, destination: input.destination, departure_date: input.departure_date }, ...(input.return_date ? [{ origin: input.destination, destination: input.origin, departure_date: input.return_date }] : [])],
    passengers: [...Array.from({ length: input.adults }, () => ({ type: 'adult' })), ...(input.children_ages ?? []).map(age => ({ age }))], cabin_class: 'economy' };
  let found: any;
  try {
    if (paidEnabled('flight-search', env)) {
      const bought = await buyService({ taskRef: input.task_ref, service: 'flight-search', inputData: { trip_request_json: JSON.stringify({ flights: body }) } }, { config: paidConfig(env), ...(deps.buy as BuyDeps) });
      if (typeof bought.result !== 'string') throw new Error('The paid search returned no result.');
      found = JSON.parse(bought.result).results?.flights;
      if (!found || found.status === 'error') throw new Error(found?.error?.message ?? 'The paid search returned no flights.');
    } else {
      const response = await fetcher(`${ORIGIN_API_URL}/v1/flights/search`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) return { error: `The flight search answered HTTP ${response.status}. Try again later.` };
      found = await response.json();
    }
  } catch (error) { return { error: `The flight search failed: ${String((error as Error).message).slice(0, 120)}.` }; }
  const offers = (found.data?.offers ?? []).filter((o: any) => Number(o.total_amount) > 0).map(summarize).sort((a: any, b: any) => a.total - b.total).slice(0, 5);
  if (!offers.length) return { error: 'No flight is available for those dates. Ask for other dates.' };
  const ledger = deps.ledger ?? await defaultLedger(paidConfig(env)?.ledgerDir ?? `${env.DATA_DIR || '.local'}/ledger`);
  try { for (const o of offers.slice(0, 3)) await ledger.addEvidence(input.task_ref, 'flights', { summary: `${o.airline ?? 'Airline'} ${o.slices.map((s: any) => `${s.route}, ${s.stops} stop${s.stops === 1 ? '' : 's'}`).join(' / ')}`, total: o.total, currency: o.currency }); } catch { /* best effort */ }
  return { source: paidEnabled('flight-search', env) ? 'Expert Travel Agency (paid via Masumi, duffel test data)' : 'Expert Travel Agency API (duffel test data)', observed_at: found.observed_at,
    note: 'Test-environment fares: indicative only, flights cannot be booked from this agent.', offers: offers.map(({ total, currency, ...o }: any) => o) };
}
