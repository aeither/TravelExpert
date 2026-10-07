# Travel Expert

An [eve](https://www.npmjs.com/package/eve) agent that is the front door to the Expert Travel Agency. A traveller sends a plain-language request ("Plan 3 days in Cebu from 20 November for 2 people"). The agent searches live hotel rates through the Expert Travel Agency API and answers with a short plan. It is paid per task with test USDM on Cardano Preprod through Masumi, and it is a Sokosumi Coworker.

Built from [`masumi-network/demo-agent-token2049`](https://github.com/masumi-network/demo-agent-token2049) (branch `feat/token2049-event-guide`). The event data and tool were replaced; the paid Coworker worker, Masumi payment code and MIP-003 API are kept and adapted to run hosted.

```mermaid
flowchart LR
  subgraph Sokosumi["Sokosumi (Cardano Preprod)"]
    U["Traveller<br/>task, comments, chat"]
  end
  subgraph Railway["Railway project origin-masumi-live"]
    TE["travel-expert (orchestrator)<br/>eve agent + worker + MIP-003 API + chat /v1/responses"]
    OA["origin-api = ExpertTravelAgency<br/>hotel search, knowledge desk /v1/knowledge"]
    MPS["mps<br/>Masumi payment node"]
  end
  ADV["Expert Travel Advisor<br/>/hotels/search, /hotels/book"]
  CHAIN[("Cardano Preprod<br/>escrow, result hash, payout")]
  LLM["OpenRouter model"]

  U -- "task, reply 'book', chat" --> TE
  TE -- "progress, plan, checkout link, tx links" --> U
  TE -- "search_hotels, destination_info" --> OA
  OA -- "hotel search" --> ADV
  TE -- "opens checkout (POST /hotels/book)" --> ADV
  TE -- "quote, escrow check, result hash" --> MPS
  MPS <--> CHAIN
  TE -- "reasoning" --> LLM
  OA -- "knowledge answers" --> LLM
```

Request lifecycle of one task:

```mermaid
sequenceDiagram
  participant T as Traveller (Sokosumi)
  participant O as Travel Expert (orchestrator)
  participant K as Expert Travel Agency (origin-api)
  participant A as Expert Travel Advisor
  participant M as Masumi mps + Cardano
  T->>O: task "Plan 3 days in Cebu from 20 November"
  O-->>T: Running, then a progress comment per step
  O->>K: destination_info (knowledge desk)
  O->>K: search_hotels
  K->>A: /hotels/search
  O-->>T: plan, status Input required: reply "book" or "no"
  T->>O: comment "book"
  O-->>T: Running, "opening the checkout, nothing charged yet"
  O->>A: /hotels/book (top pick, then fallbacks)
  O->>M: quote, then "Payment requested: X test USDM" (escrow)
  M-->>O: FundsLocked, ResultSubmitted (confirmed on-chain)
  O-->>T: Completed: checkout link and cexplorer links
  M-->>O: payout collected
  O-->>T: comment with the payout transaction link
  T->>O: later comment (follow-up)
  O-->>T: Running, then Completed with the answer
```

What is not connected yet: the orchestrator calls the knowledge desk with the internal API key, not with a paid Masumi escrow (that needs a funded purchasing wallet on `mps`), and the advisor at `expert-travel-advisor-eve.vercel.app` (now the worker's default `ADVISOR_URL`) serves MIP-003 routes but completes jobs without payment terms, so it cannot be bought from with Masumi yet.

| Piece | Where |
| --- | --- |
| Agent, tools, instructions | `agent/` (`search_hotels` calls `ORIGIN_API_URL/v1/stays/search`) |
| Sokosumi paid worker | `scripts/worker.mjs`, `scripts/paid-worker.mjs`, `scripts/sokosumi-http.mjs` |
| Masumi payment flow | `scripts/payment.ts`, `scripts/paid-adapter.mjs`, `scripts/chain.ts` |
| MIP-003 API | `scripts/agent-api.mjs` |
| Hotel search and booking Coworker (Expert Travel Advisor) | [armsves/expert-travel-advisor-origins](https://github.com/armsves/expert-travel-advisor-origins) |
| Hosting | `Dockerfile`, `scripts/railway-start.mjs`, [docs/railway.md](docs/railway.md) |

Run the tests with `npm test` (Node 24 or later). Deployment, registration and the Sokosumi Coworker are described in [docs/railway.md](docs/railway.md). Files from the original event guide that are not listed here (`status.md`, `docs/bugs.md`, `docs/decisions.md`, `docs/interfaces.md`, `docs/payment-hashing.md`, `docs/setup-state.json`) describe the template's local setup and are kept for reference only.

Limits: hotel data and checkout links come from the Expert Travel Agency API, which uses sandbox or pay-at-property inventory. The agent cannot book; it hands over the hotel page. Payments are Cardano Preprod test USDM only.
