# Status

Current checkpoint, 2026-10-06:
VERIFIED: local paid Coworker execution and seller net receipt of 1 test USDM are complete. Evidence: `docs/setup-state.json`.
VERIFIED: ongoing comment replies reuse the saved Task session. Evidence: `.local/comments-live-proof.json`.
VERIFIED: `.local/tests-prepush.log` records `tests 87`, `pass 87`, `fail 0`.
REPORTED: repeat full adversarial review found no remaining blocking source or credential issue.
The recommendation tool uses 14 curated events. The 595-row CSV remains a separate dataset.
Hosted availability, public discovery, and funded Standard API settlement remain unverified.
Earlier checkpoints below retain their historical context and corrections.


Last updated: 2026-10-05
Owner: coordinator
Phase: Completed local paid test; seller collection independently verified

## Verified checkpoints

VERIFIED: `git rev-parse --abbrev-ref HEAD` returned `feat/token2049-event-guide`.
VERIFIED: `.local/tests-latest.log` contains `tests 64`, `pass 64`, `fail 0`.
Stub payment tests do not prove a live seller receipt.
VERIFIED: `.local/coworker.json` records Personal Workspace access `GRANTED`.
VERIFIED: `.local/execution-task-completed.json` records Task `01a10c7d-e7f8-739c-8c7e-61975074f88e` as `COMPLETED`.
Its completion event is `01a10c7e-8c90-76ba-8de8-0f69ad6bf16e`.
VERIFIED: The worker journal records `stage: completed` and `executionOnly: true`.
This proves execution rehearsal, not seller payment.

VERIFIED: `.local/payment-status.json` at `2026-10-05T14:43:53.197Z` records balance HTTP `200`.
It measures `100000000` lovelace and `100000000` test USDM atomic units for the dedicated seller.
VERIFIED: `.local/registration.json` now records `RegistrationConfirmed`, source index `0`, and ID `cmuvd1v950002awvb15smizwk`.
Its registration transaction is `61682d223b1eff5eb0732b75e33486881c781b0e9c7c94cc421720ef73fac274`.
The saved independent check at `2026-10-05T14:51:40.339Z` records `3` confirmations.
The MPS status snapshot records `CurrentTransaction.status: Confirmed`, with its own counter at `0`.
VERIFIED: Local `/availability` returned HTTP `200` and `{"status":"available","type":"masumi-agent"}` near `14:55` UTC.
Registration and availability do not prove seller collection.

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

VERIFIED: The paid adapter and Standard API exist in `scripts/paid-adapter.mjs` and `scripts/agent-api.mjs`.
The API rejects new paid jobs before confirmed registration and model health.

## Corrections

The earlier key import, funding, and execution checklist was stale.
REPORTED: Coordinator confirms runtime key import succeeded in the trusted terminal.
VERIFIED: The completed Task proves the worker used the Coworker credential successfully.
The earlier HTTP `404` balance described the address before the measured funding snapshot.
The earlier claim that the paid adapter and Standard API were incomplete was also stale.
Their source now exists and tests cover stub payment ordering. Live settlement remains pending.
The earlier `tests 26` record is superseded by `.local/tests-latest.log`: `tests 64`, `pass 64`, `fail 0`.

## Next checkpoint

The earlier `RegistrationRequested` and null identifier checkpoint described the initial request.
Current saved registration evidence confirms the same ID. The source and transaction were not replaced.

The earlier HTTP `422` and null receipt described the failed attempt. Recovery saved the payment event on the same Task.
The earlier purchased-claim checkpoint preceded confirmed escrow and the completed Task.
Preserve paid Task `01a10c8d-085c-767c-810c-e464c8f2a17b` and its existing signed terms.
Wait for seller collection and verify the intended seller's net test USDM receipt independently.
Read `docs/setup-state.json` before resuming. Keep private journals and credentials out of Git.

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

## Task comments, 2026-10-06

Status: In Progress. Owner: worker maintainer.
VERIFIED: ongoing comment handling is implemented in `scripts/task-comments.mjs` and both worker entry points.
VERIFIED: `.local/tests-comments.log` records `tests 85`, `pass 85`, `fail 0`.
REPORTED: fresh feature and integration reviews found no remaining issue.
VERIFIED: live Coworker reads returned both saved Tasks as `COMPLETED` in the Personal Workspace.
The user Task has one follow-up after completion: `01a10c9d-745c-7435-907b-3669e79725ac`.
VERIFIED: old executor PID 38368 stopped before the comment-enabled executor started.
Live reply confirmation is pending. Evidence will be saved in `.local/comments-live-proof.json`.

Status correction: Completed for ongoing Task comments.
VERIFIED: `.local/comments-live-proof.json` records `replyCount: 1`, `actorType: coworker`, and `paidFilesUnchanged: true`.
Task: `01a10c8f-46da-712f-ac11-e5fedb2775d3`. Reply: `01a10cd5-4018-72cf-8ef9-56e8461f29f4`.
Session: `wrun_01M469K2JMMRWDPKEYVN8DV5XX`, matching the original execution journal.
The earlier live-reply-pending checkpoint is superseded by this evidence.
VERIFIED: subsequent poll passes report `idle`, with no reply loop.
Changes remain local on `feat/token2049-event-guide`.
