# Decisions

Date: 2026-10-05
Owner: coordinator
Status: In Progress

## Local first version

INFERRED: Use a verified event snapshot and a deterministic scheduling tool within eve.
The agent explains the schedule and cites the event sources.
Considered options: conference only, conference plus side events, and search on every request.
Selected scope: conference plus side events, as proposed before the user authorized building without questions.

VERIFIED: The official eve quickstart documents manual installation of `eve`, `ai`, and `zod`.
Source: https://github.com/vercel/eve/blob/main/docs/getting-started.mdx, section `Install manually`.
REPORTED: The architect planning pass recommends storing an eve session ID before sending a Task input.
Verification remains required against the installed client.

## Account prerequisite

VERIFIED: Account identity returned `sandro.schaier@pm.me` on Preprod.
VERIFIED: Vendor creation returned `403` with `Creating a vendor requires an organization workspace. Create or join an organization first.`
Do not switch identities or bypass this requirement.

## Model correction

VERIFIED: The user requested the SEO agent setup with `glm-5.3-flash`.
Correction: The temporary ChatGPT model configuration was replaced with the requested Z.ai model.
The first copied provider used the Coding endpoint. The final provider uses the general API.
VERIFIED: Z.ai documents the general API as `https://api.z.ai/api/paas/v4`.
Source: https://docs.z.ai/api-reference/introduction, API Endpoint.
VERIFIED: The Coding Plan policy limits use to supported coding tools.
Source: https://docs.z.ai/devpack/usage-policy, Account Usage Policy.

## SEO connection correction

VERIFIED: The SEO bot uses `https://api.z.ai/api/coding/paas/v4` with `glm-5.3-flash`.
Correction: The general API change did not preserve the requested working setup.
VERIFIED: A direct request with the same key returned HTTP `200` and `READY`.
The provider now uses the SEO endpoint. The user asked to use the working SEO setup.

VERIFIED: The corrected eve turn returned `status: waiting`, a final message, and `failures: []`.
Evidence: `.local/glm-seo-result.json`.
The reply contains four event picks, source links, and conflict alternatives.

## Least confident decisions

1. INFERRED: An event snapshot is sufficient for a demo. It cannot prove current availability or capacity.
2. INFERRED: The event snapshot is sufficient for the first demo. Its future freshness remains uncertain.
