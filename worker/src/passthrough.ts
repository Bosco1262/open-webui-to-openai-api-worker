/**
 * The `/v1/*` catch-all passthrough: which upstream paths it may forward to, and how an
 * incoming path is normalized before that question is asked.
 *
 * Two rules live here, and they are deliberately the same rule seen from both sides:
 *
 *   - The allowlist is deny-by-default (U-1): the passthrough used to relay ANY `/v1/*`
 *     path with the operator's imported credentials, so a client holding a proxy key
 *     reached the upstream's entire business and admin API.
 *   - The path is normalized BEFORE the allowlist check, and the normalized value is
 *     what gets forwarded (H1). Checking one string and forwarding another is the bug:
 *     `images/../../api/config` passes a `startsWith` check, and whatever resolves the
 *     path next (an HTTP client removing dot segments per RFC 3986, a reverse proxy, the
 *     upstream's own server) turns it into `/api/config`.
 *
 * Upstream project: `config.py:87-132` (`normalize_passthrough_path`), `config.py:457-487`
 * (`passthrough_permits`), `app.py:1245-1265` (`_target_stays_within_allowlist`).
 *
 * `/v1/*` 兜底透传：允许转发到哪些上游路径，以及发问之前如何归一化进入的路径。
 *
 * 这里放两条规则，而它们刻意是同一条规则的两面：
 *
 *   - 白名单默认拒绝（U-1）：此前的透传会用运维导入的凭证原样转发**任意** `/v1/*`
 *     路径，因此持有代理 Key 的客户端可以触达上游的整套业务与管理 API。
 *   - 路径在判白名单**之前**先归一化，且转发出去的就是归一化后的值（H1）。检查一个
 *     字符串、转发另一个字符串正是那个 bug：`images/../../api/config` 能通过
 *     `startsWith` 检查，而下一个解析该路径的角色（按 RFC 3986 移除点段的 HTTP 客户端、
 *     反向代理、上游自己的服务器）把它变成 `/api/config`。
 *
 * 上游对应位置：`config.py:87-132`（`normalize_passthrough_path`）、`config.py:457-487`
 * （`passthrough_permits`）、`app.py:1245-1265`（`_target_stays_within_allowlist`）。
 */

/**
 * Upstream paths the catch-all passthrough may forward to.
 *
 * Deny-by-default on purpose: the passthrough used to relay ANY `/v1/*` path with the
 * operator's own imported credentials, so a client holding a proxy key could reach the
 * upstream's entire business and admin API (`/auths`, `/users`, `/configs`, `/chats`,
 * ...) -- i.e. the key was equivalent to full account access. Only these documented
 * OpenAI-compatible media/file routes are forwarded now; everything else answers 403
 * `endpoint_not_allowed`.
 *
 * Extending this list is an explicit decision: add the prefix here AND document it in
 * the README's Security Notes, because every entry hands key holders the operator's
 * upstream privileges on that route.
 *
 * The leading slash is this Worker's convention: the caller slices `url.pathname` at
 * `"/v1".length`, so a subpath always arrives with one.
 *
 * 兜底透传允许转发到的上游路径。
 *
 * 刻意"默认拒绝"：此前的透传会用运维导入的凭证原样转发**任意** `/v1/*` 路径，因此持有
 * 代理 Key 的客户端可以触达上游的整套业务与管理 API（`/auths`、`/users`、`/configs`、
 * `/chats`……）——也就是说一把 Key 等价于账号全权。现在只转发这些已在文档中声明的 OpenAI
 * 兼容媒体/文件路由，其余一律回 403 `endpoint_not_allowed`。
 *
 * 扩展本列表是一个显式决定：在这里加前缀**并且**在 README 的 Security Notes 中写明，因为
 * 每一条都等于把运维在上游的权限交给 Key 持有者。
 *
 * 前导斜杠是本 Worker 的约定：调用方从 `url.pathname` 的 `"/v1".length` 处切片，因此子路径
 * 总是带着它。
 */
export const PASSTHROUGH_ALLOWLIST: readonly string[] = ["/images", "/audio", "/files"];

/** Control characters never belong in a forwarded path; the URL parser has already
 *  decoded percent-escapes, so anything left in this class was smuggled deliberately. */
/** 控制字符绝无可能属于一条要转发的路径；URL 解析器已完成百分号解码，因此这里若还出现
 *  这类字符，只能是刻意夹带。 */
const UNSAFE_PATH_CHARS = /[\x00-\x1f\x7f]/;

/** How many decode rounds the normalization looks through. Nested escapes
 *  (`%252e%252e%252f`) decode one layer per round; anything still hiding a parent
 *  segment deeper than this is refused outright, because the check could not prove it
 *  safe. The upstream project uses the same bound. */
/** 归一化最多看穿几层解码。嵌套转义（`%252e%252e%252f`）每轮解一层；比这更深还藏着父段的
 *  形式一律拒绝，因为检查无法证明它安全。上游项目用的是同一个层数。 */
const MAX_DECODE_ROUNDS = 3;

/** Whether any path segment is "..". / 路径中是否存在 ".." 段。 */
function hasParentSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "..");
}

