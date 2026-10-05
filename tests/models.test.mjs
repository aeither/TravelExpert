import test from 'node:test';
import assert from 'node:assert/strict';
import { generateText } from 'ai';
import { zai, zaiFetch } from '../agent/lib/models.mjs';

test('model credential stays on Z.ai and redirects cannot forward it', async () => {
  const previousKey = process.env.ZAI_API_KEY;
  const previousFetch = globalThis.fetch;
  try {
    delete process.env.ZAI_API_KEY;
    assert.throws(() => zaiFetch('https://api.z.ai/api/paas/v4/chat/completions'), /not set/);
    process.env.ZAI_API_KEY = 'test-only-key';
    assert.throws(() => zaiFetch('https://example.com'), /Unexpected model host/);
    let request;
    globalThis.fetch = async (url, init) => { request = { url, init }; return new Response('{}'); };
    await zaiFetch('https://api.z.ai/api/paas/v4/chat/completions', { headers: { 'x-test': 'retained' } });
    assert.equal(request.init.headers.get('authorization'), 'Bearer test-only-key');
    assert.equal(request.init.headers.get('x-test'), 'retained');
    assert.equal(request.init.redirect, 'error');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.ZAI_API_KEY;
    else process.env.ZAI_API_KEY = previousKey;
  }
});

test('D5: model requests use the SEO bot endpoint and requested GLM model', async () => {
  const previousKey = process.env.ZAI_API_KEY;
  const previousFetch = globalThis.fetch;
  try {
    process.env.ZAI_API_KEY = 'test-only-key';
    let request;
    globalThis.fetch = async (url, init) => {
      request = { url: String(url), body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        id: 'test', object: 'chat.completion', created: 0, model: 'glm-5.3-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'READY' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { headers: { 'content-type': 'application/json' } });
    };
    const result = await generateText({ model: zai('glm-5.3-flash'), prompt: 'Reply READY.', maxRetries: 0 });
    assert.equal(result.text, 'READY');
    assert.equal(request.url, 'https://api.z.ai/api/coding/paas/v4/chat/completions');
    assert.equal(request.body.model, 'glm-5.3-flash');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.ZAI_API_KEY;
    else process.env.ZAI_API_KEY = previousKey;
  }
});
