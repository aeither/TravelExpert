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
import { txUrl, CLOSING, NOT_BOOKED, REJECTED_AFTER_ESCROW, answerToOffer, collectionComment, feeFor, handoverText, insertBeforeOffer, offerFeeLine, paymentComment, proofBlock } from './booking-copy.mjs';
import { createOriginBooker, guestFromRequest } from './origin-booking.mjs';
import { createReviewer } from './audit.mjs';
import { readLedgerEvidence, renderReceiptFor } from './receipt.mjs';
import { buyService, paidEnabled } from '../agent/lib/paid.ts';
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
    case 'destination_info': return `Orchestrator → Expert Travel Agency knowledge desk (another agent): asking about ${flat(input.destination)}. Paying 0.5 test USDM through Masumi…`;
    case 'search_flights': return `Orchestrator → Expert Travel Agency flight search: ${flat(input.origin)} → ${flat(input.destination)} on ${flat(input.departure_date)}. Paying 1 test USDM through Masumi…`;
    case 'search_hotels': return `Orchestrator → Expert Travel Agency hotel search: ${flat(input.city)}, check-in ${flat(input.check_in)}, ${flat(input.nights)} night(s). Paying 1 test USDM through Masumi, so this waits for on-chain confirmation (about 2 to 3 minutes)…`;
    case 'save_plan': return 'Saving your plan, so replying "book" can continue it…';
    default: return undefined;
  }
}
export function describeResult(result) {
  const out = result?.output;
  if (Array.isArray(out?.offers)) return `Found ${out.offers.length} flight offer${out.offers.length === 1 ? '' : 's'} (test fares).`;
  if (Array.isArray(out?.hotels)) return `Found ${out.hotels.length} hotel option${out.hotels.length === 1 ? '' : 's'} with live rates.`;
  if (typeof out?.answer === 'string') return 'The knowledge desk answered.';
  if (out?.saved) return 'Plan saved.';
  return undefined;
}