/**
 * Normalize an incoming `/v1/*` path for the allowlist check and for forwarding, or
 * return null when it must not be forwarded at all.
 *
 * The bypass this exists to close: `images/../../api/config` passed a `startsWith` check
 * and was then *resolved* by the HTTP client (dot-segment removal, RFC 3986) into
 * `/api/config` -- so any holder of a proxy key could reach every upstream route the
 * allowlist exists to withhold. The check and the forwarded value are therefore the same
 * string, computed here, and it never contains a parent segment.
 *
 * The path arrives already percent-decoded from the URL parser, so `..%2f` is still
 * spelled that way here (the parser does not decode `%2f`); it is decoded further anyway,
 * because the upstream decodes again, and any form whose deeper decoding still carries
 * ".." is refused. Empty and "." segments are dropped (the HTTP client would remove them
 * anyway), and backslashes and control characters are refused outright.
 *
 * Segments are taken from the RAW form, not the decoded one: the decode loop has already
 * proven that deeper decoding stays inside the allowlist subtree, and forwarding the raw
 * form is what keeps "the checked value" identical to "the forwarded value".
 *
 * 归一化进入的 `/v1/*` 路径（既用于白名单判断也用于转发）；完全不应转发时返回 null。
 *
 * 要关掉的绕过：`images/../../api/config` 能通过 `startsWith` 检查，随后被 HTTP 客户端按
 * RFC 3986 移除点段、*解析*成 `/api/config`——于是任何持有代理 Key 的人都能抵达白名单本要
 * 挡住的全部上游路由。因此这里把"检查的值"与"转发的值"统一成同一个字符串，且它永远不含
 * 父段。
 *
 * 路径从 URL 解析器出来时已做过百分号解码，此刻 `..%2f` 仍是这种写法（解析器不解码
 * `%2f`）；这里仍然继续解码，因为上游还会再解一次；任何"更深一层解码后仍含 .."的形式一律
 * 拒绝。空段与 "." 段被丢弃（HTTP 客户端本来也会移除它们），反斜杠与控制字符直接拒绝。
 *
 * 段取自**原始**形式而非解码后的形式：解码循环已经证明更深一层解码仍落在白名单子树内，而
 * 转发原始形式正是"判定值 == 转发值"这条性质的来源。
 */
export function normalizePassthroughPath(raw: string): string | null {
  if (raw.includes("\\") || UNSAFE_PATH_CHARS.test(raw) || hasParentSegment(raw)) return null;
  let decoded = raw;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      // A malformed percent-escape (or a lone surrogate after decoding) cannot name a
      // forwardable path, and refusing is the only safe reading of "we could not check
      // it". The URL parser normally percent-encodes stray "%" to "%25", so this is a
      // belt-and-braces branch.
      //
      // 非法的百分号转义（或解码后出现的孤立代理项）指代不了任何可转发路径，而"检查不了"
      // 唯一安全的读法就是拒绝。URL 解析器通常会把游离的 "%" 转义成 "%25"，因此这是一条
      // 保险带分支。
      return null;
    }
    if (next === decoded) break;
    decoded = next;
    if (hasParentSegment(decoded)) return null;
  }
  const segments = raw.split("/").filter((segment) => segment !== "" && segment !== ".");
  return `/${segments.join("/")}`;
}

/** Whether a subpath is inside the passthrough allowlist (exact or subtree). */
/** 子路径是否落在透传白名单内（精确或其子树）。 */
export function isPassthroughAllowed(normalized: string): boolean {
  return PASSTHROUGH_ALLOWLIST.some(
    (allowed) => normalized === allowed || normalized.startsWith(`${allowed}/`),
  );
}

/**
 * Whether `targetUrl`, once the URL parser has resolved it, still lands inside an
 * allowlisted upstream subpath under `prefix` (H1, defence in depth).
 *
 * `normalizePassthroughPath` already guarantees this for everything it lets through, so
 * this is the second lock on the same door: it re-derives the answer from the string
 * that is actually about to be dialled, which is also where a decode depth beyond
 * MAX_DECODE_ROUNDS would show up.
 *
 * `targetUrl` 经 URL 解析器解析之后，是否仍落在 `prefix` 之下、白名单覆盖的上游子路径内
 * （H1，纵深防御）。
 *
 * `normalizePassthroughPath` 已经为它放行的一切保证了这一点，因此这里是同一扇门上的第二把
 * 锁：它从"真正即将拨出的那个字符串"重新推导答案，而超出 MAX_DECODE_ROUNDS 的解码深度也只
 * 会在这里显形。
 */
export function targetStaysWithinAllowlist(prefix: string, targetUrl: string): boolean {
  let resolved: URL;
  try {
    resolved = new URL(targetUrl);
  } catch {
    return false;
  }
  const prefixSegments = prefix.split("/").filter(Boolean);
  const resolvedSegments = resolved.pathname.split("/").filter(Boolean);
  if (resolvedSegments.length < prefixSegments.length) return false;
  for (let index = 0; index < prefixSegments.length; index += 1) {
    if (resolvedSegments[index] !== prefixSegments[index]) return false;
  }
  return isPassthroughAllowed(`/${resolvedSegments.slice(prefixSegments.length).join("/")}`);
}
