import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createServer as createNetServer } from "node:net";
import bobProvider, {
	applyBobAuthHeaders,
	buildModels,
	parseBobModelCatalog,
	type BobDiscoveredModel,
} from "./bob.ts";

const ENV_KEYS = [
	"IBM_BOB_API",
	"IBM_BOB_API_KEY",
	"IBM_BOB_KEY",
	"IBM_BOB_AUTH_BASE_URL",
	"IBM_BOB_AUTH_SCHEME",
	"IBM_BOB_BASE_URL",
	"IBM_BOB_CONTEXT_WINDOW",
	"IBM_BOB_DISCOVER_MODELS",
	"IBM_BOB_FORCE_ADAPTIVE_THINKING",
	"IBM_BOB_HEADERS_JSON",
	"IBM_BOB_INPUT",
	"IBM_BOB_INSTANCE_ID",
	"IBM_BOB_MAX_TOKENS",
	"IBM_BOB_MAX_TOKENS_FIELD",
	"IBM_BOB_MODEL_DISCOVERY_TIMEOUT_MS",
	"IBM_BOB_MODELS",
	"IBM_BOB_LOGIN_TIMEOUT_MS",
	"IBM_BOB_SSO_PORT",
	"IBM_BOB_READ_BOBSHELL_SETTINGS",
	"IBM_BOB_REASONING",
	"IBM_BOB_REASONING_MODELS",
	"IBM_BOB_SUPPORTS_CACHE_CONTROL_ON_TOOLS",
	"IBM_BOB_SUPPORTS_DEVELOPER_ROLE",
	"IBM_BOB_SUPPORTS_EAGER_TOOL_INPUT_STREAMING",
	"IBM_BOB_SUPPORTS_LONG_CACHE_RETENTION",
	"IBM_BOB_SUPPORTS_REASONING_EFFORT",
	"IBM_BOB_SUPPORTS_STRICT_MODE",
	"IBM_BOB_SUPPORTS_USAGE_IN_STREAMING",
	"IBM_BOB_TEAM_ID",
	"IBM_BOB_TOKEN_REQUEST_TIMEOUT_MS",
	"IBM_BOB_USER_AGENT",
	"IBM_BOB_WEB_LOGIN_URL",
	"IBM_BOB_ALLOW_EMPTY_SIGNATURE",
	"SSO_PORT",
] as const;

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
	for (const key of ENV_KEYS) delete process.env[key];
	process.env.IBM_BOB_READ_BOBSHELL_SETTINGS = "false";
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	console.warn = originalWarn;
	for (const key of ENV_KEYS) {
		const value = originalEnv.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function modelInfoPayload() {
	return {
		data: [
			{
				model_name: "premium-ide",
				litellm_params: { model: "bedrock/us.anthropic.claude-sonnet-4-6" },
				model_info: {
					max_input_tokens: 270_000,
					max_tokens: 64_000,
					supports_vision: true,
					supports_reasoning: true,
					input_cost_per_token: 0.0000027,
					output_cost_per_token: 0.0000135,
					cache_read_input_token_cost: 0.0000003,
					cache_creation_input_token_cost: 0.00000375,
				},
			},
			{
				model_name: "internal-only",
				litellm_params: { model: "secret/backend" },
				model_info: { exposed: false },
			},
			{
				model_name: "premium-ide",
				litellm_params: { model: "duplicate/backend" },
				model_info: { exposed: true },
			},
		],
	};
}

async function availablePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createNetServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : undefined;
			server.close(() => (port ? resolve(port) : reject(new Error("No test port was allocated."))));
		});
	});
}

async function assertPortCanBeRebound(port: number): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const server = createNetServer();
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
	});
}

function captureProviderRegistration() {
	let registration: any;
	const pi = {
		registerProvider(_id: string, config: unknown) {
			registration = config;
		},
	} as ExtensionAPI;
	return {
		pi,
		get registration() {
			return registration;
		},
	};
}

