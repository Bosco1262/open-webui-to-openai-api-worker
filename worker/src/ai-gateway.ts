/**
 * Cloudflare API client for AI Gateway: create gateway, register/update a
 * custom provider pointing at Open WebUI, build the routed URL and test
 * connectivity through the gateway.
 *
 * Verified against the official docs:
 *   POST   /accounts/{account_id}/ai-gateway/gateways
 *   GET    /accounts/{account_id}/ai-gateway/custom-providers
 *   POST   /accounts/{account_id}/ai-gateway/custom-providers
 *   PATCH  /accounts/{account_id}/ai-gateway/custom-providers/{id}
 *   DELETE /accounts/{account_id}/ai-gateway/custom-providers/{id}
 *
 * The gateway route is:
 *   https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/custom-{slug}/{path}
 *   ->  {base_url}/{path}
 *
 * IMPORTANT: base_url must be the bare root (https://chat.example.com), never
 * include /api/v1 — otherwise the path gets duplicated (/v1/v1/...).
 */

import type { CloudflareConfig, StoredSession } from "./types";

const CF_API_BASE = "https://api.cloudflare.com/client/v4/accounts";

const DEFAULT_PROVIDER_SLUG = "open-webui";
const DEFAULT_GATEWAY_ID = "ow2-ai-gateway";
const PROVIDER_NAME = "Open WebUI";

/** A custom provider entry as returned by the Cloudflare API. */
interface CustomProvider {
  id: string;
  name?: string;
  slug?: string;
  base_url?: string;
  enable?: boolean;
}

interface CfError {
  code: number;
  message: string;
}

