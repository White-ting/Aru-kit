// 群服务 qun · 作者 White-ting · 原版在 github.com/White-ting/Aru-kit；不许转发、不许商用，见 LICENSE
// 群服务：几个人、几个 AI（包括 Aru 里的协作者）在一个群里说话。只存群消息，不连任何人的电脑或手机。
// 人：用带口令的邀请链接打开（/?k=口令 → 记进 Cookie）；AI：MCP（streamable HTTP），请求头 Authorization: Bearer 口令。
// 有新消息时，按规则用 Aru 外部触发把那边的 AI 叫醒（seal.js，端到端加密，Host 读不到内容）。
import { submitWakeEvent, checkBundle } from "./seal.js";
import { PAGE } from "./page.js";
import { VERSION, SIGN_HDR } from "./version.js";

const MAX_TEXT = 2000;
const DAILY_WAKES = 40;        // 每个 AI 一天最多叫醒几次
const REWAKE_MIN = 10;         // 叫了还没来看，过这么久才再叫
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const enc = new TextEncoder();
async function sha256(s) {
  const b = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function json(o, status = 200, headers = {}) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-qun": SIGN_HDR, ...headers } });
}

function bjParts(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, md: `${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}

async function memberByToken(env, tok) {
  if (!tok || tok.length < 20) return null;
  return env.DB.prepare("SELECT * FROM members WHERE token_hash = ? AND active = 1").bind(await sha256(tok)).first();
}
function cookieTok(req) {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)qun_k=([A-Za-z0-9_-]+)/);
  return m ? m[1] : "";
}
function bearer(req) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(\S+)/i);
  return m ? m[1] : "";
}

async function allMembers(env) {
  const { results } = await env.DB.prepare("SELECT id, name, kind, owner FROM members WHERE active = 1 ORDER BY created").all();
  return results;
}

function mentions(text, name) {
  return text.includes("@" + name) || text.includes("＠" + name);
}

// ---------- 发消息 + 叫醒 ----------

async function post(env, ctx, author, raw, via) {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) throw new Error("消息是空的");
  if (text.length > MAX_TEXT) throw new Error(`太长了（${text.length} 字，最多 ${MAX_TEXT} 字）`);
  const now = Date.now();
  const r = await env.DB.prepare("SELECT COALESCE(SUM(ts > ?), 0) AS burst, COUNT(*) AS hour FROM messages WHERE author = ? AND ts > ?")
    .bind(now - 10e3, author.id, now - 3600e3).first();
  if (r.burst >= 3) throw new Error("说得太快了，10 秒内最多 3 条");
  if (r.hour >= (author.kind === "ai" ? 30 : 300)) throw new Error("这一小时说得太多了，歇一会儿");
  const res = await env.DB.prepare("INSERT INTO messages (ts, author, text, via) VALUES (?, ?, ?, ?)").bind(now, author.id, text, via).run();
  const msg = { id: res.meta.last_row_id, ts: now, author, text };
  ctx.waitUntil(wakeOthers(env, msg).catch(() => {}));
  return msg.id;
}

async function logWake(env, member, msg, outcome) {
  await env.DB.prepare("INSERT INTO wakes (ts, member, msg, outcome) VALUES (?, ?, ?, ?)").bind(Date.now(), member, msg, outcome).run();
}

// 不叫的理由；返回 null 就是该叫
function whyNot(m, msg) {
  const named = mentions(msg.text, m.name);
  if (m.wake_mode === "off") return "没开叫醒";
  if (msg.author.kind !== "human" && !named) return "是 AI 说的，没点它的名";
  if (m.wake_mode === "mention" && !named) return "只在被 @ 时叫";
  const today = bjParts(msg.ts).date;
  const count = m.wakes_date === today ? m.wakes_count : 0;
  if (count >= DAILY_WAKES) return `今天已经叫了 ${count} 次`;
  if (m.last_wake_msg > m.last_read && msg.ts - m.last_wake_ts < REWAKE_MIN * 60e3) return "上次叫了还没来看，先不重复叫";
  return null;
}

async function briefing(env, m, upto) {
  const { results } = await env.DB.prepare(
    "SELECT m.id, m.ts, m.text, p.name FROM messages m JOIN members p ON p.id = m.author WHERE m.id > ? AND m.id <= ? AND m.author != ? ORDER BY m.id DESC LIMIT 8")
    .bind(m.last_read, upto, m.id).all();
  const lines = results.reverse().map((x) => {
    const t = x.text.length > 300 ? x.text.slice(0, 300) + "……" : x.text;
    return `${x.name}（${bjParts(x.ts).hm}）：${t}`;
  });
  return [
    `〔群消息 · ${env.GROUP_NAME || "群"}〕群里有人说话了：`,
    ...lines,
    "",
    m.wake_via === "poll"
      ? "这一轮你的正文不会进群。想看完整的用 `qun-cli.py read`，想在群里说话用 `qun-cli.py say \"……\"`。不想说也可以不说。"
      : "想看完整的用 read_group，想说话用 post_group。不想说也可以不说。",
  ].join("\n");
}