describe("Bob model catalog", () => {
	test("parses visible LiteLLM models and converts per-token costs to per-million costs", () => {
		const models = parseBobModelCatalog(modelInfoPayload());
		expect(models).toHaveLength(1);
		expect(models[0]).toEqual({
			id: "premium-ide",
			backend: "bedrock/us.anthropic.claude-sonnet-4-6",
			reasoning: true,
			supportsVision: true,
			contextWindow: 270_000,
			maxTokens: 64_000,
			cost: { input: 2.7, output: 13.5, cacheRead: 0.3, cacheWrite: 3.75 },
		});
	});

	test("treats omitted exposed as visible while honoring explicit false", () => {
		const models = parseBobModelCatalog({
			data: [
				{
					model_name: "default-visible",
					litellm_params: { model: "backend/default" },
					model_info: {},
				},
				{
					model_name: "explicit-visible",
					litellm_params: { model: "backend/explicit" },
					model_info: { exposed: true },
				},
				{
					model_name: "hidden",
					litellm_params: { model: "backend/hidden" },
					model_info: { exposed: false },
				},
				{
					model_name: "malformed-visibility",
					litellm_params: { model: "backend/malformed" },
					model_info: { exposed: "false" },
				},
			],
		});

		expect(models.map(({ id }) => id)).toEqual(["default-visible", "explicit-visible"]);
	});

	test("rejects terminal control characters in catalog labels", () => {
		const models = parseBobModelCatalog({
			data: [
				{
					model_name: "safe-model",
					litellm_params: { model: "backend/safe" },
					model_info: {},
				},
				{
					model_name: "evil\u001b]52;c;clipboard\u0007",
					litellm_params: { model: "backend/evil" },
					model_info: {},
				},
			],
		});
		expect(models.map(({ id }) => id)).toEqual(["safe-model"]);
	});

	test("rejects catalogs when every model is hidden", () => {
		expect(() =>
			parseBobModelCatalog({
				data: [{ model_name: "hidden", model_info: { exposed: false }, litellm_params: { model: "x" } }],
			}),
		).toThrow("no visible models");
	});

	test("rejects catalogs containing only malformed visibility flags", () => {
		expect(() =>
			parseBobModelCatalog({
				data: [{ model_name: "bad", model_info: { exposed: "true" }, litellm_params: { model: "x" } }],
			}),
		).toThrow("no structurally valid model entries");
	});

	test("does not allow extreme token prices to become Infinity", () => {
		const payload = modelInfoPayload();
		payload.data[0]!.model_info.input_cost_per_token = Number.MAX_VALUE;
		expect(parseBobModelCatalog(payload)[0]?.cost.input).toBe(0);
	});

	test("uses default fallback models for empty discovered and configured lists", () => {
		process.env.IBM_BOB_MODELS = ",,,";
		expect(buildModels("openai-completions", []).map(({ id }) => id)).toEqual(["premium"]);
	});

	test("lets explicit environment metadata override discovered values", () => {
		process.env.IBM_BOB_CONTEXT_WINDOW = "123456";
		process.env.IBM_BOB_MAX_TOKENS = "4321";
		process.env.IBM_BOB_INPUT = "text";
		process.env.IBM_BOB_REASONING = "false";
		const discovered: BobDiscoveredModel[] = [
			{
				id: "premium-ide",
				backend: "bedrock/claude",
				reasoning: true,
				supportsVision: true,
				contextWindow: 270_000,
				maxTokens: 64_000,
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			},
		];
		const [model] = buildModels("openai-completions", discovered);
		expect(model.contextWindow).toBe(123456);
		expect(model.maxTokens).toBe(4321);
		expect(model.input).toEqual(["text"]);
		expect(model.reasoning).toBe(false);
	});
});

