# Bob Shell Request Signing

Research into the request-signing mechanism in Bob Shell (`bobshell`). Documents
how the official Bob Shell CLI signs HTTP requests, how the HMAC secret is
sourced, what changed in 2.x, and what it means for `pi-bob`.

## Summary

Bob Shell signs requests sent to `https://api.us-east.bob.ibm.com` (the default
Bob backend) with an HMAC-SHA256 signature. It adds two headers:

| Header                | Value                                            |
| --------------------- | ------------------------------------------------ |
| `x-request-timestamp` | ISO 8601 timestamp (`2026-07-15T19:30:00.000Z`)  |
| `x-request-signature` | HMAC-SHA256 hex digest of the signing string     |

`pi-bob` sends requests to the same endpoints without these headers. As of
2026-08-31 the server does not enforce the signature — all pi-bob traffic is
unsigned and accepted. IBM could start enforcing it at any time, which would
break `pi-bob`.

## The signing algorithm

```
bodyHash      = SHA256(requestBody).hex()
signingString = METHOD + "\n" + pathAndQuery + "\n" + timestamp + "\n" + bodyHash
signature     = HMAC_SHA256(secretKey, signingString).hex()
```

For a `GET /inference/v1/model/info` (empty body), the signing string is:

```
GET
/inference/v1/model/info
2026-07-15T19:30:00.000Z
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

### 2.x addition: optional `x-source` line

In `bobshell@2.0.1`, the signing string gains an optional fifth line appended
when an `x-source` header is present on the request:

```
METHOD
pathAndQuery
timestamp
bodyHash
x-source:<value>
```

The signature implementation (`generateSignature`/`generateSignatureHeaders` in
the 2.0.1 bundle) otherwise matches the 1.x construction: canonical uppercase
method, `extractPath` of the URL, `serializeBody` body hash, ISO-8601 UTC
timestamp, HMAC-SHA256 hex digest.

`serializeBody` normalises the body to a string before hashing:

- string as-is
- `FormData` / `URLSearchParams` via `.toString()`
- `Buffer` via `.toString("utf8")`
- `Uint8Array` via `TextDecoder`
- everything else (objects) via `JSON.stringify`

## When signing applies

### bobshell 1.0.6 (historical)

1. **URL gate** (`shouldSignUrl`): request URL must include the default Bob
   backend URL or the `CUSTOM_BASE_URL` env var value.
2. **Secret available**: `this.secretKey` non-empty; empty key skips signing.
3. **Not private preview**: the secret is only initialised in non-private-
   preview builds.

`isAuthnBackend()` routed to `/inference/v1/...` for SSO/JWT tokens (the path
pi-bob's `/login ibm-bob` uses) and skipped signing for `sk-`/`pk` API keys.

### bobshell 2.0.1 (verified 2026-08-31)

All of the above gates are gone: `shouldSignUrl`, `CUSTOM_BASE_URL`, the
private-preview gate, and `isAuthnBackend` no longer appear in the bundle. The
only remaining gate is `if (this.config.secretKey)` inside the GatewayClient
request path — and **nothing in the 2.0.1 bundle ever assigns `secretKey`**.
Signing is intact infrastructure but dormant dead code in this build: no
secret source, so no request is signed.

## The secret key

### 1.0.6 sources (historical)

1. `RUN_TIME_HMAC_SECRET` env var (took precedence), or
2. `BUILD_TIME_HMAC_SECRET` — AES-256-CBC encrypted ciphertext inside a
   UUID-marked comment block in `bob.js`, decryptable only with a key derived
   from the bundle's own bytes: `SHA256(contentBefore + contentAfter)`. This
   tied the secret to the exact official bundle (anti-tampering).

### 2.0.1 status

`RUN_TIME_HMAC_SECRET` and `BUILD_TIME_HMAC_SECRET` are gone (zero hits), as is
the UUID-marked encrypted block. No replacement secret source exists in the
bundle. If IBM re-enables signing, the provisioning mechanism will be new.

## Prior art: `thelonelyghost/pi-dangit-bobby`

A MIT-licensed fork of `pi-bob@0.2.0` that implemented request signing. Useful
as a reference; its conclusions confirm ours.

What it demonstrates:

- The signing-string reconstruction above is **correct against the live
  endpoint** (their signed end-to-end smoke passed).
- A clean operator-provisioned design works: `IBM_BOB_REQUEST_SIGNING_SECRET`
  (>= 32 bytes, no surrounding whitespace), optional fail-closed mode
  (`IBM_BOB_REQUIRE_REQUEST_SIGNING=true` — refuse to send unsigned traffic),
  strip any pre-existing signing headers before adding fresh ones, sign
  model-info and chat completions, and refuse to run signed on the
  `openai-responses` / `anthropic-messages` adapters instead of silently
  sending unsigned requests.
- Signing into Pi's adapter required a full serialization reimplementation
  (`signed-openai.ts`) to control the exact signed bytes — with extra gateway
  strictness handled along the way (64-char `prompt_cache_key` clamp, tool-call
  ID normalisation, surrogate sanitisation). Expect byte-exact body control to
  be the hard part if we ever need this.
- Their extraction script finds UUID-tagged encrypted blocks by *structure*
  (UUID-shaped regex, last match) rather than the hardcoded UUID — robust to
  marker rotation, but moot under 2.x where the block no longer exists.

What it does **not** have (we are ahead): 2.x `model/info` payload support, the
mandatory `x-instance-id` handling, the `max_output_tokens` output limit, and
the current adapter-entitlement findings.

One deliberate divergence: the fork sends a `bobshell/<version>` User-Agent
(impersonating the official CLI). pi-bob sends an honest `pi-bob/<version>` and
has never been blocked on that basis — the real server-side gates so far are
`x-instance-id` (required under 2.x) and route entitlements (403). Keep the
honest UA; impersonation is the posture that gets third-party clients flagged.

## Current status (2026-08-31, bobshell 2.0.1)

- `pi-bob` requests to Bob endpoints succeed **without** signature headers.
- The signature implementation survives in the client but is **dormant**: no
  secret is provisioned, nothing signs.
- The server *does* enforce other things under 2.x (`x-instance-id` required,
  adapter entitlement 403s) — validation is tightening around the signature,
  not at it.

## Recommendation

1. Keep sending unsigned requests. Do not implement signing speculatively.
2. If IBM enforces signatures, the fix is a **sanctioned provisioning path**
   (an env-provided operator secret like the fork's design, or an official
   SDK/partner integration) — not reverse-engineering. The fork's
   `request-signing.ts` (MIT) is the starting point; `signed-openai.ts` shows
   the adapter-hook cost.
3. Do not extract embedded secrets from the Bob CLI. Under 1.x it was fragile
   and terms-hostile; under 2.x it is not even possible.
4. Revisit this document whenever the Bob entitlement/UA behaviour changes —
   2.0 tightened validation elsewhere first, so the signature question is more
   likely to resurface than to disappear.
