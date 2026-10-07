import { defineTool } from 'eve/tools';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { searchInput, searchRaw, taskRefSchema, type Deps } from '../lib/hotels.ts';

const PLAN_DIR = resolve(process.env.DATA_DIR || resolve(process.cwd(), '.local'), 'plans');
const toHotel = (h: any) => ({ id: String(h.id), name: String(h.name), lodging: h.lodging ?? '', total: { amount: h.total.toFixed(2), currency: h.currency }, free_cancellation: !!h.free_cancellation, source: h.source, bookable: !!h.bookable,
  ...(h.offer_id ? { offer_id: h.offer_id } : {}), ...(h.rating ? { rating: h.rating } : {}), ...(h.stars ? { stars: h.stars } : {}), ...(h.address ? { address: h.address } : {}), ...(h.checkout_url ? { checkout_url: h.checkout_url } : {}) });

export const saveInput = searchInput.extend({ task_ref: taskRefSchema.describe('The task reference from the request'), hotel_id: z.string().min(1).describe('hotel_id of the top pick from search_hotels') });

// Keeps the plan for the worker. If the traveller later says "book", the worker books (or opens the checkout for) this hotel, then the next ones.
export async function savePlan(input: z.infer<typeof saveInput>, dir = PLAN_DIR, deps: Deps = {}) {
  const { task_ref, hotel_id, ...search } = input;
  const { result, raw } = await searchRaw({ ...search, task_ref }, deps);
  if (result.error) return result;
  const pick = raw.find(h => String(h.id) === hotel_id);
  if (!pick) return { error: 'That hotel_id was not in the search results. Search again and use an id from the results.' };
  const plan = { taskRef: task_ref, savedAt: new Date().toISOString(), request: { city: search.city, country_code: search.country_code.toUpperCase(), check_in: search.check_in, nights: search.nights, adults: search.adults,
      children_ages: search.children_ages ?? [], ...(search.budget_per_night ? { budget_per_night: search.budget_per_night } : {}) },
    hotel: toHotel(pick), alternatives: raw.filter(h => h !== pick).slice(0, 3).map(toHotel) };
  await mkdir(dir, { recursive: true });
  const target = resolve(dir, `${task_ref}.json`);
  await writeFile(`${target}.tmp`, JSON.stringify(plan, null, 2)); await rename(`${target}.tmp`, target);
  return { saved: true, hotel: plan.hotel.name, total: `${plan.hotel.total.amount} ${plan.hotel.total.currency}`, source: plan.hotel.source, bookable: plan.hotel.bookable };
}

export default defineTool({
  description: 'Save the plan with your chosen top-pick hotel so it can be booked if the traveller says "book". Call once, after search_hotels and before writing the plan, with the same search inputs.',
  inputSchema: saveInput,
  execute: input => savePlan(input),
});
