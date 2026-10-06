import { z } from 'zod';

const ORIGIN_API_URL = (process.env.ORIGIN_API_URL || 'https://origin-api-production-d268.up.railway.app').replace(/\/$/, '');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export const searchInput = z.object({
  city: z.string().min(2).describe('City or area, for example Cebu'),
  country_code: z.string().length(2).describe('ISO 3166-1 alpha-2 country code, for example PH'),
  check_in: day.describe('Check-in date YYYY-MM-DD, after today'),
  nights: z.number().int().min(1).max(13),
  adults: z.number().int().min(1).max(4).default(1),
});

export async function searchHotels(input: z.infer<typeof searchInput>, fetcher: typeof fetch = fetch) { return (await searchRaw(input, fetcher)).result; }

// Same search, also returning the raw hotels so save_plan can keep the fields needed to open a checkout later.
export async function searchRaw(input: z.infer<typeof searchInput>, fetcher: typeof fetch = fetch): Promise<{ result: any; raw: any[] }> {
  const today = new Date().toISOString().slice(0, 10);
  if (Number.isNaN(Date.parse(input.check_in)) || input.check_in <= today) return { result: { error: `Check-in must be after today (${today}).` }, raw: [] };
  const response = await fetcher(`${ORIGIN_API_URL}/v1/stays/search`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ check_in_date: input.check_in, check_out_date: addDays(input.check_in, input.nights), rooms: [{ adults: input.adults }],
      location: { city: input.city, country_code: input.country_code.toUpperCase() }, currency: 'USD', guest_nationality: 'US', limit: 20 }),
  });
  if (!response.ok) return { result: { error: `The Expert Travel Agency API answered HTTP ${response.status}. Try again later.` }, raw: [] };
  const found: any = await response.json();
  const priced = (found.data?.hotels ?? []).filter((h: any) => Number(h.cheapest_total?.amount) > 0);
  const hotels = priced.slice(0, 8).map((h: any) => ({
    hotel_id: String(h.id), ...(h.lodging ? { lodging: h.lodging } : {}), name: h.name, total_price: `${Number(h.cheapest_total.amount).toFixed(2)} ${h.cheapest_total.currency}`, nights: input.nights,
    free_cancellation: !!h.rooms?.[0]?.refundable, ...(h.rating ? { guest_rating_out_of_10: h.rating } : {}), ...(h.stars ? { stars: h.stars } : {}),
    ...(typeof h.url === 'string' && h.url.startsWith('https://') ? { checkout_url: h.url } : {}),
  }));
  return { raw: priced, result: hotels.length ? { source: 'Expert Travel Agency API', observed_at: found.observed_at, hotels } : { error: 'No hotel is available for those dates. Ask for other dates.' } };
}
