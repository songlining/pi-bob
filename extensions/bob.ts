import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

type CompatibleApi = "openai-completions" | "openai-responses" | "anthropic-messages";
type InputType = "text" | "image";
type MaxTokensField = "max_tokens" | "max_completion_tokens";

interface BobModelConfig {
	id: string;
	name: string;
	reasoning: boolean;
	input: InputType[];
	contextWindow: number;
	maxTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	compat?: Record<string, unknown>;
}

interface BobShellSettings {
	ibm?: {
		instanceId?: string;
		teamId?: string;
	};
}

interface BobTokenResponse {
	token: string;
	refresh_token?: string;
	expires_in?: number;
	expires_at?: number;
}

interface CallbackServer {
	port: number;
	callbackUri: string;
	code: Promise<string>;
	close(): void;
}

const PROVIDER_ID = "ibm-bob";
const DEFAULT_BOB_ORIGIN = "https://api.us-east.bob.ibm.com";
const DEFAULT_BASE_URL = `${DEFAULT_BOB_ORIGIN}/inference/v1`;
const DEFAULT_WEB_LOGIN_URL = "https://bob.ibm.com/login";
const DEFAULT_MODELS = ["premium"];
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 8192;
const SUPPORTED_APIS = new Set<CompatibleApi>(["openai-completions", "openai-responses", "anthropic-messages"]);

function env(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}

function envInt(name: string, fallback: number): number {
	const value = env(name);
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
	const value = env(name);
	if (!value) return fallback;
	if (["1", "true", "yes", "y", "on"].includes(value.toLowerCase())) return true;
	if (["0", "false", "no", "n", "off"].includes(value.toLowerCase())) return false;
	return fallback;
}