class CloudflareApiError extends Error {
  status: number;
  errors: CfError[];
  constructor(message: string, status: number, errors: CfError[] = []) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

function cfErrorMessage(errors: CfError[]): string {
  return errors.map((e) => `${e.code}: ${e.message}`).join("; ") || "未知错误";
}

async function cfRequest(
  config: CloudflareConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; result: unknown; errors: CfError[] }> {
  const url = `${CF_API_BASE}/${encodeURIComponent(config.account_id)}${path}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.api_token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new CloudflareApiError(`无法连接 Cloudflare API：${String(err)}`, 0);
  }

  let payload: { success?: boolean; errors?: CfError[]; result?: unknown } = {};
  try {
    payload = (await resp.json()) as typeof payload;
  } catch {
    // Some error responses are plain text.
  }

  if (!resp.ok || payload.success === false) {
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    const message =
      errors.length > 0
        ? cfErrorMessage(errors)
        : `Cloudflare API 返回 HTTP ${resp.status}`;
    throw new CloudflareApiError(message, resp.status, errors);
  }
  return { status: resp.status, result: payload.result, errors: [] };
}

/** Robust extraction of a custom-provider list from an unknown result shape. */
function asProviderList(result: unknown): CustomProvider[] {
  if (Array.isArray(result)) return result as CustomProvider[];
  if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    for (const key of ["providers", "items", "data", "result"]) {
      const value = obj[key];
      if (Array.isArray(value)) return value as CustomProvider[];
    }
  }
  return [];
}

/** Request headers to carry the Open WebUI credentials upstream. */
export function sessionHeaders(session: StoredSession): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": session.user_agent || "open-webui-to-openai-api-worker",
  };
  if (session.authorization) headers.Authorization = session.authorization;
  if (session.cookie) headers.Cookie = session.cookie;
  return headers;
}

/**
 * Ensure a gateway exists. Returns the gateway id to use.
 * Uses `config.gateway_id` when set; otherwise creates `ow2-ai-gateway` and
 * reuses it if it already exists (409 conflict).
 */
export async function ensureGateway(config: CloudflareConfig): Promise<string> {
  if (config.gateway_id) return config.gateway_id;

  const createBody = {
    id: DEFAULT_GATEWAY_ID,
    cache_ttl: Math.max(0, config.cache_ttl || 0),
    rate_limiting_interval: 60,
    rate_limiting_limit: 1000,
    collect_logs: true,
  };
  try {
    await cfRequest(config, "POST", "/ai-gateway/gateways", createBody);
    return DEFAULT_GATEWAY_ID;
  } catch (err) {
    if (err instanceof CloudflareApiError && err.status === 409) {
      // Gateway already exists — reuse it.
      return DEFAULT_GATEWAY_ID;
    }
    throw err;
  }
}

async function findCustomProvider(
  config: CloudflareConfig,
  slug: string,
): Promise<CustomProvider | null> {
  const { result } = await cfRequest(config, "GET", "/ai-gateway/custom-providers?per_page=100");
  return asProviderList(result).find((p) => p.slug === slug) ?? null;
}

/**
 * Register (or update) the custom provider for Open WebUI.
 * Returns the provider id and the resulting gateway base URL.
 */
export async function upsertCustomProvider(
  config: CloudflareConfig,
  baseUrl: string,
): Promise<{ providerId: string; gatewayUrl: string }> {
  const slug = config.provider_slug || DEFAULT_PROVIDER_SLUG;
  const payload = {
    name: PROVIDER_NAME,
    slug,
    base_url: baseUrl,
    description: "Open WebUI, routed via open-webui-to-openai-api-worker",
    enable: true,
  };

  const existing = await findCustomProvider(config, slug);
  let providerId: string;
  if (existing) {
    const { result } = await cfRequest(
      config,
      "PATCH",
      `/ai-gateway/custom-providers/${encodeURIComponent(existing.id)}`,
      payload,
    );
    const patched =
      result && typeof result === "object" ? (result as Record<string, unknown>) : null;
    providerId = typeof patched?.id === "string" && patched.id ? patched.id : existing.id;
  } else {
    const { result } = await cfRequest(config, "POST", "/ai-gateway/custom-providers", payload);
    const obj = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
    providerId = (obj.id as string) ?? "";
    if (!providerId) {
      throw new CloudflareApiError("创建 Custom Provider 成功但未返回 provider id", 0);
    }
  }

  return { providerId, gatewayUrl: buildGatewayUrl(config) };
}

export async function deleteCustomProvider(
  config: CloudflareConfig,
  slug: string,
): Promise<void> {
  const existing = await findCustomProvider(config, slug);
  if (!existing) return;
  await cfRequest(config, "DELETE", `/ai-gateway/custom-providers/${encodeURIComponent(existing.id)}`);
}

/**
 * Base URL routed through the AI Gateway, e.g.
 *   https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/custom-{slug}
 */
export function buildGatewayUrl(config: CloudflareConfig): string {
  const slug = config.provider_slug || DEFAULT_PROVIDER_SLUG;
  return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(config.account_id)}/${encodeURIComponent(config.gateway_id)}/custom-${slug}`;
}

/** Headers to add when talking to an (possibly authenticated) gateway. */
export function gatewayAuthHeader(config: CloudflareConfig): Record<string, string> {
  return { "cf-aig-authorization": `Bearer ${config.api_token}` };
}

/**
 * Probe the upstream through the AI Gateway to verify credentials + prefix.
 * Returns the first working prefix and HTTP status.
 */
export async function testViaGateway(
  config: CloudflareConfig,
  session: StoredSession,
  prefixes: string[],
): Promise<{ ok: boolean; status: number; prefix: string; detail?: string }> {
  if (!config.gateway_id) {
    return { ok: false, status: 0, prefix: "", detail: "Gateway 尚未创建，请先执行一键接入。" };
  }
  const base = buildGatewayUrl(config);
  let lastStatus = 0;
  for (const prefix of prefixes) {
    const url = `${base}${prefix}/models`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { ...sessionHeaders(session), ...gatewayAuthHeader(config) },
      });
    } catch (err) {
      return { ok: false, status: 0, prefix, detail: `无法连接网关：${String(err)}` };
    }
    lastStatus = resp.status;
    await resp.text().catch(() => {});
    if (resp.status === 404) continue;
    return { ok: resp.ok, status: resp.status, prefix };
  }
  return { ok: false, status: lastStatus, prefix: prefixes[0] };
}
