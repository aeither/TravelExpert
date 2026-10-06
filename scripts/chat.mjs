import { randomUUID } from 'node:crypto';
import { travelPrompt } from './agent-api.mjs';

const MODEL = 'travel-expert';
const MAX_TEXT = 12_000;
const text = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => typeof part === 'string' ? part : part?.text ?? '').join('') : '';

// OpenAI Responses-compatible input: a string, or a list of { role, content } where content is text or typed parts.
export function transcript(body) {
  const items = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : Array.isArray(body.input) ? body.input : [];
  const lines = items.filter(item => item && ['user', 'assistant'].includes(item.role)).map(item => ({ role: item.role, body: text(item.content).trim() })).filter(item => item.body).map(item => `${item.role === 'user' ? 'Traveller' : 'You'}: ${item.body}`);
  if (!lines.length || !items.some(item => item?.role === 'user' && text(item.content).trim())) throw Object.assign(new Error('input must contain a user message.'), { statusCode: 400 });
  const joined = lines.join('\n');
  return joined.length > MAX_TEXT ? joined.slice(-MAX_TEXT) : joined;
}

export const chatPrompt = (conversation, now) => `Mode: chat\n${travelPrompt(conversation, now)}`;

export function responseObject(id, answer, model = MODEL) {
  const itemId = `msg_${randomUUID().replaceAll('-', '')}`;
  return { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model, error: null,
    output: [{ type: 'message', id: itemId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: answer, annotations: [] }] }],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
}

// Server-sent events in the order OpenAI clients expect. The answer is already complete, so it is sent in a few chunks.
export function* streamEvents(response) {
  const item = response.output[0], part = item.content[0];
  let n = 0;
  const ev = (type, data) => ({ type, data: { type, sequence_number: n++, ...data } });
  yield ev('response.created', { response: { ...response, status: 'in_progress', output: [] } });
  yield ev('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
  yield ev('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: '' } });
  for (let i = 0; i < part.text.length; i += 200) yield ev('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: part.text.slice(i, i + 200) });
  yield ev('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: part.text });
  yield ev('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part });
  yield ev('response.output_item.done', { output_index: 0, item });
  yield ev('response.completed', { response });
}

// Chat is free and stateless on our side: Sokosumi sends the history, or previous_response_id which we resolve from a small memory.
export function createChat({ turn, now = () => new Date(), maxConcurrent = 3 }) {
  const memory = new Map();
  let active = 0;
  return {
    models: () => ({ object: 'list', data: [{ id: MODEL, object: 'model', created: 0, owned_by: 'travel-expert' }] }),
    async respond(body) {
      let conversation = transcript(body);
      const previous = typeof body.previous_response_id === 'string' ? memory.get(body.previous_response_id) : undefined;
      if (previous) conversation = `${previous}\n${conversation}`.slice(-MAX_TEXT);
      if (active >= maxConcurrent) throw Object.assign(new Error('The agent is busy. Try again in a moment.'), { statusCode: 429 });
      active += 1;
      let answer;
      try { answer = await turn(chatPrompt(conversation, now())); }
      catch { throw Object.assign(new Error('The agent could not answer right now.'), { statusCode: 503 }); }
      finally { active -= 1; }
      const response = responseObject(`resp_${randomUUID().replaceAll('-', '')}`, answer);
      memory.set(response.id, `${conversation}\nYou: ${answer}`.slice(-MAX_TEXT));
      if (memory.size > 200) memory.delete(memory.keys().next().value);
      return response;
    },
  };
}
