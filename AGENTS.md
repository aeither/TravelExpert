# Travel Expert

An eve agent hosted on Railway, paid through Masumi and exposed as a Sokosumi Coworker. Read [README.md](README.md) and [docs/railway.md](docs/railway.md) first.

- Node 24 or later. `npm ci`, then `npm test`. `npx eve build` must pass before a deploy.
- Never put credentials in Git, chat or model-visible output. Keys live in Railway variables and private `.env.local`.
- Money and payment steps are code, never model decisions. The agent only has the `search_hotels` tool.
- Do not blindly retry a paid task. Inspect its journal and the payment first.
- Deploy: `railway up --service travel-expert --detach`, then check `railway deployment list` for SUCCESS and `/availability`.
