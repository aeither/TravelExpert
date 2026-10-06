import { defineTool } from 'eve/tools';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { searchInput, searchRaw } from '../lib/hotels.ts';

const PLAN_DIR = resolve(process.env.DATA_DIR || resolve(process.cwd(), '.local'), 'plans');
const toHotel = (h: any) => ({ id: String(h.id), name: String(h.name), lodging: h.lodging ?? '', total: h.cheapest_total, free_cancellation: !!h.rooms?.[0]?.refundable, ...(h.rating ? { rating: h.rating } : {}) });

export const saveInput = searchInput.extend({ task_ref: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).describe('The task reference from the request'), hotel_id: z.string().min(1).describe('hotel_id of the top pick from search_hotels') });

// Keeps the plan for the worker. If the traveller later says "book", the worker opens the checkout for this hotel, then the next ones.
export async function savePlan(input: z.infer<typeof saveInput>, dir = PLAN_DIR, fetcher: typeof fetch = fetch) {
  const { task_ref, hotel_id, ...search } = input;
  const { result, raw } = await searchRaw(search, fetcher);
  if (result.error) return result;
  const pick = raw.find(h => String(h.id) === hotel_id);
  if (!pick) return { error: 'That hotel_id was not in the search results. Search again and use an id from the results.' };
  const plan = { taskRef: task_ref, savedAt: new Date().toISOString(), request: { city: search.city, country_code: search.country_code.toUpperCase(), check_in: search.check_in, nights: search.nights, adults: search.adults },
    hotel: toHotel(pick), alternatives: raw.filter(h => h !== pick).slice(0, 3).map(toHotel) };
  await mkdir(dir, { recursive: true });
  const target = resolve(dir, `${task_ref}.json`);
  await writeFile(`${target}.tmp`, JSON.stringify(plan, null, 2)); await rename(`${target}.tmp`, target);
  return { saved: true, hotel: plan.hotel.name, total: `${Number(plan.hotel.total.amount).toFixed(2)} ${plan.hotel.total.currency}` };
}

export default defineTool({
  description: 'Save the plan with your chosen top-pick hotel so it can be booked if the traveller says "book". Call once, after search_hotels and before writing the plan.',
  inputSchema: saveInput,
  execute: input => savePlan(input),
});
