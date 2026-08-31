# pi-bob

Pi provider package for IBM Bob / IBM-approved enterprise model endpoints.

The package registers Bob through Pi's built-in compatible provider APIs and discovers the currently exposed model catalog from Bob's authenticated `/inference/v1/model/info` endpoint. It does not scrape Bob, extract browser/session credentials, or bypass IBM-approved access paths.

> **✅ Works with IBM Bob Shell / Bob CLI 2.x (verified against `bobshell@2.0.1`, 2026-08-31).**
> SSO login, token refresh, and live model discovery all work against Bob 2.0 — 13 models discovered, including `premium`, `premium-ide`, `ultra`, `fast`, and `wxO-model` (1M ctx). One caveat: under 2.x, Bob only accepts the default **`openai-completions`** adapter; `anthropic-messages` and `openai-responses` are rejected with 403 by Bob-side entitlement. 1.x Bob Shell installations keep working — the parser accepts both payload shapes. See [Discovered local Bob Shell settings](#discovered-local-bob-shell-settings) for the full 2.x change list.

## Discovered local Bob Shell settings

Updated for the installed `bobshell@2.0.1` package (upgraded from 1.0.6; findings verified against the live endpoint on 2026-08-31):

- Bob Shell 2.x moved stored SSO tokens to `~/.bob/settings/auth-secrets.json` (key `bob.auth.tokens-<gateway>`); `~/.bob/settings.json` keeps only non-secret settings. This extension still reads only `ibm.instanceId`/`ibm.teamId` from there and still ignores Bob's secrets.
- Token endpoints are unchanged in practice: 2.x builds `${gateway}/authn` + `v1/auth/token|refresh`, which resolves to the same `/authn/v1/auth/token` and `/authn/v1/auth/refresh` routes used here. The web login URL is now assembled as `https://bob.ibm.com` + `/login`; the final URL is the same as the 1.x constant.
- **Breaking:** 2.x `model/info` entries dropped `litellm_params` (the backend identifier) and now carry `max_output_tokens` and `supports_prompt_caching` alongside `max_tokens`. The parser accepts both shapes and falls back to the route name when the backend is missing.
- **Breaking:** 2.x `model/info` requires `x-instance-id` (HTTP 400 without it); `x-team-id` stays optional. The extension already sends both from Bob settings or the JWT `instances` claim.
- Model tiers were renamed: 1.x `premium`/`pro`/`flash`/`flash-lite` became 2.x tiers `fast`/`premium`/`ultra` (`explorer` exists but is hidden). Live catalog also exposes `premium-ide`, `premium-shell`, `sonnet-4.5`, `wxO-model` (1M ctx / 64k out), `gpt-oss-20b`, and granite/rnj code models. The `premium` alias still exists, so the fallback catalog stays valid.
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

Under Bob Shell 2.x, Bob currently accepts only the default `openai-completions` adapter; the other two return `403 Access denied` regardless of extension settings (verified 2026-08-31).

The extension registers provider id `ibm-bob`. It uses an isolated `ibm-bob-compatible` Pi API adapter internally, then delegates serialization and streaming to the selected built-in adapter. This prevents Bob-specific authentication rules from affecting other providers.

## Dynamic model discovery

Model discovery is enabled by default:

- With `IBM_BOB_API_KEY` or `IBM_BOB_KEY`, the extension fetches `/inference/v1/model/info` during Pi's async extension startup. This makes current models available to `--list-models` and `/model` immediately.
- With `/login ibm-bob`, the extension fetches the catalog after login, and on token refresh only when no catalog is already cached (reusing a cached catalog avoids holding Pi's global auth-store lock across a network call). A sanitized, non-secret copy is cached with Pi's OAuth credentials so the models can be restored on later startups.
- Entries returned by the authenticated catalog are registered when `model_info.exposed` is omitted or `true`. Routes explicitly marked `exposed: false` are ignored.
- HTTP failures, timeouts, malformed responses, empty catalogs, and catalogs with no visible models retain the previous SSO catalog or fall back to `IBM_BOB_MODELS`. Bob still enforces route access during inference.

Discovered context limits, output limits, vision support, reasoning support, backend identifiers, and token prices are mapped into Pi model definitions. Bob reports prices per token; Pi displays prices per million tokens, so the extension performs that conversion.

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

Discovered pricing comes from Bob's model-info response and is converted to Pi's per-million-token units. Fallback models retain zero pricing.

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

### Verified against Bob Shell 2.0.1 (2026-08-31)

- Live discovery through Pi: `pi --list-models` shows all 13 catalog models (`premium`, `premium-ide`, `premium-shell`, `ultra`, `fast`, `explorer`, `sonnet-4.5`, `wxO-model`, `gpt-oss-20b`, granite/rnj) from any directory, using stored SSO credentials.
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
