import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const text = await readFile(new URL('../agent/instructions.md', import.meta.url), 'utf8');

test('revise mode: corrected plan only, no tools, no new facts, the closing question kept', () => {
  const revise = text.split('\n').find(line => line.startsWith('- `Mode: revise`'));
  assert.ok(revise, 'Mode: revise is documented');
  for (const phrase of [/corrected plan only/, /Never call any tool/, /Do not add new facts/, /keep the final question line exactly/]) assert.match(revise, phrase);
});

test('the plan rules ground claims in tool results and use the knowledge desk for every question', () => {
  assert.match(text, /write "not verified"/);
  assert.match(text, /Never invent museums/);
  assert.match(text, /every question the traveller asked in `question`/);
  assert.match(text, /children_ages/);
  assert.match(text, /search_flights/);
  assert.doesNotMatch(text, /advise on visas, weather or insurance/);
  assert.match(text, /Would you like me to open the checkout for the top pick\? Reply "book" to continue, or "no" to finish\./);
});
