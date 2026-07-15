import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi, openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
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

export interface BobDiscoveredModel {
	id: string;
	backend: string;
	reasoning: boolean;
	supportsVision: boolean;
	contextWindow?: number;
	maxTokens?: number;
	cost: BobModelConfig["cost"];
}

interface BobOAuthCredentials extends OAuthCredentials {
	bobModelCatalog?: BobDiscoveredModel[];
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
	callbackUri: string;
	code: Promise<string>;
	close(): void;
}

const PROVIDER_ID = "ibm-bob";
const BOB_API = "ibm-bob-compatible" as Api;
const DEFAULT_BOB_ORIGIN = "https://api.us-east.bob.ibm.com";
const DEFAULT_BASE_URL = `${DEFAULT_BOB_ORIGIN}/inference/v1`;
const DEFAULT_WEB_LOGIN_URL = "https://bob.ibm.com/login";
const DEFAULT_MODELS = ["premium"];
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 5000;
const DEFAULT_TOKEN_REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_CATALOG_ENTRIES = 500;
const MAX_CATALOG_LABEL_LENGTH = 512;
const CATALOG_CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const CATALOG_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const SUPPORTED_APIS = new Set<CompatibleApi>(["openai-completions", "openai-responses", "anthropic-messages"]);

function env(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}

function envInt(name: string, fallback: number): number {
	return envOptionalInt(name) ?? fallback;
}

