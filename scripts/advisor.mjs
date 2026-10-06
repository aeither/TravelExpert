// The Expert Travel Advisor's /hotels/book opens a pay-at-property checkout. It never confirms a reservation.
export function createAdvisor(baseUrl, send = fetch) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error('ADVISOR_URL must be an https URL without credentials.');
  async function checkout(input) {
    try {
      const response = await send(new URL('/hotels/book', base), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90_000), headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destination: input.destination, check_in: input.check_in, check_out: input.check_out, adults: input.adults, payment_type: 'PAY_LATER', lodging: input.lodging ?? '', property_id: input.property_id }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) return { opened: false, failure_reason: `the hotel agent returned HTTP ${response.status}` };
      const c = payload.checkout ?? {};
      const url = typeof c.checkout_url === 'string' && c.checkout_url.startsWith('https://') ? c.checkout_url : null;
      return { opened: !!(url || c.trip_id), trip_id: c.trip_id ?? null, url, failure_reason: c.failure_reason ?? null };
    } catch { return { opened: false, failure_reason: 'the hotel agent did not answer' }; }
  }
  // Top pick first, then the next candidates: the agent cannot open an offer for every stay it lists. The first that opens wins.
  async function openCheckout(plan) {
    const end = new Date(Date.parse(`${plan.request.check_in}T00:00:00Z`) + plan.request.nights * 86_400_000).toISOString().slice(0, 10);
    let failure = 'no checkout was available';
    for (const candidate of [plan.hotel, ...plan.alternatives]) {
      const result = await checkout({ destination: plan.request.city, check_in: plan.request.check_in, check_out: end, adults: plan.request.adults, property_id: candidate.id, lodging: candidate.lodging });
      if (!result.opened) { failure = result.failure_reason ?? failure; continue; }
      const swapped = candidate.id !== plan.hotel.id ? plan.hotel.name : undefined;
      return { opened: true, hotel: candidate, checkout: { trip_id: result.trip_id, url: result.url }, swappedFrom: swapped };
    }
    return { opened: false, failure_reason: failure };
  }
  return { checkout, openCheckout };
}
