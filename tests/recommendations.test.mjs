import test from 'node:test';
import assert from 'node:assert/strict';
import catalog from '../data/events.json' with { type: 'json' };
import { recommendEvents, eventsConflict, formatRecommendations } from '../src/recommendations.mjs';

test('recommendations retain sources, fit supplied days, and do not overlap', () => {
  const result = recommendEvents({ interests: ['ai agents', 'stablecoins', 'payments'], dates: ['2026-10-07', '2026-10-08'] });
  assert.ok(result.itinerary.length >= 2);
  assert.ok(result.itinerary.some(event => event.kind === 'conference'));
  assert.ok(result.itinerary.some(event => event.kind === 'side-event'));
  for (const event of result.itinerary) {
    assert.ok(event.url.startsWith('https://'));
    assert.ok(event.end);
    assert.ok(['2026-10-07', '2026-10-08'].includes(event.start.slice(0, 10)));
  }
  for (const a of result.itinerary) for (const b of result.itinerary) {
    if (a.id !== b.id) assert.equal(eventsConflict(a, b, 30), false);
  }
  assert.match(formatRecommendations(result), /Singapore/);
});

test('unknown end times never become a timed itinerary', () => {
  const result = recommendEvents({ interests: ['ai'], dates: ['2026-10-06'] });
  const unknown = catalog.events.find(event => event.end === null);
  assert.ok(unknown);
  assert.ok(!result.itinerary.some(event => event.id === unknown.id));
  assert.ok(result.alternatives.some(event => event.id === unknown.id));
});

test('D1: equal topic relevance prefers shorter sessions over a full-day event', () => {
  const snapshot = { ...catalog, events: catalog.events.filter(event => ['circle-house-07', 'stablecoin-payments'].includes(event.id)) };
  assert.equal(snapshot.events.length, 2);
  const result = recommendEvents({ interests: ['agents', 'stablecoins', 'payments'], limit: 1 }, snapshot);
  assert.equal(result.itinerary[0].kind, 'conference');
});

test('hard zero budget excludes unknown prices, preserves verified free events and admission notes', () => {
  const result = recommendEvents({ interests: ['stablecoins'], maxCostSgd: 0 });
  assert.ok(result.itinerary.length > 0);
  assert.ok(result.itinerary.every(event => event.admission.priceSgd === 0));
  assert.ok(result.excluded.some(event => event.reason.includes('not verified')));
  assert.ok(result.itinerary.every(event => event.admission.notes.includes('QR')));
});

test('time window and topic constraints return empty results rather than fabricated events', () => {
  assert.equal(recommendEvents({ interests: ['payments'], dates: ['2026-10-08'], availableUntil: '08:00' }).itinerary.length, 0);
  assert.equal(recommendEvents({ interests: ['underwater basket weaving'] }).itinerary.length, 0);
});

test('reject invalid inputs at both CLI and tool boundary', () => {
  for (const input of [{ interests: [] }, { interests: ['ai'], availableFrom: '25:00' },
    { interests: ['ai'], dates: ['2026-10-99'] }, { interests: ['ai'], limit: 0 },
    { interests: ['ai'], availableFrom: '17:00', availableUntil: '09:00' }]) {
    assert.throws(() => recommendEvents(input));
  }
});

test('curated records have unique identifiers and valid dated Singapore source evidence', () => {
  assert.equal(new Set(catalog.events.map(event => event.id)).size, catalog.events.length);
  for (const event of catalog.events) {
    assert.ok(Number.isFinite(Date.parse(event.start)));
    assert.ok(event.start.endsWith('+08:00'));
    assert.match(event.sourceEvidence, /2026-10-05/);
    if (event.end) assert.ok(Date.parse(event.end) > Date.parse(event.start));
  }
});

test('D2: an unknown-end event outside the time window is excluded', () => {
  const result = recommendEvents({ interests: ['ai'], dates: ['2026-10-06'], availableUntil: '18:00' });
  assert.ok(!result.alternatives.some(event => event.end === null));
});

test('D3: a known pass requirement excludes attendees without that pass', () => {
  const event = { ...catalog.events[0], admission: { ...catalog.events[0].admission, conferencePassRequired: true } };
  const snapshot = { ...catalog, events: [event] };
  const request = { interests: event.topics, hasConferencePass: false };
  assert.equal(recommendEvents(request, snapshot).itinerary.length, 0);
  assert.equal(recommendEvents({ ...request, hasConferencePass: true }, snapshot).itinerary.length, 1);
});

test('D4: conference pass does not invent a zero price under a hard budget', () => {
  const event = { ...catalog.events[0], admission: { ...catalog.events[0].admission, priceSgd: 100 } };
  const request = { interests: event.topics, hasConferencePass: true, maxCostSgd: 0 };
  assert.equal(recommendEvents(request, { ...catalog, events: [event] }).itinerary.length, 0);
  const unknown = { ...event, admission: { ...event.admission, priceSgd: null } };
  assert.equal(recommendEvents(request, { ...catalog, events: [unknown] }).itinerary.length, 0);
});
