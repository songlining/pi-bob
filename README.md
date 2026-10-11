# pi-bob

Pi provider package for IBM Bob / IBM-approved enterprise model endpoints.

The package registers Bob through Pi's built-in compatible provider APIs and discovers the currently exposed model catalog from Bob's authenticated `/inference/v1/model/info` endpoint. It does not scrape Bob, extract browser/session credentials, or bypass IBM-approved access paths.

> **✅ Works with IBM Bob Shell / Bob CLI 2.x (verified against `bobshell@2.0.6`, 2026-10-11).**
> Routing headers, `model/info` payload shape, live discovery, and end-to-end inference were all re-checked on 2.0.6: the catalog now exposes 10 models — `premium`, `premium-ide`, `premium-shell`, `fast`, `explorer`, `wxO-model` (1M ctx), `background`, `security`, `gpt-oss-20b`, and `openai/gpt-oss-20b`. SSO login and token refresh were last exercised on 2.0.1; see [Validation performed](#validation-performed). One caveat: under 2.x, Bob only accepts the default **`openai-completions`** adapter; `anthropic-messages` and `openai-responses` are rejected with 403 by Bob-side entitlement. 1.x Bob Shell installations keep working — the parser accepts both payload shapes. See [Discovered local Bob Shell settings](#discovered-local-bob-shell-settings) for the full 2.x change list.

## Discovered local Bob Shell settings

First characterised on the installed `bobshell@2.0.1` package (upgraded from 1.0.6) and re-verified on `bobshell@2.0.6` against the live endpoint on 2026-10-11:

- Bob Shell 2.x moved stored SSO tokens to `~/.bob/settings/auth-secrets.json` (key `bob.auth.tokens-<gateway>`); `~/.bob/settings.json` keeps only non-secret settings. This extension still reads only `ibm.instanceId`/`ibm.teamId` from there and still ignores Bob's secrets.
- Token endpoints are unchanged in practice: 2.x builds `${gateway}/authn` + `v1/auth/token|refresh`, which resolves to the same `/authn/v1/auth/token` and `/authn/v1/auth/refresh` routes used here. The web login URL is now assembled as `https://bob.ibm.com` + `/login`; the final URL is the same as the 1.x constant.
- **Payload shape:** 2.x `model/info` entries carry `max_output_tokens` and `supports_prompt_caching` alongside `max_tokens`; `litellm_params` (the backend identifier) was absent in 2.0.1 and is present again in 2.0.6. The parser accepts both shapes and falls back to the route name when the backend is missing. `max_output_tokens` is the enforced output cap under 2.x (verified 2026-08-31: `premium` accepted `max_tokens=50000` despite a catalog `max_tokens` of 12000) and is advertised when present.
- 2.x requires the `x-instance-id` header (HTTP 400 `X-Instance-ID header is required` without it). `x-team-id` is optional for `model/info` (HTTP 200 without it) but **required for inference** — a `chat/completions` request without it returns HTTP 402 `team user not found or has been deleted` (verified 2026-10-11). The extension always sends both, from Bob settings or the JWT `instances` claim.
- Model tiers were renamed: 1.x `premium`/`pro`/`flash`/`flash-lite` became 2.x tiers `fast`/`premium`/`ultra`. The 2.0.6 catalog is `premium`, `premium-ide`/`premium-shell` (270K ctx), `fast`, `explorer`, `wxO-model` (1M ctx / 64K out), and the utility routes `background`, `security`, `gpt-oss-20b`, `openai/gpt-oss-20b` (131,072 ctx) — all with `supports_vision` except the utility routes. The catalog changes server-side without a CLI release: `ultra`, `sonnet-4.5`, and the granite/rnj code models were exposed in 2.0.1 and are gone in 2.0.6, and `explorer` became visible. The `premium` alias exists in both, so the fallback catalog stays valid.
- No route in the 2.0.6 catalog publishes `supports_reasoning`, `supports_reasoning_effort`, or `supports_thinking`, so every Bob model is advertised as non-reasoning. `premium` does return `reasoning_content` when asked for `reasoning_effort`, so reasoning is opt-in via `IBM_BOB_REASONING_MODELS=premium` (with `IBM_BOB_SUPPORTS_REASONING_EFFORT=true`).
- **Breaking (entitlement):** under 2.0, the `anthropic-messages` and `openai-responses` routes return `403 Access denied` with a valid token (routes exist; access is denied for this instance). Only the default `openai-completions` adapter works; treat the alternates as unavailable until IBM grants access.

From the installed `bobshell@1.0.6` package and the local redacted Bob configuration (historical):

- Bob Shell CLI: `bob`
- Bob Shell package: `bobshell`
- Installed auth method: `sso`
- Default Bob API host: `https://api.us-east.bob.ibm.com`
- OpenAI-compatible chat base URL: `https://api.us-east.bob.ibm.com/inference/v1`
- Chat completions route used by Bob Shell: `/inference/v1/chat/completions`
- Model-info route used by Bob Shell: `/inference/v1/model/info`
- Default model alias used by Bob Shell: `premium`
- Other visible aliases/constants in the installed client: `pro`, `flash`, `flash-lite`, `bob-3-pro-preview`
- Installed Bob Shell contains a broad ~1M context-window default, but the observed `premium` backend route maps to Claude Sonnet 4.5 with `Max Input Tokens=200000`.
- Default context window advertised to Pi: `200000`, so Pi compacts before Bob rejects oversized requests.
- Default max output token constant in the installed client: `8192`

Bob Shell sends non-secret instance/team routing headers. This extension reads only these non-secret fields from `~/.bob/settings.json` by default:

- `ibm.instanceId` -> `x-instance-id`
- `ibm.teamId` -> `x-team-id`

It intentionally ignores Bob's stored SSO secrets.

## What it supports

Set `IBM_BOB_API` to one of Pi's compatible API adapters:

- `openai-completions` — default; OpenAI Chat Completions-compatible routes.
- `openai-responses` — OpenAI Responses-compatible routes.
- `anthropic-messages` — Anthropic Messages-compatible routes.

Under Bob Shell 2.x, Bob currently accepts only the default `openai-completions` adapter; the other two return `403 Access denied` regardless of extension settings (re-verified 2026-10-11).

The extension registers provider id `ibm-bob`. It uses an isolated `ibm-bob-compatible` Pi API adapter internally, then delegates serialization and streaming to the selected built-in adapter. This prevents Bob-specific authentication rules from affecting other providers.

## Dynamic model discovery

Model discovery is enabled by default:

- With `IBM_BOB_API_KEY` or `IBM_BOB_KEY`, the extension fetches `/inference/v1/model/info` during Pi's async extension startup. This makes current models available to `--list-models` and `/model` immediately.
- With `/login ibm-bob`, the extension fetches the catalog after login, and on token refresh only when no catalog is already cached (reusing a cached catalog avoids holding Pi's global auth-store lock across a network call). A sanitized, non-secret copy is cached with Pi's OAuth credentials so the models can be restored on later startups.
- Entries returned by the authenticated catalog are registered when `model_info.exposed` is omitted or `true`. Routes explicitly marked `exposed: false` are ignored.
- HTTP failures, timeouts, malformed responses, empty catalogs, and catalogs with no visible models retain the previous SSO catalog or fall back to `IBM_BOB_MODELS`. Bob still enforces route access during inference.

Discovered context limits, output limits, vision support, reasoning support, and backend identifiers are mapped into Pi model definitions. Pricing is not discovered — Bob reports `0` for every per-token price — so costs come from the [Bobcoin rate table](#bobcoin-billing) instead.

### How context/output limits are determined

Every advertised number comes from Bob's own `/model/info` catalog — the extension never hardcodes per-model values:

- **Context window** ← `model_info.max_input_tokens`.
- **Max output tokens** ← `model_info.max_output_tokens` when present (2.x), else `model_info.max_tokens` (the 1.x output cap).
- Models that report no limits (e.g. the 1.x `granite-8b-code-instruct` and `rnj-1-*` routes) use the defaults: 200,000 context / 8,192 output, overridable via `IBM_BOB_CONTEXT_WINDOW` / `IBM_BOB_MAX_TOKENS`.

The 2.x precedence was determined empirically, not from documentation. The 2.x catalog reports *two* output fields for the same route (e.g. `premium`: `max_tokens: 12000`, `max_output_tokens: 64000`), so on 2026-08-31 the extension author probed the live endpoint: a `chat/completions` request for `premium` with `max_tokens=50000` — four times the catalog's `max_tokens` — returned HTTP `200` and completed normally. That proves `max_tokens` is no longer the enforced cap and `max_output_tokens` is the real limit, so the larger, newer field is advertised when present. 1.x payloads have no `max_output_tokens`, where `max_tokens` was verified to be the output cap, keeping that behavior unchanged.

## Quick start for the discovered Bob endpoint

Use Bob SSO through Pi:

```bash
pi -e .
# inside Pi:
#   /login ibm-bob
#   /model ibm-bob/premium
```

Pi stores the resulting Bob SSO access/refresh tokens in Pi's normal auth store (`~/.pi/agent/auth.json`). This extension obtains those tokens only through Bob's browser SSO endpoints; it does not read Bob Shell's stored SSO secrets.

For non-interactive use with an approved Bob API key, run:

```bash
export IBM_BOB_API_KEY="..." # IBM_BOB_KEY is also accepted; do not commit either

pi -e . --list-models
pi -e . --model ibm-bob/premium
```

API keys use Bob's `Authorization: Apikey ...` scheme by default. If your approved credential is instead a bearer token, set `IBM_BOB_AUTH_SCHEME=Bearer`. Pi resolves credentials in this order: runtime `--api-key`, a stored credential (including SSO), then the provider's environment-key fallback. The model catalog follows stored SSO metadata when SSO remains configured. Run `/logout ibm-bob` before switching from SSO to either `IBM_BOB_API_KEY` or runtime `--api-key`; runtime-only keys cannot drive startup discovery.

Defaults are already set to:

```bash
IBM_BOB_BASE_URL="https://api.us-east.bob.ibm.com/inference/v1"
IBM_BOB_API="openai-completions"
IBM_BOB_DISCOVER_MODELS="true"
IBM_BOB_MODELS="premium"                  # fallback catalog
IBM_BOB_MODEL_DISCOVERY_TIMEOUT_MS="5000"
```

Discovered metadata is used unless a corresponding metadata override is set. Without a discovered catalog, fallback models use a 200,000-token context window and 8,192-token output limit.

For SSO, do **not** copy a token out of Bob's local credential store unless IBM policy explicitly permits it. Use `/login ibm-bob` instead.

## Configuration

### Core

| Variable | Default | Description |
| --- | --- | --- |
| `IBM_BOB_BASE_URL` | `https://api.us-east.bob.ibm.com/inference/v1` | Approved Bob/IBM endpoint base URL. For `anthropic-messages`, a trailing `/inference/v1` is normalized so the adapter sends requests to `/inference/v1/messages` rather than `/inference/v1/v1/messages`. |
| `IBM_BOB_MODELS` | `premium` | Comma-separated fallback model IDs used when discovery is unavailable. |
| `IBM_BOB_API_KEY` | unset | Approved API key/token. Keep it out of repo files. |
| `IBM_BOB_KEY` | unset | Alias for `IBM_BOB_API_KEY`, matching Bob/OpenCode configuration. |
| `IBM_BOB_API` | `openai-completions` | One of `openai-completions`, `openai-responses`, `anthropic-messages`. |
| `IBM_BOB_DISCOVER_MODELS` | `true` | Discover visible models from `/model/info`; entries explicitly marked `exposed: false` are excluded. |
| `IBM_BOB_MODEL_DISCOVERY_TIMEOUT_MS` | `5000` | Startup/login discovery timeout in milliseconds. |
| `IBM_BOB_TOKEN_REQUEST_TIMEOUT_MS` | `10000` | SSO token exchange and refresh timeout in milliseconds. |

### Bob routing headers

| Variable | Default | Description |
| --- | --- | --- |
| `IBM_BOB_READ_BOBSHELL_SETTINGS` | `true` | Read non-secret `instanceId`/`teamId` from `~/.bob/settings.json`. |
| `IBM_BOB_INSTANCE_ID` | Bob setting | Override `x-instance-id`. |
| `IBM_BOB_TEAM_ID` | Bob setting | Override `x-team-id`. |
| `IBM_BOB_USER_AGENT` | `pi-bob/0.2.2` | User-Agent header sent to Bob endpoint. |

### Auth headers

| Variable | Default | Description |
| --- | --- | --- |
| `IBM_BOB_AUTH_SCHEME` | `Apikey` for environment API keys | Override with `Bearer` when the environment credential is a bearer token. SSO always uses Bearer automatically. |
| `IBM_BOB_HEADERS_JSON` | unset | JSON object of extra headers. Values may use Pi env interpolation such as `"$IBM_BOB_API_KEY"`. |

### Model metadata

| Variable | Default | Description |
| --- | --- | --- |
| `IBM_BOB_CONTEXT_WINDOW` | discovered; fallback `200000` | Override the context window for every Bob model. Keep it at or below the backend limit so Pi compacts before Bob rejects the request. |
| `IBM_BOB_MAX_TOKENS` | discovered; fallback `8192` | Override maximum output tokens for every Bob model. |
| `IBM_BOB_INPUT` | discovered; fallback `text` | Override input types with `text` or `text,image`. |
| `IBM_BOB_REASONING` | discovered; fallback `false` | Explicitly enable or disable reasoning for all models. |
| `IBM_BOB_REASONING_MODELS` | empty | Comma-separated model IDs to mark as reasoning-capable. |
| `IBM_BOB_CREDITS_PER_MILLION` | per-route table below | Override the Bobcoin rate for every model, in Bobcoins per million tokens. |

Pricing comes from the Bobcoin rate table below, because Bob's model-info response reports `0` for every per-token price. If IBM ever populates those fields, the catalog values win and are converted from per-token to Pi's per-million-token units.

### Bobcoin billing

Bob bills a flat **Bobcoin** rate per route. Bobcoins are IBM's consumption meter at **$0.50 each**, drawn from a monthly plan allocation (Free trial 50, Pro 50, Pro+ 180, Ultra 1000) with opt-in pay-as-you-go overage at the same rate.

Measured against the live endpoint on 2026-10-11 (`bobshell@2.0.6`): `credits == rate × (prompt + completion) tokens / 1e6`, exact to four decimals from 254 to 9,780 input tokens, with **input and output priced identically and no discount for cache reads or writes** — a repeated 9,913-token prefix billed the same on the cache-write and cache-hit turns.

| Route | Bobcoins/M | Pi cost (at $0.50) |
| --- | --- | --- |
| `premium`, `premium-ide`, `premium-shell`, `wxO-model` | 2.0 | $1.00/M |
| `background`, `security` | 2.0 | $1.00/M |
| `fast`, `explorer` | 0.8333 | $0.4167/M |
| `gpt-oss-20b`, `openai/gpt-oss-20b` | 0 | free |

Any route not in the table is priced at the 2.0 rate. Because the rate is flat, Pi's cost total is exact whichever bucket Pi puts cached tokens in — verified end to end: a 21,941-token `premium` turn reported `$0.021941`, which is 0.043882 Bobcoins at $0.50.

The dollar figure is the **overage rate**, not marginal cost: while you are inside your plan allocation the Bobcoins are already paid for, so treat the footer as a burn gauge rather than a bill. Re-measure if the numbers look off — IBM can reprice without a CLI release.

### OpenAI compatibility toggles

```bash
export IBM_BOB_SUPPORTS_DEVELOPER_ROLE=false
export IBM_BOB_SUPPORTS_REASONING_EFFORT=false
export IBM_BOB_SUPPORTS_USAGE_IN_STREAMING=true
export IBM_BOB_SUPPORTS_STRICT_MODE=false
export IBM_BOB_MAX_TOKENS_FIELD=max_tokens
```

Bob's OpenAI-compatible route currently rejects `tools[].function.strict`, so `IBM_BOB_SUPPORTS_STRICT_MODE=false` is the default.
It also rejects OpenAI-specific `store` and `prompt_cache_key` request properties with a bare `422`, so both are always disabled for the OpenAI adapters.

## Validation performed

### Verified against Bob Shell 2.0.6 (2026-10-11)

- Live discovery through Pi: `pi -e . --list-models` shows all 10 current catalog models (`premium`, `premium-ide`, `premium-shell`, `fast`, `explorer`, `wxO-model`, `background`, `security`, `gpt-oss-20b`, `openai/gpt-oss-20b`) from any directory, using stored SSO credentials.
- End-to-end inference through `openai-completions`: `pi -e . --model ibm-bob/premium -p 'Reply with exactly: pi-bob-ok'` returned `pi-bob-ok`, and `--model ibm-bob/openai/gpt-oss-20b` returned `slash-id-ok`, so two-segment model IDs flow through selection and inference. A raw `POST /inference/v1/chat/completions` for `premium` returned `200` without the signing headers, so request signing is still unenforced.
- `anthropic-messages` and `openai-responses` routes: `403 Access denied` with a valid token — Bob-side entitlement, not an extension defect.
- `bun test`: 37 tests pass.
- When probing by hand, set `User-Agent: pi-bob/0.2.2` (what the extension sends). Requests from `curl`/`python-urllib` default UAs are rejected by Cloudflare in front of Bob with a `403` HTML page, which looks like an entitlement failure but is not.
- Not re-verified on 2.0.6: SSO token refresh (last confirmed on 2.0.1, 2026-08-31).

### Verified against Bob Shell 2.0.1 (2026-08-31)

- Live discovery through Pi: `pi --list-models` showed all 13 catalog models then exposed (`premium`, `premium-ide`, `premium-shell`, `ultra`, `fast`, `explorer`, `sonnet-4.5`, `wxO-model`, `gpt-oss-20b`, granite/rnj) from any directory, using stored SSO credentials.
- End-to-end inference through `openai-completions`: `premium`, `ultra`, and `premium-shell` all responded correctly to exact-reply smokes.
- SSO refresh on `/authn/v1/auth/refresh` returned `200` with a rotated refresh token; the refreshed token immediately passed `model/info`.
- `anthropic-messages` and `openai-responses` routes: `403 Access denied` with a valid token — Bob-side entitlement change, not an extension defect.
- `bun test`: 33 tests pass, including a fixture built from an observed 2.x `model/info` payload (no `litellm_params`, `max_output_tokens`, `supports_prompt_caching`).

### Earlier validation (Bob Shell 1.x era)

The unauthenticated Bob model-info endpoint responds as expected when called with a normal User-Agent:

```bash
curl -H 'User-Agent: pi-bob/0.2.2' \
  https://api.us-east.bob.ibm.com/inference/v1/model/info
```

Result: HTTP `401` with `Authentication required`, confirming the discovered route exists and requires auth.

The Bob SSO endpoint flow was smoke-tested independently: browser SSO callback succeeded, token exchange succeeded, and `GET /inference/v1/model/info` returned HTTP `200` using the fresh SSO token.

The Pi provider registers with fallback settings when no authenticated catalog is available:

```bash
pi -e . --list-models | grep ibm-bob
```

Automated tests cover LiteLLM response validation, hidden-model filtering, per-million cost conversion, API-key discovery, `IBM_BOB_KEY` compatibility, fallback behavior, SSO refresh discovery, routing headers, cached catalog replacement, and final authentication headers/routes through all three advertised adapters:

```bash
bun test
npm run check
```

A dummy-token Pi request reaches the Bob endpoint and fails with the expected auth error:

```bash
IBM_BOB_API_KEY=dummy IBM_BOB_AUTH_SCHEME=Apikey \
  pi -e . --model ibm-bob/premium -p 'Say hi'
```

Result: HTTP `401 unauthorized`.

End-to-end smoke with a fresh Bob SSO token succeeded:

```text
pi -e . --model ibm-bob/premium -p 'Reply with exactly: pi-bob-ok'
```

Result:

```text
pi-bob-ok
```

## Troubleshooting

**`/login ibm-bob` freezes after the browser returns to Pi.** Pi refreshes
model catalogs for built-in providers after every login by fetching
`https://pi.dev/api/models/providers/<id>` (the remote-catalog provider). If
pi.dev's API is unreachable or hangs from your network, that post-login fetch
blocks with no timeout for roughly 5 minutes, and Ctrl-C cannot cancel it.
Run Pi with `PI_OFFLINE=1` to skip Pi's network catalog refresh entirely; the
login then returns to the prompt immediately after SSO, and ibm-bob's own
model discovery still runs.

**`/model` shows only `premium` under `ibm-bob`.** The stored credentials carry no cached model catalog — typical for credentials created before this version, or after Bob changes its catalog shape. Run `/login ibm-bob` once: login always rediscovers the catalog and re-attaches it to the stored credentials, and every later startup reuses it. Do **not** hand-edit `~/.pi/agent/auth.json` to add the catalog; Pi's auth store manages that file and may silently drop hand-written fields.

**Debugging the login flow.** Run with `IBM_BOB_DEBUG=1` and stderr
redirected to a file to see per-step timing for the SSO callback, token
exchange, and model discovery:

```bash
IBM_BOB_DEBUG=1 pi 2>/tmp/pi-bob-debug.log
```

## Install options

Temporary test load:

```bash
pi -e .
```

Install as a local Pi package:

```bash
pi install npm:pi-bob
```

Remove later:

```bash
pi remove npm:pi-bob
```

## Next steps

The compatible provider, `/login ibm-bob`, and dynamic model discovery are implemented. Next useful improvements:

1. Add a `/bob-status` command that checks auth, model-info, selected instance, and selected team without printing secrets.
2. Run periodic compatibility smoke tests against representative Claude, GPT, and Gemini routes exposed by Bob.