function envOptionalInt(name: string): number | undefined {
	const value = env(name);
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function envBool(name: string, fallback: boolean): boolean {
	const value = env(name);
	if (!value) return fallback;
	if (["1", "true", "yes", "y", "on"].includes(value.toLowerCase())) return true;
	if (["0", "false", "no", "n", "off"].includes(value.toLowerCase())) return false;
	return fallback;
}

function envOptionalBool(name: string): boolean | undefined {
	const value = env(name);
	if (!value) return undefined;
	if (["1", "true", "yes", "y", "on"].includes(value.toLowerCase())) return true;
	if (["0", "false", "no", "n", "off"].includes(value.toLowerCase())) return false;
	return undefined;
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

function providerRequestBaseUrl(api: CompatibleApi): string {
	const baseUrl = providerBaseUrl().replace(/\/+$/, "");
	return api === "anthropic-messages" ? baseUrl.replace(/\/inference\/v1$/, "/inference") : baseUrl;
}

function configuredApiKey(): { envName: "IBM_BOB_API_KEY" | "IBM_BOB_KEY"; value: string } | undefined {
	const primary = env("IBM_BOB_API_KEY");
	if (primary) return { envName: "IBM_BOB_API_KEY", value: primary };
	const alias = env("IBM_BOB_KEY");
	return alias ? { envName: "IBM_BOB_KEY", value: alias } : undefined;
}

function providerApiKeyReference(): string {
	return `$${configuredApiKey()?.envName ?? "IBM_BOB_API_KEY"}`;
}

function apiKeyAuthScheme(): string {
	return env("IBM_BOB_AUTH_SCHEME") ?? "Apikey";
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function perMillionCost(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
	const scaled = value * 1_000_000;
	return Number.isFinite(scaled) ? scaled : 0;
}

function safeCatalogLabel(value: unknown): string {
	if (typeof value !== "string") return "";
	const label = value.trim();
	return label && label.length <= MAX_CATALOG_LABEL_LENGTH && !CATALOG_CONTROL_CHARACTER.test(label) ? label : "";
}

export function parseBobModelCatalog(payload: unknown): BobDiscoveredModel[] {
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error("IBM Bob model-info response did not contain a data array.");
	}
	if (payload.data.length > MAX_CATALOG_ENTRIES) {
		throw new Error(`IBM Bob model-info response exceeded ${MAX_CATALOG_ENTRIES} entries.`);
	}

	const models: BobDiscoveredModel[] = [];
	const seen = new Set<string>();
	let structurallyValidEntries = 0;
	for (const entry of payload.data) {
		if (!isRecord(entry) || !isRecord(entry.model_info) || !isRecord(entry.litellm_params)) continue;
		const id = safeCatalogLabel(entry.model_name);
		const backend = safeCatalogLabel(entry.litellm_params.model);
		if (!id || !backend) continue;
		const exposed = entry.model_info.exposed;
		if (exposed !== undefined && typeof exposed !== "boolean") continue;
		structurallyValidEntries++;

		const visible = exposed === undefined || exposed === true;
		if (!visible || seen.has(id)) continue;

		seen.add(id);
		models.push({
			id,
			backend,
			reasoning:
				entry.model_info.supports_reasoning === true ||
				entry.model_info.supports_reasoning_effort === true ||
				entry.model_info.supports_thinking === true,
			supportsVision: entry.model_info.supports_vision === true,
			contextWindow: positiveNumber(entry.model_info.max_input_tokens),
			maxTokens: positiveNumber(entry.model_info.max_tokens),
			cost: {
				input: perMillionCost(entry.model_info.input_cost_per_token),
				output: perMillionCost(entry.model_info.output_cost_per_token),
				cacheRead: perMillionCost(entry.model_info.cache_read_input_token_cost),
				cacheWrite: perMillionCost(entry.model_info.cache_creation_input_token_cost),
			},
		});
	}

	if (structurallyValidEntries === 0) {
		throw new Error("IBM Bob model-info response contained no structurally valid model entries.");
	}
	if (models.length === 0) {
		throw new Error("IBM Bob model-info response contained no visible models.");
	}
	return models;
}

function sanitizeCachedCatalog(value: unknown): BobDiscoveredModel[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const models: BobDiscoveredModel[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (!isRecord(entry) || !isRecord(entry.cost)) continue;
		const id = safeCatalogLabel(entry.id);
		const backend = safeCatalogLabel(entry.backend);
		if (!id || !backend || seen.has(id)) continue;
		seen.add(id);
		models.push({
			id,
			backend,
			reasoning: entry.reasoning === true,
			supportsVision: entry.supportsVision === true,
			contextWindow: positiveNumber(entry.contextWindow),
			maxTokens: positiveNumber(entry.maxTokens),
			cost: {
				input: positiveNumber(entry.cost.input) ?? 0,
				output: positiveNumber(entry.cost.output) ?? 0,
				cacheRead: positiveNumber(entry.cost.cacheRead) ?? 0,
				cacheWrite: positiveNumber(entry.cost.cacheWrite) ?? 0,
			},
		});
	}
	return models.length > 0 ? models : undefined;
}

function cachedCatalog(credentials: OAuthCredentials | undefined): BobDiscoveredModel[] | undefined {
	return sanitizeCachedCatalog((credentials as BobOAuthCredentials | undefined)?.bobModelCatalog);
}

export function buildModels(api: CompatibleApi, discovered?: BobDiscoveredModel[]): BobModelConfig[] {
	const reasoningModels = parseReasoningModels();
	const reasoningOverride = envOptionalBool("IBM_BOB_REASONING");
	const inputOverride = env("IBM_BOB_INPUT") ? parseInputTypes() : undefined;
	const contextOverride = envOptionalInt("IBM_BOB_CONTEXT_WINDOW");
	const maxTokensOverride = envOptionalInt("IBM_BOB_MAX_TOKENS");
	const compat = buildOpenAiCompat(api) ?? buildAnthropicCompat(api);

	if (discovered && discovered.length > 0) {
		return discovered.map((model) => ({
			id: model.id,
			name: model.backend === model.id ? modelName(model.id) : `${modelName(model.id)} — ${model.backend}`,
			reasoning:
				reasoningOverride === true ||
				reasoningModels.has(model.id) ||
				(reasoningOverride === undefined && model.reasoning),
			input: inputOverride ?? (model.supportsVision ? ["text", "image"] : ["text"]),
			contextWindow: contextOverride ?? model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
			maxTokens: maxTokensOverride ?? model.maxTokens ?? DEFAULT_MAX_TOKENS,
			cost: model.cost,
			...(compat ? { compat } : {}),
		}));
	}

	const configuredIds = envCsv("IBM_BOB_MODELS", DEFAULT_MODELS);
	const ids = configuredIds.length > 0 ? configuredIds : DEFAULT_MODELS;
	const input = inputOverride ?? parseInputTypes();
	const contextWindow = contextOverride ?? DEFAULT_CONTEXT_WINDOW;
	const maxTokens = maxTokensOverride ?? DEFAULT_MAX_TOKENS;
	return ids.map((id) => ({
		id,
		name: modelName(id),
		reasoning: reasoningOverride === true || reasoningModels.has(id),
		input,
		contextWindow,
		maxTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...(compat ? { compat } : {}),
	}));
}

async function readBoundedResponseBody(response: Response): Promise<string> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
		throw new Error(`IBM Bob response exceeded ${MAX_RESPONSE_BYTES} bytes.`);
	}
	if (!response.body) return "";

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytesRead = 0;
	let body = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytesRead += value.byteLength;
			if (bytesRead > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw new Error(`IBM Bob response exceeded ${MAX_RESPONSE_BYTES} bytes.`);
			}
			body += decoder.decode(value, { stream: true });
		}
		return body + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

async function readJsonResponse(response: Response): Promise<unknown> {
	const body = await readBoundedResponseBody(response);
	return JSON.parse(body);
}

