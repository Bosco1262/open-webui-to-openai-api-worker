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

/** A KV namespace that serves one stored session, so the probe RPC paths can run. */
class SessionKV extends EmptyKV {
  private readonly raw: string;

  constructor(session: unknown) {
    super();
    this.raw = JSON.stringify(session);
  }

  async get(key: string): Promise<string | null> {
    return key === "session" ? this.raw : null;
  }
}

/** The credentials the probe refresh tests run against. */
const STORED_SESSION = {
  authorization: "Bearer stored-token",
  cookie: "",
  user_agent: "test-agent",
  captured_at: 1_700_000_000,
  base_url: "https://upstream.test",
};

function makeEnv(
  options: {
    adminPassword?: string;
    storedSession?: unknown;
    probe?: DurableObjectNamespace;
  } = {},
): Env {
  return {
    KV: (options.storedSession === undefined
      ? new EmptyKV()
      : new SessionKV(options.storedSession)) as unknown as KVNamespace,
    PROBE: options.probe ?? ({} as unknown as DurableObjectNamespace),
    // A bound SESSION_SECRET keeps `createAdminToken` off KV entirely.
    SESSION_SECRET: "test-secret",
    ...(options.adminPassword === undefined ? {} : { ADMIN_PASSWORD: options.adminPassword }),
  } as unknown as Env;
}

/** A coordinator stub whose background-round RPC throws the given error. */
function failingProbe(error: unknown): DurableObjectNamespace {
  const stub = {
    refreshInBackground: async (): Promise<never> => {
      throw error;
    },
  };
  return { getByName: () => stub } as unknown as DurableObjectNamespace;
}

