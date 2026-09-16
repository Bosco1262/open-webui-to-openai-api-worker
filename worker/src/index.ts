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
 *
 * The Durable Object class is re-exported from here because Wrangler only looks for
 * Durable Object classes on the entry module.
 *
 * Durable Object 类必须从入口模块再导出，因为 Wrangler 只在入口模块上查找
 * Durable Object 类。
 */

import { ADMIN_SECURITY_HEADERS, handleAdminApiRequest } from "./admin.ts";
import { handleV1Request } from "./proxy.ts";
import { ADMIN_UI } from "./ui.ts";
import type { Env } from "./types.ts";

export { ModelProbeCoordinator } from "./probeCoordinator.ts";

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
        // The console carries the same hardening as the admin API: never cached (it
        // renders credentials-adjacent state), never sniffed, and a CSP that limits
        // what the inline page is allowed to reach (see ADMIN_SECURITY_HEADERS).
        //
        // 控制台与管理 API 使用同样的加固：绝不缓存（它渲染与凭证相邻的状态）、
        // 不做类型嗅探，并用 CSP 限制这个内联页面能触达的范围（见 ADMIN_SECURITY_HEADERS）。
        return new Response(ADMIN_UI, {
          headers: { ...ADMIN_SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" },
        });
      }

      // ---- OpenAI-compatible proxy ----
      // Exact matching only: `startsWith("/v1")` also let `/v1models` through,
      // and the passthrough then built `.../api/v1models` -- a route that does
      // not exist, often answered by the SPA's "200 + HTML" page. Slash-less
      // paths are an OpenAI-style 404 now.
      //
      // ---- OpenAI 兼容代理 ----
      // 只做精确匹配：`startsWith("/v1")` 会放行 `/v1models`，随后透传会拼出
      // `.../api/v1models`——一个不存在的路由，常被 SPA 以 "200 + 一页 HTML" 应答。
      // 缺斜杠的路径现在返回 OpenAI 风格的 404。
      if (path === "/v1" || path.startsWith("/v1/")) {
        return await handleV1Request(env, request, ctx);
      }

      // ---- Meta ----
      // ---- 元信息 ----
      if (path === "/" || path === "/index.html") {
        // Deliberately no endpoint inventory: `/` is unauthenticated, and a list of
        // this deployment's routes is reconnaissance an anonymous visitor has no need
        // for. The console and the README document them.
        //
        // 刻意不列举端点清单：`/` 无需鉴权，而本部署的路由清单属于匿名访问者不需要的
        // 侦察信息。控制台与 README 里都有说明。
        return json({
          service: "open-webui-to-openai-api-worker",
          version: VERSION,
          admin: "/admin",
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
