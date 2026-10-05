import { z } from 'zod';
import catalog from '../data/events.json' with { type: 'json' };

const MINUTE_MS = 60_000;
const DEFAULT_TRANSFER_MINUTES = 30;
const MAX_RECOMMENDATIONS = 10;
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const date = z.string().regex(/^2026-10-(?:0[5-9]|1[01])$/);
const aliases = new Map([
  ['artificial intelligence', 'ai'], ['agentic ai', 'agents'], ['agentic payments', 'agents'],
  ['ai agents', 'agents'], ['agentic finance', 'agents'], ['agent', 'agents'],
  ['stablecoin', 'stablecoins'], ['usdc', 'stablecoins'], ['usdm', 'stablecoins'],
  ['payment', 'payments'], ['decentralized finance', 'defi'],
]);

export const recommendationInput = z.object({
  interests: z.array(z.string().trim().min(1).max(80)).min(1).max(10),
  dates: z.array(date).min(1).max(7).optional(),
  availableFrom: clock.default('00:00'),
  availableUntil: clock.default('23:59'),
  maxCostSgd: z.number().finite().min(0).optional(),
  hasConferencePass: z.boolean().default(false),
  includeConference: z.boolean().default(true),
  includeSideEvents: z.boolean().default(true),
  limit: z.number().int().min(1).max(MAX_RECOMMENDATIONS).default(5),
  transferMinutes: z.number().int().min(0).max(180).default(DEFAULT_TRANSFER_MINUTES),
}).strict().refine(input => input.availableFrom < input.availableUntil, {
  message: 'The available time window must end after it starts. Use Singapore local time.',
});

function normalize(value) {
  const lower = value.toLowerCase().trim();
  return aliases.get(lower) ?? lower;
}

export function eventsConflict(a, b, bufferMinutes) {
  if (!a.end || !b.end) return true;
  const buffer = bufferMinutes * MINUTE_MS;
  return Date.parse(a.start) < Date.parse(b.end) + buffer && Date.parse(b.start) < Date.parse(a.end) + buffer;
}

export function recommendEvents(rawInput, snapshot = catalog) {
  const input = recommendationInput.parse(rawInput);
  const interests = [...new Set(input.interests.map(normalize))];
  const candidates = [];
  const excluded = [];
  for (const event of snapshot.events) {
    const day = event.start.slice(0, 10);
    if (input.dates && !input.dates.includes(day)) continue;
    if (event.kind === 'conference' && !input.includeConference) continue;
    if (event.kind === 'side-event' && !input.includeSideEvents) continue;
    const matchedInterests = interests.filter(interest => event.topics.map(normalize).includes(interest));
    if (!matchedInterests.length) continue;
    if (event.admission.conferencePassRequired === true && !input.hasConferencePass) {
      excluded.push({ id: event.id, reason: 'A conference pass is required.' });
      continue;
    }
    const priced = event.admission.priceSgd;
    if (input.maxCostSgd !== undefined && (priced === null || priced > input.maxCostSgd)) {
      excluded.push({ id: event.id, reason: priced === null ? 'Price not verified for this budget.' : 'Price exceeds budget.' });
      continue;
    }
    if (event.start.slice(11, 16) < input.availableFrom || event.start.slice(11, 16) >= input.availableUntil || (event.end && event.end.slice(11, 16) > input.availableUntil)) {
      excluded.push({ id: event.id, reason: 'Outside the available Singapore time window.' });
      continue;
    }
    candidates.push({ ...event, matchedInterests, score: matchedInterests.length,
      reason: `Matches ${matchedInterests.join(', ')}. Topic basis: ${event.topicProvenance}.` });
  }
  // Greedy relevance ranking is sufficient for this small snapshot; it does not optimize a whole city itinerary.
  const duration = event => event.end ? Date.parse(event.end) - Date.parse(event.start) : Infinity;
  candidates.sort((a, b) => b.score - a.score || duration(a) - duration(b) || a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  const itinerary = [];
  const alternatives = [];
  for (const event of candidates) {
    if (!event.end) {
      alternatives.push({ ...event, reason: `${event.reason} End time unknown; confirm before scheduling.` });
      continue;
    }
    const conflicts = itinerary.filter(pick => eventsConflict(event, pick, input.transferMinutes));
    if (conflicts.length) {
      alternatives.push({ ...event, conflictsWith: conflicts.map(pick => pick.id) });
    } else if (itinerary.length < input.limit) {
      itinerary.push(event);
    } else {
      alternatives.push(event);
    }
  }
  itinerary.sort((a, b) => a.start.localeCompare(b.start));
  return {
    timezone: 'Asia/Singapore',
    retrievedAt: snapshot.retrievedAt,
    coverage: snapshot.coverage,
    itinerary,
    alternatives: alternatives.slice(0, MAX_RECOMMENDATIONS),
    excluded,
    limits: [
      'A curated snapshot cannot prove current availability or admission approval. Verify each linked organizer page.',
      `Schedule uses a ${input.transferMinutes}-minute planning buffer between events. This is not a measured travel time.`,
      'Unknown end times remain outside the itinerary. Whole-event times do not prove the time of a specific talk.',
    ],
  };
}

export function formatRecommendations(result) {
  const time = value => value.slice(11, 16);
  const lines = [`TOKEN2049 event guide`, `All times: Singapore (UTC+08:00). Source snapshot: ${result.retrievedAt}.`, result.coverage, ''];
  if (!result.itinerary.length) lines.push('No verified events meet all supplied constraints.');
  for (const [index, event] of result.itinerary.entries()) {
    lines.push(`${index + 1}. ${event.title}`, `${event.start.slice(0, 10)} ${time(event.start)} to ${time(event.end)}`, event.location,
      event.reason, `Admission: ${event.admission.notes}`, `Source: ${event.url}`, '');
  }
  if (result.alternatives.length) {
    lines.push('Alternatives. Check conflicts and admission before replacing a pick.');
    for (const event of result.alternatives) lines.push(`${event.title}: ${event.url}${event.conflictsWith ? ` (conflicts with ${event.conflictsWith.join(', ')})` : ''}`);
  }
  lines.push('', ...result.limits);
  return lines.join('\n');
}