async function wakeOne(env, m, msgId, content) {
  await submitWakeEvent(JSON.parse(m.wake_bundle), content);
}

async function wakeOthers(env, msg) {
  const { results } = await env.DB.prepare("SELECT * FROM members WHERE kind = 'ai' AND active = 1 AND (wake_bundle IS NOT NULL OR wake_via = 'poll') AND id != ?").bind(msg.author.id).all();
  for (const m of results) {
    const why = whyNot(m, msg);
    if (why) { await logWake(env, m.id, msg.id, "没叫：" + why); continue; }
    try {
      const brief = await briefing(env, m, msg.id);
      if (m.wake_via === "poll") {   // 不在 Aru 里的 AI（比如跑在电脑上的）：存着等它自己来取（群服务进不了别人的电脑）
        await env.DB.prepare("UPDATE members SET pending = ?, pending_msg = ? WHERE id = ?").bind(brief, msg.id, m.id).run();
      } else {
        await wakeOne(env, m, msg.id, brief);
      }
      const today = bjParts(msg.ts).date;
      const count = m.wakes_date === today ? m.wakes_count : 0;
      await env.DB.prepare("UPDATE members SET last_wake_ts = ?, last_wake_msg = ?, wakes_date = ?, wakes_count = ? WHERE id = ?")
        .bind(msg.ts, msg.id, today, count + 1, m.id).run();
      await logWake(env, m.id, msg.id, "叫了");
    } catch (e) {
      await logWake(env, m.id, msg.id, "出错：" + e.message);
    }
  }
}

// ---------- 读消息 ----------

async function messagesAfter(env, after, limit) {
  const q = after > 0
    ? env.DB.prepare("SELECT id, ts, author, text FROM messages WHERE id > ? ORDER BY id LIMIT ?").bind(after, limit)
    : env.DB.prepare("SELECT * FROM (SELECT id, ts, author, text FROM messages ORDER BY id DESC LIMIT ?) ORDER BY id").bind(limit);
  return (await q.all()).results;
}

async function markRead(env, id, upto) {
  await env.DB.prepare("UPDATE members SET last_read = MAX(last_read, ?) WHERE id = ?").bind(upto, id).run();
}

// ---------- MCP（给 AI 用）----------

const TOOLS = [
  {
    name: "read_group",
    description: "看群里的消息。默认给你上次看过以后别人说的新消息（最多 50 条，给你看了就算读过）；没有新的就给最近 20 条。开头会列出群里有谁。",
    inputSchema: {
      type: "object",
      properties: { recent: { type: "integer", minimum: 1, maximum: 100, description: "不管读没读过，直接看最近这么多条" } },
    },
  },
  {
    name: "post_group",
    description: "在群里说一句话，群里所有人都看得到。要点名某人就写 @名字。别的 AI 说的话不点你名时不会叫醒你；你说的话也只有 @ 了对方，才会叫醒别的 AI。一次最多 2000 字。",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "要说的话" } },
      required: ["text"],
    },
  },
];

function fmtLine(x, names) {
  const p = bjParts(x.ts);
  return `#${x.id} ${p.md} ${p.hm} ${names[x.author] || x.author}：${x.text}`;
}

async function callTool(env, ctx, me, name, args) {
  if (name === "post_group") {
    const id = await post(env, ctx, me, args?.text, "mcp");
    return `发出去了（#${id}）。`;
  }
  if (name === "read_group") {
    const members = await allMembers(env);
    const names = Object.fromEntries(members.map((x) => [x.id, x.name]));
    const who = members.map((x) => `${x.name}（${x.kind === "ai" ? "AI" : "人"}${x.id === me.id ? "，就是你" : ""}）`).join("、");
    const head = `群「${env.GROUP_NAME || "群"}」：${who}`;
    const recent = Number(args?.recent);
    if (recent >= 1) {
      const rows = await messagesAfter(env, 0, Math.min(100, Math.floor(recent)));
      if (rows.length) await markRead(env, me.id, rows[rows.length - 1].id);
      return [head, `最近 ${rows.length} 条：`, ...rows.map((x) => fmtLine(x, names))].join("\n");
    }
    const rows = await messagesAfter(env, me.last_read, 50);
    const fresh = rows.filter((x) => x.author !== me.id);
    if (fresh.length) {
      await markRead(env, me.id, rows[rows.length - 1].id);
      const more = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE id > ?").bind(rows[rows.length - 1].id).first();
      return [head, `新消息 ${fresh.length} 条：`, ...rows.map((x) => fmtLine(x, names)), more.n ? `（后面还有 ${more.n} 条，再调一次 read_group）` : ""].filter(Boolean).join("\n");
    }
    const last = await messagesAfter(env, 0, 20);
    return [head, "没有新消息。最近的：", ...last.map((x) => fmtLine(x, names))].join("\n");
  }
  throw new Error("没有这个工具：" + name);
}

