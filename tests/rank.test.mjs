import test from 'node:test';
import assert from 'node:assert/strict';
import { rankStays } from '../agent/lib/rank.ts';

const h = (name, nightly, extra = {}) => ({ name, nightly, rating: null, free_cancellation: true, ...extra });

test('hotels over the nightly budget are dropped and counted', () => {
  const { ranked, dropped_over_budget } = rankStays([h('a', 160), h('b', 90), h('c', 150)], { budget_per_night: 150 });
  assert.deepEqual(ranked.map(x => x.name), ['c', 'b'].sort((x, y) => (x === 'b' ? 90 : 150) - (y === 'b' ? 90 : 150)));
  assert.equal(dropped_over_budget, 1);
});

test('free cancellation first, then good rating, then the cheapest', () => {
  const order = rankStays([h('cheap-nonref', 20, { free_cancellation: false, rating: 9 }), h('mid', 80, { rating: 8.5 }), h('low-rated', 30, { rating: 5 }), h('best', 60, { rating: 9.1 })]).ranked.map(x => x.name);
  assert.deepEqual(order, ['best', 'mid', 'low-rated', 'cheap-nonref']);
});

test('a hotel that forbids children is dropped only when children travel', () => {
  const list = [h('no-kids', 50, { children_allowed: false }), h('ok', 70, { children_allowed: true }), h('unknown', 60, { children_allowed: null })];
  assert.deepEqual(rankStays(list, { children: 2 }).ranked.map(x => x.name), ['unknown', 'ok']);
  assert.equal(rankStays(list, { children: 2 }).dropped_children, 1);
  assert.equal(rankStays(list, { children: 0 }).ranked.length, 3);
});
