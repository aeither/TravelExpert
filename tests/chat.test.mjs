import test from 'node:test';
import assert from 'node:assert/strict';
import { createChat, streamEvents, transcript } from '../scripts/chat.mjs';

test('chat input accepts a string or typed messages and rejects empty input', () => {
  assert.equal(transcript({ input: 'Hotels in Cebu?' }), 'Traveller: Hotels in Cebu?');
  assert.equal(transcript({ input: [{ role: 'system', content: 'x' }, { role: 'user', content: [{ type: 'input_text', text: 'Cebu hotels' }] }, { role: 'assistant', content: 'Sure' }, { role: 'user', content: 'cheaper' }] }), 'Traveller: Cebu hotels\nYou: Sure\nTraveller: cheaper');
  assert.throws(() => transcript({ input: '' }), { statusCode: 400 });
  assert.throws(() => transcript({}), { statusCode: 400 });
});

test('chat answers in Responses format, remembers previous_response_id and caps concurrency', async () => {
  const prompts = [];
  const chat = createChat({ turn: async p => { prompts.push(p); return 'Cebu has many hotels.'; }, now: () => new Date('2026-10-07T00:00:00Z'), maxConcurrent: 1 });
  const first = await chat.respond({ input: 'Hotels in Cebu?' });
  assert.equal(first.object, 'response'); assert.equal(first.output[0].content[0].text, 'Cebu has many hotels.');
  assert.match(prompts[0], /^Mode: chat\nToday is 2026-10-07\./);
  await chat.respond({ input: 'And cheaper?', previous_response_id: first.id });
  assert.match(prompts[1], /Hotels in Cebu\?.*You: Cebu has many hotels\..*And cheaper\?/);
  let release; const slow = createChat({ turn: () => new Promise(r => { release = () => r('ok'); }), maxConcurrent: 1 });
  const pending = slow.respond({ input: 'a long question' });
  await assert.rejects(slow.respond({ input: 'another one' }), { statusCode: 429 });
  release(); await pending;
});

test('streamed events end with response.completed and rebuild the full text', () => {
  const chat = createChat({ turn: async () => 'x'.repeat(450) });
  return chat.respond({ input: 'hello there' }).then(response => {
    const events = [...streamEvents(response)];
    assert.equal(events[0].type, 'response.created'); assert.equal(events.at(-1).type, 'response.completed');
    assert.equal(events.filter(e => e.type === 'response.output_text.delta').map(e => e.data.delta).join(''), 'x'.repeat(450));
    assert.deepEqual(events.map(e => e.data.sequence_number), events.map((_, i) => i));
  });
});
