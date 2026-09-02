/**
 * Worker entry: fetch handler + route dispatch.
 *
 * Routes:
 *   GET  /                    service metadata
 *   GET  /healthz             health check (unauthenticated, always 200)
 *   GET  /admin               admin console (HTML)
 *   /admin/api/*              admin REST API
 *   /v1/*                     OpenAI-compatible proxy
 */

import { handleAdminApiRequest } from "./admin";
import { handleV1Request } from "./proxy";
import { ADMIN_UI } from "./ui";
import type { Env } from "./types";

const VERSION = "1.0.0";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ---- Admin console & API ----
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
      if (path.startsWith("/v1")) {
        return await handleV1Request(env, request, ctx);
      }

      // ---- Meta ----
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

      return json({ error: { message: "Not found", type: "invalid_request_error", code: "not_found" } }, 404);
    } catch (err) {
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
