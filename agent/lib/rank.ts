// Choosing hotels is code, not a model decision: the budget cap and the family rules are enforced here.
export type Rankable = { nightly: number; rating: number | null; free_cancellation: boolean; children_allowed?: boolean | null };
export type RankOptions = { budget_per_night?: number; children?: number };

// A guest rating of 8 or more is "good", 7 or more "fair". Within a tier the cheapest wins; free cancellation always comes first.
const tier = (rating: number | null) => rating === null ? 0 : rating >= 8 ? 2 : rating >= 7 ? 1 : 0;

export function rankStays<T extends Rankable>(hotels: T[], options: RankOptions = {}) {
  const budget = options.budget_per_night;
  const overBudget = (h: T) => budget !== undefined && h.nightly > budget;
  const noKids = (h: T) => (options.children ?? 0) > 0 && h.children_allowed === false;
  const kept = hotels.filter(h => !overBudget(h) && !noKids(h));
  kept.sort((a, b) => Number(b.free_cancellation) - Number(a.free_cancellation) || tier(b.rating) - tier(a.rating) || a.nightly - b.nightly);
  return { ranked: kept, dropped_over_budget: hotels.filter(overBudget).length, dropped_children: hotels.filter(h => !overBudget(h) && noKids(h)).length };
}