describe("inference authentication", () => {
	const ssoToken = `header.${Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString("base64url")}.signature`;

	test("rewrites an OpenAI adapter bearer header for an opaque Bob API key", () => {
		const headers = { authorization: "Bearer selected-api-key" };
		applyBobAuthHeaders(headers);
		expect(headers.authorization).toBeNull();
		expect(headers.Authorization).toBe("Apikey selected-api-key");
	});

	test("keeps the resolved SSO JWT as Bearer even when an environment API key also exists", () => {
		process.env.IBM_BOB_API_KEY = "different-environment-key";
		const headers = { Authorization: `Bearer ${ssoToken}` };
		applyBobAuthHeaders(headers);
		expect(headers.Authorization).toBe(`Bearer ${ssoToken}`);
	});

	test("converts Anthropic x-api-key authentication for API keys and SSO", () => {
		const apiKeyHeaders: Record<string, string | null> = { "x-api-key": "selected-api-key" };
		applyBobAuthHeaders(apiKeyHeaders);
		expect(apiKeyHeaders["x-api-key"]).toBeNull();
		expect(apiKeyHeaders.Authorization).toBe("Apikey selected-api-key");

		const ssoHeaders: Record<string, string | null> = { "x-api-key": ssoToken };
		applyBobAuthHeaders(ssoHeaders);
		expect(ssoHeaders["x-api-key"]).toBeNull();
		expect(ssoHeaders.Authorization).toBe(`Bearer ${ssoToken}`);
	});

	test("honors an explicit Bearer override for opaque credentials", () => {
		process.env.IBM_BOB_AUTH_SCHEME = "Bearer";
		const headers = { Authorization: "Bearer opaque-bearer-token" };
		applyBobAuthHeaders(headers);
		expect(headers.Authorization).toBe("Bearer opaque-bearer-token");
	});

	for (const [api, expectedPath] of [
		["openai-completions", "/inference/v1/chat/completions"],
		["openai-responses", "/inference/v1/responses"],
		["anthropic-messages", "/inference/v1/messages"],
	] as const) {
		test(`sends only Apikey auth through the ${api} adapter`, async () => {
			process.env.IBM_BOB_API = api;
			process.env.IBM_BOB_API_KEY = "adapter-test-key";
			process.env.IBM_BOB_DISCOVER_MODELS = "false";
			let request: Request | undefined;
			globalThis.fetch = (async (input, init) => {
				request = new Request(input, init);
				return new Response(JSON.stringify({ error: { message: "expected test stop" } }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}) as typeof fetch;

			const captured = captureProviderRegistration();
			await bobProvider(captured.pi);
			const config = captured.registration.models[0];
			const model = {
				...config,
				api: captured.registration.api,
				provider: "ibm-bob",
				baseUrl: captured.registration.baseUrl,
			};
			const stream = captured.registration.streamSimple(
				model,
				{ messages: [{ role: "user", content: "test", timestamp: Date.now() }] },
				{ apiKey: "adapter-test-key" },
			);
			for await (const _event of stream) {
				// Consume the expected authentication error so the adapter finalizes.
			}

			expect(new URL(request!.url).pathname).toBe(expectedPath);
			expect(request!.headers.get("authorization")).toBe("Apikey adapter-test-key");
			expect(request!.headers.has("x-api-key")).toBe(false);
		});
	}
});

describe("provider discovery", () => {
	test("discovers API-key models during startup using the Apikey scheme", async () => {
		process.env.IBM_BOB_API_KEY = "test-api-key";
		let requestUrl = "";
		let requestHeaders: Record<string, string> = {};
		globalThis.fetch = (async (input, init) => {
			requestUrl = String(input);
			requestHeaders = init?.headers as Record<string, string>;
			return new Response(JSON.stringify(modelInfoPayload()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const captured = captureProviderRegistration();
		await bobProvider(captured.pi);

		expect(requestUrl).toBe("https://api.us-east.bob.ibm.com/inference/v1/model/info");
		expect(requestHeaders.Authorization).toBe("Apikey test-api-key");
		expect(captured.registration.api).toBe("ibm-bob-compatible");
		expect(captured.registration.apiKey).toBe("$IBM_BOB_API_KEY");
		expect(captured.registration.headers.Authorization).toBeUndefined();
		expect(captured.registration.models.map((model: any) => model.id)).toEqual(["premium-ide"]);
		expect(captured.registration.models[0].contextWindow).toBe(270_000);
	});

	test("uses the stored SSO catalog when it is Pi's active credential over an environment key", async () => {
		process.env.IBM_BOB_API_KEY = "test-api-key";
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(modelInfoPayload()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})) as typeof fetch;
		const captured = captureProviderRegistration();
		await bobProvider(captured.pi);
		const staleSsoCatalog: BobDiscoveredModel[] = [
			{
				id: "stale-sso-model",
				backend: "backend/stale",
				reasoning: false,
				supportsVision: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		];

		const apiKeyModels = captured.registration.models.map((model: any) => ({
			...model,
			provider: "ibm-bob",
			api: captured.registration.api,
			baseUrl: captured.registration.baseUrl,
		}));
		const modified = captured.registration.oauth.modifyModels(apiKeyModels, {
			access: "stored-sso-token",
			refresh: "stored-refresh",
			expires: Date.now() + 60_000,
			bobModelCatalog: staleSsoCatalog,
		});
		expect(modified.map((model: any) => model.id)).toEqual(["stale-sso-model"]);
	});

	test("uses fallback models for stored SSO credentials that have no cached catalog", async () => {
		process.env.IBM_BOB_API_KEY = "test-api-key";
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(modelInfoPayload()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})) as typeof fetch;
		const captured = captureProviderRegistration();
		await bobProvider(captured.pi);
		const apiKeyModels = captured.registration.models.map((model: any) => ({
			...model,
			provider: "ibm-bob",
			api: captured.registration.api,
			baseUrl: captured.registration.baseUrl,
		}));

		const modified = captured.registration.oauth.modifyModels(apiKeyModels, {
			access: "stored-sso-token",
			refresh: "stored-refresh",
			expires: Date.now() + 60_000,
		});
		expect(modified.map((model: any) => model.id)).toEqual(["premium"]);
	});

	test("accepts IBM_BOB_KEY as an API-key alias", async () => {
		process.env.IBM_BOB_KEY = "alias-key";
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(modelInfoPayload()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})) as typeof fetch;
		const captured = captureProviderRegistration();
		await bobProvider(captured.pi);
		expect(captured.registration.apiKey).toBe("$IBM_BOB_KEY");
		expect(captured.registration.headers.Authorization).toBeUndefined();
	});

	test("falls back to configured models when discovery fails without logging terminal controls", async () => {
		process.env.IBM_BOB_API_KEY = "test-api-key";
		process.env.IBM_BOB_MODELS = "manual-model";
		globalThis.fetch = (async () => new Response("unavailable\u001b]52;c;clipboard\u0007", { status: 503 })) as typeof fetch;
		let warning = "";
		console.warn = (message) => {
			warning = String(message);
		};
		const captured = captureProviderRegistration();
		await bobProvider(captured.pi);
		expect(captured.registration.models.map((model: any) => model.id)).toEqual(["manual-model"]);
		expect(warning).not.toContain("\u001b");
		expect(warning).not.toContain("\u0007");
		expect(warning).toContain("\\u001b");
	});

	test("falls back when model-info contains only malformed entries", async () => {
		process.env.IBM_BOB_API_KEY = "test-api-key";
		process.env.IBM_BOB_MODELS = "manual-model";
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ data: [{}] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})) as typeof fetch;
		console.warn = () => {};

		const captured = captureProviderRegistration();
		await bobProvider(captured.pi);
		expect(captured.registration.models.map((model: any) => model.id)).toEqual(["manual-model"]);
	});

	test("uses fallback models when a stored SSO catalog is malformed", async () => {
		const captured = captureProviderRegistration();
		await bobProvider(captured.pi);
		const existingModels = captured.registration.models.map((model: any) => ({
			...model,
			provider: "ibm-bob",
			api: captured.registration.api,
			baseUrl: captured.registration.baseUrl,
		}));
		const modified = captured.registration.oauth.modifyModels(existingModels, {
			access: "stored-sso-token",
			refresh: "stored-refresh",
			expires: Date.now() + 60_000,
			bobModelCatalog: [{ id: "\u001b]52;c;bad\u0007", backend: "backend/bad", cost: {} }],
		});
		expect(modified.map((model: any) => model.id)).toEqual(["premium"]);
	});

	test("falls back after model discovery times out", async () => {
		process.env.IBM_BOB_API_KEY = "test-api-key";
		process.env.IBM_BOB_MODEL_DISCOVERY_TIMEOUT_MS = "20";
		globalThis.fetch = ((_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
			})) as typeof fetch;
		console.warn = () => {};
		const captured = captureProviderRegistration();
		await bobProvider(captured.pi);
		expect(captured.registration.models.map((model: any) => model.id)).toEqual(["premium"]);
	});

	test("uses fallback models when every discovered model is hidden", async () => {
		process.env.IBM_BOB_API_KEY = "test-api-key";
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					data: [
						{ model_name: "premium", litellm_params: { model: "backend/premium" }, model_info: { exposed: false } },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			)) as typeof fetch;

		console.warn = () => {};
		const captured = captureProviderRegistration();
		await bobProvider(captured.pi);
		expect(captured.registration.models.map((model: any) => model.id)).toEqual(["premium"]);
	});

	test("completes browser SSO callback, token exchange, and catalog discovery", async () => {
		const port = await availablePort();
		process.env.IBM_BOB_SSO_PORT = String(port);
		const calls: string[] = [];
		globalThis.fetch = (async (input) => {
			const url = String(input);
			calls.push(url);
			if (url.endsWith("/authn/v1/auth/token")) {
				return new Response(JSON.stringify({ token: "login-sso-token", refresh_token: "login-refresh", expires_in: 3600 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.endsWith("/inference/v1/model/info")) {
				return new Response(JSON.stringify(modelInfoPayload()), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected mocked request: ${url}`);
		}) as typeof fetch;

		const captured = captureProviderRegistration();
		await bobProvider(captured.pi);
		const credentials = await captured.registration.oauth.login({
			onAuth({ url }: { url: string }) {
				const loginUrl = new URL(url);
				const callbackUrl = new URL(loginUrl.searchParams.get("callback_uri")!);
				callbackUrl.searchParams.set("state", loginUrl.searchParams.get("state")!);
				callbackUrl.searchParams.set("code", "browser-code");
				queueMicrotask(() => void originalFetch(callbackUrl));
			},
		});

		expect(credentials.access).toBe("login-sso-token");
		expect(credentials.refresh).toBe("login-refresh");
		expect(credentials.bobModelCatalog).toHaveLength(1);
		expect(calls).toEqual([
			"https://api.us-east.bob.ibm.com/authn/v1/auth/token",
			"https://api.us-east.bob.ibm.com/inference/v1/model/info",
		]);
	});

	test("rejects a forged callback state without exchanging a token", async () => {
		const port = await availablePort();
		process.env.IBM_BOB_SSO_PORT = String(port);
		let tokenCalls = 0;
		globalThis.fetch = (async (input) => {
			if (String(input).endsWith("/authn/v1/auth/token")) tokenCalls++;
			throw new Error(`Unexpected mocked request: ${String(input)}`);
		}) as typeof fetch;
		const captured = captureProviderRegistration();
		await bobProvider(captured.pi);
		let callbackResponse: Promise<Response> | undefined;
		const login = captured.registration.oauth.login({
			onAuth({ url }: { url: string }) {
				const loginUrl = new URL(url);
				const callbackUrl = new URL(loginUrl.searchParams.get("callback_uri")!);
				callbackUrl.searchParams.set("state", "forged-state");
				callbackUrl.searchParams.set("code", "browser-code");
				callbackResponse = originalFetch(callbackUrl);
			},
		});

		await expect(login).rejects.toThrow("Invalid state parameter");
		expect((await callbackResponse)?.status).toBe(400);
		expect(tokenCalls).toBe(0);
		await assertPortCanBeRebound(port);
	});

	test("closes the browser callback server after login timeout", async () => {
		const port = await availablePort();
		process.env.IBM_BOB_SSO_PORT = String(port);
		process.env.IBM_BOB_LOGIN_TIMEOUT_MS = "20";
		const captured = captureProviderRegistration();
		await bobProvider(captured.pi);

		await expect(captured.registration.oauth.login({ onAuth() {} })).rejects.toThrow("timed out");
		await assertPortCanBeRebound(port);
	});

	test("times out stalled SSO token requests", async () => {
		process.env.IBM_BOB_TOKEN_REQUEST_TIMEOUT_MS = "20";
		globalThis.fetch = ((_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
			})) as typeof fetch;
		const captured = captureProviderRegistration();
		await bobProvider(captured.pi);

		await expect(
			captured.registration.oauth.refreshToken({
				access: "old-sso-token",
				refresh: "refresh-token",
				expires: 0,
			}),
		).rejects.toThrow("timed out after 20ms");
	});

	test("sanitizes terminal controls in SSO token errors", async () => {
		globalThis.fetch = (async () =>
			new Response("denied\u001b]52;c;clipboard\u0007", { status: 503 })) as typeof fetch;
		const captured = captureProviderRegistration();
		await bobProvider(captured.pi);

		try {
			await captured.registration.oauth.refreshToken({
				access: "old-sso-token",
				refresh: "refresh-token",
				expires: 0,
			});
			throw new Error("Expected refreshToken to reject.");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).not.toContain("\u001b");
			expect(message).not.toContain("\u0007");
			expect(message).toContain("\\u001b");
		}
	});

	test("refreshes and restores an SSO catalog with Bearer routing headers", async () => {
		process.env.IBM_BOB_INSTANCE_ID = "instance-1";
		process.env.IBM_BOB_TEAM_ID = "team-1";
		const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			calls.push({ url, headers: init?.headers as Record<string, string> | undefined });
			if (url.endsWith("/authn/v1/auth/refresh")) {
				return new Response(JSON.stringify({ token: "fresh-sso-token", expires_in: 3600 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify(modelInfoPayload()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const captured = captureProviderRegistration();
		await bobProvider(captured.pi);
		const credentials = await captured.registration.oauth.refreshToken({
			access: "old-sso-token",
			refresh: "refresh-token",
			expires: 0,
		});
		const modelCall = calls.find((call) => call.url.endsWith("/inference/v1/model/info"));
		expect(modelCall?.headers?.Authorization).toBe("Bearer fresh-sso-token");
		expect(modelCall?.headers?.["x-instance-id"]).toBe("instance-1");
		expect(modelCall?.headers?.["x-team-id"]).toBe("team-1");
		expect(credentials.bobModelCatalog).toHaveLength(1);

		const existingModels = [
			{
				id: "premium",
				name: "fallback",
				api: "openai-completions",
				provider: "ibm-bob",
				baseUrl: "https://example.test",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8192,
			},
			{
				id: "other-model",
				name: "other",
				api: "openai-completions",
				provider: "other-provider",
				baseUrl: "https://example.test",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000,
				maxTokens: 100,
			},
		];
		const modified = captured.registration.oauth.modifyModels(existingModels, credentials);
		expect(modified.map((model: any) => `${model.provider}/${model.id}`)).toEqual([
			"other-provider/other-model",
			"ibm-bob/premium-ide",
		]);
	});

	test("preserves the previous SSO catalog when rediscovery fails", async () => {
		globalThis.fetch = (async (input) => {
			const url = String(input);
			if (url.endsWith("/authn/v1/auth/refresh")) {
				return new Response(JSON.stringify({ token: "fresh-sso-token", expires_in: 3600 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("unavailable", { status: 503 });
		}) as typeof fetch;
		console.warn = () => {};
		const previousCatalog = parseBobModelCatalog(modelInfoPayload());
		const captured = captureProviderRegistration();
		await bobProvider(captured.pi);

		const credentials = await captured.registration.oauth.refreshToken({
			access: "old-sso-token",
			refresh: "refresh-token",
			expires: 0,
			bobModelCatalog: previousCatalog,
		});
		expect(credentials.bobModelCatalog).toEqual(previousCatalog);
	});

	test("preserves the previous SSO catalog when rediscovery is malformed", async () => {
		globalThis.fetch = (async (input) => {
			const url = String(input);
			if (url.endsWith("/authn/v1/auth/refresh")) {
				return new Response(JSON.stringify({ token: "fresh-sso-token", expires_in: 3600 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ data: [{}] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;
		console.warn = () => {};
		const previousCatalog = parseBobModelCatalog(modelInfoPayload());
		const captured = captureProviderRegistration();
		await bobProvider(captured.pi);

		const credentials = await captured.registration.oauth.refreshToken({
			access: "old-sso-token",
			refresh: "refresh-token",
			expires: 0,
			bobModelCatalog: previousCatalog,
		});
		expect(credentials.bobModelCatalog).toEqual(previousCatalog);
	});
});