async function rpc(env, ctx, me, r) {
  if (!r || r.jsonrpc !== "2.0" || typeof r.method !== "string") {
    return { jsonrpc: "2.0", id: r?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
  }
  if (r.id === undefined || r.id === null) return null;   // 通知，不用回
  const ok = (result) => ({ jsonrpc: "2.0", id: r.id, result });
  switch (r.method) {
    case "initialize": {
      const want = r.params?.protocolVersion;
      return ok({
        protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[1],
        capabilities: { tools: {} },
        serverInfo: { name: "qun（White-ting）", version: VERSION },
        instructions: `这是群「${env.GROUP_NAME || "群"}」，你的名字是 ${me.name}。read_group 看消息，post_group 说话。`,
      });
    }
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS });
    case "tools/call":
      try {
        const text = await callTool(env, ctx, me, r.params?.name, r.params?.arguments || {});
        return ok({ content: [{ type: "text", text }] });
      } catch (e) {
        return ok({ content: [{ type: "text", text: "没成功：" + e.message }], isError: true });
      }
    default:
      return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "Method not found: " + r.method } };
  }
}

async function mcp(req, env, ctx) {
  if (req.method === "GET") return new Response("", { status: 405, headers: { allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 204 });
  if (req.method !== "POST") return new Response("", { status: 405 });
  const me = await memberByToken(env, bearer(req) || new URL(req.url).searchParams.get("k"));
  if (!me || me.kind !== "ai") return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "口令不对" } }, 401);
  let body;
  try { body = await req.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
  const batch = Array.isArray(body);
  const outs = [];
  for (const r of batch ? body : [body]) {
    const o = await rpc(env, ctx, me, r);
    if (o) outs.push(o);
  }
  if (!outs.length) return new Response(null, { status: 202 });
  return json(batch ? outs : outs[0]);
}

// ---------- 电脑上的 AI 用（wake_via=poll，命令行或轮询程序，Bearer 口令）----------

async function aiApi(req, env, ctx, path) {
  const me = await memberByToken(env, bearer(req));
  if (!me || me.kind !== "ai") return json({ error: "口令不对" }, 401);
  const url = new URL(req.url);
  try {
    if (path === "/api/ai/pending" && req.method === "GET") {
      return json(me.pending ? { id: me.pending_msg, text: me.pending } : { id: 0 });
    }
    if (path === "/api/ai/ack" && req.method === "POST") {   // 送进终端了：清掉，算读到这条
      const b = await req.json().catch(() => ({}));
      const id = Number(b.id) || 0;
      await env.DB.prepare("UPDATE members SET pending = NULL, last_read = MAX(last_read, ?) WHERE id = ? AND pending_msg = ?").bind(id, me.id, id).run();
      return json({ ok: true });
    }
    if (path === "/api/ai/read" && req.method === "GET") {
      const recent = Number(url.searchParams.get("recent")) || 0;
      return json({ text: await callTool(env, ctx, me, "read_group", recent ? { recent } : {}) });
    }
    if (path === "/api/ai/say" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      return json({ id: await post(env, ctx, me, b.text, "cli") });
    }
  } catch (e) {
    return json({ error: e.message }, 400);
  }
  return json({ error: "没有这个接口" }, 404);
}

// ---------- 网页（给人用）----------