/** A coordinator stub that accepts a background round. */
function acceptingProbe(): DurableObjectNamespace {
  const stub = {
    refreshInBackground: async (): Promise<void> => {},
  };
  return { getByName: () => stub } as unknown as DurableObjectNamespace;
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
// /admin/api/status: public by necessity, minimal by design
// /admin/api/status：因必要而公开，按最小化设计
// --------------------------------------------------------------------------- //

test("status reveals only the password mode until the caller is signed in", async () => {
  const env = makeEnv({ adminPassword: "preset", storedSession: STORED_SESSION });
  const anonymous = await handleAdminApiRequest(
    env,
    new Request("https://worker.test/admin/api/status"),
  );
  assert.equal(anonymous.status, 200);
  const anon = (await anonymous.json()) as Record<string, unknown>;
  // Pre-login the console needs exactly one field: which login view to show.
  // Everything else -- the upstream base_url, the credential summary, the key
  // count, this Worker's /v1 address -- is deployment info an unauthenticated
  // visitor has no need for.
  //
  // 登录前控制台只需要一个字段：该显示哪个登录视图。其余一切——上游 base_url、
  // 凭证摘要、Key 数量、本 Worker 的 /v1 地址——都是未登录访问者无需知道的
  // 部署信息。
  assert.equal(anon.adminPasswordMode, "secret");
  assert.deepEqual(Object.keys(anon).sort(), ["adminPasswordMode", "ok"]);

  const authed = await handleAdminApiRequest(
    env,
    new Request("https://worker.test/admin/api/status", {
      headers: { cookie: `ow2_admin=${await createAdminToken(env)}` },
    }),
  );
  assert.equal(authed.status, 200);
  const full = (await authed.json()) as Record<string, unknown>;
  // The signed-in payload keeps its operator-facing shape.
  // 已登录的负载保持面向运维的完整形状。
  assert.equal(full.ok, true);
  assert.equal(full.adminPasswordMode, "secret");
  assert.ok("session" in full);
  assert.ok("apiKeys" in full);
  assert.ok("baseUrl" in full);
  assert.ok("touchInterval" in full);
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

// --------------------------------------------------------------------------- //
// Probe refresh: coordinator errors survive the DO RPC boundary
// --------------------------------------------------------------------------- //

/** The error the console saw as a raw "models_failed" string in production. */
function roundUnavailableFromRpc(code: "session_missing" | "models_failed"): Error {
  // A Durable Object RPC keeps only `name` and `message` when it re-throws: the class
  // identity and the custom `code` field are gone by the time the caller catches it.
  //
  // Durable Object RPC 重新抛出时只保留 `name` 与 `message`：调用方 catch 到时，类的身份
  // 与自定义的 `code` 字段都已不复存在。
  return Object.assign(new Error(code), { name: "RoundUnavailable" });
}

test("an RPC-crossed RoundUnavailable keeps its localized 502", async () => {
  const env = makeEnv({
    adminPassword: "preset",
    storedSession: STORED_SESSION,
    probe: failingProbe(roundUnavailableFromRpc("models_failed")),
  });
  const response = await post(env, "/admin/api/probe/refresh", {}, true);
  assert.equal(response.status, 502);
  const payload = (await response.json()) as { error: string };
  // The old code fell through to `err.message` + 500, so the console displayed the raw
  // string "models_failed" instead of the translated message.
  //
  // 旧代码会落到 `err.message` + 500，控制台于是显示原始字符串 "models_failed" 而不是
  // 翻译后的消息。
  assert.equal(payload.error, "err.probe_models_failed");
});

test("a missing session inside the coordinator maps to its own message", async () => {
  const env = makeEnv({
    adminPassword: "preset",
    storedSession: STORED_SESSION,
    probe: failingProbe(roundUnavailableFromRpc("session_missing")),
  });
  const response = await post(env, "/admin/api/probe/refresh", {}, true);
  assert.equal(response.status, 502);
  assert.equal(((await response.json()) as { error: string }).error, "err.probe_session_missing");
});

test("an ordinary coordinator failure still answers with its own text", async () => {
  // A deliberately UNRELATED message: the model-list message now travels with a
  // dedicated error name and its own 404 (see the test below), so this test pins
  // the generic fallback for everything else.
  //
  // 刻意选一条**无关**消息：模型列表的消息现在带着专用错误名与它自己的 404（见下面的
  // 用例），因此本用例钉住的是其余错误的通用回退。
  const env = makeEnv({
    adminPassword: "preset",
    storedSession: STORED_SESSION,
    probe: failingProbe(new Error("storage blew up")),
  });
  const response = await post(env, "/admin/api/probe/refresh", { model: "x" }, true);
  assert.equal(response.status, 500);
  assert.equal(((await response.json()) as { error: string }).error, "storage blew up");
});

test("a per-model refresh naming an absent model answers its own localized 404", async () => {
  // The coordinator throws with the dedicated NAME; only name + message survive the
  // RPC boundary, and the name is what the admin API matches on.
  //
  // 协调者抛出带专用**名字**的错误；跨 RPC 边界只有名字与消息幸存，管理端匹配的
  // 正是这个名字。
  const env = makeEnv({
    adminPassword: "preset",
    storedSession: STORED_SESSION,
    probe: failingProbe(
      Object.assign(new Error("model 'x' is not in the upstream model list"), {
        name: "ModelNotInList",
      }),
    ),
  });
  const response = await post(env, "/admin/api/probe/refresh", { model: "x" }, true);
  assert.equal(response.status, 404);
  assert.equal(((await response.json()) as { error: string }).error, "err.probe_model_missing");
});

test("a probe request is acknowledged for background execution", async () => {
  const env = makeEnv({
    adminPassword: "preset",
    storedSession: STORED_SESSION,
    probe: acceptingProbe(),
  });
  const response = await post(env, "/admin/api/probe/refresh", {}, true);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { accepted: boolean };
  // The round runs on the coordinator's alarm (it can outlive an HTTP invocation);
  // the console gets an immediate ack and watches the table and the failure banner
  // instead of carrying round stats in this response.
  //
  // 轮次由协调者的 alarm 执行（它可能超出一次 HTTP 调用的生存期）；控制台立即得到
  // 应答，改为观察表格与失败横幅，而不是由本响应携带轮次统计。
  assert.equal(payload.accepted, true);
});

// --------------------------------------------------------------------------- //
// Probe settings: the heartbeat re-arm rides the save
// 探测设置：心跳重排随保存发生
// --------------------------------------------------------------------------- //

/** A coordinator stub that only counts rescheduleHeartbeat calls. */
/** 只统计 rescheduleHeartbeat 调用次数的协调者 stub。 */
function reschedulingProbe(): { namespace: DurableObjectNamespace; calls: () => number } {
  let calls = 0;
  const stub = {
    rescheduleHeartbeat: async (): Promise<void> => {
      calls += 1;
    },
  };
  return { namespace: { getByName: () => stub } as unknown as DurableObjectNamespace, calls: () => calls };
}

test("saving probe settings re-arms the coordinator's heartbeat immediately", async () => {
  const probe = reschedulingProbe();
  const env = makeEnv({
    adminPassword: "preset",
    storedSession: STORED_SESSION,
    probe: probe.namespace,
  });
  const response = await post(env, "/admin/api/probe/settings", {
    enabled: true,
    timeout: 30,
    wait: 5,
    budget: 40,
    expose_instance_meta: true,
    heartbeat_interval: 43_200,
  }, true);
  assert.equal(response.status, 200);
  // An idle deployment has no other occasion to notice the change: without this call
  // the new patrol interval would only apply after some future round.
  //
  // 空闲部署没有别的时机感知改动：缺了这次调用，新的巡检间隔要到未来某一轮才生效。
  assert.equal(probe.calls(), 1);
});

test("a heartbeat step outside the shared table is a rejected settings write", async () => {
  const probe = reschedulingProbe();
  const env = makeEnv({
    adminPassword: "preset",
    storedSession: STORED_SESSION,
    probe: probe.namespace,
  });
  const response = await post(env, "/admin/api/probe/settings", {
    enabled: true,
    timeout: 30,
    wait: 5,
    budget: 40,
    expose_instance_meta: true,
    // 600s = 10 minutes: a step that was deliberately removed from the shared table.
    // 600 秒 = 10 分钟：共享档位表中已被刻意移除的档位。
    heartbeat_interval: 600,
  }, true);
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: string }).error, "err.settings_invalid");
  // A rejected write must not touch the coordinator's schedule either.
  // 被拒绝的写入同样绝不能碰协调者的排程。
  assert.equal(probe.calls(), 0);
});