function truncateHttpBody(body: string): string {
	const trimmed = body.trim();
	const truncated = trimmed.length > 512 ? `${trimmed.slice(0, 512)}…` : trimmed;
	return truncated.replace(CATALOG_CONTROL_CHARACTERS, (character) =>
		`\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

async function fetchBobModelCatalog(
	accessToken: string,
	authScheme: string,
	settings?: BobShellSettings,
): Promise<BobDiscoveredModel[]> {
	const controller = new AbortController();
	const timeoutMs = envInt("IBM_BOB_MODEL_DISCOVERY_TIMEOUT_MS", DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS);
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const headers: Record<string, string> = {
		Accept: "application/json",
		Authorization: `${authScheme} ${accessToken}`,
		"User-Agent": env("IBM_BOB_USER_AGENT") ?? "pi-bob/0.1.0",
	};
	const instanceId = env("IBM_BOB_INSTANCE_ID") ?? settings?.ibm?.instanceId;
	const teamId = env("IBM_BOB_TEAM_ID") ?? settings?.ibm?.teamId;
	if (instanceId) headers["x-instance-id"] = instanceId;
	if (teamId) headers["x-team-id"] = teamId;

	try {
		const response = await fetch(`${providerBaseUrl().replace(/\/+$/, "")}/model/info`, {
			method: "GET",
			headers,
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(
				`IBM Bob model discovery failed: ${response.status} ${truncateHttpBody(await readBoundedResponseBody(response))}`.trim(),
			);
		}
		return parseBobModelCatalog(await readJsonResponse(response));
	} catch (error) {
		if (controller.signal.aborted) {
			throw new Error(`IBM Bob model discovery timed out after ${timeoutMs}ms.`);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function attachBobModelCatalog(
	credentials: OAuthCredentials,
	previous?: OAuthCredentials,
): Promise<BobOAuthCredentials> {
	if (!envBool("IBM_BOB_DISCOVER_MODELS", true)) {
		const previousCatalog = cachedCatalog(previous);
		return previousCatalog ? { ...credentials, bobModelCatalog: previousCatalog } : credentials;
	}

	try {
		const catalog = await fetchBobModelCatalog(credentials.access, "Bearer", readBobShellSettings());
		return { ...credentials, bobModelCatalog: catalog };
	} catch (error) {
		const previousCatalog = cachedCatalog(previous);
		console.warn(
			`pi-bob: ${error instanceof Error ? error.message : String(error)} Using ${
				previousCatalog ? "the previously cached catalog" : "configured fallback models"
			}.`,
		);
		return previousCatalog ? { ...credentials, bobModelCatalog: previousCatalog } : credentials;
	}
}

function jwtPayload(accessToken: string): Record<string, unknown> | undefined {
	try {
		const parts = accessToken.split(".");
		if (parts.length !== 3 || !parts[1]) return undefined;
		const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
		const parsed = JSON.parse(json) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function jwtExpiry(accessToken: string): number | undefined {
	const exp = jwtPayload(accessToken)?.exp;
	return typeof exp === "number" ? exp * 1000 - 5 * 60 * 1000 : undefined;
}

export function applyBobAuthHeaders(
	headers: Record<string, string | null | undefined>,
	resolvedCredential?: string,
): void {
	let token = resolvedCredential;
	if (!token) {
		for (const [name, value] of Object.entries(headers)) {
			if (typeof value !== "string") continue;
			const lowerName = name.toLowerCase();
			if (lowerName === "authorization") {
				const match = value.match(/^\s*(?:Bearer|Apikey)\s+(.+)\s*$/iu);
				if (match?.[1]) token = match[1];
			} else if (lowerName === "x-api-key" && value.trim()) {
				token ??= value.trim();
			}
		}
	}
	if (!token) return;

	for (const name of Object.keys(headers)) {
		const lowerName = name.toLowerCase();
		if (lowerName === "authorization" || lowerName === "x-api-key") headers[name] = null;
	}
	const scheme = jwtPayload(token) ? "Bearer" : apiKeyAuthScheme();
	headers.Authorization = `${scheme} ${token}`;
}

function streamBob(
	adapter: CompatibleApi,
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const mutableHeaders: Record<string, string | null | undefined> = { ...options?.headers };
	applyBobAuthHeaders(mutableHeaders, options?.apiKey);
	const headers = Object.fromEntries(
		Object.entries(mutableHeaders).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
	const hasHeaderAuth = Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
	const forwardedOptions: SimpleStreamOptions = { ...options, headers };

	switch (adapter) {
		case "anthropic-messages":
			return anthropicMessagesApi().streamSimple(model as Model<"anthropic-messages">, context, {
				...forwardedOptions,
				apiKey: hasHeaderAuth ? undefined : options?.apiKey,
			});
		case "openai-responses":
			return openAIResponsesApi().streamSimple(model as Model<"openai-responses">, context, {
				...forwardedOptions,
				apiKey: hasHeaderAuth ? "pi-bob-header-auth" : options?.apiKey,
			});
		default:
			return openAICompletionsApi().streamSimple(model as Model<"openai-completions">, context, {
				...forwardedOptions,
				apiKey: hasHeaderAuth ? "pi-bob-header-auth" : options?.apiKey,
			});
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
		callbackUri: `http://localhost:${port}/bob-callback`,
		code,
		close() {
			server.close();
		},
	};
}

