/**
 * Admin API tests that do not need the Workers runtime.
 *
 * Two behaviours are pinned here:
 *
 *   1. first-visit setup is closed once `ADMIN_PASSWORD` is bound (403), so a
 *      deployment that presets the secret cannot have its console claimed by the first
 *      visitor;
 *   2. the connectivity test confirms a prefix with the SAME rule the proxy uses --
 *      "the upstream answered 200" is not enough, and a deployment whose modern prefix
 *      is broken must still test OK through its legacy prefix.
 *
 * 不需要 Workers 运行时即可运行的管理 API 测试。
 *
 * 这里钉住两件事：
 *
 *   1. `ADMIN_PASSWORD` 绑定后，首次设密入口即关闭（403），因此预设了 Secret 的部署不会被
 *      第一个访客占走控制台；
 *   2. 连通性测试使用与代理**完全相同**的前缀确认规则——"上游回了 200"不算数，而现代前缀
 *      坏掉的部署仍必须能通过旧前缀测通。
 *
 * The module is importable under plain Node because `admin.ts` only imports the
 * coordinator as a TYPE: its error class and scheduling decisions live in
 * probeRuntime.ts, which has no `cloudflare:workers` dependency.
 *
 * 该模块能在普通 Node 下导入，因为 `admin.ts` 只把协调者当作**类型**导入：它的错误类与
 * 调度决策都在 probeRuntime.ts 里，而后者不依赖 `cloudflare:workers`。
 */

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { handleAdminApiRequest } from "../src/admin.ts";
import { createAdminToken } from "../src/auth.ts";
import type { Env } from "../src/types.ts";

/** A KV namespace holding nothing: only the auth path reads it here. */
class EmptyKV {
  async get(): Promise<null> {
    return null;
  }

  async put(): Promise<void> {}

  async delete(): Promise<void> {}

  async list(): Promise<{ keys: []; list_complete: boolean; cursor: string }> {
    return { keys: [], list_complete: true, cursor: "" };
  }
}

function makeEnv(options: { adminPassword?: string } = {}): Env {
  return {
    KV: new EmptyKV() as unknown as KVNamespace,
    PROBE: {} as unknown as DurableObjectNamespace,
    // A bound SESSION_SECRET keeps `createAdminToken` off KV entirely.
    SESSION_SECRET: "test-secret",
    ...(options.adminPassword === undefined ? {} : { ADMIN_PASSWORD: options.adminPassword }),
  } as unknown as Env;
}

async function post(env: Env, path: string, body: unknown, authed = false): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authed) headers.cookie = `ow2_admin=${await createAdminToken(env)}`;
  return handleAdminApiRequest(
    env,
    new Request(`https://worker.test${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

/**
 * The pristine fetch, restored before every test in this file.
 *
 * The suite runs with `--test-isolation=none` (all files in one process) and several
 * files stub `globalThis.fetch`. Module top-level code executes before any test, so
 * every file captures the real fetch here; putting it back per test makes the stubs
 * left by earlier tests (and files) harmless -- `mockUpstream.test.ts` talks real
 * HTTP and must never be answered by someone else's stub.
 *
 * 原始的 fetch，本文件每个测试开始前恢复。
 *
 * 测试套件以 `--test-isolation=none` 运行（所有文件同进程），且多个文件会替换
 * `globalThis.fetch`。模块顶层代码在任何测试之前执行，因此每个文件都能在这里捕获
 * 真正的 fetch；逐测试恢复使先前测试（与文件）留下的 stub 不再有害——
 * `mockUpstream.test.ts` 走真实 HTTP，绝不能被别人的 stub 应答。
 */
const REAL_FETCH = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = REAL_FETCH;
});

/** Answer upstream `/models` per pathname; everything else is the caller's business. */
function stubUpstream(table: Record<string, { status: number; body: string; contentType?: string }>): void {
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const answer = table[new URL(url).pathname];
    if (!answer) return new Response("not found", { status: 404 });
    return new Response(answer.body, {
      status: answer.status,
      headers: { "content-type": answer.contentType ?? "application/json" },
    });
  }) as typeof fetch;
}

const MODEL_LIST = JSON.stringify({ object: "list", data: [{ id: "a" }] });

// --------------------------------------------------------------------------- //
// First-visit setup vs the ADMIN_PASSWORD secret (R6)
// --------------------------------------------------------------------------- //

test("setup is refused with 403 while the ADMIN_PASSWORD secret is bound", async () => {
  const env = makeEnv({ adminPassword: "preset-from-secret" });
  const response = await post(env, "/admin/api/setup", {
    password: "a-long-enough-password",
    confirm: "a-long-enough-password",
  });
  assert.equal(response.status, 403);
  assert.equal(((await response.json()) as { error: string }).error, "err.setup_secret_exists");
});

test("with nothing configured, setup is still open (it is the only way in)", async () => {
  const env = makeEnv();
  const rejected = await post(env, "/admin/api/setup", { password: "short", confirm: "short" });
  assert.equal(rejected.status, 400);
  assert.equal(((await rejected.json()) as { error: string }).error, "err.pw_too_short");
});

// --------------------------------------------------------------------------- //
// Connectivity test: the same confirmation rule as the proxy (U1)
// --------------------------------------------------------------------------- //

test("a connectivity test is NOT fooled by a 200 + HTML page", async () => {
  const env = makeEnv({ adminPassword: "preset" });
  stubUpstream({
    "/api/v1/models": { status: 200, body: "<!doctype html><html></html>", contentType: "text/html" },
    "/api/models": { status: 404, body: '{"detail":"Not Found"}' },
  });

  const response = await post(
    env,
    "/admin/api/session",
    { json: sessionJson(), test: true, save: false },
    true,
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { test: { ok: boolean; code: string } };
  // The old rule answered `up.test_ok` here, telling the operator everything was fine
  // while the proxy would have gone on to talk to the SPA.
  //
  // 旧规则在这里会回 `up.test_ok`，告诉运维一切正常，而代理接下来会在跟 SPA 说话。
  assert.equal(payload.test.ok, false);
  assert.equal(payload.test.code, "up.test_not_models");
});

test("a broken modern prefix still tests OK through the legacy prefix", async () => {
  const env = makeEnv({ adminPassword: "preset" });
  stubUpstream({
    "/api/v1/models": { status: 500, body: '{"detail":"Internal Server Error"}' },
    "/api/models": { status: 200, body: MODEL_LIST },
  });

  const response = await post(
    env,
    "/admin/api/session",
    { json: sessionJson(), test: true, save: false },
    true,
  );
  const payload = (await response.json()) as { test: { ok: boolean; code: string; prefix: string } };
  assert.equal(payload.test.ok, true);
  assert.equal(payload.test.code, "up.test_ok");
  assert.equal(payload.test.prefix, "/api");
});

test("dead credentials are reported as such, not as a working connection", async () => {
  const env = makeEnv({ adminPassword: "preset" });
  stubUpstream({ "/api/v1/models": { status: 403, body: '{"detail":"Forbidden"}' } });
  const response = await post(
    env,
    "/admin/api/session",
    { json: sessionJson(), test: true, save: false },
    true,
  );
  const payload = (await response.json()) as { test: { ok: boolean; code: string; status: number } };
  assert.equal(payload.test.ok, false);
  assert.equal(payload.test.code, "up.test_http");
  assert.equal(payload.test.status, 403);
});

function sessionJson(): string {
  return JSON.stringify({
    authorization: "Bearer pasted-token",
    cookie: "",
    user_agent: "test-agent",
    base_url: "https://upstream.test",
  });
}
