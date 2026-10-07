import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewer, constraintsOf } from '../scripts/audit.mjs';

const plan = { request: { city: 'Cebu', nights: 3, adults: 2, children_ages: [6, 9], budget_per_night: 150 }, hotel: { name: 'Fili', total: { amount: '300.00', currency: 'USD' } } };
const answer = '# Cebu\nFili: 300 USD total\n\nWould you like me to open the checkout for the top pick? Reply "book" to continue, or "no" to finish.';
const evidence = { hotels: [{ name: 'Fili', total: 300, currency: 'USD' }], knowledge: ['Magellan\'s Cross is a landmark.'] };
const pass = { verdict: 'pass', summary: '8 claims checked, all supported', claims: [{ claim: 'a', status: 'supported' }], rewrite_hints: [] };

test('constraints come from the saved plan', () => {
  assert.deepEqual(constraintsOf(plan), { nights: 3, adults: 2, children_ages: [6, 9], budget_per_night: 150, currency: 'USD' });
});

test('a passing audit keeps the plan and adds one audit line before the question', async () => {
  const said = []; let bought;
  const review = createReviewer({ buy: async arg => { bought = arg; return { result: JSON.stringify(pass) }; }, readEvidence: async () => evidence });
  const text = await review({ taskId: 'task_abcdefgh', plan, answer, say: async t => said.push(t), revise: async () => { throw new Error('no revision expected'); } });
  assert.equal(bought.service, 'audit'); assert.equal(bought.taskRef, 'task_abcdefgh');
  const sent = JSON.parse(bought.inputData.audit_request_json);
  assert.equal(sent.plan_text, answer); assert.deepEqual(sent.evidence, evidence); assert.equal(sent.constraints.budget_per_night, 150);
  assert.match(said[0], /Trip Auditor \(another agent\)/);
  assert.match(text, /Audit by the Trip Auditor: passed/); assert.ok(text.indexOf('Audit by') < text.indexOf('Would you like me to'));
});

test('a revise verdict triggers exactly one revision turn that keeps the closing question', async () => {
  const verdict = { verdict: 'revise', summary: '1 of 8 claims unsupported', claims: [{ claim: 'Socorro mini-zoo', status: 'unsupported' }], rewrite_hints: ['Remove "Socorro mini-zoo": not in the knowledge desk answer.'] };
  const prompts = [];
  const review = createReviewer({ buy: async () => ({ result: JSON.stringify(verdict) }), readEvidence: async () => evidence });
  const text = await review({ taskId: 'task_abcdefgh', plan, answer, say: async () => {}, revise: async p => { prompts.push(p); return '# Cebu fixed\n\nWould you like me to open the checkout for the top pick? Reply "book" to continue, or "no" to finish.'; } });
  assert.equal(prompts.length, 1); assert.match(prompts[0], /^Mode: revise/); assert.match(prompts[0], /Socorro mini-zoo/);
  assert.match(text, /Cebu fixed/); assert.match(text, /Audit by the Trip Auditor: revised/);
});

test('a revision that loses the question is discarded and the original plan is kept', async () => {
  const verdict = { verdict: 'revise', summary: 's', claims: [], rewrite_hints: ['fix'] };
  const review = createReviewer({ buy: async () => ({ result: JSON.stringify(verdict) }), readEvidence: async () => evidence });
  const text = await review({ taskId: 'task_abcdefgh', plan, answer, say: async () => {}, revise: async () => 'garbage with no question' });
  assert.match(text, /^# Cebu/); assert.match(text, /could not be applied/);
});

test('an unreachable auditor never blocks the plan, and the plan says it was not audited', async () => {
  const review = createReviewer({ buy: async () => { throw new Error('cap reached'); }, readEvidence: async () => evidence });
  const text = await review({ taskId: 'task_abcdefgh', plan, answer, say: async () => {}, revise: async () => '' });
  assert.match(text, /^# Cebu/); assert.match(text, /not audited/i);
  const none = createReviewer({ buy: async () => ({ result: null }), readEvidence: async () => evidence });
  assert.match(await none({ taskId: 'task_abcdefgh', plan, answer, say: async () => {}, revise: async () => '' }), /not audited/i);
});

test('with no evidence recorded there is nothing to audit against, so no purchase is made', async () => {
  let bought = false;
  const review = createReviewer({ buy: async () => { bought = true; return {}; }, readEvidence: async () => ({ hotels: [], flights: [], knowledge: [] }) });
  const text = await review({ taskId: 'task_abcdefgh', plan, answer, say: async () => {}, revise: async () => '' });
  assert.equal(bought, false); assert.match(text, /not audited/i);
});
