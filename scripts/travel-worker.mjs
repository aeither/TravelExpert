import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createPaymentPlan, createSignedQuote, buildMasumiPaymentEvent, readPayment, readSellerCollection, submitSellerResult } from './payment.ts';
import { createStore, safeId } from './worker-state.mjs';
import { createHttpClient } from './sokosumi-http.mjs';
import { createEveClient } from './eve-client.mjs';
import { hostedPaidConfiguration } from './hosted.mjs';
import { createAdvisor } from './advisor.mjs';
import { travelPrompt } from './agent-api.mjs';
import { txUrl, CLOSING, NOT_OPENED, answerToOffer, collectionComment, feeFor, handoverText, paymentComment, proofBlock } from './booking-copy.mjs';
import { inAllowedWorkspace } from './workspaces.mjs';

const POLL_MS = 10_000;
const COLLECT_GRACE_MS = 30 * 60_000;
const FOLLOW_UP_WINDOW_MS = 2 * 24 * 3600_000;
const confirmed = (payment, state) => payment.onChainState === state && payment.CurrentTransaction?.status === 'Confirmed' && !!payment.CurrentTransaction.txHash && (payment.CurrentTransaction.confirmations ?? 0) > 0;
const readPlan = async (dir, taskId) => { try { return JSON.parse(await readFile(resolve(dir, 'plans', `${safeId(taskId)}.json`), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } };

// Plan (free) -> the traveller says "book" -> checkout opened first -> dynamic fee in escrow -> hash -> checkout handed over -> payout proof.
// Every step persists before and after an external write, and never retries a possibly charged step on its own.
const flat = value => String(value ?? '').replace(/\s+/g, ' ').slice(0, 60);
export function describeAction(action) {
  const input = action?.input ?? {};
  switch (action?.toolName) {
    case 'destination_info': return `Orchestrator → Expert Travel Agency knowledge desk (another agent): asking about ${flat(input.destination)}…`;
    case 'search_hotels': return `Orchestrator → Expert Travel Agency hotel search: ${flat(input.city)}, check-in ${flat(input.check_in)}, ${flat(input.nights)} night(s)…`;
    case 'save_plan': return 'Saving your plan, so replying "book" can continue it…';
    default: return undefined;
  }
}
export function describeResult(result) {
  const out = result?.output;
  if (Array.isArray(out?.hotels)) return `Found ${out.hotels.length} hotel option${out.hotels.length === 1 ? '' : 's'} with live rates.`;
  if (typeof out?.answer === 'string') return 'The knowledge desk answered.';
  if (out?.saved) return 'Plan saved.';
  return undefined;
}

export function createTravelWorker({ api, mps, eve, advisor, store, source, coworkerId, dataDir, log = console.log, runAgent }) {
  let polls = 0;
  const events = async id => (await api.get(`/v1/tasks/${safeId(id)}/events?limit=100`)).data;
  const post = (id, body) => api.post(`/v1/tasks/${safeId(id)}/events`, body);
  const turn = runAgent ?? (async (prompt, onEvent) => {
    const { session } = await eve.sessions.create();
    const response = await session.send(prompt);
    if (!onEvent) {
      const result = await response.result();
      if (!['waiting', 'completed'].includes(result.status) || result.inputRequests?.length || result.events?.some(e => ['authorization.required', 'turn.failed'].includes(e.type)) || !result.message?.trim()) throw new Error('The agent returned no answer.');
      return result.message.trim();
    }
    // Reading the stream shows what the agent is doing while it works, so a long turn is never silent. The stream cannot be read twice, so the answer comes from it too.
    let message = '', failed = false, reason = '';
    for await (const event of response) {
      if (['turn.failed', 'authorization.required'].includes(event.type)) { failed = true; reason = String(event.data?.error?.message ?? event.data?.message ?? '').slice(0, 300); }
      if (event.type === 'message.completed' && event.data?.finishReason !== 'tool-calls' && typeof event.data?.message === 'string') message = event.data.message;
      try { await onEvent(event); } catch { /* progress is best effort */ }
    }
    if (failed || !message.trim()) throw new Error(`The agent returned no answer.${reason ? ` ${reason}` : ''}`);
    return message.trim();
  });

  // The traveller's answer to our last question: the newest user comment after it, or a new description set back to Ready.
  async function reply(task, st) {
    if (task.status === 'READY' && task.description !== st.input) return { text: task.description, fromEdit: true };
    const all = await events(task.id);
    const asked = all.filter(e => e.status === 'INPUT_REQUIRED' && e.actor?.id === task.assigneeId).map(e => String(e.createdAt ?? '')).sort().at(-1) ?? '';
    const answers = all.filter(e => typeof e.comment === 'string' && e.comment.trim() && e.actor?.type === 'user' && String(e.createdAt ?? '') > asked && !st.used?.includes(e.id)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const answer = answers.at(-1);
    if (!answer) return undefined;
    st.used = [...(st.used ?? []), answer.id];
    return { text: answer.comment.trim() };
  }

  // Progress comments: one per distinct step, never a status change. Best effort, so a failed comment never stops the work.
  const reporter = taskId => {
    const said = new Set();
    const say = async text => { if (said.has(text)) return; said.add(text); try { await post(taskId, { comment: text }); } catch { /* ignore */ } };
    return async event => {
      if (event.type === 'actions.requested') for (const action of event.data?.actions ?? []) { const line = describeAction(action); if (line) await say(line); }
      else if (event.type === 'action.result') { const line = describeResult(event.data?.result); if (line) await say(line); }
      else if (event.type === 'step.started' && event.data?.stepIndex > 0) await say('Putting the answer together…');
    };
  };

  const finish = async (task, st, save, text, status = 'COMPLETED') => {
    st.phase = 'complete-pending'; st.final = text; await save();
    const event = (await post(task.id, { status, comment: text })).data;
    if (event?.status !== status || !event.id) throw new Error('Completion was not confirmed. Inspect the task.');
    st.phase = st.paid ? 'collecting' : 'completed'; st.eventId = event.id; st.finishedAt = new Date().toISOString(); await save();
    return 'completed';
  };
  const askUser = async (task, st, save, text, reason) => {
    st.phase = 'ask-pending'; await save();
    const event = (await post(task.id, { status: 'INPUT_REQUIRED', comment: text })).data;
    if (event?.status !== 'INPUT_REQUIRED') throw new Error('Question was not confirmed. Inspect the task.');
    st.phase = 'waiting-reply'; st.reason = reason; delete st.reply; await save();
    return 'input_required';
  };

  async function plan(task, st, save) {
    const earlier = [st.input, st.context].filter(Boolean).join(' ');
    const text = st.reply !== undefined ? `Original request: ${earlier}\nTraveller's reply to my last message: ${st.reply}` : earlier;
    await post(task.id, { comment: 'Working on your request. I will report each step here.' }).catch(() => {});
    const answer = await turn(`${travelPrompt(text)}\nTask reference: ${task.id}`, reporter(task.id));
    const saved = await readPlan(dataDir, task.id);
    if (saved) { st.plan = saved; return askUser(task, st, save, answer, 'offer'); }
    // Asking something without having planned anything is a question: the task waits for the traveller.
    if (/\?/.test(answer) && !/checkout|book/i.test(answer)) { st.context = [st.context, st.reply].filter(Boolean).join(' '); return askUser(task, st, save, answer, 'ask'); }
    return finish(task, st, save, answer);
  }

  async function booking(task, st, save) {
    const p = st.paid ?? {};
    if (!st.checkout) {
      await post(task.id, { comment: 'Orchestrator → Expert Travel Advisor: opening the hotel checkout (nothing is charged yet)…' }).catch(() => {});
      const opened = await advisor.openCheckout(st.plan);
      if (!opened.opened) return finish(task, st, save, NOT_OPENED(opened.failure_reason));
      st.checkout = opened.checkout; st.plan = { ...st.plan, hotel: opened.hotel, ...(opened.swappedFrom ? { swappedFrom: opened.swappedFrom } : {}) };
      st.fee = feeFor(st.plan.hotel.total); await save();
    }
    if (!p.stage) {
      const info = { taskId: task.id, name: task.name ?? 'Hotel booking', description: task.description ?? null };
      p.plan = createPaymentPlan(info, source, { amount: st.fee.atomic });
      st.paid = { ...p, stage: 'quote-pending' }; await save();
      p.quote = await createSignedQuote(mps, p.plan);
      st.paid = { ...p, stage: 'quote-saved' }; await save();
    }
    if (st.paid.stage === 'quote-saved') {
      const event = buildMasumiPaymentEvent(st.paid.plan, st.paid.quote);
      st.paid.stage = 'payment-event-pending'; await save();
      st.paid.eventId = (await post(task.id, { comment: paymentComment(st.plan, st.fee, task.id), ...event })).data?.id ?? null;
      st.paid.stage = 'awaiting-escrow'; await save();
    }
    if (['quote-pending', 'payment-event-pending'].includes(st.paid.stage)) throw new Error(`Uncertain ${st.paid.stage}. Inspect the payment before retrying.`);
    const paid = st.paid;
    if (paid.stage === 'awaiting-escrow') {
      const now = await readPayment(mps, paid.plan, paid.quote);
      if (!confirmed(now, 'FundsLocked')) {
        if (Date.now() > Date.parse(paid.plan.submitResultTime)) { st.phase = 'blocked'; st.reason = 'ESCROW_EXPIRED'; await save(); }
        return 'waiting';
      }
      paid.escrowTx = now.CurrentTransaction.txHash; paid.fundedPayment = now; paid.stage = 'escrow-confirmed';
      await post(task.id, { comment: `Escrow confirmed on-chain: ${txUrl(paid.escrowTx)}\nSubmitting my result hash…` }).catch(() => {});
      st.answer = handoverText(st.plan, st.checkout, task.id); await save();
    }
    if (paid.stage === 'escrow-confirmed') {
      if (Date.now() >= Date.parse(paid.plan.submitResultTime)) throw new Error('Result deadline passed before the hash was submitted.');
      paid.stage = 'submit-pending'; await save();
      paid.resultHash = (await submitSellerResult(mps, paid.plan, paid.fundedPayment, st.answer)).resultHash;
      paid.stage = 'awaiting-result'; await save();
    }
    if (paid.stage === 'submit-pending') throw new Error('Uncertain result submission. Inspect it before retrying.');
    if (paid.stage === 'awaiting-result') {
      const now = await readPayment(mps, paid.plan, paid.quote);
      if (!(confirmed(now, 'ResultSubmitted') && now.resultHash === paid.resultHash)) return 'waiting';
      paid.resultTx = now.CurrentTransaction.txHash; paid.stage = 'result-confirmed'; await save();
    }
    return finish(task, st, save, st.answer + '\n' + proofBlock(paid, source, st.fee));
  }

  async function advance(task) {
    const prior = await store.read(task.id);
    let st = prior ?? { taskId: task.id, coworkerId, phase: 'new', input: task.description };
    const save = () => store.save(st);
    if (!prior) await save();
    if (['completed', 'blocked', 'collecting'].includes(st.phase)) return 'skipped';
    if (st.phase === 'new' && task.status !== 'READY') return 'skipped';
    if (st.phase === 'waiting-reply') {
      if (!['READY', 'INPUT_REQUIRED'].includes(task.status)) return 'skipped';
      const answer = await reply(task, st);
      if (answer === undefined) return 'waiting';
      const choice = st.reason === 'offer' && !answer.fromEdit ? answerToOffer(answer.text) : undefined;
      if (answer.fromEdit) { st.input = task.description; st.context = ''; delete st.plan; }
      else st.reply = answer.text;
      // Show the traveller that work resumed. A failed status write must not stop the booking.
      await post(task.id, { status: 'RUNNING' }).catch(() => {});
      st.phase = choice === 'yes' ? 'booking' : choice === 'no' ? 'closing' : 'planning'; await save();
    } else if (st.phase === 'new') {
      st.phase = 'start-pending'; await save();
      const started = (await post(task.id, { status: 'RUNNING' })).data;
      if (started?.status !== 'RUNNING') throw new Error('Start was not confirmed. Inspect the task.');
      st.phase = 'planning'; await save();
    } else if (st.phase === 'start-pending') throw new Error('Uncertain start. Inspect the task before retrying.');
    try {
      if (st.phase === 'planning') return await plan(task, st, save);
      if (st.phase === 'closing') return await finish(task, st, save, CLOSING);
      if (st.phase === 'booking') return await booking(task, st, save);
      return 'skipped';
    } catch (error) {
      log(`task ${task.id} stopped in ${st.phase}: ${String(error?.message ?? error).slice(0, 160)}`);
      if (['planning', 'closing'].includes(st.phase) && !st.paid) {
        // Nothing was charged: tell the traveller and block the task for inspection.
        st.phase = 'blocked'; st.reason = 'FAILED'; await save();
        const quota = /rate limit|quota|free-models-per-day/i.test(String(error?.message));
        await post(task.id, { status: 'FAILED', comment: quota ? 'The AI model I use has reached its free daily limit, so I could not plan this. Nothing was charged. Please try again later.' : 'Sorry, I could not finish this. Please try again in a minute.' }).catch(() => {});
        return 'failed';
      }
      st.inspectionRequired = true; await save(); return 'inspection_required';
    }
  }

  // Follow-ups: a user comment on a finished task gets a short free answer as a comment. Nothing is charged and no status changes.
  async function followUps(st, task) {
    if (task.status !== 'COMPLETED' || !st.final) return 0;
    const all = await events(st.taskId);
    const done = all.find(e => e.id === st.eventId);
    const after = String(done?.createdAt ?? '');
    const fresh = all.filter(e => typeof e.comment === 'string' && e.comment.trim() && e.actor?.type === 'user' && String(e.createdAt ?? '') > after && !st.used?.includes(e.id)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const next = fresh[0];
    if (!next) return 0;
    // At most once: remember the comment before answering, so a crash never posts two replies.
    st.used = [...(st.used ?? []), next.id]; await store.save(st);
    // Same visible statuses as the first request: Running while it works, Completed with the answer.
    const reopened = await post(st.taskId, { status: 'RUNNING', comment: 'Looking into your follow-up…' }).then(() => true, () => false);
    let answer;
    try { answer = await turn(`Mode: follow-up\n${travelPrompt(`The task's final answer:\n${String(st.final).slice(0, 4000)}\n\nNew comment from the traveller: ${next.comment.trim().slice(0, 2000)}`)}`, reporter(st.taskId)); }
    catch { answer = 'Sorry, I could not answer that follow-up. Please try again in a minute.'; }
    const text = answer.slice(0, 20000);
    if (reopened) await post(st.taskId, { status: 'COMPLETED', comment: text }).catch(() => post(st.taskId, { comment: text }));
    else await post(st.taskId, { comment: text });
    return 1;
  }

  // Completed paid tasks: follow collection, then post where to verify the payout.
  async function collect(st) {
    const paid = st.paid;
    const found = await readSellerCollection(mps, paid.plan, paid.quote);
    if (found.settled && found.txHash) {
      paid.withdrawalTx = found.txHash; st.phase = 'completed'; await store.save(st);
      await post(st.taskId, { comment: collectionComment(paid, st.fee) });
      return 'settled';
    }
    if (Date.now() >= Date.parse(paid.plan.externalDisputeUnlockTime) + COLLECT_GRACE_MS) { st.inspectionRequired = true; await store.save(st); return 'collection_overdue'; }
    return 'collecting';
  }

  async function tick() {
    const release = await store.lock(coworkerId);
    try {
      const out = [];
      for (const id of await store.ids()) {
        const st = await store.read(id);
        if (st?.phase === 'collecting' && !st.inspectionRequired) { try { out.push(await collect(st)); } catch { out.push('collect_check_failed'); } }
      }
      // Follow-ups on tasks finished in the last two days, checked about every 30 seconds.
      if (++polls % 3 === 0) {
        for (const id of await store.ids()) {
          const st = await store.read(id);
          if (!st || st.inspectionRequired || !['completed', 'collecting'].includes(st.phase) || !st.final || Date.now() - Date.parse(st.finishedAt ?? 0) > FOLLOW_UP_WINDOW_MS) continue;
          try { const task = (await api.get(`/v1/tasks/${safeId(id)}`)).data; if (await followUps(st, task)) out.push('follow_up'); } catch { out.push('follow_up_failed'); }
        }
      }
      const seen = new Set();
      for (const status of ['READY', 'RUNNING', 'INPUT_REQUIRED']) {
        const page = await api.get(`/v1/tasks?${new URLSearchParams({ coworkerId, status, limit: '100' })}`);
        for (const task of page.data ?? []) {
          if (seen.has(task.id) || (task.assigneeId ?? task.coworkerId) !== coworkerId || !inAllowedWorkspace(task)) continue;
          seen.add(task.id);
          const st = await store.read(task.id);
          if (st?.inspectionRequired) continue;
          try { out.push(await advance(task)); } catch (error) { log(`task ${task.id}: ${String(error?.message ?? error).slice(0, 160)}`); out.push('error'); }
        }
      }
      return out.filter(x => !['skipped', 'waiting', 'collecting'].includes(x));
    } finally { await release(); }
  }
  return { tick, advance, collect, followUps };
}

async function main() {
  const config = hostedPaidConfiguration();
  const dataDir = resolve(process.env.DATA_DIR || resolve(import.meta.dirname, '../.local'));
  const worker = createTravelWorker({
    api: createHttpClient(process.env.SOKOSUMI_COWORKER_API_KEY), mps: config.mps, eve: createEveClient(), advisor: createAdvisor(process.env.ADVISOR_URL || 'https://expert-travel-advisor.vercel.app'),
    store: await createStore(resolve(dataDir, 'travel')), source: config.source, coworkerId: config.coworkerId, dataDir,
  });
  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());
  while (!stop.signal.aborted) {
    try { const done = await worker.tick(); if (done.length) console.log(JSON.stringify({ status: done })); }
    catch (error) { console.error('travel worker tick failed:', String(error?.message ?? error).slice(0, 160)); }
    try { await delay(POLL_MS, undefined, { signal: stop.signal }); } catch { break; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error('Travel worker stopped:', String(error?.message ?? error).slice(0, 160)); process.exitCode = 1; });
}
