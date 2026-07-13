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
- Default context window for `premium`: ~1M tokens
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
- `IBM_BOB_CONTEXT_WINDOW=1048576`
- `IBM_BOB_MAX_TOKENS=8192`

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

## Remaining work

The provider works end-to-end for a basic Pi prompt through Bob's OpenAI-compatible route. Useful next steps:

1. Run interactive `/login ibm-bob` once inside Pi to persist SSO credentials in Pi's auth store.
2. Add `/bob-status` for no-secret health checks.
3. Add dynamic model discovery from `/inference/v1/model/info`.
4. Add regression tests for SSO callback, refresh, and strict-tool compatibility.
