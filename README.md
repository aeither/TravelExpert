# TOKEN2049 Event Guide

Current checkpoint, 2026-10-06:
VERIFIED: local paid Coworker execution and seller net receipt of 1 test USDM are complete. Evidence: `docs/setup-state.json`.
VERIFIED: ongoing comment replies reuse the saved Task session. Evidence: `.local/comments-live-proof.json`.
VERIFIED: `.local/tests-prepush.log` records `tests 87`, `pass 87`, `fail 0`.
REPORTED: repeat full adversarial review found no remaining blocking source or credential issue.
The recommendation tool uses 14 curated events. The 595-row CSV remains a separate dataset.
Hosted availability, public discovery, and funded Standard API settlement remain unverified.
Earlier checkpoints below retain their historical context and corrections.


VERIFIED: The local tool returns event picks with sources, admission limits, and schedule conflicts.
Evidence: `node scripts/recommend.mjs examples/request.json`; records come from `data/events.json`.
The snapshot contains 14 records retrieved on `2026-10-05`. It cannot prove current availability.
VERIFIED: `.local/tests-latest.log` contains `tests 64`, `pass 64`, `fail 0`.
Payment tests use stubs. They do not prove a live seller receipt.

## Run locally

VERIFIED: `package.json` requires Node.js 24 or later and defines the commands below.
Install the locked packages through Socket Firewall.

```sh
sfw npm ci
npm run recommend -- examples/request.json
npm test
npm run dev
```

VERIFIED: `agent/agent.ts` configures `glm-5.3-flash` with default tools disabled.
Keep `ZAI_API_KEY` in private `.env.local`, with permissions `600`.
VERIFIED: The saved GLM turn in `.local/glm-seo-result.json` has `status: waiting` and a final message.
The configured provider endpoint is `https://api.z.ai/api/coding/paas/v4`.
See `agent/lib/models.mjs` for provider configuration. Secrets stay outside agent context and Git.

VERIFIED: `src/recommendations.mjs` requires `interests`.
Optional fields include `dates`, `availableFrom`, `availableUntil`, and `hasConferencePass`.
Use Singapore time. `maxCostSgd` caps each event's verified price. Unknown prices fail a hard budget.
A conference pass does not prove a zero event price.
`transferMinutes` is a planning buffer. It does not measure travel time.

## Completed Coworker rehearsal

VERIFIED: `.local/coworker.json` records Coworker `01a10c70-007d-717f-8b40-7c9fc2ddc564`, named `TOKEN2049 Event Guide`.
Its Vendor is `01a10c6f-d09d-764b-bf6d-b8df8c3046ee`; Personal Workspace access is `GRANTED`.
REPORTED: Coordinator confirms the Coworker runtime key import succeeded in a trusted terminal.
VERIFIED: `.local/execution-task-completed.json` records Task `01a10c7d-e7f8-739c-8c7e-61975074f88e` as `COMPLETED`.
Completion event: `01a10c7e-8c90-76ba-8de8-0f69ad6bf16e`.
Its worker journal records `executionOnly: true`. This rehearsal does not pay the seller.

VERIFIED: The saved result recommends these two talks for October 7, 2026, Singapore time:

1. The Base Case for Moving Money Onchain, `11:55` to `12:15`.
2. The Next Era of Stablecoin Payments, `12:50` to `13:05`.

