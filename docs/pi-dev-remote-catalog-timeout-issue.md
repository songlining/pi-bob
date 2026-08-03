# Remote-catalog refresh after `/login` has no timeout — login freezes for ~5 minutes when pi.dev API is unresponsive

## Summary

After a successful `/login` — reproduced after logging into **multiple providers** (`ibm-bob`, `google`, `deepseek`) — the post-login model refresh calls the pi.dev remote-catalog API with **no timeout**. When pi.dev's `/api/models/providers/*` is unresponsive, the login hangs for undici's default ~300s, and Ctrl-C/Escape cannot cancel it (no abort signal is wired into the post-login refresh). `PI_OFFLINE=1` avoids the call entirely and the login returns instantly.

## Environment

- pi 0.83.0 (`@earendil-works/pi-coding-agent`)
- macOS, direct network (no HTTP proxy configured)

## Steps to reproduce

1. Have any built-in provider credentialed (e.g. `google`, `deepseek`, or `github-copilot`) whose cached remote catalog is older than the 4h freshness window (`REMOTE_CATALOG_REFRESH_INTERVAL_MS`).
2. Run `/login <any-provider>` and complete auth. The login provider itself is irrelevant — the same freeze occurs for OAuth logins (`ibm-bob`) and API-key logins (`google`).
3. Post-login, pi calls `https://pi.dev/api/models/providers/<credentialedBuiltinId>` and blocks on it with no timeout.

## Evidence

- `curl https://pi.dev/api/models/providers/deepseek` → **no response within 30s** (HTTP 000), on IPv4 and IPv6, HTTP/1.1 and HTTP/2.
- `curl https://pi.dev/` (root) → HTTP 200 in ~77ms — the host is reachable; only the API path is unresponsive (server accepts TLS then goes silent). Last successful catalog refresh was written to `models-store.json` the previous day; the endpoint hung ~20h later, i.e. a pi.dev server-side regression, not a client/network issue.
- Reproduced after `/login` for `ibm-bob`, `google`, and `deepseek` — the freeze is independent of which provider is being logged in; it occurs whenever *any* credentialed built-in provider's catalog is stale. With several credentialed built-ins (`ibm-bob`, `google`, `deepseek`), multiple such fetches run in parallel post-login.
- Debug log during the freeze: the logged-in extension's own flow completes in ~21s (token exchange + model discovery), then the login stalls with no further progress until ~300s later.
- `ps` shows the process idle (0% CPU) while blocked on the fetch; the frozen state is indistinguishable from a deadlock to the user.

## Root cause

In `packages/coding-agent/src/core/remote-catalog-provider.ts` the refresh does:

```ts
const response = await fetch(url, {
  headers: { ... },
  signal: context.signal,   // undefined post-login → no timeout
});
```

Post-login, `context.signal` is `undefined` because `modelRuntime.login()` calls `this.refresh({ allowNetwork: this.modelNetworkEnabled })` without passing the login interaction's abort signal. Result: an untimed fetch that blocks the login completion for undici's default headers timeout (~300s), and which cannot be cancelled.

Note the **startup** refresh is bounded (15s AbortController, `model-runtime.ts`), but the **post-login** refresh is not.

## Impact

- Every `/login` for a user with any credentialed built-in provider can hang ~5 minutes whenever pi.dev's API is down/slow from their network.
- Ctrl-C/Escape is ineffective (dialog signal is not threaded into the refresh), so the user cannot abort; they may resort to killing the process.
- This also makes the whole process appear deadlocked, which complicates diagnosis.

## Suggested fix

- Use `signal: context.signal ?? AbortSignal.timeout(15_000)` in the remote-catalog fetch (mirroring the 15s startup bound).
- Thread the login interaction's abort signal into `modelRuntime.login()`'s `refresh()` call so Ctrl-C/Escape can cancel the post-login refresh.
- Consider an explicit timeout on the OAuth token refresh fetches too (e.g. github-copilot's `refreshGitHubCopilotAccessToken` fetch has no timeout and runs under the auth.json lock).

## Workaround

`PI_OFFLINE=1 pi` — skips the remote-catalog network refresh; `/login` returns to the prompt immediately after SSO.
