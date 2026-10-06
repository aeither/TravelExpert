import test from 'node:test';
import assert from 'node:assert/strict';
import { generateText } from 'ai';
import { openrouter, openrouterFetch } from '../agent/lib/models.mjs';

test('model credential stays on OpenRouter and redirects cannot forward it', async () => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousFetch = globalThis.fetch;
  try {
    delete process.env.OPENROUTER_API_KEY;
    assert.throws(() => openrouterFetch('https://openrouter.ai/api/v1/chat/completions'), /not set/);
    process.env.OPENROUTER_API_KEY = 'test-only-key';
    assert.throws(() => openrouterFetch('https://example.com'), /Unexpected model host/);
    let request;
    globalThis.fetch = async (url, init) => { request = { url, init }; return new Response('{}'); };
    await openrouterFetch('https://openrouter.ai/api/v1/chat/completions', { headers: { 'x-test': 'retained' } });
    assert.equal(request.init.headers.get('authorization'), 'Bearer test-only-key');
    assert.equal(request.init.headers.get('x-test'), 'retained');
    assert.equal(request.init.redirect, 'error');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  }
});

test('model requests use the OpenRouter endpoint and the requested model', async () => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousFetch = globalThis.fetch;
  try {
    process.env.OPENROUTER_API_KEY = 'test-only-key';
    let request;
    globalThis.fetch = async (url, init) => {
      request = { url: String(url), body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        id: 'test', object: 'chat.completion', created: 0, model: 'openrouter/free',
        choices: [{ index: 0, message: { role: 'assistant', content: 'READY' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { headers: { 'content-type': 'application/json' } });
    };
    const result = await generateText({ model: openrouter('openrouter/free'), prompt: 'Reply READY.', maxRetries: 0 });
    assert.equal(result.text, 'READY');
    assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(request.body.model, 'openrouter/free');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  }
});
