// knock · aru：守门人 Worker（最小版）
// 快捷指令 POST /event → 存时间线 → 规则 → 硬底线 → 叫醒（Aru 外部触发；没配就推送；都没配只记下）
// 规则没碰到的，交给小模型看一眼（定时、或者事件"差一点"碰到规则时），它说叫也照样要过硬底线
import { mergeConfig, evaluate, guard, afterWake, applyState, buildBriefing, nearMiss, daySummary, describe, localParts,
  statusLine, quietReason, confirmWorkEnd, checkInactivity, REPORT_FIELDS } from "./rules.js";
import { submitWakeEvent } from "./seal.js";
import { buildMessages, parseDecision, askModel } from "./model.js";

// 版本和署名（11-01 起）：管理页底部、每个回复的 x-knock 头都带着。BUILD 是构建号，打包时按拿到的人换掉
export const VERSION = "2.1", RELEASED = "2026-11-04", BUILD = "dev";
const SIGN = `knock 守门人 v${VERSION}（${RELEASED}）· White-ting · 构建 ${BUILD}`;
const SIGN_HDR = `knock v${VERSION} ${RELEASED} White-ting ${BUILD}`;

const TYPES = new Set(["app_open", "app_close", "arrive", "leave", "sleep", "wake_up", "charge_start", "charge_stop", "health", "note",
  "battery_low", "battery_ok", "focus_change", "mood", ...Object.keys(REPORT_FIELDS)]);
// 快捷指令里写中文也认
const FOCUS_ALIAS = { work: "work", "工作": "work", sleep: "sleep", "睡眠": "sleep", dnd: "dnd", "勿扰": "dnd", "勿扰模式": "dnd" };
// 声音识别：快捷指令里写英文、带"声"字也认，统一存成中文
const SOUND_ALIAS = { doorbell: "门铃", knock: "敲门", knocking: "敲门", baby: "婴儿哭", baby_crying: "婴儿哭", "婴儿哭泣": "婴儿哭",
  water: "流水", running_water: "流水", alarm: "警报", siren: "警笛", "火警": "火警警报", fire_alarm: "火警警报", smoke_alarm: "烟雾警报",
  dog: "狗叫", "狗": "狗叫", "狗吠": "狗叫", cat: "猫叫", "猫": "猫叫" };
function soundKind(v) {
  let raw = String(v == null ? "" : v).trim();
  if (!raw) throw new Error("sound 要带声音的种类（门铃 / 敲门 / 婴儿哭 / 流水 / 警报 / 狗叫 / 猫叫 之类）");
  const low = raw.toLowerCase().replace(/\s+/g, "_");
  if (SOUND_ALIAS[low]) return SOUND_ALIAS[low];
  if (raw.length > 1 && raw.endsWith("声")) raw = raw.slice(0, -1);
  return SOUND_ALIAS[raw] || raw.slice(0, 20);
}
const MOOD_ALIAS = { happy: "happy", "开心": "happy", low: "low", "低落": "low", alone: "alone", "想独处": "alone", need_company: "need_company", "想聊天": "need_company" };
function flag(v) {
  const t = String(v).trim().toLowerCase();
  if (["true", "1", "on", "开", "打开", "开启", "是"].includes(t)) return true;
  if (["false", "0", "off", "关", "关闭", "关掉", "否"].includes(t)) return false;
  throw new Error(`active 要写 true 或 false（收到：${v}）`);
}
const TIMELINE_HOURS = 4;   // 简报里带最近几小时
const KEEP_DAYS = 14;       // 事件留几天