function envCsv(name: string, fallback: string[] = []): string[] {
	const value = env(name);
	if (!value) return fallback;
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function readBobShellSettings(): BobShellSettings | undefined {
	if (!envBool("IBM_BOB_READ_BOBSHELL_SETTINGS", true)) return undefined;

	try {
		const raw = readFileSync(join(homedir(), ".bob", "settings.json"), "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

		const ibm = (parsed as BobShellSettings).ibm;
		return {
			ibm: {
				instanceId: typeof ibm?.instanceId === "string" ? ibm.instanceId : undefined,
				teamId: typeof ibm?.teamId === "string" ? ibm.teamId : undefined,
			},
		};
	} catch {
		return undefined;
	}
}

function providerBaseUrl(): string {
	return env("IBM_BOB_BASE_URL") ?? DEFAULT_BASE_URL;
}

function bobOrigin(): string {
	const explicit = env("IBM_BOB_AUTH_BASE_URL");
	if (explicit) return explicit.replace(/\/$/, "");
	try {
		return new URL(providerBaseUrl()).origin;
	} catch {
		return DEFAULT_BOB_ORIGIN;
	}
}

function bobWebLoginUrl(): string {
	if (env("IBM_BOB_WEB_LOGIN_URL")) return env("IBM_BOB_WEB_LOGIN_URL")!;
	try {
		const host = new URL(bobOrigin()).host;
		if (host === "api.dev.bob.ibm.com") return "https://public-dev.bob.ibm.com/login";
		if (host === "api.qa-test.bob.ibm.com") return "https://qa.bob.ibm.com/login";
		return DEFAULT_WEB_LOGIN_URL;
	} catch {
		return DEFAULT_WEB_LOGIN_URL;
	}
}

function parseApi(): CompatibleApi {
	const requested = env("IBM_BOB_API") ?? "openai-completions";
	if (SUPPORTED_APIS.has(requested as CompatibleApi)) return requested as CompatibleApi;
	console.warn(
		`pi-bob: unsupported IBM_BOB_API=${JSON.stringify(requested)}; falling back to openai-completions.`,
	);
	return "openai-completions";
}

function parseInputTypes(): InputType[] {
	const values = envCsv("IBM_BOB_INPUT", ["text"]);
	const input = values.filter((value): value is InputType => value === "text" || value === "image");
	return input.length > 0 ? [...new Set(input)] : ["text"];
}

function parseJsonHeaders(): Record<string, string> | undefined {
	const json = env("IBM_BOB_HEADERS_JSON");
	if (!json) return undefined;

	try {
		const parsed = JSON.parse(json) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			console.warn("pi-bob: IBM_BOB_HEADERS_JSON must be a JSON object; ignoring it.");
			return undefined;
		}

		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === "string") headers[key] = value;
			else console.warn(`pi-bob: header ${JSON.stringify(key)} is not a string; ignoring it.`);
		}

		return Object.keys(headers).length > 0 ? headers : undefined;
	} catch (error) {
		console.warn(
			`pi-bob: failed to parse IBM_BOB_HEADERS_JSON; ignoring it. ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return undefined;
	}
}

function buildHeaders(settings?: BobShellSettings): Record<string, string> | undefined {
	const headers: Record<string, string> = {
		"User-Agent": env("IBM_BOB_USER_AGENT") ?? "pi-bob/0.1.0",
	};

	const instanceId = env("IBM_BOB_INSTANCE_ID") ?? settings?.ibm?.instanceId;
	const teamId = env("IBM_BOB_TEAM_ID") ?? settings?.ibm?.teamId;
	if (instanceId) headers["x-instance-id"] = instanceId;
	if (teamId) headers["x-team-id"] = teamId;

	const authScheme = env("IBM_BOB_AUTH_SCHEME");
	if (authScheme && authScheme.toLowerCase() !== "bearer") {
		headers.Authorization = `${authScheme} $IBM_BOB_API_KEY`;
	}

	const jsonHeaders = parseJsonHeaders();
	if (jsonHeaders) Object.assign(headers, jsonHeaders);

	return Object.keys(headers).length > 0 ? headers : undefined;
}

function modelName(id: string): string {
	const known: Record<string, string> = {
		premium: "IBM Bob Premium",
		pro: "IBM Bob Pro",
		flash: "IBM Bob Flash",
		"flash-lite": "IBM Bob Flash Lite",
		"bob-3-pro-preview": "IBM Bob 3 Pro Preview",
	};
	if (known[id]) return known[id];

	return id
		.split(/[/:._-]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function parseReasoningModels(): Set<string> {
	return new Set(envCsv("IBM_BOB_REASONING_MODELS"));
}

function buildOpenAiCompat(api: CompatibleApi): Record<string, unknown> | undefined {
	if (api === "anthropic-messages") return undefined;

	const compat: Record<string, unknown> = {
		supportsDeveloperRole: envBool("IBM_BOB_SUPPORTS_DEVELOPER_ROLE", false),
		supportsReasoningEffort: envBool("IBM_BOB_SUPPORTS_REASONING_EFFORT", false),
		supportsUsageInStreaming: envBool("IBM_BOB_SUPPORTS_USAGE_IN_STREAMING", true),
		supportsStrictMode: envBool("IBM_BOB_SUPPORTS_STRICT_MODE", false),
	};

	const maxTokensField = env("IBM_BOB_MAX_TOKENS_FIELD") as MaxTokensField | undefined;
	if (maxTokensField === "max_tokens" || maxTokensField === "max_completion_tokens") {
		compat.maxTokensField = maxTokensField;
	} else {
		compat.maxTokensField = api === "openai-completions" ? "max_tokens" : "max_completion_tokens";
	}

	return compat;
}

function buildAnthropicCompat(api: CompatibleApi): Record<string, unknown> | undefined {
	if (api !== "anthropic-messages") return undefined;

	return {
		supportsEagerToolInputStreaming: envBool("IBM_BOB_SUPPORTS_EAGER_TOOL_INPUT_STREAMING", false),
		supportsLongCacheRetention: envBool("IBM_BOB_SUPPORTS_LONG_CACHE_RETENTION", true),
		supportsCacheControlOnTools: envBool("IBM_BOB_SUPPORTS_CACHE_CONTROL_ON_TOOLS", true),
		forceAdaptiveThinking: envBool("IBM_BOB_FORCE_ADAPTIVE_THINKING", false),
		allowEmptySignature: envBool("IBM_BOB_ALLOW_EMPTY_SIGNATURE", false),
	};
}

function buildModels(api: CompatibleApi): BobModelConfig[] {
	const ids = envCsv("IBM_BOB_MODELS", DEFAULT_MODELS);
	const reasoningModels = parseReasoningModels();
	const allReasoning = envBool("IBM_BOB_REASONING", false);
	const input = parseInputTypes();
	const contextWindow = envInt("IBM_BOB_CONTEXT_WINDOW", DEFAULT_CONTEXT_WINDOW);
	const maxTokens = envInt("IBM_BOB_MAX_TOKENS", DEFAULT_MAX_TOKENS);
	const compat = buildOpenAiCompat(api) ?? buildAnthropicCompat(api);

	return ids.map((id) => ({
		id,
		name: modelName(id),
		reasoning: allReasoning || reasoningModels.has(id),
		input,
		contextWindow,
		maxTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...(compat ? { compat } : {}),
	}));
}

function jwtExpiry(accessToken: string): number | undefined {
	try {
		const [, payload] = accessToken.split(".");
		if (!payload) return undefined;
		const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
		const parsed = JSON.parse(json) as { exp?: unknown };
		if (typeof parsed.exp !== "number") return undefined;
		return parsed.exp * 1000 - 5 * 60 * 1000;
	} catch {
		return undefined;
	}
}

function credentialsFromTokenResponse(response: BobTokenResponse, previousRefresh?: string): OAuthCredentials {
	if (!response.token) throw new Error("IBM Bob SSO response did not include an access token.");
	return {
		access: response.token,
		refresh: response.refresh_token ?? previousRefresh ?? "",
		expires:
			jwtExpiry(response.token) ??
			(typeof response.expires_at === "number"
				? response.expires_at - 5 * 60 * 1000
				: Date.now() + (response.expires_in ?? 55 * 60) * 1000 - 5 * 60 * 1000),
	};
}

async function choosePort(): Promise<number> {
	const configured = envInt("SSO_PORT", 0) || envInt("IBM_BOB_SSO_PORT", 0);
	if (configured) return configured;

	return new Promise((resolve, reject) => {
		const server = createNetServer();
		server.on("error", reject);
		server.listen(0, () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : undefined;
			server.close(() => (port ? resolve(port) : reject(new Error("Failed to allocate callback port."))));
		});
	});
}

async function startCallbackServer(state: string): Promise<CallbackServer> {
	const port = await choosePort();
	const server = createServer();

	const code = new Promise<string>((resolve, reject) => {
		server.on("request", (req, res) => {
			if (!req.url?.startsWith("/bob-callback")) {
				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end("Not Found");
				return;
			}

			try {
				const url = new URL(req.url, `http://localhost:${port}`);
				const returnedState = url.searchParams.get("state");
				const authCode = url.searchParams.get("code");
				const error = url.searchParams.get("error");

				if (returnedState !== state) {
					res.writeHead(400, { "Content-Type": "text/plain" });
					res.end("Invalid state parameter");
					reject(new Error("Invalid state parameter from IBM Bob SSO callback."));
					return;
				}

				if (error) {
					res.writeHead(400, { "Content-Type": "text/plain" });
					res.end("Authentication failed");
					reject(new Error(`IBM Bob SSO failed: ${error}`));
					return;
				}

				if (!authCode) {
					res.writeHead(400, { "Content-Type": "text/plain" });
					res.end("Missing authorization code");
					reject(new Error("IBM Bob SSO callback did not include an authorization code."));
					return;
				}

				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(`<!doctype html>
<html><body style="font-family: system-ui; margin: 3rem;">
<h1>IBM Bob authentication successful</h1>
<p>You can close this window and return to Pi.</p>
<script>setTimeout(() => window.close(), 1000);</script>
</body></html>`);
				resolve(authCode);
				setTimeout(() => server.close(), 500);
			} catch (error) {
				reject(error);
			}
		});
		server.on("error", reject);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, () => {
			server.off("error", reject);
			resolve();
		});
	});

	return {
		port,
		callbackUri: `http://localhost:${port}/bob-callback`,
		code,
		close() {
			server.close();
		},
	};
}

