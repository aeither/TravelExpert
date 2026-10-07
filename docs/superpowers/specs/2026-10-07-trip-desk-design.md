# Trip Desk: design for the next Travel Expert iteration

Date: 2026-10-07. Goal: win the Masumi agent-to-agent flow track at TOKEN2049 Origins with a flow that is deeper than a single paid hop.

## Judging criteria this design targets

From the submission checklist: (1) quality of results, (2) a useful agent with visible decisions and human steps, (3) reliable execution with no duplicate work or double charge, (4) verified payment: receipts and collection transactions on Cardano Preprod.

## What the live roast found (task `01a116a3-2eb6-71af-97b2-439c9649ce52`, 2026-10-07)

| # | Finding | Evidence | Criterion |
|---|---|---|---|
| F1 | "book" ends in a failed checkout, so escrow, result hash and payout never run on real requests. | Two runs: "The selected stay has no offer to open". | 3, 4 |
| F2 | Root cause of F1. The advisor `POST /hotels/book` answers HTTP 200 with `checkout_error: "The selected stay has no offer to open"` and a pre-filled Hotels.com page in `stays[0].url`. `scripts/advisor.mjs` reads `payload.checkout`, which is absent, so it reports "no checkout was available". The search side is fine: `origin-api` search reports `provider: "advisor"` and ids are Expedia property ids, so there is no id mismatch (an earlier hypothesis, disproved by probing). | curl probes against `expert-travel-advisor-eve.vercel.app` | 3, 4 |
| F3 | Kids are ignored: `searchInput` has `adults` only (max 4), and the plan does not say so. | Request: 2 adults + 2 kids. | 1 |
| F4 | Budget cap, "quiet" and "near the beach" are not enforced by code and not sourced. The plan asserts them. | Plan text. | 1 |
| F5 | The rainy-day and weather question went unanswered. `destination_info.question` is optional and the model skipped it. The instructions also say "no weather advice" while the plan gave weather. | Plan text. | 1 |
| F6 | Named places look invented or misnamed ("Siargao Museum (General Lubao)", "Socorro Island mini-zoo"). | Plan text. | 1 |
| F7 | The 1 test USDM paid for the search never appears in the task: no tx link, no receipt. | Task activity. | 4 |
| F8 | A failed booking is posted as Completed. | Task status. | 3 |
| F9 | One poll lock serialises everything: a 3-minute paid search blocks all tasks. Tasks from Oct 6 still show Running. | `tick()` in `scripts/travel-worker.mjs`. | 3 |
| F10 | The knowledge desk is called with a shared bearer key, not a Masumi purchase. | `agent/lib/knowledge.ts`. | 4 |

Not verified: why the advisor cannot open an offer. `_single_offer` in the advisor repo (`agent/hotels_api.py:319-411`) returns an empty `singleUnitOffer`. The advisor is deployed from another account, and the Vercel build may differ from the repo source (the response shape differs), so we cannot fix it ourselves.

## Intended outcome

A traveller writes one request. Travel Expert hires several specialist agents through Masumi escrow, in parallel where possible, audits their output with a separate agent, stays inside a spend cap the traveller approved, and returns one plan with one receipt that proves every payment. Booking degrades honestly when the supplier cannot open a checkout.

## Design

### 1. Base fixes (P0)

- **Advisor contract (F1, F2).** `advisor.mjs` accepts both shapes: `payload.checkout` (old) and top-level `checkout_error` plus `stays[0].url` (deployed). When the advisor returns a pre-filled page but no offer, the worker hands over that **deep link**, states plainly that the page is pre-filled (dates, room, rate plan, pay later) and that no reservation exists, and runs the paid handover only if the traveller accepts it. If neither a checkout nor a link exists, the task ends **Failed** (not Completed) with the other options (F8).
- **Occupancy (F3).** `search_hotels` and `save_plan` take `children_ages`. Code derives rooms from party size. If the supplier cannot price children, the plan says so.
- **Constraints in code (F4).** A pure function filters and ranks hotels by nightly cap, free cancellation and rating. The model may only pick from the filtered list. "Quiet" and "near the beach" are labelled "not verified" unless a tool returned them.
- **Weather and questions (F5).** The traveller's questions are extracted by the worker and passed verbatim to `destination_info`. The instruction contradiction is removed.
- **Concurrency (F9).** The per-coworker lock only guards polling. Each task runs in its own async slot (configurable limit, default 4), with a per-task lock in the journal. Stale Running tasks are listed for inspection, never retried blindly (repo rule).

