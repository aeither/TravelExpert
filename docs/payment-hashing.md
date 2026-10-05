# Payment result hashing

VERIFIED: The official [MIP-004 specification](https://github.com/masumi-network/masumi-improvement-proposals/blob/main/MIPs/MIP-004/MIP-004.md), inspected on 2026-10-05, states: `string_to_hash = identifier_from_purchaser + ";" + output`. Output is raw UTF-8 text.

VERIFIED: Local `/Users/sandro/GitHub/sokosumi/packages/masumi/src/hash/hash.ts:76` instead contains:

```ts
const escaped = JSON.stringify(result).slice(1, -1);
return createHash(`${identifierFromPurchaser};${escaped}`);
```

VERIFIED: Local `/Users/sandro/GitHub/sokosumi/packages/masumi/src/hash/verification.ts:66` compares only this escaped result hash. This source inspection does not prove the deployed Core implementation.

VERIFIED: MPS `/Users/sandro/GitHub/masumi-payment-service/src/routes/api/payments/submit-result/index.ts:16` accepts `submitResultHash`, a 64-character hexadecimal digest. It receives no output text. It cannot choose between these pre-images.

VERIFIED: The module exports `hashPaymentResult` for compatibility with the inspected Sokosumi source. `hashMip004Result` and `submitStandardResult` use raw MIP-004 output hashing. Both input routes use canonical JSON and the nonce delimiter.

VERIFIED: This session computed the following vector. The result uses one actual newline, two quotes, and one backslash.

```json
{
  "nonce": "01234567890123456789",
  "result": "line\n\"next\"\\end",
  "coreCompatible": "36767ae2635033ebfa81d977b51a72b9d9ea541c73c9c7e6f55302543ba97db3",
  "mip004": "7274791448dbdd3200d56594716830eec96cc7e4929e90a1f5d005dbbd3c1dcd"
}
```

VERIFIED: `node --test tests/payment.test.mjs tests/chain.test.mjs` returned `tests 20`, `pass 20`, `fail 0`. Injected responses test validation and request construction. They do not prove live payment acceptance or settlement.

VERIFIED: paid Task `01a10c8d-085c-767c-810c-e464c8f2a17b` completed with the compatibility result hash and confirmed seller collection. Evidence: `docs/setup-state.json` and `.local/automated-seller-collection-proof.json`.
Correction: the earlier live-verification-pending checkpoint is superseded for this tested route. Standard API settlement remains untested.

## Least confident decisions

1. INFERRED: future Core versions will retain this compatibility rule. The successful Task proves the tested route, not future implementations.
