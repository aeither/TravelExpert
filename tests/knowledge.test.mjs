import test from 'node:test';
import assert from 'node:assert/strict';
import { destinationInfo } from '../agent/lib/knowledge.ts';

const ok = answer => async () => Response.json({ destination: 'Cebu', answer });

test('the knowledge desk answer is reused for the same question, even when asked at the same time', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return Response.json({ destination: 'Cebu', answer: 'Go in January.' }); };
  const [a, b] = await Promise.all([destinationInfo({ destination: 'Cebu-A' }, fetcher, 'k'), destinationInfo({ destination: ' cebu-a ' }, fetcher, 'k')]);
  const c = await destinationInfo({ destination: 'Cebu-A' }, fetcher, 'k');
  assert.equal(calls, 1);
  assert.equal(a.answer, 'Go in January.'); assert.deepEqual(b, a); assert.deepEqual(c, a);
});

test('different questions are not mixed up', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({ destination: 'Cebu', answer: `a${calls}` }); };
  const a = await destinationInfo({ destination: 'Bohol-B', question: 'best month?' }, fetcher, 'k');
  const b = await destinationInfo({ destination: 'Bohol-B', question: 'getting around?' }, fetcher, 'k');
  assert.notEqual(a.answer, b.answer); assert.equal(calls, 2);
});

test('failures are never cached, so the next ask tries again', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return calls === 1 ? new Response('no', { status: 502 }) : ok('fine')(); };
  assert.match((await destinationInfo({ destination: 'Palawan-C' }, fetcher, 'k')).error, /HTTP 502/);
  assert.equal((await destinationInfo({ destination: 'Palawan-C' }, fetcher, 'k')).answer, 'fine');
  const thrown = async () => { throw new Error('network'); };
  await assert.rejects(destinationInfo({ destination: 'Siargao-D' }, thrown, 'k'));
  assert.equal((await destinationInfo({ destination: 'Siargao-D' }, ok('later'), 'k')).answer, 'later');
});
