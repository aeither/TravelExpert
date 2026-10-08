// The Trip Auditor review: the orchestrator hires a second agent (paid through Masumi) to check the draft plan against the
// evidence the tools returned. Code runs this step, not the model. One revision at most, and a failed audit never blocks the plan.
import { insertBeforeOffer } from './booking-copy.mjs';

export const constraintsOf = plan => ({
  nights: plan.request.nights, adults: plan.request.adults,
  ...(plan.request.children_ages?.length ? { children_ages: plan.request.children_ages } : {}),
  ...(plan.request.budget_per_night ? { budget_per_night: plan.request.budget_per_night } : {}),
  currency: plan.hotel?.total?.currency ?? 'USD',
});

const hasEvidence = e => !!(e?.hotels?.length || e?.flights?.length || e?.knowledge?.length);
const line = text => `_${text}_`;

export function createReviewer({ buy, readEvidence, log = () => {} }) {
  return async function review({ taskId, plan, answer, say = async () => {}, revise }) {
    const evidence = await readEvidence(taskId);
    if (!hasEvidence(evidence)) return insertBeforeOffer(answer, [line('Not audited: there were no source results to check the plan against.')]);
    await say('Orchestrator → Trip Auditor (another agent): checking every hotel, price and place against my sources. Paying 0.5 test USDM through Masumi, so this waits for on-chain confirmation…');
    let verdict = null;
    try {
      const { result } = await buy({ taskRef: taskId, service: 'audit', inputData: { audit_request_json: JSON.stringify({ plan_text: answer, constraints: constraintsOf(plan), evidence }) } });
      verdict = result ? JSON.parse(result) : null;
    } catch (error) { log(`audit failed: ${String(error?.message ?? error).slice(0, 120)}`); }
    if (!verdict || !['pass', 'revise'].includes(verdict.verdict)) return insertBeforeOffer(answer, [line('Not audited: the Trip Auditor did not answer in time. The plan below is unchecked.')]);
    const checked = Array.isArray(verdict.claims) ? verdict.claims.length : 0;
    if (verdict.verdict === 'pass' || !verdict.rewrite_hints?.length) return insertBeforeOffer(answer, [line(`Audit by the Trip Auditor: passed (${verdict.summary ?? `${checked} claims checked`}).`)]);
    await say(`The Trip Auditor found claims I cannot support (${verdict.summary ?? 'see audit'}). Rewriting those parts…`);
    let revised = null;
    try {
      revised = await revise(['Mode: revise', `Task reference: ${taskId}`, 'Draft plan:', answer, '', 'Audit findings. Remove or correct exactly these, add nothing new:', ...verdict.rewrite_hints.slice(0, 10).map(h => `- ${h}`)].join('\n'));
    } catch (error) { log(`revision failed: ${String(error?.message ?? error).slice(0, 120)}`); }
    // A revision must still end with the booking question, otherwise the task could not continue.
    // ...and must keep the saved top pick, otherwise "book" would act on a hotel the plan no longer shows.
    if (typeof revised === 'string' && /Would you like me to/.test(revised) && (!plan.hotel?.name || revised.includes(plan.hotel.name))) return insertBeforeOffer(revised.trim(), [line(`Audit by the Trip Auditor: revised (${verdict.summary ?? 'unsupported claims removed'}).`)]);
    return insertBeforeOffer(answer, [line(`Audit by the Trip Auditor: ${verdict.summary ?? 'some claims could not be verified'}. The corrections could not be applied, so treat the unverified parts with care.`)]);
  };
}