// A turn waits on the model and, for hotel search, on a Cardano confirmation (about 3 minutes). One that never ends would hold the poll lock and freeze every task.
const TURN_TIMEOUT_MS = 20 * 60_000;
const withTimeout = (work, ms) => { let timer; return Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The agent took too long.')), ms); })]).finally(() => clearTimeout(timer)); };

// `booker` books LiteAPI stays through the Expert Travel Agency; `review` audits the plan with a paid agent; `receipt` renders the purchase ledger.
// All three are optional, so the worker still plans and opens advisor checkouts without them. `concurrency` caps tasks running side by side.
export function createTravelWorker({ api, mps, eve, advisor, booker, review, receipt, guest, store, source, coworkerId, dataDir, log = console.log, runAgent, turnTimeoutMs = TURN_TIMEOUT_MS, concurrency = 4 }) {
  let polls = 0;
  const events = async id => (await api.get(`/v1/tasks/${safeId(id)}/events?limit=100`)).data;
  const post = (id, body) => api.post(`/v1/tasks/${safeId(id)}/events`, body);
  // The scarce resource is a running agent turn, not polling a task: at most `concurrency` turns run at once, the rest wait their turn.
  let active = 0; const waiting = [];
  const slot = async work => { if (active >= concurrency) await new Promise(resolve => waiting.push(resolve)); active++; try { return await work(); } finally { active--; waiting.shift()?.(); } };
  const turn = (prompt, onEvent) => slot(() => runAgent ? runAgent(prompt, onEvent) : withTimeout(runTurn(prompt, onEvent), turnTimeoutMs));
  async function runTurn(prompt, onEvent) {
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
  }

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
    if (saved) {
      st.plan = saved;
      let text = answer, receiptBlock = '';
      // The audit and the receipt are extras: a failure in either never blocks the plan.
      if (review) { try { text = (await review({ taskId: task.id, plan: saved, answer, revise: prompt => turn(prompt), say: line => post(task.id, { comment: line }).catch(() => {}) })) || answer; } catch (error) { log(`task ${task.id}: review failed: ${String(error?.message ?? error).slice(0, 120)}`); } }
      if (receipt) { try { receiptBlock = await receipt(task.id); } catch (error) { log(`task ${task.id}: receipt failed: ${String(error?.message ?? error).slice(0, 120)}`); } }
      return askUser(task, st, save, insertBeforeOffer(text, [receiptBlock, offerFeeLine(saved)]), 'offer');
    }
    // Asking something without having planned anything is a question: the task waits for the traveller.
    if (/\?/.test(answer) && !/checkout|book/i.test(answer)) { st.context = [st.context, st.reply].filter(Boolean).join(' '); return askUser(task, st, save, answer, 'ask'); }
    return finish(task, st, save, answer);
  }

  // Picks what the traveller can actually get, before any money moves. LiteAPI stays are re-checked and booked through the Expert Travel Agency;
  // advisor stays open a pay-at-property checkout, or fall back to the pre-filled hotel page.
  async function chooseCheckout(task, st) {
    const plan = st.plan;
    const said = text => post(task.id, { comment: text }).catch(() => {});
    if (plan.hotel.source === 'liteapi') {
      const candidates = [plan.hotel, ...(plan.alternatives ?? [])].filter(h => h.source === 'liteapi' && h.bookable);
      if (!booker || !candidates.length) { st.failure = 'booking is not available for this stay'; return false; }
      await said(`Orchestrator → Expert Travel Agency booking desk: checking that ${plan.hotel.name} is still bookable at the quoted price (nothing is charged yet)…`);
      let reason = 'no hotel could be re-checked';
      for (const hotel of candidates) {
        const found = await booker.check(plan, hotel);
        if (!found.ok) { reason = found.reason ?? reason; continue; }
        st.checkout = { kind: 'reservation', offer: found.offer };
        st.plan = { ...plan, hotel: found.hotel, ...(hotel.id !== plan.hotel.id ? { swappedFrom: plan.hotel.name } : {}) };
        return true;
      }
      st.failure = reason; return false;
    }
    await said('Orchestrator → Expert Travel Advisor: opening the hotel checkout (nothing is charged yet)…');
    const opened = await advisor.openCheckout(plan);
    if (opened.opened) {
      st.checkout = { kind: 'checkout', ...opened.checkout };
      st.plan = { ...plan, hotel: opened.hotel, ...(opened.swappedFrom ? { swappedFrom: opened.swappedFrom } : {}) };
      return true;
    }
    if (opened.linkOnly) { st.checkout = { kind: 'link', url: opened.linkOnly.url }; st.plan = { ...plan, hotel: opened.linkOnly.hotel }; return true; }
    st.failure = opened.failure_reason ?? null; return false;
  }

  async function booking(task, st, save) {
    const p = st.paid ?? {};
    if (!st.checkout) {
      if (!(await chooseCheckout(task, st))) {
        const others = [st.plan.hotel, ...(st.plan.alternatives ?? [])].map(h => h.name).slice(0, 3);
        return finish(task, st, save, NOT_BOOKED(st.failure ?? 'no checkout was available', others), 'FAILED');
      }
      // A pre-filled page is handed over for free: no fee for something that is not a reservation.
      if (st.checkout.kind === 'link') return finish(task, st, save, handoverText(st.plan, st.checkout, task.id));
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
      await post(task.id, { comment: `Escrow confirmed on-chain: ${txUrl(paid.escrowTx)}\n${st.checkout.kind === 'reservation' ? `Booking ${st.plan.hotel.name} now…` : 'Submitting my result hash…'}` }).catch(() => {});
      await save();
    }
    if (paid.stage === 'escrow-confirmed') {
      if (Date.now() >= Date.parse(paid.plan.submitResultTime)) throw new Error('Result deadline passed before the hash was submitted.');
      if (st.checkout.kind === 'reservation' && !st.booking) {
        // The supplier booking is the one irreversible step: its stage is saved first and an unknown outcome is never retried.
        if (st.bookStage === 'book-pending') { st.inspectionRequired = true; await save(); return 'inspection_required'; }
        st.bookStage = 'book-pending'; await save();
        const who = guestFromRequest([st.input, st.context, st.reply].filter(Boolean).join(' '), guest ?? booker.guest);
        try { st.booking = await booker.book({ taskId: task.id, hotel: st.plan.hotel, offer: st.checkout.offer, total: st.plan.hotel.total, guest: who, adults: st.plan.request.adults }); }
        catch (error) {
          log(`task ${task.id}: booking failed (${error?.code ?? 'unknown'}): ${String(error?.message ?? error).slice(0, 120)}`);
          if (error?.definite) {
            st.bookStage = 'rejected'; st.phase = 'blocked'; st.reason = 'BOOKING_REJECTED_AFTER_ESCROW'; await save();
            await post(task.id, { comment: REJECTED_AFTER_ESCROW(String(error.message).slice(0, 100)) }).catch(() => {});
            return 'blocked';
          }
          st.inspectionRequired = true; await save();
          await post(task.id, { comment: 'I could not confirm whether the hotel booking went through. I will not try again on my own: I am checking it manually and nothing more will be charged.' }).catch(() => {});
          return 'inspection_required';
        }
        st.bookStage = 'booked'; await save();
      }
      st.answer ??= handoverText(st.plan, st.checkout, task.id, st.booking); await save();
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

  // Each task runs on its own: a 3-minute paid search no longer holds up every other task. A task is never started twice
  // (one slot per task id) and agent turns are limited by `concurrency` (see `slot`). The poll lock only covers scheduling.
  const inflight = new Map();
  let finished = [];
  function schedule(key, work) {
    if (inflight.has(key) || inflight.size >= concurrency * 10) return null;
    const run = (async () => { try { return await work(); } catch (error) { log(`${key}: ${String(error?.message ?? error).slice(0, 160)}`); return 'error'; } })()
      .then(outcome => { inflight.delete(key); finished.push(outcome); return outcome; });
    inflight.set(key, run);
    return run;
  }
  const idle = async () => { while (inflight.size) await Promise.all([...inflight.values()]); };
  const drain = () => { const out = finished.filter(x => !['skipped', 'waiting', 'collecting'].includes(x)); finished = []; return out; };

  async function tick({ wait = true } = {}) {
    const release = await store.lock(coworkerId);
    const started = [];
    const run = (key, work) => { const job = schedule(key, work); if (job) started.push(job); };
    try {
      for (const id of await store.ids()) {
        const st = await store.read(id);
        if (st?.phase === 'collecting' && !st.inspectionRequired) run(`task:${id}`, async () => { try { return await collect(st); } catch { return 'collect_check_failed'; } });
      }
      // Follow-ups on tasks finished in the last two days, checked about every 30 seconds.
      if (++polls % 3 === 0) {
        for (const id of await store.ids()) {
          const st = await store.read(id);
          if (!st || st.inspectionRequired || !['completed', 'collecting'].includes(st.phase) || !st.final || Date.now() - Date.parse(st.finishedAt ?? 0) > FOLLOW_UP_WINDOW_MS) continue;
          run(`task:${id}`, async () => { try { const task = (await api.get(`/v1/tasks/${safeId(id)}`)).data; return (await followUps(st, task)) ? 'follow_up' : 'skipped'; } catch { return 'follow_up_failed'; } });
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
          run(`task:${task.id}`, () => advance(task));
        }
      }
    } finally { await release(); }
    if (!wait) return drain();
    await Promise.all(started);
    return drain();
  }
  return { tick, advance, collect, followUps, idle, drain };
}

async function main() {
  const config = hostedPaidConfiguration();
  const dataDir = resolve(process.env.DATA_DIR || resolve(import.meta.dirname, '../.local'));
  const env = process.env;
  const guest = { given_name: env.GUEST_GIVEN_NAME || 'Alex', family_name: env.GUEST_FAMILY_NAME || 'Traveller', email: env.GUEST_EMAIL || 'alex.traveller@example.com' };
  // LiteAPI booking, the paid Trip Auditor and the receipt are each switched on by their own settings, so the worker still runs without them.
  const booker = env.ORIGIN_API_KEY ? createOriginBooker({ baseUrl: env.ORIGIN_API_URL || 'https://origin-api-production-d268.up.railway.app', apiKey: env.ORIGIN_API_KEY, guest }) : undefined;
  const review = paidEnabled('audit') ? createReviewer({ buy: buyService, readEvidence: readLedgerEvidence, log: message => console.log(message) }) : undefined;
  const worker = createTravelWorker({
    api: createHttpClient(env.SOKOSUMI_COWORKER_API_KEY), mps: config.mps, eve: createEveClient(), advisor: createAdvisor(env.ADVISOR_URL || 'https://expert-travel-advisor-eve.vercel.app'),
    booker, review, receipt: renderReceiptFor, guest, concurrency: Number(env.WORKER_CONCURRENCY || 4),
    store: await createStore(resolve(dataDir, 'travel')), source: config.source, coworkerId: config.coworkerId, dataDir,
  });
  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());
  while (!stop.signal.aborted) {
    try { const done = await worker.tick({ wait: false }); if (done.length) console.log(JSON.stringify({ status: done })); }
    catch (error) { console.error('travel worker tick failed:', String(error?.message ?? error).slice(0, 160)); }
    try { await delay(POLL_MS, undefined, { signal: stop.signal }); } catch { break; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error('Travel worker stopped:', String(error?.message ?? error).slice(0, 160)); process.exitCode = 1; });
}