// 表第一次用时自己建（网页后台部署时不用另外跑 schema.sql）
const schemaReady = new WeakSet();   // 按数据库记：建过表的就不再建
async function ensureSchema(db) {
  if (schemaReady.has(db)) return;
  await db.batch(SCHEMA.split(";").map(x => x.trim()).filter(Boolean).map(x => db.prepare(x)));
  schemaReady.add(db);
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL, app TEXT, place TEXT, data TEXT);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
CREATE INDEX IF NOT EXISTS events_app ON events (app, type, ts);
CREATE TABLE IF NOT EXISTS wakes (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, rule TEXT, reason TEXT, outcome TEXT, briefing TEXT);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS checks (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, trigger TEXT, wake INTEGER, reason TEXT, outcome TEXT)`;

function json(o, status = 200) {
  return new Response(JSON.stringify(o, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "x-knock": SIGN_HDR } });
}

function authed(req, token) {
  token = String(token || "").trim();   // 粘贴口令时常带进空格、换行
  if (!token) return false;
  const h = req.headers.get("authorization") || "";
  const q = new URL(req.url).searchParams;
  const got = (h.startsWith("Bearer ") ? h.slice(7) : q.get("key") || q.get("token") || "").trim();
  if (got.length !== token.length) return false;
  let d = 0;
  for (let i = 0; i < got.length; i++) d |= got.charCodeAt(i) ^ token.charCodeAt(i);
  return d === 0;
}

async function kvGet(db, k, dflt) {
  const r = await db.prepare("SELECT v FROM kv WHERE k = ?").bind(k).first();
  return r ? JSON.parse(r.v) : dflt;
}
async function kvPut(db, k, v) {
  await db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, JSON.stringify(v)).run();
}

function parseEvent(body) {
  const type = String(body.type || "").trim();
  if (!TYPES.has(type)) throw new Error(`不认识的 type：${type || "（空）"}`);
  let ts = Date.now();
  if (body.t != null && body.t !== "") {
    const p = typeof body.t === "number" ? body.t : Date.parse(body.t);
    if (!Number.isNaN(p) && Math.abs(p - ts) < 24 * 3600e3) ts = p;   // 太离谱的时间不信，用收到的时间
  }
  const { type: _a, t: _b, app, place, ...data } = body;
  if (REPORT_FIELDS[type]) return parseReport(type, ts, body);
  if (type === "battery_low" || type === "battery_ok") {
    if (data.level != null && data.level !== "") {
      const n = Number(String(data.level).replace("%", "").trim());
      if (!(n >= 0 && n <= 100)) throw new Error(`level 要是 0–100 的数（收到：${data.level}）`);
      data.level = Math.round(n);
    } else delete data.level;
  }
  if (type === "focus_change") {
    const raw = String(data.mode || "").trim();
    if (!raw) throw new Error("focus_change 要带 mode（work / sleep / dnd）");
    data.mode = FOCUS_ALIAS[raw.toLowerCase()] || FOCUS_ALIAS[raw] || raw.slice(0, 20);   // 别的模式（个人、健身…）原样记下，不做保护
    if (data.active == null || data.active === "") throw new Error("focus_change 要带 active（打开 true，关掉 false）");
    data.active = typeof data.active === "boolean" ? data.active : flag(data.active);
  }
  if (type === "mood") {
    const m = MOOD_ALIAS[String(data.mood || "").trim().toLowerCase()] || MOOD_ALIAS[String(data.mood || "").trim()];
    if (!m) throw new Error(`mood 要是 happy / low / alone / need_company（或 开心 / 低落 / 想独处 / 想聊天），收到：${data.mood || "（空）"}`);
    data.mood = m;
  }
  return { type, ts, app: app ? String(app).slice(0, 60) : null, place: place ? String(place).slice(0, 60) : null, data };
}

// 更多小报告：只留白名单里的字段。通知正文、金额、商户这些就算快捷指令填进来了，也在这里丢掉，不进数据库
function parseReport(type, ts, body) {
  const keep = REPORT_FIELDS[type], txt = (v, n) => (v == null || String(v).trim() === "" ? null : String(v).trim().slice(0, n));
  const ev = { type, ts, app: null, place: null, data: {} };
  if (keep.includes("app")) ev.app = txt(body.app, 40);
  if (keep.includes("place")) ev.place = txt(body.place, 30);
  if (keep.includes("kind")) { const k = txt(body.kind, 20); if (k) ev.data.kind = k; }
  if (keep.includes("card")) { const k = txt(body.card, 30); if (k) ev.data.card = k; }
  if (keep.includes("sound")) ev.data.sound = soundKind(body.sound);
  if (keep.includes("on")) {
    if (body.on == null || body.on === "") throw new Error("carplay 要带 on（连上 true，断开 false）");
    ev.data.on = typeof body.on === "boolean" ? body.on : flag(body.on);
  }
  return ev;
}

// 防刷屏：notify 同一个 App、sound 同一种声音、截屏，在 dedupe_min 分钟内已经记过一条就不再记
async function recentDuplicate(db, ev, config) {
  const rc = REPORT_FIELDS[ev.type] && (config.reports || {})[ev.type], min = Number(rc && rc.dedupe_min);
  if (!(min > 0)) return null;
  let sql = "SELECT ts FROM events WHERE type = ? AND ts > ? AND ts <= ?";
  const args = [ev.type, ev.ts - min * 60e3, ev.ts];
  if (ev.type === "notify") { sql += ev.app ? " AND app = ?" : " AND app IS NULL"; if (ev.app) args.push(ev.app); }
  if (ev.type === "sound") { sql += " AND json_extract(data, '$.sound') = ?"; args.push(ev.data.sound); }
  const r = await db.prepare(sql + " LIMIT 1").bind(...args).first();
  return r ? min : null;
}

// app_close 时算这次在这个 App 里待了几分钟：最近一次打开它、且之后没关过。
// 快捷指令没带 App 名字的（常见：用了"快捷指令输入"变量，自动化跑的时候是空的），没名字的打开和关掉也配成一对
async function sessionMinutes(db, ev) {
  if (ev.type !== "app_close") return null;
  const same = ev.app ? "app = ?" : "app IS NULL", args = ev.app ? [ev.app] : [];
  const open = await db.prepare(`SELECT ts FROM events WHERE type = 'app_open' AND ${same} AND ts <= ? ORDER BY ts DESC LIMIT 1`).bind(...args, ev.ts).first();
  if (!open) return null;
  const closed = await db.prepare(`SELECT ts FROM events WHERE type = 'app_close' AND ${same} AND ts > ? AND ts < ? LIMIT 1`).bind(...args, open.ts, ev.ts).first();
  if (closed) return null;
  return (ev.ts - open.ts) / 60e3;
}

async function deliver(env, briefing) {
  if (env.WAKE_BUNDLE) {
    const id = await submitWakeEvent(JSON.parse(env.WAKE_BUNDLE), briefing);
    return `已敲门（Aru 外部触发 ${id}）`;
  }
  if (env.PUSH_URL) {   // 先拿推送代替：ntfy 的主题地址，正文就是简报
    const r = await fetch(env.PUSH_URL, { method: "POST", headers: { Title: "knock" }, body: briefing });
    if (!r.ok) throw new Error(`推送失败：HTTP ${r.status}`);
    return "已推送";
  }
  return "没配叫醒方式，只记下";
}

async function eventsSince(db, since) {
  const rows = (await db.prepare("SELECT ts, type, app, place, data FROM events WHERE ts >= ? ORDER BY ts").bind(since).all()).results || [];
  return rows.map(r => ({ ...r, data: JSON.parse(r.data || "{}") }));
}

// 她时区里今天 0 点
function dayStart(ts, tz) {
  const t = localParts(ts, tz);
  return ts - (t.hour * 60 + t.minute) * 60e3 - (ts % 60e3);
}

// 叫醒一次：拼简报、送出去、记下来。hit = {rule, reason}
async function wake(env, hit, ev, config, state) {
  const db = env.DB;
  const timeline = await eventsSince(db, ev.ts - TIMELINE_HOURS * 3600e3);
  const summary = daySummary(await eventsSince(db, dayStart(ev.ts, config.tz)), config.tz);
  const briefing = buildBriefing({ hit, ev, config, timeline, summary, status: statusLine(state, ev.ts, config) });
  let outcome;
  try { outcome = await deliver(env, briefing); } catch (e) { outcome = `失败：${e.message}`; }
  await db.prepare("INSERT INTO wakes (ts, rule, reason, outcome, briefing) VALUES (?, ?, ?, ?, ?)").bind(ev.ts, hit.rule, hit.reason, outcome, briefing).run();
  return { outcome, state: afterWake(hit, ev, { config, state }) };
}

// 问小模型一次。dry = 只问、不叫（管理页的「现在问一次」）
async function modelCheck(env, trigger, { dry = false } = {}) {
  const db = env.DB, now = Date.now();
  const config = mergeConfig(await kvGet(db, "config", null));
  const today = await eventsSince(db, dayStart(now, config.tz));
  const recent = (await eventsSince(db, now - 2 * 3600e3)).map(e => describe(e, config.tz));
  const last = await db.prepare("SELECT ts, reason FROM wakes WHERE outcome NOT LIKE '挡下%' AND rule != 'test' ORDER BY ts DESC LIMIT 1").first();
  const messages = buildMessages({
    trigger, config, now: localParts(now, config.tz).hm, summary: daySummary(today, config.tz), recent,
    status: statusLine(await kvGet(db, "state", {}), now, config),
    lastWake: last ? `${localParts(last.ts, config.tz).hm}，因为 ${last.reason}` : "",
  });
  let decision, outcome = "";
  try {
    decision = parseDecision(await askModel(env, config, messages));
  } catch (e) {
    await db.prepare("INSERT INTO checks (ts, trigger, wake, reason, outcome) VALUES (?, ?, ?, ?, ?)").bind(now, trigger, 0, "", `出错：${e.message}`).run();
    return { ok: false, error: e.message, messages };
  }
  if (decision.wake && !dry) {
    let state = await kvGet(db, "state", {});
    const hit = { rule: "model", reason: decision.reason }, ev = { ts: now };
    const blocked = guard(hit, ev, { config, state });
    if (blocked) outcome = `挡下：${blocked}`;
    else {
      const w = await wake(env, hit, ev, config, state);
      outcome = w.outcome;
      await kvPut(db, "state", w.state);
    }
  } else outcome = dry ? "只是问问，没敲门" : "不叫";
  await db.prepare("INSERT INTO checks (ts, trigger, wake, reason, outcome) VALUES (?, ?, ?, ?, ?)").bind(now, trigger, decision.wake ? 1 : 0, decision.reason, outcome).run();
  return { ok: true, ...decision, outcome, messages };
}

// 定时检查出来的事（下班、很久没动静）：要不要叫、叫了没有，都记进 checks。hold = 不叫的理由（只记录）
async function decide(env, { trigger, hit, now, config, state, hold }) {
  const db = env.DB;
  let outcome;
  const blocked = hold ? null : guard(hit, { ts: now }, { config, state });
  if (hold) outcome = `只记下：${hold}`;
  else if (blocked) outcome = `挡下：${blocked}`;
  else {
    const w = await wake(env, hit, { ts: now }, config, state);
    state = w.state; outcome = w.outcome;
  }
  await db.prepare("INSERT INTO checks (ts, trigger, wake, reason, outcome) VALUES (?, ?, ?, ?, ?)").bind(now, trigger, hold ? 0 : 1, hit.reason, outcome).run();
  return state;
}

// 每次定时：下班确认、很久没动静。不管小模型开没开都跑
async function settle(env, config, now) {
  const db = env.DB;
  let state = await kvGet(db, "state", {});
  const we = confirmWorkEnd(state, now, config);
  state = we.state;
  if (we.ended && config.work_end.enabled) {
    const { start, end } = we.ended, hm = ts => localParts(ts, config.tz).hm;
    const dur = start && start < end ? `，从 ${hm(start)} 起工作了约 ${Math.round((end - start) / 3600e3 * 10) / 10} 小时` : "";
    state = await decide(env, { trigger: "下班确认", now, config, state,
      hit: { rule: "work_end", reason: `${hm(end)} 关了工作模式、${config.work_end.confirm_min} 分钟没再打开，算下班了${dur}` },
      hold: config.work_end.wake ? null : "work_end.wake 没打开" });
  }
  const ia = checkInactivity(state, now, config);
  state = ia.state;
  if (ia.step === "pending") {
    const h = Math.round(ia.gap / 3600e3 * 10) / 10;
    await db.prepare("INSERT INTO checks (ts, trigger, wake, reason, outcome) VALUES (?, ?, ?, ?, ?)")
      .bind(now, "没动静检查", 0, `已经 ${h} 小时没有动静`, "先等等，下次检查还没动静才算").run();
  }
  if (ia.step === "confirmed") {
    const hold = !config.inactivity.wake ? "inactivity.wake 没打开（先看几天记得对不对）"
      : state.battery_low ? "手机电量低，可能是没电关机了，不当成没动静" : null;
    state = await decide(env, { trigger: "没动静检查", hit: ia.hit, now, config, state, hold });
  }
  await kvPut(db, "state", state);
  return state;
}

async function handleEvent(req, env, ectx) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "要 JSON" }, 400); }
  let ev;
  try { ev = parseEvent(body); } catch (e) { return json({ ok: false, error: e.message }, 400); }
  const db = env.DB;
  const config = mergeConfig(await kvGet(db, "config", null));
  const dup = await recentDuplicate(db, ev, config);
  if (dup) return json({ ok: true, wake: false, skipped: `${dup} 分钟内已经记过一条同样的，这条不记` });
  await db.prepare("INSERT INTO events (ts, type, app, place, data) VALUES (?, ?, ?, ?, ?)")
    .bind(ev.ts, ev.type, ev.app, ev.place, JSON.stringify(ev.data)).run();

  let state = applyState(ev, await kvGet(db, "state", {}), config);
  const ctx = { config, state, sessionMin: await sessionMinutes(db, ev) };
  const hit = evaluate(ev, ctx);
  let result = { ok: true, wake: false };
  if (hit) {
    const blocked = guard(hit, ev, ctx);
    if (blocked) {
      await db.prepare("INSERT INTO wakes (ts, rule, reason, outcome) VALUES (?, ?, ?, ?)").bind(ev.ts, hit.rule, hit.reason, `挡下：${blocked}`).run();
      result = { ok: true, wake: false, rule: hit.rule, blocked };
    } else {
      const w = await wake(env, hit, ev, config, state);
      state = w.state;
      result = { ok: true, wake: true, rule: hit.rule, outcome: w.outcome };
    }
  }
  await kvPut(db, "state", state);
  // 没碰到规则、但差一点：回完快捷指令再让小模型看（不让手机等）
  const near = !hit && config.model.enabled && !state.asleep && !quietReason(state, ev.ts, config.tz) ? nearMiss(ev, ctx) : null;
  if (near) {
    const job = modelCheck(env, "差一点：" + near);
    if (ectx && ectx.waitUntil) ectx.waitUntil(job); else await job;
    result.model = "交给小模型看了";
  }
  return json(result);
}

export default {
  async fetch(req, env, ectx) {
    const url = new URL(req.url), p = url.pathname;
    if (!env.DB) return json({ ok: false, error: "还没绑定 D1 数据库（变量名要叫 DB）" }, 500);
    await ensureSchema(env.DB);
    if (p === "/event" && req.method === "POST") {
      if (!String(env.EVENT_TOKEN || "").trim()) return json({ ok: false, error: "守门人还没设 EVENT_TOKEN（或者设了没点 Deploy）" }, 401);
      if (!authed(req, env.EVENT_TOKEN)) return json({ ok: false, error: "事件口令不对" }, 401);
      return handleEvent(req, env, ectx);
    }
    // 管理页本身不带数据，谁都能打开；页面里取数据要带管理口令
    if ((p === "/" || p === "/admin") && req.method === "GET") return new Response(ADMIN_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-knock": SIGN_HDR } });
    if (!String(env.ADMIN_TOKEN || "").trim()) return json({ ok: false, error: "守门人还没设 ADMIN_TOKEN（名字要一模一样，设了要点 Deploy）" }, 401);
    if (!authed(req, env.ADMIN_TOKEN)) return json({ ok: false, error: "管理口令不对（看看网址 ?key= 后面那串跟 ADMIN_TOKEN 是不是一样；口令里别用 + & # 空格这些符号）" }, 401);
    const db = env.DB;
    if (p === "/config" && req.method === "GET") return json(mergeConfig(await kvGet(db, "config", null)));
    if (p === "/config" && req.method === "PUT") {
      let body; try { body = await req.json(); } catch { return json({ ok: false, error: "要 JSON" }, 400); }
      const merged = mergeConfig({ ...(await kvGet(db, "config", {})), ...body });
      await kvPut(db, "config", merged);
      return json({ ok: true, config: merged });
    }
    if (p === "/timeline") {
      const h = Math.min(72, Number(url.searchParams.get("hours")) || 6);
      const rows = (await db.prepare("SELECT ts, type, app, place, data FROM events WHERE ts >= ? ORDER BY ts").bind(Date.now() - h * 3600e3).all()).results;
      return json(rows);
    }
    if (p === "/wakes") {
      const rows = (await db.prepare("SELECT ts, rule, reason, outcome FROM wakes ORDER BY ts DESC, id DESC LIMIT 50").all()).results;
      return json(rows);
    }
    if (p === "/state") {
      const state = await kvGet(db, "state", {}), config = mergeConfig(await kvGet(db, "config", null));
      return json({ 现在: statusLine(state, Date.now(), config) || "没有特别的状态", ...state });
    }
    if (p === "/checks") {
      const rows = (await db.prepare("SELECT ts, trigger, wake, reason, outcome FROM checks ORDER BY ts DESC, id DESC LIMIT 40").all()).results;
      return json(rows);
    }
    if (p === "/ask" && req.method === "POST") return json(await modelCheck(env, "管理页手动问", { dry: true }));
    if (p === "/test" && req.method === "POST") {   // 管理页的「测试敲门」：不看规则，直接送一条
      const config = mergeConfig(await kvGet(db, "config", null));
      const briefing = buildBriefing({ hit: { rule: "test", reason: "测试敲门" }, ev: { ts: Date.now() }, config, timeline: [] });
      let outcome; try { outcome = await deliver(env, briefing); } catch (e) { outcome = `失败：${e.message}`; }
      await db.prepare("INSERT INTO wakes (ts, rule, reason, outcome, briefing) VALUES (?, ?, ?, ?, ?)").bind(Date.now(), "test", "测试敲门", outcome, briefing).run();
      return json({ ok: true, outcome });
    }
    return json({ ok: false, error: "没有这个地址" }, 404);
  },

  // 定时（Cron 建议每 30 分钟）：清旧记录；开了小模型的话，白天到点让它看一眼
  async scheduled(ev, env, ectx) {
    const db = env.DB, now = (ev && ev.scheduledTime) || Date.now();
    await ensureSchema(db);
    await db.prepare("DELETE FROM events WHERE ts < ?").bind(now - KEEP_DAYS * 86400e3).run();
    await db.prepare("DELETE FROM checks WHERE ts < ?").bind(now - KEEP_DAYS * 86400e3).run();
    const config = mergeConfig(await kvGet(db, "config", null)), m = config.model;
    const state = await settle(env, config, now);   // 下班、没动静：跟小模型开没开无关
    if (!m.enabled) return;
    const h = localParts(now, config.tz).hour;
    if (state.asleep || quietReason(state, now, config.tz) || !(m.from <= m.to ? h >= m.from && h < m.to : h >= m.from || h < m.to)) return;
    const lastAsk = await kvGet(db, "model_last", 0);
    if (now - lastAsk < (m.every_min - 2) * 60e3) return;   // Cron 比 every_min 勤的话跳过几次
    await kvPut(db, "model_last", now);
    const job = modelCheck(env, "定时看一眼");
    if (ectx && ectx.waitUntil) ectx.waitUntil(job); else await job;
  },
};

// 管理页：口令放在地址后面 ?key=ADMIN_TOKEN，页面里的请求都带上它
const ADMIN_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>knock 守门人</title><style>
:root{--bg:#f6f3ef;--card:#fff;--ink:#2a2522;--dim:#8a817a;--acc:#c96442}
@media (prefers-color-scheme:dark){:root{--bg:#171513;--card:#211e1b;--ink:#eee7df;--dim:#9a9087}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:720px;margin:0 auto;padding:20px 16px 60px}h1{font-size:22px;margin:4px 0 2px}p.s{color:var(--dim);margin:0 0 16px}
section{background:var(--card);border-radius:16px;padding:16px;margin:0 0 14px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
h2{font-size:16px;margin:0 0 8px}textarea{width:100%;box-sizing:border-box;min-height:260px;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;background:transparent;color:var(--ink);border:1px solid rgba(128,128,128,.3);border-radius:10px;padding:10px}
button{font:inherit;border:0;border-radius:10px;padding:9px 16px;background:var(--acc);color:#fff;cursor:pointer;margin-right:8px}button.g{background:rgba(128,128,128,.18);color:var(--ink)}
.row{font-size:13px;padding:6px 0;border-top:1px solid rgba(128,128,128,.15)}.row:first-child{border:0}.d{color:var(--dim)}#msg{min-height:1.4em;color:var(--acc);margin-top:8px}
</style></head><body><main>
<h1>knock 守门人</h1><p class="s">快捷指令报来的事，按这里的规则判断要不要敲门叫醒 Aru 里的 TA。</p>
<section><h2>叫醒说明</h2><p class="s">note 是 TA 用自己的口气写给守门人的话，会原样放进简报。其余是开关和数字，改完点保存。</p>
<textarea id="cfg"></textarea><div style="margin-top:10px"><button id="save">保存</button><button class="g" id="test">测试敲门</button></div><div id="msg"></div></section>
<section><h2>她现在</h2><div id="now" class="d">读取中…</div></section>
<section><h2>小模型和定时检查</h2><p class="s">小模型：规则管不到的时候它替 TA 看一眼，只决定叫不叫，叫了也要过硬底线。在叫醒说明里把 model.enabled 改成 true 才会开始看。定时检查（下班、很久没动静）不管小模型开没开都会跑，结果也记在下面。</p>
<button class="g" id="ask">现在问它一次（不会真的敲门）</button><div id="askr" class="row" style="display:none"></div><div id="checks" class="d" style="margin-top:8px">读取中…</div></section>
<section><h2>叫醒记录</h2><div id="wakes" class="d">读取中…</div></section>
<section><h2>最近 6 小时收到的事</h2><div id="tl" class="d">读取中…</div></section>
<p class="s" style="text-align:center;font-size:12px;margin-top:22px">${SIGN}<br>原版在 github.com/White-ting/Aru-kit · 不许转发、不许商用</p>
</main><script>
const K=new URLSearchParams(location.search).get('key')||'';
const H={Authorization:'Bearer '+K,'Content-Type':'application/json'};
const $=id=>document.getElementById(id), msg=t=>$('msg').textContent=t;
const t=ms=>new Date(ms).toLocaleString('zh-CN',{hour12:false});
const esc=s=>String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function api(p,o){const r=await fetch(p,Object.assign({headers:H},o||{}));if(r.status==401){const j=await r.json().catch(()=>({}));throw new Error(j.error||'口令不对');}return r.json();}
async function load(){
 try{$('cfg').value=JSON.stringify(await api('/config'),null,2);}catch(e){msg(e.message);return;}
 const w=await api('/wakes');$('wakes').innerHTML=w.length?w.map(x=>'<div class="row">'+t(x.ts)+' · '+esc(x.rule)+' · '+esc(x.reason)+'<br><span class="d">'+esc(x.outcome)+'</span></div>').join(''):'还没有';
 const st=await api('/state');$('now').textContent=st['现在'];
 const c=await api('/checks');$('checks').innerHTML=c.length?c.map(x=>'<div class="row">'+t(x.ts)+' · '+esc(x.trigger)+' · <b>'+(x.wake?'想叫':'不叫')+'</b> '+esc(x.reason)+'<br><span class="d">'+esc(x.outcome)+'</span></div>').join(''):'还没看过';
 const e=await api('/timeline?hours=6');$('tl').innerHTML=e.length?e.slice().reverse().map(x=>'<div class="row">'+t(x.ts)+' · '+esc(x.type)+' '+esc(x.app||x.place||'')+((x.type=='app_open'||x.type=='app_close')&&!x.app?' <b style="color:var(--acc)">没带 App 名字（快捷指令请求体里加 app）</b>':'')+' <span class="d">'+esc(x.data&&x.data!='{}'?x.data:'')+'</span></div>').join(''):'还没有';
}
$('save').onclick=async()=>{let c;try{c=JSON.parse($('cfg').value);}catch(e){return msg('格式不对：'+e.message);}
 try{await api('/config',{method:'PUT',body:JSON.stringify(c)});msg('保存好了');load();}catch(e){msg(e.message);}};
$('ask').onclick=async()=>{const b=$('askr');b.style.display='block';b.textContent='问着…';
 try{const r=await api('/ask',{method:'POST'});b.innerHTML=r.ok?('<b>'+(r.wake?'想叫':'不叫')+'</b> · '+esc(r.reason)):('出错：'+esc(r.error));load();}catch(e){b.textContent=e.message;}};
$('test').onclick=async()=>{msg('敲门中…');try{const r=await api('/test',{method:'POST'});msg('结果：'+r.outcome);load();}catch(e){msg(e.message);}};
load();
</script></body></html>`;
