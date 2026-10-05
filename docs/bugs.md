# Bug evidence

Owner: coordinator
Date: 2026-10-05

## D1: Equal relevance consumes the whole day

VERIFIED: `npm test` returned `tests 18`, `pass 17`, `fail 1`.
Failure: `assert.ok(result.itinerary.some(event => event.kind === 'conference'))`.
VERIFIED: The example itinerary selected Circle House from `09:30` to `17:00`.
Cause: equal relevance used start time before event duration in `src/recommendations.mjs`.
INFERRED invariant D1: For equal relevance, prefer a shorter session over an all-day event.
Regression test: `D1: equal topic relevance prefers shorter sessions over a full-day event`.
No SPEC.md exists. The user forbids creating SPEC.md without a request.

## D2 and D3: schedule constraints

VERIFIED: Before the fix, `node --test tests/recommendations.test.mjs` returned `tests 9`, `pass 7`, `fail 2`.
D2 preserves the start-time upper bound when the end time is unknown.
D3 excludes a known conference pass requirement when the attendee has no pass.
The source previously checked only lower start bounds and event prices.

## D4: A pass invents a free session

VERIFIED: The added regression test returned `tests 10`, `pass 9`, `fail 1` before the fix.
The source replaced all conference prices with zero when the attendee had a pass.
D4 requires verified prices for a hard budget. A pass does not prove session inclusion.

## D5: Endpoint differs from the working SEO bot

VERIFIED: The SEO bot config uses `https://api.z.ai/api/coding/paas/v4`.
Evidence: `/Users/sandro/GitHub/seo-bot/agent/lib/models.ts`, provider `baseURL`.
VERIFIED: A direct request returned `{"status":200,"model":"glm-5.3-flash","reply":"READY","finishReason":"stop"}`.
Correction: The general API credit error did not prove that the existing key could not run GLM.
The earlier test used a different endpoint from the working SEO setup.
VERIFIED: Before the fix, the provider regression returned `tests 2`, `pass 1`, `fail 1`.
D5 checks the actual request URL and model against the requested SEO setup.

## D6: Unsupported Task list option

VERIFIED: The live CLI returned `--personal supports coworkers register/connect, tasks create, workspaces list, and runtime start/complete/run`.
The worker had supplied `--personal` on `tasks list`. That route uses the OAuth personal context by default.
The supported Task list command omits that option. Runtime start and complete still use it.

## D7: Payment client acts for the user

VERIFIED: Core returned HTTP `422`: `Only the assigned coworker can set masumiPayment on task events`.
Evidence: `.local/paid-event-error.json`, Task `01a10c8d-085c-767c-810c-e464c8f2a17b`.
The runtime client supplied `contextUserId`. Core treats this header as acting for that user.
Evidence: `/Users/sandro/GitHub/sokosumi/apps/core/src/middleware/auth.ts:213` and `scripts/core-runtime.mjs` before the fix.
D7 requires payment requests to use the assigned Coworker actor without user context headers.
REPORTED: The review agent ran the regression before the fix: `tests 1`, `pass 0`, `fail 1`.
VERIFIED: After the fix, `.local/tests-latest.log` reports `tests 64`, `pass 64`, `fail 0`.
VERIFIED: The same signed terms produced payment event `01a10c8f-bd26-726f-931f-966457840191` after the fix.
Evidence: `.local/worker/01a10c8d-085c-767c-810c-e464c8f2a17b.json`, `paymentEventId`.
Core receipt reports `claimStatus: PURCHASED` and `settled: false`. This proves acceptance, not seller collection.

## D8: Ordinary withdrawal rejected as missing payout summary

VERIFIED: `.local/paid-receipt-latest.json` records `onChainState: Withdrawn`, `settled: true`, and `withdrawnForSeller: []`.
The client threw `Receipt does not prove a settled test USDM seller payout`.
The live Core OpenAPI at `/v1/openapi.json` describes ordinary withdrawals separately from disputed seller payouts.
Root cause: the client required a dispute payout summary for every withdrawal.
Invariant D8: an ordinary withdrawal can omit that summary, but settlement still requires independent seller verification.
VERIFIED: the D8 regressions returned `tests 2`, `pass 0`, `fail 2` before the fix.
After the fix, they returned `tests 2`, `pass 2`, `fail 0`.
The adapter regression rejects failed independent seller amount verification.
VERIFIED: the live adapter then recorded `sellerNetUnits: 1000000` and `confirmations: 39` for the same payment.
Evidence: `.local/automated-seller-collection-proof.json`. No new payment was submitted.

## D9: Expired unpaid job stopped the Standard API

VERIFIED: the saved quote had expired and the previous API process had exited.
Evidence: `.local/standard-api-contract-test.json` and `.local/api-deadline-restart-proof.json`.
Root cause: repeated deadline errors escaped the job transition and stopped the poll loop.
Invariant D9: an expired waiting job becomes failed before any model call. Preserve its signed terms and nonce.
Check the deadline again after availability and funding reads. Either read can cross the deadline.
VERIFIED: each new regression failed before its source fix: `tests 1`, `pass 0`, `fail 1`.
VERIFIED: both regressions then returned `tests 2`, `pass 2`, `fail 0`.
VERIFIED: the complete suite returned `tests 68`, `pass 68`, `fail 0`.
REPORTED: fresh adversarial review found no remaining issue in these changes.
VERIFIED: the restarted API reports `available`. The same expired job is failed, with unchanged signed response and no model session.
No new quote, payment, or model call was created during this restart check.

## D10 to D12: Comment polling review findings

VERIFIED: `.local/comments-review-red.log` records `tests 3`, `pass 0`, `fail 3` before these fixes.
D10: early returns let a busy Task prevent replies on later Tasks. Visit every saved Task once per pass.
D11: one failed Task read escaped the poll loop. Keep read failures within that Task and continue other Tasks.
D12: missing `nextCursor` looked like complete history. Require a string or null before accepting a page.
VERIFIED: `.local/tests-comments.log` records `tests 85`, `pass 85`, `fail 0` after the fixes.
REPORTED: fresh adversarial review found no remaining comment or worker integration issue.
Limit: fixtures prove these paths. They do not prove live comment authorization.

## D13: Paid model execution after the result deadline

VERIFIED: `.local/d13-red.log` records `tests 2`, `pass 0`, `fail 2` before the fix.
A funding read or session creation could cross the deadline and still permit a model send.
Invariant D13: check the result deadline after funding reads and immediately before the paid model send.
A missing or invalid saved paid deadline must also stop execution.
VERIFIED: `.local/d13-green.log` records `tests 2`, `pass 2`, `fail 0` after the fix.