### 2. Paid specialist hops

| Hop | Seller | Status |
|---|---|---|
| Hotel search | `origin-api` | Paid today. |
| Flights | `origin-api` `/v1/flights/search` (takes `slices`, `passengers`) | Route exists, reached through MIP-003 `trip_request_json`. Needs a probe to confirm it works paid. |
| Knowledge desk (F10) | `origin-api` `/v1/knowledge` | Reached only by bearer key. Paying for it needs a MIP-003 route on `origin-api`, whose source is not in this repo. Fallback: keep the bearer key and say so in the receipt. |
| Trip Auditor | New MIP-003 agent from this repo, registered on Masumi | New. See below. |

Hops that do not depend on each other run in parallel (hotel search, flights, knowledge). Payment code is the existing `a2a-buyer.mjs`, journaled and idempotent.

### 3. Trip Auditor (agents checking agents)

A second registered Masumi seller, deployed as its own Railway service from this repo. Input: the draft plan plus the raw tool outputs. Output: a signed verdict listing each claim (hotel, price, place, constraint) as supported, unsupported or unverifiable. Unsupported claims are removed or rewritten by the orchestrator. If the auditor misses its deadline or fails, the orchestrator requests a refund for that hop (the existing `request-refund` path). This directly answers F6.

### 4. Budget governor (code, not model)

Before spending, the worker posts a quote (hop list with prices, total, cap) and sets the task to Input required. The traveller replies "approve". The governor then refuses any purchase that would exceed the cap. The model never sees keys or amounts it can change.

### 5. One receipt (F7)

The final answer ends with a receipt: for each hop the seller, price, escrow tx, result-submit tx and, when settled, the collection tx, all as explorer links. Pending collection is shown as pending, never as received (existing rule in `docs/agent-to-agent.md`).

## Data flow

traveller task -> worker parses request and constraints -> quote and cap approval (Input required) -> parallel paid hops (search, flights, knowledge) -> filter and rank in code -> draft plan -> paid audit -> corrected plan + receipt + offer to book -> "book" -> advisor checkout or deep link -> fee escrow -> hash -> handover -> payout proof comment.

## Error handling

- Every external write is journaled before and after. An unknown outcome sets `inspectionRequired`.
- A paid hop failure returns an error for that hop only. The plan states what is missing. No silent fallback to a free endpoint.
- Escrow, deadline and refund behaviour follow the existing worker.

## Testing and verification

- Unit tests for each new pure function (constraint filter, occupancy, advisor shape adapter, governor, receipt renderer), written test-first.
- `npm test` and `npx eve build` must pass before deploy.
- Live check on preprod: the Siargao family request end to end, then a deliberate failure case (auditor timeout, refund). Evidence is recorded with tx hashes in `docs/agent-to-agent.md`.

## Risks and open items

1. The advisor cannot open offers and is outside this account. Mitigation: deep-link handover. Ask the partner who owns it to check `_single_offer` against the live Hotels.com response.
2. The knowledge desk may not be payable without an `origin-api` change. Mitigation: label it unpaid in the receipt.
3. Registering and funding a second Masumi agent (the Auditor) takes time. Mitigation: build in this order: P0 fixes, receipt, governor, auditor, flights. Each stage is demo-able on its own.
4. Each paid hop costs test USDM and about 2.5 minutes. Parallel hops keep total time near 3 minutes.
