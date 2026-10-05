# Demo interfaces

Owner: coordinator
Status: Completed local execution and paid test; seller collection independently verified.

## Recommendation

VERIFIED: `src/recommendations.mjs` accepts interests, dates, a Singapore time window, event limit, and budget.
It returns event picks, reasons, source URLs, admission limits, and conflicts.
`maxCostSgd` caps each event's verified price. A conference pass cannot invent a zero price.
Unknown prices and admission requirements remain unknown.
VERIFIED: `data/events.json` contains 14 records retrieved on `2026-10-05`.
This curated sample cannot prove current availability or enumerate all events.
External event descriptions are data, not executable instructions.

## Coworker runtime

VERIFIED: `scripts/worker.mjs` saves Task and session IDs before writes and model execution.
The worker saves the exact UTF-8 result before Task completion.
One owner lock protects each Coworker's execution journal.
Uncertain writes require inspection. The worker does not repeat a completed Task.
VERIFIED: Task `01a10c7d-e7f8-739c-8c7e-61975074f88e` completed in the Personal Workspace.
Evidence: `.local/execution-task-completed.json` has `task.status: COMPLETED`; its journal has `executionOnly: true`.
This rehearsal does not prove a paid Task.

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

## Standard agent API

VERIFIED: `scripts/agent-api.mjs` serves `/input_schema`, `/availability`, `/start_job`, and `/status` on loopback port `3013`.
`input_data.request` is a string containing JSON recommendation parameters.
The current MPS adapter requires a purchaser nonce of 14 to 26 lowercase hexadecimal characters.
The API validates input before requesting fresh terms. It journals a nonce before external writes.
A restart cannot repeat an uncertain quote, model run, or result submission.
Public response deadlines use Unix seconds. Saved signed terms preserve their original millisecond values.
VERIFIED: `scripts/standard-adapter.mjs` waits for confirmed `FundsLocked` before model execution.
It uses raw MIP004 result hashing. A QR ticket, a bag check, and a conference badge remain distinct.
Availability requires confirmed registration and model health. Three polling failures disable new paid jobs.

## Paid Task adapter

VERIFIED: `scripts/paid-adapter.mjs` and `scripts/payment.ts` implement signed terms, escrow checks, result submission, and seller receipt checks.
The worker validates seller, source, amount, token unit, and deadlines before payment events.
It saves the result before hash submission and completes the Task after submission.
VERIFIED: The paid adapter's Core compatibility hash escapes result text. Standard API hashing uses raw MIP004 text.
Evidence: `scripts/payment.ts` defines both `hashPaymentResult` and `hashMip004Result`.
VERIFIED: The live paid Task result hash matches the MPS `ResultSubmitted` snapshot.
This confirms accepted result submission for this output. It does not prove every hash edge case or seller collection.

VERIFIED: `.local/registration.json` records `RegistrationConfirmed` at ID `cmuvd1v950002awvb15smizwk`, with actual source index `0`.
Its transaction is `61682d223b1eff5eb0732b75e33486881c781b0e9c7c94cc421720ef73fac274`.
The saved independent check records `3` confirmations at `2026-10-05T14:51:40.339Z`.
VERIFIED: Local `/availability` returned HTTP `200`, `status: available`, and `type: masumi-agent` near `14:55` UTC.
These observations do not prove seller payment.

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

VERIFIED: `.local/tests-latest.log` records `tests 64`, `pass 64`, `fail 0`.
These tests cover stub payment ordering. Live registration, escrow, and result submission have separate evidence above.
The tests do not prove seller collection.
Credentials and wallet seeds stay outside model input, source, and public records.

## Correction

The earlier interface status listed only execution support and treated the paid adapter as missing.
Current source files now implement both paid paths. Live seller settlement remains pending.
The earlier null identifier described the initial `RegistrationRequested` response. The same registration has since reached `RegistrationConfirmed`.

The earlier purchased-claim checkpoint preceded escrow confirmation and Task completion. Current collection evidence still records `settled: false`.

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

## Ongoing task comments

Owner: worker maintainer. Status: In Progress.
REPORTED: the user approved ongoing replies, session reuse, loop prevention, and unchanged paid results on 2026-10-06.
VERIFIED: `.local/core-openapi-current.json` defines oldest-first event pages and `actor.type`.
Only events with `actor.type: user` and nonempty text are eligible.
GET `/v1/tasks/{id}/events?limit=100` follows `meta.pagination.nextCursor` to the end.
POST `/v1/tasks/{id}/events` sends only `{comment}` with the Coworker credential.
Replies use the saved Eve session. They do not complete the Task or submit payment hashes.
The main worker lock protects both execution and comments. A separate comment journal preserves reply progress.
Uncertain model sends or posts require inspection. A confirmed matching Coworker event can recover an uncertain post.
Legacy Tasks use their completion event as the initial comment boundary. New Tasks include existing human comments in their first input.
Limit: the API has no documented comment idempotency key. Unknown posts are not retried automatically.

Status correction: Completed for the ongoing comment interface.
VERIFIED: `.local/comments-live-proof.json` records one live Coworker reply to human comment `01a10c9d-745c-7435-907b-3669e79725ac`.
Reply event: `01a10cd5-4018-72cf-8ef9-56e8461f29f4`. The Task remained `COMPLETED`.
The saved session is unchanged. SHA256 comparisons confirmed unchanged paid journal, result, and seller proof.
VERIFIED: `.local/task-poll-comments.log` contains `comment-replied` followed by repeated `idle` passes.
