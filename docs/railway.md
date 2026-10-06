# Hosting on Railway, Masumi and Sokosumi

Updated 2026-10-07. No secrets in this file. Keys live in Railway variables.

## Where it runs

Railway project `origin-masumi-live` (`255138b6-6400-4391-84d2-c038bd8ca0ae`), environment `production`:

| Service | Role |
| --- | --- |
| `travel-expert` (this repo) | eve agent (loopback), public MIP-003 API, Sokosumi paid worker. Public URL https://travel-expert-production.up.railway.app. Volume at `/data`. |
| `origin-api` (ExpertTravelAgency repo) | Hotel search and checkout links. Called by the agent's `search_hotels` tool. |
| `mps` | Masumi Payment Service shared by both agents. |

`scripts/railway-start.mjs` is the container entry point. It starts `eve start` on 127.0.0.1:2000, the public API on `$PORT` and, once configured, the paid worker. A generated per-boot password protects the loopback eve routes (`agent/channels/eve.ts`). Journals live in `/data/worker`, `/data/comments`, `/data/agent-api` and survive redeploys.

## Variables (names only)

`OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (default `openrouter/free`), `ORIGIN_API_URL`, `MPS_URL`, `MPS_TOKEN`, `BLOCKFROST_API_KEY_PREPROD`, `DATA_DIR=/data`, `ALLOWED_HOSTS` (public hostname), `MASUMI_AGENT_IDENTIFIER`, `MASUMI_SMART_CONTRACT_ADDRESS`, `MASUMI_SELLER_VKEY`, `MASUMI_SELLER_ADDRESS`, `MASUMI_SOURCE_INDEX`, `SOKOSUMI_COWORKER_ID`, `SOKOSUMI_COWORKER_API_KEY`. The OpenRouter key, MPS token and Blockfrost key are Railway references to `origin-api` and `mps`, so they are not duplicated.

Until `MASUMI_AGENT_IDENTIFIER` and the Coworker key are set the service answers `/availability` as `unavailable` and does not start the worker.

## Masumi registration

Registered on the Railway `mps` node (Preprod, type Standard, Dynamic pricing) with the same selling wallet as Expert Travel Agency. Registration id `cmux3jqnk006m20o7t12hva4m`, agent **Travel Expert**, `RegistrationConfirmed`. `apiBaseUrl` is the public URL above. Its agent identifier is the `MASUMI_AGENT_IDENTIFIER` variable. Updating the registration burns and mints its NFT, which changes the identifier: set the new value and redeploy.

## Sokosumi

Coworker **Travel Expert**, id `01a112c7-de40-761e-80ae-113072c5c70f`, Vendor Bebop (`01a11100-22ad-74ca-8076-05a63cbabe04`), Personal Workspace access GRANTED. The runtime key was created with `sokosumi coworkers api-key` and stored only in Railway. Tasks in an organization Workspace need an approved event or workspace connection first (`sokosumi coworkers connect`); the worker currently serves personal-workspace tasks only (`validateTask`).

Each task is charged 1 test USDM: quote, `masumiPayment` event, escrow confirmed, agent runs, result hash submitted, task completed. The payout is collected by the payment node after the unlock time. The worker does not wait for it: `settleDue()` checks completed tasks on every poll and verifies the seller receipt on-chain. A task whose collection window closes without a receipt is flagged `inspectionRequired`.

## Verified 2026-10-07 (Cardano Preprod)

- Task `01a112ca-0549-736e-ba19-1826b3232a5b` ("Plan 3 days in Cebu from 20 November for 2 people") reached COMPLETED through the hosted worker. The agent called the Expert Travel Agency API and returned a hotel plan. Escrow reached FundsLocked and the result hash was submitted on the node.
- Seller collection and on-chain receipt for that task were still pending at the time of writing.
- 87 automated tests pass (`npm test`).

## Operate

```sh
railway up --service travel-expert --detach        # deploy
railway logs --service travel-expert --lines 100
sokosumi --preprod tasks create --personal --coworker-id 01a112c7-de40-761e-80ae-113072c5c70f --description "Plan 2 days in Manila from 5 December" --status READY --json
```

A task with saved progress that did not finish stops the worker on purpose (`Inspect saved Task`). Inspect the Task and its journal in `/data/worker` before removing anything.
