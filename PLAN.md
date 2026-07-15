# IBM Bob provider plan

## Safety boundaries

- Use only IBM-approved Bob/model endpoints and credentials the user is authorised to use.
- Do not scrape, extract, copy, or reuse Bob browser/session credentials.
- Do not store secrets in this repository or in chat transcripts.
- Prefer environment variables, password-manager commands, formal Pi `/login` support, or approved local auth helpers for credentials.

## Implementation strategy

### Option 1 — compatible provider first

Implement a Pi package that registers IBM Bob as a normal Pi provider using Pi's built-in compatible API adapters:

- `openai-completions` for OpenAI Chat Completions-compatible Bob routes.
- `openai-responses` for OpenAI Responses-compatible Bob routes.
- `anthropic-messages` for Anthropic Messages-compatible Bob routes.

This avoids custom streaming code and keeps the integration transparent: Pi serializes messages, tools, streaming, and usage exactly as it already does for compatible providers.

### Option 2 — approved SSO/auth wrapper

If Bob uses short-lived IBM SSO/IAM/direct-access tokens but still exposes an OpenAI/Anthropic-compatible model API, add a Pi `/login ibm-bob` flow or an approved auth-helper integration that obtains tokens, injects headers, and delegates to Pi's built-in streamers.

Implemented: `/login ibm-bob` uses Bob's browser SSO endpoints (`/authn/v1/auth/token` and `/authn/v1/auth/refresh`) and Pi's standard OAuth credential store. It does not extract Bob Shell's stored token from `~/.bob/settings.json` or Bob's credential store.

Dynamic model discovery is also implemented. Environment API keys fetch `/inference/v1/model/info` during Pi's async extension startup. SSO fetches after login and token refresh, caches only sanitized model metadata with the OAuth credential, and restores those models through Pi's `modifyModels()` hook. Transport failures and catalogs with no valid visible models preserve the previous catalog or use static fallback models. Bob uses an isolated custom Pi API ID and delegates to the selected built-in serializer/streamer, so its request-time `Apikey`/Bearer normalization cannot affect unrelated providers.

### Option 3 — native Bob/watsonx adapter

Only if Bob exposes a non-compatible native API, implement a full `streamSimple` adapter that maps Pi context and tool calls to Bob requests and Bob streaming events back to Pi assistant-message events.

## Discovered local Bob Shell facts

From `bobshell@1.0.6` installed at `/opt/homebrew/lib/node_modules/bobshell`:

- CLI path: `/opt/homebrew/bin/bob`
- Local auth method: `sso`
- Default Bob API host: `https://api.us-east.bob.ibm.com`
- OpenAI-compatible base URL: `https://api.us-east.bob.ibm.com/inference/v1`
- Chat route: `/inference/v1/chat/completions`
- Model-info route: `/inference/v1/model/info`
- Default model alias: `premium`
- Other visible aliases/constants: `pro`, `flash`, `flash-lite`, `bob-3-pro-preview`
- Installed Bob Shell contains a broad ~1M context-window default, but the observed `premium` backend route maps to Claude Sonnet 4.5 with `Max Input Tokens=200000`.
- Provider default context window for Pi: `200000`, so Pi compacts before Bob rejects oversized requests.
- Default max output token constant: `8192`
- Non-secret routing headers: `x-instance-id`, `x-team-id`
- SSO browser login URL: `https://bob.ibm.com/login?callback_uri=...&state=...`
- SSO token endpoint: `/authn/v1/auth/token`
- SSO refresh endpoint: `/authn/v1/auth/refresh`

## Option 1 execution

This repository now contains a local Pi package:

- `package.json` declares a Pi package.
- `extensions/bob.ts` registers provider `ibm-bob` and Pi `/login ibm-bob` SSO.
- `README.md` documents discovered settings, setup, and validation.

Defaults now target the discovered Bob Shell route:

- `IBM_BOB_BASE_URL=https://api.us-east.bob.ibm.com/inference/v1`
- `IBM_BOB_API=openai-completions`
- `IBM_BOB_MODELS=premium`
- `IBM_BOB_CONTEXT_WINDOW=200000`
- `IBM_BOB_MAX_TOKENS=8192`
- `IBM_BOB_DISCOVER_MODELS=true`
- `IBM_BOB_MODEL_DISCOVERY_TIMEOUT_MS=5000`
- `IBM_BOB_TOKEN_REQUEST_TIMEOUT_MS=10000`

The extension reads only non-secret `ibm.instanceId` and `ibm.teamId` from `~/.bob/settings.json` unless `IBM_BOB_READ_BOBSHELL_SETTINGS=false`.

Secret configuration remains external:

- Pi `/login ibm-bob`, which stores fresh SSO credentials in `~/.pi/agent/auth.json`, or
- `IBM_BOB_API_KEY`, or
- `IBM_BOB_HEADERS_JSON` with environment-variable placeholders, or
- future approved local auth-helper support.

## Validation completed

- Bob Shell SSO test succeeded with `bob --auth-method sso -m premium`.
- Direct unauthenticated model-info call reached the discovered endpoint and returned expected `401 Authentication required`.
- Pi provider lists `ibm-bob/premium` with dummy token.
- Pi request with dummy token reaches Bob and returns expected `401 unauthorized`.
- Independent Bob SSO smoke test succeeded: callback received, token exchange succeeded, and authenticated model-info returned HTTP `200`.
- Direct minimal chat completion returned `direct-bob-ok`.
- Direct tool payload test showed Bob rejects `tools[].function.strict`; provider default now sets `supportsStrictMode=false`.
- Pi end-to-end with fresh SSO token succeeded: `pi-bob-ok`.
- Dynamic catalog tests cover optional visibility metadata, explicit hidden-model filtering, LiteLLM metadata parsing, per-million cost conversion, API-key `Apikey` auth, the `IBM_BOB_KEY` alias, SSO `Bearer` auth with routing headers, fallback behavior, and cached-model replacement.
- Adapter-level tests verify final `Authorization` headers, absence of conflicting `x-api-key`, and routes for OpenAI Completions, OpenAI Responses, and Anthropic Messages.
- `bun test`, `npm run check`, and `git diff --check` pass after the discovery implementation.
- After a real context overflow from Bob (`Max Input Tokens=200000, Got=236458`), the provider default context window was lowered from `1048576` to `200000` so Pi's own compaction/overflow handling can engage before Bob rejects the request.

## Remaining work

The provider works end-to-end for a basic Pi prompt through Bob's OpenAI-compatible route and now tracks Bob's exposed model catalog. Useful next steps:

1. Add `/bob-status` for no-secret health checks.
2. Run compatibility smoke tests against representative Claude, GPT, and Gemini model aliases.