async function postToken(path: "/authn/v1/auth/token" | "/authn/v1/auth/refresh", body: unknown): Promise<BobTokenResponse> {
	const controller = new AbortController();
	const timeoutMs = envInt("IBM_BOB_TOKEN_REQUEST_TIMEOUT_MS", DEFAULT_TOKEN_REQUEST_TIMEOUT_MS);
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`${bobOrigin()}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "User-Agent": env("IBM_BOB_USER_AGENT") ?? "pi-bob/0.1.0" },
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		if (!response.ok) {
			throw new Error(
				`IBM Bob SSO token request failed: ${response.status} ${truncateHttpBody(await readBoundedResponseBody(response))}`,
			);
		}

		return (await readJsonResponse(response)) as BobTokenResponse;
	} catch (error) {
		if (controller.signal.aborted) throw new Error(`IBM Bob SSO token request timed out after ${timeoutMs}ms.`);
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function loginBob(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const state = randomBytes(16).toString("hex");
	const callbackServer = await startCallbackServer(state);
	const loginUrl = new URL(bobWebLoginUrl());
	loginUrl.searchParams.set("callback_uri", callbackServer.callbackUri);
	loginUrl.searchParams.set("state", state);

	let loginTimeout: ReturnType<typeof setTimeout> | undefined;
	try {
		callbacks.onAuth({ url: loginUrl.toString() });

		const timeoutMs = envInt("IBM_BOB_LOGIN_TIMEOUT_MS", 180_000);
		const timeout = new Promise<never>((_resolve, reject) => {
			loginTimeout = setTimeout(() => reject(new Error("IBM Bob SSO timed out.")), timeoutMs);
		});

		const code = await Promise.race([callbackServer.code, timeout]);
		const credentials = credentialsFromTokenResponse(await postToken("/authn/v1/auth/token", { code }));
		return attachBobModelCatalog(credentials);
	} finally {
		if (loginTimeout) clearTimeout(loginTimeout);
		callbackServer.close();
	}
}

async function refreshBobToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	if (!credentials.refresh) throw new Error("No IBM Bob refresh token is available. Run /login ibm-bob again.");
	const refreshed = credentialsFromTokenResponse(
		await postToken("/authn/v1/auth/refresh", { refresh_token: credentials.refresh }),
		credentials.refresh,
	);
	return attachBobModelCatalog(refreshed, credentials);
}

function modifyModelsFromCachedCatalog(
	models: Model<Api>[],
	credentials: OAuthCredentials,
	api: CompatibleApi,
): Model<Api>[] {
	if (!envBool("IBM_BOB_DISCOVER_MODELS", true)) return models;
	const catalog = cachedCatalog(credentials);
	const otherProviders = models.filter((model) => model.provider !== PROVIDER_ID);
	const discovered = buildModels(api, catalog).map(
		(model) =>
			({
				...model,
				api: BOB_API,
				provider: PROVIDER_ID,
				baseUrl: providerRequestBaseUrl(api),
			}) as Model<Api>,
	);
	return [...otherProviders, ...discovered];
}

export default async function (pi: ExtensionAPI) {
	const api = parseApi();
	const settings = readBobShellSettings();
	const headers = buildHeaders(settings);
	let catalog: BobDiscoveredModel[] | undefined;
	const apiKey = configuredApiKey();
	if (apiKey && envBool("IBM_BOB_DISCOVER_MODELS", true)) {
		try {
			catalog = await fetchBobModelCatalog(apiKey.value, apiKeyAuthScheme(), settings);
		} catch (error) {
			console.warn(
				`pi-bob: ${error instanceof Error ? error.message : String(error)} Using configured fallback models.`,
			);
		}
	}

	pi.registerProvider(PROVIDER_ID, {
		name: "IBM Bob",
		baseUrl: providerRequestBaseUrl(api),
		apiKey: providerApiKeyReference(),
		api: BOB_API,
		...(headers ? { headers } : {}),
		models: buildModels(api, catalog),
		streamSimple: (model, context, options) => streamBob(api, model, context, options),
		oauth: {
			name: "IBM Bob SSO",
			login: loginBob,
			refreshToken: refreshBobToken,
			getApiKey: (credentials) => credentials.access,
			modifyModels: (models, credentials) => modifyModelsFromCachedCatalog(models, credentials, api),
		},
	});
}