async function postToken(path: "/authn/v1/auth/token" | "/authn/v1/auth/refresh", body: unknown): Promise<BobTokenResponse> {
	const response = await fetch(`${bobOrigin()}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "User-Agent": env("IBM_BOB_USER_AGENT") ?? "pi-bob/0.1.0" },
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		throw new Error(`IBM Bob SSO token request failed: ${response.status} ${await response.text()}`);
	}

	return (await response.json()) as BobTokenResponse;
}

async function loginBob(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const state = randomBytes(16).toString("hex");
	const callbackServer = await startCallbackServer(state);
	const loginUrl = new URL(bobWebLoginUrl());
	loginUrl.searchParams.set("callback_uri", callbackServer.callbackUri);
	loginUrl.searchParams.set("state", state);

	try {
		callbacks.onAuth({ url: loginUrl.toString() });
		callbacks.onDeviceCode?.({
			userCode: "Browser SSO",
			verificationUri: loginUrl.toString(),
			expiresInSeconds: Math.floor(envInt("IBM_BOB_LOGIN_TIMEOUT_MS", 180_000) / 1000),
		});

		const timeoutMs = envInt("IBM_BOB_LOGIN_TIMEOUT_MS", 180_000);
		const timeout = new Promise<never>((_resolve, reject) => {
			setTimeout(() => reject(new Error("IBM Bob SSO timed out.")), timeoutMs);
		});

		const code = await Promise.race([callbackServer.code, timeout]);
		return credentialsFromTokenResponse(await postToken("/authn/v1/auth/token", { code }));
	} finally {
		callbackServer.close();
	}
}

async function refreshBobToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	if (!credentials.refresh) throw new Error("No IBM Bob refresh token is available. Run /login ibm-bob again.");
	return credentialsFromTokenResponse(
		await postToken("/authn/v1/auth/refresh", { refresh_token: credentials.refresh }),
		credentials.refresh,
	);
}

export default function (pi: ExtensionAPI) {
	const api = parseApi();
	const settings = readBobShellSettings();
	const headers = buildHeaders(settings);

	pi.registerProvider(PROVIDER_ID, {
		name: "IBM Bob",
		baseUrl: providerBaseUrl(),
		apiKey: "$IBM_BOB_API_KEY",
		api,
		...(headers ? { headers } : {}),
		models: buildModels(api),
		oauth: {
			name: "IBM Bob SSO",
			login: loginBob,
			refreshToken: refreshBobToken,
			getApiKey: (credentials) => credentials.access,
		},
	});
}
