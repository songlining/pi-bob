# pi-bob

Pi provider package for IBM Bob / IBM-approved enterprise model endpoints.

This first pass implements **Option 1** from `PLAN.md`: register Bob as a Pi provider using Pi's built-in compatible provider APIs. It does not scrape Bob, extract browser/session credentials, or bypass IBM-approved access paths.

## Discovered local Bob Shell settings

From the installed `bobshell@1.0.6` package and the local redacted Bob configuration:

- Bob Shell CLI: `/opt/homebrew/bin/bob`
- Bob Shell package: `/opt/homebrew/lib/node_modules/bobshell`
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

The extension registers provider id `ibm-bob`.

## Quick start for the discovered Bob endpoint

Use Bob SSO through Pi:

```bash
pi -e /Users/larry.song/work/hashicorp/pi-bob
# inside Pi:
#   /login ibm-bob
#   /model ibm-bob/premium
```

Pi stores the resulting Bob SSO access/refresh tokens in Pi's normal auth store (`~/.pi/agent/auth.json`). This extension obtains those tokens only through Bob's browser SSO endpoints; it does not read Bob Shell's stored SSO secrets.

For non-interactive/API-key use, if you have an approved Bob bearer token/API token available outside Bob Shell, run:

```bash
export IBM_BOB_API_KEY="..." # do not commit this

pi -e /Users/larry.song/work/hashicorp/pi-bob --list-models
pi -e /Users/larry.song/work/hashicorp/pi-bob --model ibm-bob/premium
```

Defaults are already set to:

```bash
IBM_BOB_BASE_URL="https://api.us-east.bob.ibm.com/inference/v1"
IBM_BOB_API="openai-completions"
IBM_BOB_MODELS="premium"
IBM_BOB_CONTEXT_WINDOW="200000"
IBM_BOB_MAX_TOKENS="8192"
```

For IBM Bob API keys that require `Authorization: Apikey ...` rather than `Authorization: Bearer ...`:

```bash
export IBM_BOB_AUTH_SCHEME="Apikey"
```

For SSO, do **not** copy a token out of Bob's local credential store unless IBM policy explicitly permits it. Use `/login ibm-bob` instead.

## Configuration

### Core

| Variable | Default | Description |
| --- | --- | --- |
| `IBM_BOB_BASE_URL` | `https://api.us-east.bob.ibm.com/inference/v1` | Approved Bob/IBM endpoint base URL. |
| `IBM_BOB_MODELS` | `premium` | Comma-separated model IDs exposed by the endpoint. |
| `IBM_BOB_API_KEY` | unset | Approved API key/token. Keep it out of repo files. |
| `IBM_BOB_API` | `openai-completions` | One of `openai-completions`, `openai-responses`, `anthropic-messages`. |

### Bob routing headers

| Variable | Default | Description |
| --- | --- | --- |
| `IBM_BOB_READ_BOBSHELL_SETTINGS` | `true` | Read non-secret `instanceId`/`teamId` from `~/.bob/settings.json`. |
| `IBM_BOB_INSTANCE_ID` | Bob setting | Override `x-instance-id`. |
| `IBM_BOB_TEAM_ID` | Bob setting | Override `x-team-id`. |
| `IBM_BOB_USER_AGENT` | `pi-bob/0.1.0` | User-Agent header sent to Bob endpoint. |

### Auth headers

| Variable | Default | Description |
| --- | --- | --- |
| `IBM_BOB_AUTH_SCHEME` | unset/Bearer via Pi's OpenAI adapter | Set to `Apikey` when the Bob token must be sent as `Authorization: Apikey $IBM_BOB_API_KEY`. Do not set this for `/login ibm-bob` SSO. |
| `IBM_BOB_HEADERS_JSON` | unset | JSON object of extra headers. Values may use Pi env interpolation such as `"$IBM_BOB_API_KEY"`. |

### Model metadata

| Variable | Default | Description |
| --- | --- | --- |
| `IBM_BOB_CONTEXT_WINDOW` | `200000` | Context window Pi should assume. Keep this at or below Bob's backend max input tokens so Pi compacts before Bob rejects the request. |
| `IBM_BOB_MAX_TOKENS` | `8192` | Max output tokens Pi should request/allow. |
| `IBM_BOB_INPUT` | `text` | Comma-separated input types: `text` or `text,image`. |
| `IBM_BOB_REASONING` | `false` | Mark all configured models as reasoning-capable. |
| `IBM_BOB_REASONING_MODELS` | empty | Comma-separated subset of model IDs that support reasoning. |

Pricing is set to zero until IBM-specific metering details are known.

### OpenAI compatibility toggles

```bash
export IBM_BOB_SUPPORTS_DEVELOPER_ROLE=false
export IBM_BOB_SUPPORTS_REASONING_EFFORT=false
export IBM_BOB_SUPPORTS_USAGE_IN_STREAMING=true
export IBM_BOB_SUPPORTS_STRICT_MODE=false
export IBM_BOB_MAX_TOKENS_FIELD=max_tokens
```

Bob's OpenAI-compatible route currently rejects `tools[].function.strict`, so `IBM_BOB_SUPPORTS_STRICT_MODE=false` is the default.

## Validation performed

Bob Shell SSO itself works locally:

```bash
bob --auth-method sso -m premium -p 'Reply with exactly: bob-ok' --hide-intermediary-output --output-format json
```

The response included `bob-ok` and successful usage stats for model `premium`.

The unauthenticated Bob model-info endpoint responds as expected when called with a normal User-Agent:

```bash
curl -H 'User-Agent: pi-bob/0.1.0' \
  https://api.us-east.bob.ibm.com/inference/v1/model/info
```

Result: HTTP `401` with `Authentication required`, confirming the discovered route exists and requires auth.

The Bob SSO endpoint flow was smoke-tested independently: browser SSO callback succeeded, token exchange succeeded, and `GET /inference/v1/model/info` returned HTTP `200` using the fresh SSO token.

The Pi provider registers with default settings when an env token is present:

```bash
IBM_BOB_API_KEY=dummy pi -e . --list-models | grep ibm-bob
```

Result:

```text
ibm-bob         premium                 200K     8.2K     no        no
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

## Install options

Temporary test load:

```bash
pi -e /Users/larry.song/work/hashicorp/pi-bob
```

Install as a local Pi package:

```bash
pi install /Users/larry.song/work/hashicorp/pi-bob
```

Remove later:

```bash
pi remove /Users/larry.song/work/hashicorp/pi-bob
```

## Next steps

Option 1 is wired to the discovered Bob OpenAI-compatible route and `/login ibm-bob` is implemented. Next useful improvements:

1. Add a `/bob-status` command that checks auth, model-info, selected instance, and selected team without printing secrets.
2. Add optional dynamic model discovery from `/inference/v1/model/info` after login.
3. Add tests around Bob's SSO callback and token refresh helpers.