Both cite the [official agenda](https://www.token2049.com/singapore/agenda).
Evidence: `.local/worker/01a10c7d-e7f8-739c-8c7e-61975074f88e.result.txt`.
The 35-minute gap exceeds the requested 30-minute planning buffer. Actual travel time remains unmeasured.

VERIFIED: `scripts/worker.mjs` journals Tasks before writes and saves exact UTF-8 results before completion.
Run only one executor for this Coworker. Inspect an uncertain Task before restarting.
For another execution-only rehearsal:

```sh
COWORKER_ID=01a10c70-007d-717f-8b40-7c9fc2ddc564 npm run worker -- --poll
```

## Use the Coworker in Sokosumi

VERIFIED: The saved connection grants Personal Workspace access: `workspaceAccess.status: GRANTED`.
Evidence: `.local/coworker.json` and `docs/setup-state.json:17`.
Switch to Personal Workspace to find `TOKEN2049 Event Guide` and create a Task.
The saved Coworker has `isShown: false` and `isWhitelisted: false`.
This record does not prove access from another Workspace or public discovery.
REPORTED: The coordinator has not connected this Coworker to the newly created organization Workspace.
The saved connection covers Personal Workspace only. Workspace membership does not establish a Coworker connection.

VERIFIED: `scripts/worker.mjs` starts new READY Tasks with their authoritative description and existing human comments.
Completed Tasks receive ongoing human-comment replies through `scripts/task-comments.mjs` in the same saved Eve session.
Correction: the earlier worker did not forward comments and required new Tasks for follow-ups. That limitation is superseded.

VERIFIED: `.local/user-task-completed.json` records Task `01a10c8f-46da-712f-ac11-e5fedb2775d3` as `COMPLETED`, with `totalCredits: 0`.
Its journal records `stage: completed` and `executionOnly: true`.
The execution-only poll command serves new READY Tasks while the local process runs.
VERIFIED: seller collection is confirmed in `.local/automated-seller-collection-proof.json`.
The worker provides local comment replies. Hosted availability remains separate work.

## Payment node and registration

VERIFIED: `.local/migrations.log:5` identifies PostgreSQL database `token2049_event_guide` at `127.0.0.1:5432`.
REPORTED: Earlier setup used MPS revision `99d94cf31cad168a74281494e79d5cc56f34838d`.
The setup record contains the same revision. It does not prove the current sibling checkout revision.
Keep the same database and encryption key. Do not reseed or replace wallets on resume.
Read `docs/setup-state.json` before starting services. Keep private wallet seed output out of chat and Git.

VERIFIED: `package.json` defines these node commands:

```sh
npm run payment:start
node scripts/payment-status.mjs
npm run agent:api
```

VERIFIED: `.local/payment-status.json`, checked at `2026-10-05T14:43:53.197Z`, records balance HTTP `200` for this seller:

```text
addr_test1qrdjlmxk80n3hx32dwu2cf298t05vp47t5ekrcdr7ca8ywct5efu6vn2wj78hqepnzj66heq56lyfkmvhjehx43psprqylpzyl
```

The snapshot contains `100000000` lovelace, equal to `100` test ADA.
It also contains `100000000` atomic units of test USDM, equal to `100` test USDM.
The token unit is `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d`.
This address snapshot does not prove registration confirmation or settlement readiness.

VERIFIED: The initial `.local/registration-response.json` returned HTTP `200` and `RegistrationRequested`.
VERIFIED: `.local/registration.json` now records `RegistrationConfirmed` for the same ID, `cmuvd1v950002awvb15smizwk`.
The returned source index is `0`. Dynamic pricing and Cardano Preprod V2 remain configured.
Registration transaction: `61682d223b1eff5eb0732b75e33486881c781b0e9c7c94cc421720ef73fac274`.
The saved independent check at `2026-10-05T14:51:40.339Z` records `3` confirmations.
The MPS status snapshot reports `CurrentTransaction.status: Confirmed` and `confirmations: 0`; these are distinct snapshots.
The full returned Masumi agent identifier is in `docs/setup-state.json`.
Registration confirmation does not prove seller payment.

VERIFIED: `scripts/agent-api.mjs` implements the required Standard endpoints on loopback port `3013`.
It rejects paid jobs until confirmed registration and model health are configured.
VERIFIED: A local availability request returned HTTP `200` and `{"status":"available","type":"masumi-agent"}` near `14:55` UTC.
This availability response does not prove paid execution or settlement.
VERIFIED: `scripts/paid-worker.mjs` requires confirmed source configuration and a scoped MPS runtime token.
When those checks pass, stop the execution-only executor before starting the paid executor:

```sh
npm run worker:paid -- --poll
```

Keep the scoped token in private `.local/mps-runtime.env`. Keep signed terms unchanged.
VERIFIED: The paid adapter saves payment stages and checks seller receipt independently.
Its stub tests do not prove that deployed Core accepts the payment and result hashes.

## Corrections and remaining checkpoints

The earlier README incorrectly left key import, funding, and execution on the pending checklist.
The saved completed Task now proves execution. Key import success is reported by the coordinator.
The earlier address HTTP `404` applied before the measured funding snapshot. It did not prove a zero balance.
The earlier Standard API and paid adapter checklist is superseded by the implemented source and stub tests.
The initial registration HTTP `200` proved request acceptance only. The same registration has since reached `RegistrationConfirmed`.
The earlier `agentIdentifier: null` claim described the initial response, not current registration state.
The earlier general model endpoint error was `Insufficient balance or no resource package. Please recharge.`
It described a different endpoint. The saved SEO-provider GLM turn now has a final result.
The earlier purchased-claim checkpoint is historical. Confirmed escrow, Task completion, and result submission now have separate evidence.

VERIFIED: Paid Task `01a10c8d-085c-767c-810c-e464c8f2a17b` is now `COMPLETED`, with `totalCredits: 100`.
Completion event: `01a10c92-b5ea-76ec-bfa5-6c2efd0f8a16`.
Evidence: `.local/paid-task-completed.json` and its worker journal, now at `collection-pending`.
VERIFIED: The saved result contains `2583` UTF-8 bytes and equals the completion event comment.
The computed compatibility result hash matches `b3ce2f88b138c260700b2f06939e62318a5840fe20baf4ac18553f67ab1b85c0`.

VERIFIED: The journal records `FundsLocked` before execution, with funding transaction `f0882896c4a8a3ea223c0ffd35ea58a3793a9e19e32cb858b9eb16a696cf5664`, `Confirmed`, and `1` confirmation.
The candidate contract output in `.local/escrow-candidate-utxos.json` contains `1000000` atomic units of test USDM.
Input hash, seller verification key, and nonce match hexadecimal substrings in its datum.
These substring checks do not decode the typed datum or verify every field.

VERIFIED: `.local/paid-mps-latest.json` records `ResultSubmitted` and the same result hash.
Its result submission transaction is `e03dd2f38aadc13b0bce51e9ca05e51ce59d4e4c1767cce9219b8acfdca1e91a`, `Confirmed`, with `1` confirmation.
`NextAction` is `WaitingForExternalAction`, with `errorType: null`.
VERIFIED: The Core receipt at `2026-10-05T15:00:36.559Z` records `ResultSubmitted`, `settled: false`, `txHash: null`, and `withdrawnForSeller: []`.
Task completion, 100 credits, and result submission do not prove seller collection.

VERIFIED: The signed unlock is October 5 at `23:28:26.741` Singapore time (`2026-10-05T15:28:26.741Z`).
The external dispute unlock is `23:44:26.741` Singapore time (`2026-10-05T15:44:26.741Z`).
V2 collection can require a delay after unlock. Keep the payment node running until collection confirms.
VERIFIED: `.local/receipt-restart-evidence.json` records unchanged Task, session, payment event, completion event, and result hash after restart.
The process check returned `33125 S node`; old PID `29304` was not listed.
This check verifies saved identifiers and process state, not every network call.

Pending: seller collection confirmation and independent measurement of the intended seller's net test USDM received.
REPORTED: Coordinator has not deployed a hosted service. This local setup depends on the participant's machine.

## Least confident decisions

1. INFERRED: A curated snapshot is sufficient for this demo. Check organizer pages for event changes and admission.
2. INFERRED: Greedy scheduling is sufficient for 14 records. It does not optimize a complete city itinerary.

## Confirmed seller collection

VERIFIED: `.local/automated-seller-collection-proof.json` records `settled: true` and `onChainState: Withdrawn`.
Collection transaction: `64a9b1a031d220fb48653171fe8989d722ad25c05c8c5e26287ca15e0fa08bed`.
The adapter matched the Core and MPS transaction IDs.
Independent Blockfrost verification records `sellerNetUnits: 1000000` and `confirmations: 39`.
This is `1` test USDM received by the configured seller on Cardano Preprod.
The check subtracts seller inputs from outputs and excludes collateral and reference inputs.
It proves this transaction, not future payments or hosted availability.

Correction: the earlier collection-pending checkpoint described the state before withdrawal.
The initial checker stopped because Core returned `withdrawnForSeller: []` with `settled: true`.
VERIFIED: the live Core OpenAPI permits an ordinary `Withdrawn` receipt without a dispute payout summary.
D8 fixed the client check. Disputed withdrawals still require a positive seller summary.
Independent seller amount verification remains required.
VERIFIED: `.local/tests-latest.log` records `tests 66`, `pass 66`, `fail 0`.
Both D8 regression tests failed before the source fix and passed afterward.

## Current verification after API restart

VERIFIED: `.local/tests-latest.log` now records `tests 68`, `pass 68`, `fail 0`.
Correction: earlier counts of 64 and 66 describe earlier runs. The log was replaced by this run.
VERIFIED: `.local/api-deadline-restart-proof.json` records API `available` and MPS `status: ok`.
The expired unpaid job is `deadline-expired`. Its signed response is unchanged. It has no model session.
REPORTED: fresh adversarial review found no remaining D9 issue and independently ran both regressions: `tests 2`, `pass 2`, `fail 0`.
Limit: this proves expiration before model execution. It does not prove a started model finishes before its deadline.
Seller collection is confirmed in the evidence above. Earlier pending statements describe prior checkpoints.
The services run locally. Hosted deployment and event Workspace approval remain separate work.

## Ongoing replies to Task comments

VERIFIED: the worker reads user-actor comments and reuses each Task's saved Eve session.
Source: `scripts/task-comments.mjs` and `scripts/worker.mjs`.
Existing comments are included when a new Task starts. Completed Tasks can receive follow-up replies.
For older Tasks, comments before their completion event remain part of the earlier execution checkpoint.
Each reply names its source comment. Coworker and Soko Bot comments do not trigger replies.
Comment journals live in `.local/comments`. Paid result files and payment journals remain separate.
Uncertain sends or posts require inspection. The worker does not automatically repeat an unknown write.
VERIFIED: `.local/tests-comments.log` records `tests 85`, `pass 85`, `fail 0`.
REPORTED: the final adversarial review found no remaining feature issue.
The existing worker start command enables comment polling. Keep one executor running per Coworker.

VERIFIED: the live follow-up test returned one Coworker reply, using the original Task session.
Evidence: `.local/comments-live-proof.json`, reply event `01a10cd5-4018-72cf-8ef9-56e8461f29f4`.
The Task remained `COMPLETED`. Paid journal, result, and seller proof hashes remained unchanged.
Subsequent passes reported `idle` in `.local/task-poll-comments.log`.
