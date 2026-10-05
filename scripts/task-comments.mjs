import { resolve } from 'node:path';
import { safeId } from './worker-state.mjs';

export const COMMENT_DIRECTORY = resolve(import.meta.dirname, '../.local/comments');
const TEXT_LIMIT = 1_048_576;

export function humanComments(events) {
  return events.filter(event => event.actor?.type === 'user' && typeof event.actor.id === 'string' &&
    typeof event.comment === 'string' && event.comment.trim());
}

function validateAssignedTask(task, taskId, coworkerId) {
  if (task?.id !== taskId || task.status !== 'COMPLETED' || task.organizationId !== null ||
      (task.assigneeId ?? task.coworkerId) !== coworkerId) {
    throw new Error('Comment Task is no longer completed and assigned in the Personal Workspace.');
  }
}

async function processTaskComments(taskId, { coworkerId, store, commentStore, core, eve }) {
  const execution = await store.read(taskId);
  if (!execution?.eventId || !execution.sessionId || execution.coworkerId !== coworkerId ||
      !['completed', 'collection-pending'].includes(execution.stage)) return { status: 'idle' };
  const task = await core.task(taskId);
  // Reassigned, archived, or reopened Tasks cannot receive replies from this executor.
  try { validateAssignedTask(task, taskId, coworkerId); } catch { return { status: 'idle' }; }
  const events = await core.events(taskId);
  const ids = new Set();
  for (const event of events) {
    safeId(event.id);
    if (event.taskId !== taskId || ids.has(event.id)) throw new Error('Invalid or duplicate comment event.');
    ids.add(event.id);
  }
  let state = await commentStore.read(taskId);
  if (!state) {
    const boundary = events.findIndex(event => event.id === execution.eventId);
    if (boundary < 0) throw new Error('Task completion boundary is missing from its events.');
    state = { taskId, sessionId: safeId(execution.sessionId), items: [],
      seen: execution.initialCommentIds ?? humanComments(events.slice(0, boundary + 1)).map(event => event.id) };
    await commentStore.save(state);
  }
  if (state.sessionId !== execution.sessionId) throw new Error('Saved comment session does not match Task execution.');
  let item = state.items.find(entry => entry.stage !== 'replied');
  if (item?.stage === 'post-pending') {
    const confirmed = events.find(event => event.actor?.type === 'coworker' &&
      event.actor.id === coworkerId && event.comment === item.reply);
    if (confirmed) {
      item.stage = 'replied'; item.replyEventId = confirmed.id;
      await commentStore.save(state);
      return { status: 'comment-recovered', taskId, commentId: item.commentId };
    }
  }
  if (item && !['received', 'reply-saved'].includes(item.stage)) {
    return { status: 'comment-inspection-required', taskId, commentId: item.commentId };
  }
  if (!item) {
    const event = humanComments(events).find(event => !state.seen.includes(event.id) &&
      !state.items.some(entry => entry.commentId === event.id));
    if (!event) return { status: 'idle' };
    if (Buffer.byteLength(event.comment) > TEXT_LIMIT) throw new Error('Human comment exceeds 1 MiB.');
    item = { commentId: safeId(event.id), actorId: safeId(event.actor.id), text: event.comment, stage: 'received' };
    state.items.push(item);
    await commentStore.save(state);
  }
  try {
    if (item.stage === 'received') {
      item.stage = 'send-pending'; await commentStore.save(state);
      const session = eve.sessions.attach(state.sessionId, { streamIndex: state.streamIndex ?? 0 });
      const response = await session.send(`Reply to this human follow-up comment on the current Task. Keep the original paid result unchanged.\n${JSON.stringify({ commentId: item.commentId, comment: item.text })}`);
      const result = await response.result();
      if (!['waiting', 'completed'].includes(result.status) || result.inputRequests?.length ||
          result.events?.some(event => ['authorization.required', 'turn.failed'].includes(event.type)) ||
          typeof result.message !== 'string' || !result.message.trim()) throw new Error('No final reply.');
      item.reply = `Reply to comment ${item.commentId}:\n\n${result.message}`;
      if (Buffer.byteLength(item.reply) > TEXT_LIMIT) throw new Error('Reply exceeds 1 MiB.');
      state.streamIndex = session.state.streamIndex;
      item.stage = 'reply-saved'; await commentStore.save(state);
    }
    validateAssignedTask(await core.task(taskId), taskId, coworkerId);
    item.stage = 'post-pending'; await commentStore.save(state);
    item.replyEventId = await core.comment(taskId, item.reply, coworkerId);
    item.stage = 'replied'; await commentStore.save(state);
    return { status: 'comment-replied', taskId, commentId: item.commentId, eventId: item.replyEventId };
  } catch {
    // Keep uncertain sends/posts durable. Never persist raw model or API errors.
    return { status: 'comment-inspection-required', taskId, commentId: item.commentId };
  }
}

export async function processComments(dependencies) {
  const results = [];
  for (const taskId of await dependencies.store.ids()) {
    try {
      const result = await processTaskComments(taskId, dependencies);
      if (result.status !== 'idle') results.push(result);
    } catch { results.push({ status: 'comment-inspection-required', taskId }); }
  }
  return results.length > 1 ? { status: 'comments-processed', results } : results[0] ?? { status: 'idle' };
}