async function api(req, env, ctx, path) {
  const me = await memberByToken(env, cookieTok(req));
  if (!me || me.kind !== "human") return json({ error: "没登录：请用邀请链接打开" }, 401);
  const url = new URL(req.url);

  if (path === "/api/state" && req.method === "GET") {
    const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
    const rows = await messagesAfter(env, after, after ? 200 : 100);
    if (rows.length) await markRead(env, me.id, rows[rows.length - 1].id);
    const out = {
      group: env.GROUP_NAME || "群",
      me: { id: me.id, name: me.name },
      members: (await allMembers(env)).map(({ id, name, kind }) => ({ id, name, kind })),
      messages: rows,
    };
    if (url.searchParams.has("mine")) {   // 我管的 AI：叫醒设置和最近几次叫醒
      const { results } = await env.DB.prepare("SELECT id, name, wake_mode, wake_via, wake_bundle IS NOT NULL AS has_bundle FROM members WHERE owner = ? AND kind = 'ai' AND active = 1").bind(me.id).all();
      for (const a of results) {
        a.wakes = (await env.DB.prepare("SELECT ts, msg, outcome FROM wakes WHERE member = ? ORDER BY id DESC LIMIT 8").bind(a.id).all()).results;
      }
      out.mine = results;
    }
    return json(out);
  }

  if (path === "/api/send" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    try { return json({ id: await post(env, ctx, me, b.text, "web") }); }
    catch (e) { return json({ error: e.message }, 400); }
  }

  if (path === "/api/wake" && req.method === "POST") {   // 给自己的 AI 填叫醒凭证 / 改叫醒方式 / 试叫一次
    const b = await req.json().catch(() => ({}));
    const ai = await env.DB.prepare("SELECT * FROM members WHERE id = ? AND owner = ? AND kind = 'ai'").bind(String(b.ai || ""), me.id).first();
    if (!ai) return json({ error: "这个 AI 不归你管" }, 403);
    try {
      if (b.bundle !== undefined) {
        if (b.bundle === null || b.bundle === "") {
          await env.DB.prepare("UPDATE members SET wake_bundle = NULL WHERE id = ?").bind(ai.id).run();
        } else {
          const bundle = typeof b.bundle === "string" ? JSON.parse(b.bundle) : b.bundle;
          checkBundle(bundle);
          await env.DB.prepare("UPDATE members SET wake_bundle = ? WHERE id = ?").bind(JSON.stringify(bundle), ai.id).run();
        }
      }
      if (b.mode !== undefined) {
        if (!["human", "mention", "off"].includes(b.mode)) throw new Error("叫醒方式不对");
        await env.DB.prepare("UPDATE members SET wake_mode = ? WHERE id = ?").bind(b.mode, ai.id).run();
      }
      if (b.test) {
        const cur = await env.DB.prepare("SELECT wake_bundle FROM members WHERE id = ?").bind(ai.id).first();
        if (!cur.wake_bundle) throw new Error("还没填叫醒凭证");
        await wakeOne(env, { wake_bundle: cur.wake_bundle }, 0,
          `〔群 · 测试叫醒〕这是 ${me.name} 在群「${env.GROUP_NAME || "群"}」的设置里点的测试，不用回群里。收到就说明群能叫醒你了。`);
        await logWake(env, ai.id, 0, "测试：叫了");
      }
      return json({ ok: true });
    } catch (e) {
      if (b.test) await logWake(env, ai.id, 0, "测试出错：" + e.message);
      return json({ error: e instanceof SyntaxError ? "凭证不是 JSON，要整段复制" : e.message }, 400);
    }
  }
  return json({ error: "没有这个接口" }, 404);
}

const PAGE_HEADERS = { "x-qun": SIGN_HDR,
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
};

// 想把群页面嵌进自己别的网页里：在 wrangler.jsonc 的 vars 里设 FRAME_ANCESTORS（空格分开的地址，如 "https://a.example.com"）
function pageHeaders(env) {
  if (!env.FRAME_ANCESTORS) return PAGE_HEADERS;
  const h = { ...PAGE_HEADERS };
  h["content-security-policy"] = h["content-security-policy"].replace("frame-ancestors 'self'", "frame-ancestors 'self' " + env.FRAME_ANCESTORS);
  return h;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/mcp") return mcp(req, env, ctx);
    if (path.startsWith("/api/ai/")) return aiApi(req, env, ctx, path);
    if (path.startsWith("/api/")) return api(req, env, ctx, path);
    // 邀请链接两种写法：/?k=口令，或 /i/口令（Aru「连接网页应用」不收带查询参数的网址）
    const inv = req.method === "GET" && path.startsWith("/i/") ? path.slice(3) : "";
    if ((path === "/" || inv) && req.method === "GET") {
      const k = inv || url.searchParams.get("k");
      if (k) {   // 邀请链接：核对口令，记进 Cookie，跳回不带口令的地址
        const m = await memberByToken(env, k);
        if (!m || m.kind !== "human") return new Response("这个邀请链接不对，或者已经停用了。", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
        return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `qun_k=${k}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`, "referrer-policy": "no-referrer" } });
      }
      return new Response(PAGE, { headers: pageHeaders(env) });
    }
    if (path === "/logout") return new Response(null, { status: 303, headers: { location: "/", "set-cookie": "qun_k=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax" } });
    return new Response("Not found", { status: 404 });
  },
};
