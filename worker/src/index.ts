/**
 * Worker entry: fetch handler + route dispatch.
 * Routes:
 *   GET  /                    service metadata
 *   GET  /healthz             health check (unauthenticated, always 200)
 *   GET  /admin               admin console (HTML)
 *   /admin/api/*              admin REST API
 *   /v1/*                     OpenAI-compatible proxy
 * 
 * Worker 入口：fetch 处理器与路由分发。
 * 路由：
 *   GET  /                    服务元信息
 *   GET  /healthz             健康检查（无需鉴权，始终 200）
 *   GET  /admin               管理界面（HTML）
 *   /admin/api/*              管理 REST API
 *   /v1/*                     OpenAI 兼容代理
 */

import { handleAdminApiRequest } from "./admin";
import { handleV1Request } from "./proxy";
import { ADMIN_UI } from "./ui";
import type { Env } from "./types";

const VERSION = "1.0.0";

// Build a JSON response with the given payload and status.
// 用给定的负载与状态码构造 JSON 响应。
function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ---- Admin console & API ----
      // ---- 管理界面与管理 API ----
      if (path === "/admin" || path === "/admin/" || path.startsWith("/admin/")) {
        if (path.startsWith("/admin/api")) {
          return await handleAdminApiRequest(env, request);
        }
        return new Response(ADMIN_UI, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }

      // ---- OpenAI-compatible proxy ----
      // ---- OpenAI 兼容代理 ----
      if (path.startsWith("/v1")) {
        return await handleV1Request(env, request, ctx);
      }

      // ---- Meta ----
      // ---- 元信息 ----
      if (path === "/" || path === "/index.html") {
        return json({
          service: "open-webui-to-openai-api-worker",
          version: VERSION,
          admin: "/admin",
          endpoints: [
            "GET  /healthz",
            "GET  /v1/models",
            "POST /v1/chat/completions",
            "POST /v1/embeddings",
            "ANY  /v1/{path}  (passthrough)",
          ],
        });
      }
      if (path === "/healthz" || path === "/healthz/") {
        return json({ status: "ok", version: VERSION });
      }

      // Unknown paths return an OpenAI-style 404 error body.
      // 未知路径返回 OpenAI 风格的 404 错误体。
      return json({ error: { message: "Not found", type: "invalid_request_error", code: "not_found" } }, 404);
    } catch (err) {
      // Log unexpected errors as structured JSON for observability.
      // 以结构化 JSON 记录未预期错误，便于可观测性排查。
      console.error(
        JSON.stringify({
          message: "unhandled error",
          error: err instanceof Error ? err.message : String(err),
          path,
        }),
      );
      return json(
        {
          error: {
            message: "Internal server error",
            type: "server_error",
            code: "internal",
          },
        },
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;
