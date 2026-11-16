// 不装 wrangler 的本地测试：node:sqlite 假装 D1，直接调 Worker 的 fetch。
// 跑法（项目根目录）：docker run --rm -v "$PWD/aru/worker":/w -w /w node:24-alpine node test/run.mjs
import { DatabaseSync } from "node:sqlite";
import { createDecipheriv, randomBytes } from "node:crypto";
const worker = (await import(process.env.WORKER || "../src/index.js")).default;
import { sealWakeEvent } from "../src/seal.js";
import { parseDecision } from "../src/model.js";
import { daySummary, describe, checkInactivity, mergeConfig } from "../src/rules.js";

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  return {
    async batch(stmts) { for (const st of stmts) await st.run(); return []; },
    prepare(sql) {
      let args = [];
      const st = {
        bind(...a) { args = a; return st; },
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async run() { db.prepare(sql).run(...args); return { success: true }; },
      };
      return st;
    },
  };
}

let fails = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "通过" : "失败"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
}

const env = { DB: fakeD1(), EVENT_TOKEN: "ev-token-123", ADMIN_TOKEN: "admin-token-456" };
const base = "https://knock.test";
// 北京时间某天的时刻 → ISO
const at = (day, hm) => new Date(`${new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7)}-${day}T${hm}:00+08:00`).toISOString();   // 今天所在的年月（北京时间）
async function send(body, token = env.EVENT_TOKEN) {
  const r = await worker.fetch(new Request(base + "/event", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }), env);
  return { status: r.status, ...(await r.json()) };
}
async function admin(path, method = "GET", body) {
  const r = await worker.fetch(new Request(base + path, { method, headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` }, body: body ? JSON.stringify(body) : undefined }), env);
  return r.json();
}

// 事件时间要在"现在"前后一天内才会被采用，所以测试日期用今天
const now = new Date(), pad = n => String(n).padStart(2, "0");
const bj = new Date(now.getTime() + 8 * 3600e3);
const D = pad(bj.getUTCDate());

check("口令不对被拒", (await send({ type: "note" }, "wrong")).status === 401);
check("不认识的 type 被拒", (await send({ type: "dance" })).status === 400);

await admin("/config", "PUT", { note: "她熬夜我会担心，到医院一定叫我。", places: { watch: ["医院"] }, cooldown_min: 30 });
const cfg = await admin("/config");
check("叫醒说明存进去了", cfg.places.watch[0] === "医院" && cfg.late_night.from === 1 && cfg.cooldown_min === 30);

let r = await send({ type: "app_open", app: "小红书", t: at(D, "00:50") });
check("00:50 开 App 不叫", r.wake === false);
r = await send({ type: "app_open", app: "小红书", t: at(D, "01:20") });
check("01:20 开 App 叫醒（熬夜）", r.wake === true && r.rule === "late_night", r.outcome);
r = await send({ type: "app_open", app: "微博", t: at(D, "02:30") });
check("同一夜第二次熬夜不叫", r.wake === false && /今晚已经/.test(r.blocked || ""), r.blocked);

await send({ type: "sleep", t: at(D, "02:40") });
await send({ type: "wake_up", t: at(D, "08:00") });
r = await send({ type: "arrive", place: "市第一人民医院", t: at(D, "10:10") });
check("到医院叫醒", r.wake === true && r.rule === "place", r.outcome);
r = await send({ type: "leave", place: "市第一人民医院", t: at(D, "10:25") });
check("15 分钟后离开医院被冷却挡下", r.wake === false && /冷却/.test(r.blocked || ""), r.blocked);

await send({ type: "app_open", app: "抖音", t: at(D, "12:00") });
r = await send({ type: "app_close", app: "抖音", t: at(D, "14:05") });
check("抖音待了 125 分钟叫醒", r.wake === true && r.rule === "long_session", r.outcome);

await send({ type: "sleep", t: at(D, "22:30") });
await send({ type: "app_open", app: "淘宝", t: at(D, "22:40") });
r = await send({ type: "app_close", app: "淘宝", t: at(D, "23:59") });
check("睡觉状态下长时间也不叫（不是熬夜规则）", r.wake === false, r.blocked || "");

await send({ type: "wake_up", t: at(D, "23:59") });
await admin("/config", "PUT", { cooldown_min: 0 });
await send({ type: "app_open", t: at(D, "21:00") });
r = await send({ type: "app_close", t: at(D, "23:10") });
check("快捷指令没带 App 名字，打开和关掉也能配对算时长", r.wake === true && r.rule === "long_session", r.outcome || r.blocked);
await admin("/config", "PUT", { cooldown_min: 30 });
const wakes = await admin("/wakes");
const sent = wakes.filter(w => !String(w.outcome).startsWith("挡下"));
check("记了 4 次叫醒", sent.length === 4, sent.map(w => w.rule).join(","));
const full = env.DB.prepare("SELECT briefing FROM wakes WHERE rule = 'place' AND briefing IS NOT NULL");
const b = (await full.first()).briefing;
check("简报带交代的话和时间线", b.includes("她熬夜我会担心") && b.includes("到达「市第一人民医院」"));
check("真的叫醒，简报开头写明不是测试", b.startsWith("〔守门人敲门 · 这次是真的〕"));
console.log("\n--- 到医院那次的简报 ---\n" + b + "\n---");

const page = await worker.fetch(new Request(base + "/?key=x"), env);
check("管理页不用口令也能打开", page.status === 200 && (await page.text()).includes("knock 守门人"));
const qk = await worker.fetch(new Request(base + "/config?key=" + env.ADMIN_TOKEN), env);
check("?key= 也能当管理口令", qk.status === 200);
const tr = await admin("/test", "POST");
check("测试敲门（没配叫醒方式时只记下）", tr.ok && /只记下/.test(tr.outcome), tr.outcome);
const tb = (await env.DB.prepare("SELECT briefing FROM wakes WHERE rule = 'test'").first()).briefing;
check("测试敲门的简报写明是测试", tb.startsWith("〔守门人 · 测试敲门〕") && !tb.includes("这次是真的"));

// 封信：用 Node 的 crypto 解开，对上 aru-host wake-send.mjs 的格式
const key = randomBytes(32);
const bundle = { schema: "aru.wake-bridge.sender-bundle.v2", triggerId: "trg-1", submitURL: "https://host.example/x", submitToken: "t", encryptionKey: key.toString("base64") };
const env2 = await sealWakeEvent(bundle, "  你好  ", "evt-1");
const raw = Buffer.from(env2.sealedPayload, "base64");
const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
d.setAuthTag(raw.subarray(raw.length - 16));
const plain = JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8"));
check("信封能用 Node 解开、字段对", env2.schema === "aru.wake-bridge.sealed-event.v1" && plain.schema === "aru.wake-bridge.payload.v2"
  && plain.eventId === "evt-1" && plain.triggerId === "trg-1" && plain.content === "你好");

// ---------- 小模型 ----------
console.log("\n--- 小模型 ---");
const replies = [], calls = [];
const fakeAI = { async run(name, input) { calls.push({ name, input }); const r = replies.shift(); if (r instanceof Error) throw r; return r; } };
const m = { DB: fakeD1(), EVENT_TOKEN: "ev-token-123", ADMIN_TOKEN: "admin-token-456", AI: fakeAI };
const ago = min => new Date(Date.now() - min * 60e3).toISOString();
const sendM = async body => (await worker.fetch(new Request(base + "/event", { method: "POST", headers: { authorization: `Bearer ${m.EVENT_TOKEN}` }, body: JSON.stringify(body) }), m)).json();
const adminM = async (path, method = "GET", body) => (await worker.fetch(new Request(base + path, { method, headers: { authorization: `Bearer ${m.ADMIN_TOKEN}` }, body: body ? JSON.stringify(body) : undefined }), m)).json();

await sendM({ type: "app_open", app: "微信", t: ago(100) });
let mr = await sendM({ type: "app_close", app: "微信", t: ago(10) });
check("小模型没开：差一点也不问它", calls.length === 0 && !mr.model);

await adminM("/config", "PUT", { note: "她一个人闷着刷手机很久的时候叫我。", model: { enabled: true, from: 0, to: 24 } });
replies.push({ response: '<think>想一想</think>{"wake": false, "reason": "她在正常聊微信"}' });
let ask = await adminM("/ask", "POST");
check("管理页问一次：只问不叫", ask.ok && ask.wake === false && /正常聊微信/.test(ask.reason) && calls.length === 1);
const sys = calls[0].input.messages[0].content, usr = calls[0].input.messages[1].content;
check("提示里有 TA 的原话和今天的摘要", sys.includes("她一个人闷着刷手机") && /微信 开了 1 次、约 90 分钟/.test(usr), usr.split("\n")[1]);
check("默认模型是 Workers AI 的 qwen3", calls[0].name === "@cf/qwen/qwen3-30b-a3b-fp8");
check("默认性子是少叫", sys.includes("拿不准就不叫"));
await adminM("/config", "PUT", { model: { enabled: true, from: 0, to: 24, style: "多叫" } });
replies.push({ response: '{"wake": false, "reason": "x"}' });
await adminM("/ask", "POST");
check("性子改成多叫，提示跟着换", calls[1].input.messages[0].content.includes("只要有一点 TA 可能在意的迹象就叫") && !calls[1].input.messages[0].content.includes("拿不准就不叫"));
await adminM("/config", "PUT", { model: { enabled: true, from: 0, to: 24, style: "少叫" } });
calls.length = 1;

await sendM({ type: "app_open", app: "小红书", t: ago(95) });
replies.push({ choices: [{ message: { content: '{"wake": true, "reason": "她在小红书里待了快一个半小时，一直没出来"}' } }] });
mr = await sendM({ type: "app_close", app: "小红书", t: ago(5) });
check("差一点（85 分钟，规则 120）交给小模型、它说叫就叫", mr.wake === false && mr.model && calls.length === 2);
let mw = await adminM("/wakes");
check("叫醒记录里是小模型叫的", mw[0] && mw[0].rule === "model" && !/挡下/.test(mw[0].outcome), mw[0] && mw[0].outcome);
const mb = (await m.DB.prepare("SELECT briefing FROM wakes WHERE rule = 'model'").first()).briefing;
check("简报写着小模型的理由、今天的摘要", mb.includes("守门人的小模型看了觉得——她在小红书里待了快一个半小时") && mb.includes("她今天："));

await sendM({ type: "app_open", app: "抖音", t: ago(4) });
replies.push({ response: '{"wake": true, "reason": "又开了抖音"}' });
await sendM({ type: "app_close", app: "抖音", t: ago(3) });   // 待了 1 分钟：不算差一点
check("离规则还远的事件不问小模型", calls.length === 2);
replies.length = 0;

replies.push({ response: '{"wake": true, "reason": "还在刷"}' });
await sendM({ type: "arrive", place: "公司" });
let mc = await adminM("/checks");
check("小模型说叫也要过冷却", /挡下：离上次叫醒/.test(mc[0].outcome), mc[0].outcome);

await adminM("/config", "PUT", { cooldown_min: 0, model: { enabled: true, from: 0, to: 24, daily_cap: 1 } });
replies.push({ response: '{"wake": true, "reason": "又到了一个地方"}' });
await sendM({ type: "leave", place: "公司" });
mc = await adminM("/checks");
check("小模型一天的上限", /小模型今天已经叫过 1 次/.test(mc[0].outcome), mc[0].outcome);

replies.length = 0;   // 定时那次 replies 已经空了 → 这次故意回乱码
replies.push({ response: "我觉得应该叫醒吧" });
await worker.scheduled({}, m);
mc = await adminM("/checks");
check("定时看一眼；回的不是 JSON 记成出错、不叫", mc[0].trigger === "定时看一眼" && /出错/.test(mc[0].outcome), mc[0].outcome);
const n0 = calls.length;
await worker.scheduled({}, m);
check("刚看过，下一次 Cron 跳过", calls.length === n0);

await sendM({ type: "sleep" });
await m.DB.prepare("DELETE FROM kv WHERE k = 'model_last'").run();
await worker.scheduled({}, m);
check("她睡了，定时不看", calls.length === n0);

check("JSON 前后有废话也能读", parseDecision('好的：\n```json\n{"wake":"true","reason":"x"}\n```').wake === true);
const sum = daySummary([{ ts: 0, type: "wake_up" }, { ts: 60e3, type: "app_open", app: "A" }, { ts: 31 * 60e3, type: "app_close", app: "A" },
  { ts: 32 * 60e3, type: "app_open", app: "B" }], "Asia/Shanghai");
check("今天的摘要", /08:00 起床/.test(sum) && /A 开了 1 次、约 30 分钟/.test(sum) && /B 开了 1 次/.test(sum), sum);

// ---------- 新事件：电量、专注模式、心情；下班、很久没动静 ----------
console.log("\n--- 新事件和状态 ---");
function mk(extra = {}) {
  const e = { DB: fakeD1(), EVENT_TOKEN: "ev-token-123", ADMIN_TOKEN: "admin-token-456", ...extra };
  return {
    env: e,
    send: async body => { const r = await worker.fetch(new Request(base + "/event", { method: "POST", headers: { authorization: `Bearer ${e.EVENT_TOKEN}` }, body: JSON.stringify(body) }), e); return { status: r.status, ...(await r.json()) }; },
    admin: async (path, method = "GET", body) => (await worker.fetch(new Request(base + path, { method, headers: { authorization: `Bearer ${e.ADMIN_TOKEN}` }, body: body ? JSON.stringify(body) : undefined }), e)).json(),
    tick: min => worker.scheduled({ scheduledTime: Date.now() + min * 60e3 }, e),
  };
}
// 11-04 Ting：九种小报告默认都不叫醒；测"叫醒"那几段先在管理页把关闹钟、声音打开
async function mkOn(extra = {}) {
  const m = mk(extra);
  await m.admin("/config", "PUT", { reports: { alarm_stop: { wake: true }, sound: { wake: true } } });
  return m;
}
const H24 = { from: 0, to: 24 };
// 没动静从"今天检查时段开始"算起：时段设成从 6 小时前到 2 小时后，几点跑测试都对
const HB = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false }).format(new Date())) % 24;
const HW = { from: (HB + 18) % 24, to: (HB + 2) % 24 };

let k = mk();
let x = await k.send({ type: "battery_low", level: "18%" });
let st = await k.admin("/state");
check("低电量：18% 记下、状态是电量低", x.ok && st.battery_low === true && st.battery_level === 18 && /电量低（18%）/.test(st["现在"]), st["现在"]);
check("低电量：level 写错被拒", (await k.send({ type: "battery_low", level: "很低" })).status === 400);
await k.send({ type: "charge_start" });
check("插上充电，电量低解除", (await k.admin("/state")).battery_low === false);
check("专注模式：没带 active 被拒", (await k.send({ type: "focus_change", mode: "work" })).status === 400);
check("心情：不认识的被拒", (await k.send({ type: "mood", mood: "无聊" })).status === 400);

// 工作模式：拦平常的关心，到医院照叫
k = mk();
await k.admin("/config", "PUT", { cooldown_min: 0, places: { watch: ["医院"] } });
x = await k.send({ type: "focus_change", mode: "工作", active: "true", t: ago(200) });
st = await k.admin("/state");
check("专注模式写中文「工作」也认、状态是在工作", x.ok && st.focus_mode === "work" && /在工作/.test(st["现在"]), st["现在"]);
await k.send({ type: "app_open", app: "抖音", t: ago(150) });
x = await k.send({ type: "app_close", app: "抖音", t: ago(20) });
check("工作模式下 App 待太久被拦", x.wake === false && /工作专注模式/.test(x.blocked || ""), x.blocked);
x = await k.send({ type: "arrive", place: "医院", t: ago(19) });
check("工作模式下到医院照样叫", x.wake === true && x.rule === "place", x.outcome || x.blocked);
const kb = (await k.env.DB.prepare("SELECT briefing FROM wakes WHERE rule = 'place'").first()).briefing;
check("简报里有「她现在：在工作」", /她现在：在工作/.test(kb), kb.split("\n").find(l => l.startsWith("她现在")));

// 下班：关了又开不算；关满 15 分钟算
await k.send({ type: "focus_change", mode: "work", active: false, t: ago(18) });
await k.send({ type: "focus_change", mode: "work", active: true, t: ago(17) });
st = await k.admin("/state");
check("关了马上又开：不算下班，开始时间照旧", !st.pending_work_end_at && st.focus_mode === "work" && Math.abs(st.work_started_at - (Date.now() - 200 * 60e3)) < 5e3);
await k.send({ type: "focus_change", mode: "work", active: false, t: ago(10) });
await k.tick(0);
st = await k.admin("/state");
check("关了 10 分钟：还没确认下班", st.pending_work_end_at && !st.work_ended_at && /还没确认下班/.test(st["现在"]), st["现在"]);
await k.tick(10);
st = await k.admin("/state");
let kc = await k.admin("/checks");
check("关满 15 分钟：下班，记进检查记录、默认只记不叫", st.work_ended_at && !st.pending_work_end_at && kc[0].trigger === "下班确认" && /只记下/.test(kc[0].outcome) && /工作了约 3.2 小时/.test(kc[0].reason), kc[0] && kc[0].reason);
await k.admin("/config", "PUT", { work_end: { wake: true } });
await k.send({ type: "focus_change", mode: "work", active: true, t: ago(8) });
await k.send({ type: "focus_change", mode: "work", active: false, t: ago(7) });
await k.tick(10);
kc = await k.admin("/checks");
check("work_end.wake 打开后下班会叫醒", kc[0].trigger === "下班确认" && !/^(只记下：|挡下)/.test(kc[0].outcome) && (await k.admin("/wakes"))[0].rule === "work_end", kc[0].outcome);

// 心情
k = mk();
await k.admin("/config", "PUT", { cooldown_min: 60, places: { watch: ["医院"] } });
await k.send({ type: "mood", mood: "想独处", t: ago(60) });
await k.send({ type: "app_open", app: "微博", t: ago(190) });
x = await k.send({ type: "app_close", app: "微博", t: ago(50) });
check("想独处：App 待太久被拦", x.wake === false && /想独处/.test(x.blocked || ""), x.blocked);
x = await k.send({ type: "arrive", place: "医院", t: ago(45) });
check("想独处时到医院照样叫", x.wake === true, x.outcome || x.blocked);
await k.send({ type: "sleep", t: ago(40) });
x = await k.send({ type: "mood", mood: "need_company", t: ago(20) });
check("点想聊天：睡觉状态、离上次 25 分钟（平常冷却 60）也叫，冷却只算 15", x.wake === true && x.rule === "mood_request", x.outcome || x.blocked);
const mrb = (await k.env.DB.prepare("SELECT briefing FROM wakes WHERE rule = 'mood_request'").first()).briefing;
check("想聊天的简报开头写明是她自己点的", mrb.startsWith("〔守门人敲门 · 这次是真的〕这不是测试：她刚在手机上点了「想聊天」"), mrb.split("\n")[0]);
x = await k.send({ type: "mood", mood: "想聊天", t: ago(10) });
check("10 分钟后又点想聊天：被 15 分钟冷却挡下", x.wake === false && /冷却 15/.test(x.blocked || ""), x.blocked);
st = await k.admin("/state");
check("点了别的心情，想独处作废", !(st.alone_until > Date.now()) && st.mood === "need_company");
k = mk();
await k.send({ type: "mood", mood: "alone", t: ago(300) });
await k.send({ type: "app_open", app: "微博", t: ago(160) });
x = await k.send({ type: "app_close", app: "微博", t: ago(30) });   // 想独处到 60 分钟前就过期了
check("想独处 4 小时过了就不拦", x.wake === true && x.rule === "long_session", x.outcome || x.blocked);

// 很久没动静
k = mk();
await k.admin("/config", "PUT", { inactivity: HW });
await k.send({ type: "app_open", app: "微信", t: ago(200) });
await k.send({ type: "charge_start", t: ago(100) });
await k.send({ type: "note", text: "自动化备注", t: ago(90) });
await k.tick(0);
kc = await k.admin("/checks");
check("3 小时 20 分没动静（充电、备注不算）：先记 pending，不急着算", kc[0] && kc[0].trigger === "没动静检查" && /先等等/.test(kc[0].outcome), kc[0] && kc[0].reason);
await k.tick(10);
check("10 分钟后再查：还在等二次确认", (await k.admin("/checks")).length === 1);
await k.tick(30);
kc = await k.admin("/checks");
check("下一次定时还没动静：算数，默认只记不叫", kc.length === 2 && /只记下：inactivity.wake/.test(kc[0].outcome) && /3 小时/.test(kc[0].reason), kc[0].reason);
await k.tick(60);
check("同一段没动静只算一次", (await k.admin("/checks")).length === 2);
check("小模型没开，没动静检查照样跑", (await k.admin("/config")).model.enabled === false);

k = mk();
await k.admin("/config", "PUT", { inactivity: { ...HW, wake: true } });
await k.send({ type: "app_close", app: "微信", t: ago(240) });
await k.tick(0); await k.tick(30);
kc = await k.admin("/checks");
let kw = await k.admin("/wakes");
check("inactivity.wake 打开：二次确认后叫醒", kw[0] && kw[0].rule === "inactivity" && !/挡下/.test(kw[0].outcome), kw[0] && kw[0].outcome);
await k.send({ type: "app_open", app: "微信", t: ago(1) });
st = await k.admin("/state");
check("有动静了：重新计时", Math.abs(st.last_activity_ts - (Date.now() - 60e3)) < 5e3 && !st.inactivity_pending_since);

k = mk();
await k.admin("/config", "PUT", { inactivity: { ...HW, wake: true } });
await k.send({ type: "app_close", app: "微信", t: ago(240) });
await k.send({ type: "battery_low", level: 5, t: ago(200) });
await k.tick(0); await k.tick(30);
kc = await k.admin("/checks");
check("电量低时没动静：多半是没电关机，只记不叫", /电量低/.test(kc[0].outcome), kc[0].outcome);

k = mk();
await k.admin("/config", "PUT", { inactivity: { ...HW, wake: true } });
await k.send({ type: "app_close", app: "微信", t: ago(240) });
await k.send({ type: "focus_change", mode: "dnd", active: true, t: ago(230) });
await k.tick(0); await k.tick(30);
kc = await k.admin("/checks");
check("勿扰模式下没动静：挡下", /挡下：她开着勿扰专注模式/.test(kc[0].outcome), kc[0].outcome);

k = mk();
await k.admin("/config", "PUT", { inactivity: { ...HW, wake: true } });
await k.send({ type: "app_close", app: "微信", t: ago(240) });
await k.send({ type: "focus_change", mode: "睡眠", active: true, t: ago(230) });
st = await k.admin("/state");
await k.tick(0); await k.tick(30);
kc = await k.admin("/checks");
check("睡眠专注模式 = 在睡觉，没动静不叫", st.asleep === true && /挡下：她在睡觉/.test(kc[0].outcome), kc[0].outcome);

// 小模型知道她现在的状态；工作/独处时不白问
const calls2 = [], replies2 = [];
k = mk({ AI: { async run(name, input) { calls2.push(input); return replies2.shift() || { response: '{"wake":false,"reason":"x"}' }; } } });
await k.admin("/config", "PUT", { model: { enabled: true, ...H24 } });
await k.send({ type: "battery_low", level: 12 });
await k.admin("/ask", "POST");
check("小模型的提示里有「她现在：手机电量低（12%）」", /她现在：手机电量低（12%）/.test(calls2[0].messages[1].content));
await k.send({ type: "focus_change", mode: "work", active: true });
await k.send({ type: "app_open", app: "小红书", t: ago(90) });
await k.send({ type: "app_close", app: "小红书", t: ago(1) });
await k.env.DB.prepare("DELETE FROM kv WHERE k = 'model_last'").run();
await k.tick(0);
check("工作模式下：差一点和定时都不问小模型", calls2.length === 1, String(calls2.length));

// 跨天的情况：直接用规则函数，时间随便定
const bjt = (d, hm) => Date.parse(`2026-10-${d}T${hm}:00+08:00`);
const IC = { tz: "Asia/Shanghai", inactivity: { enabled: true, wake: true, hours: 3, from: 9, to: 23 } };
let ic = checkInactivity({ last_activity_ts: bjt(20, "23:00") }, bjt(21, "09:00"), IC);
check("早上 9 点：昨晚 23 点以后的一整夜不算没动静", ic.step === null);
ic = checkInactivity({ last_activity_ts: bjt(20, "23:00") }, bjt(21, "12:10"), IC);
check("到 12:10（从 9 点算满 3 小时）才先记等等", ic.step === "pending" && Math.round(ic.gap / 60e3) === 190);
ic = checkInactivity(ic.state, bjt(21, "12:40"), IC);
check("12:40 确认，理由写明从检查时段开始算", ic.step === "confirmed" && /从今天 09:00（检查时段开始）起 3 小时 40 分钟/.test(ic.hit.reason), ic.hit && ic.hit.reason);
ic = checkInactivity({ last_activity_ts: bjt(20, "19:00"), inactivity_pending_since: bjt(20, "22:50") }, bjt(20, "23:20"), IC);
check("出了时段：没确认完的等等作废", ic.step === null && !ic.state.inactivity_pending_since);
ic = checkInactivity({ last_activity_ts: bjt(20, "19:00"), inactivity_pending_since: bjt(20, "22:50") }, bjt(21, "12:10"), IC);
check("昨天留下的等等不算第一次，今天重新等", ic.step === "pending" && ic.state.inactivity_pending_since === bjt(21, "12:10"));
ic = checkInactivity({ last_activity_ts: bjt(20, "18:00") }, bjt(21, "01:00"), { ...IC, inactivity: { ...IC.inactivity, from: 20, to: 2 } });
check("跨午夜的时段（20 点到 2 点）：凌晨 1 点从昨天 20 点算", ic.step === "pending" && Math.round(ic.gap / 3600e3) === 5);
const mc0 = mergeConfig({ mood: null, model: 5, note: "x" });
check("叫醒说明里一组写成 null 或数字：用默认的，不报错", mc0.mood.cooldown_min === 15 && mc0.model.enabled === false && mc0.note === "x");

const tl = describe({ ts: 0, type: "focus_change", data: { mode: "work", active: true } }, "Asia/Shanghai")
  + " / " + describe({ ts: 0, type: "mood", data: { mood: "need_company" } }, "Asia/Shanghai");
check("时间线写成人话", tl === "08:00 打开了「工作」专注模式 / 08:00 点了心情「想聊天」", tl);

// ---------- 更多小报告（TASK8）----------
console.log("\n--- 更多小报告 ---");
const rows = async (k, type) => (await k.env.DB.prepare(`SELECT ts, type, app, place, data FROM events${type ? " WHERE type = ?" : ""} ORDER BY ts, id`).bind(...(type ? [type] : [])).all()).results;
const NEW_TYPES = { screenshot: {}, notify: { app: "微信" }, alarm_stop: {}, wind_down: {}, wifi_join: { place: "家" }, workout: { kind: "跑步" },
  carplay: { on: true }, wallet: { card: "地铁卡" }, sound: { sound: "流水" } };

// 能收
k = mk();
let okAll = true;
for (const [type, extra] of Object.entries(NEW_TYPES)) {
  x = await k.send({ type, ...extra, t: at(D, "20:00") });
  if (!(x.status === 200 && x.ok)) { okAll = false; console.log("  没收下：", type, JSON.stringify(x)); }
}
check("9 种新小报告都能收", okAll && (await rows(k)).length === 9);
check("carplay 没带 on 被拒", (await k.send({ type: "carplay" })).status === 400);
check("carplay 的 on 写中文「是 / 否」也认", (await k.send({ type: "carplay", on: "否", t: at(D, "20:01") })).ok && JSON.parse((await rows(k, "carplay")).at(-1).data).on === false);
check("sound 没带种类被拒", (await k.send({ type: "sound" })).status === 400);
x = await k.send({ type: "sound", sound: "Doorbell", t: at(D, "20:02") });
check("sound 写英文 doorbell 也认，存成「门铃」", JSON.parse((await rows(k, "sound")).at(-1).data).sound === "门铃");
await k.send({ type: "sound", sound: "敲门声", t: at(D, "20:03") });
check("sound 写「敲门声」也认，存成「敲门」", JSON.parse((await rows(k, "sound")).at(-1).data).sound === "敲门");

// 多余字段被丢：存之前就没了
k = mk();
const SECRET = ["在吗宝贝我想你了", "88.50", "全家便利店", "base64AAAA", "0.93"];
await k.send({ type: "notify", app: "微信", title: "妈妈", text: SECRET[0], body: SECRET[0], place: "家", t: at(D, "20:00") });
await k.send({ type: "wallet", card: "地铁卡", amount: SECRET[1], merchant: SECRET[2], app: "钱包", t: at(D, "20:01") });
await k.send({ type: "sound", sound: "敲门", confidence: SECRET[4], audio: SECRET[3], t: at(D, "20:02") });
await k.send({ type: "screenshot", image: SECRET[3], app: "相册", t: at(D, "20:03") });
await k.send({ type: "wifi_join", place: "公司", ssid: "CMCC-5G-XXXX", password: "12345678", t: at(D, "20:04") });
await k.send({ type: "carplay", on: true, car: "她的车牌", t: at(D, "20:05") });
const stored = await rows(k);
const dump = JSON.stringify(stored);
check("通知只存 App 名字：标题、正文、多余的 place 都丢了", stored[0].app === "微信" && stored[0].place === null && stored[0].data === "{}", JSON.stringify(stored[0]));
check("钱包只存卡名：金额、商户、多余的 app 都丢了", stored[1].app === null && stored[1].data === '{"card":"地铁卡"}', stored[1].data);
check("声音只存种类", stored[2].data === '{"sound":"敲门"}', stored[2].data);
check("截屏什么都不存", stored[3].app === null && stored[3].data === "{}");
check("Wi-Fi 只存她填的名字，不存网络名、密码", stored[4].place === "公司" && stored[4].data === "{}");
check("CarPlay 只存 on", stored[5].data === '{"on":true}');
check("数据库里一个多余的字都没有", !SECRET.some(w => dump.includes(w)) && !/CMCC|12345678|车牌|妈妈|相册/.test(dump));

// 简报里的中文
const T = Date.parse(at(D, "21:03"));
const zh = (type, extra = {}) => describe({ ts: T, type, app: extra.app || null, place: extra.place || null, data: extra.data || {} }, "Asia/Shanghai");
const want = [
  [zh("screenshot"), "21:03 截了一张屏"],
  [zh("notify", { app: "微信" }), "21:03 收到了 微信 的通知"],
  [zh("alarm_stop"), "21:03 关掉了闹钟"],
  [zh("wind_down"), "21:03 开始助眠，准备睡了"],
  [zh("wifi_join", { place: "家" }), "21:03 连上了家里的 Wi-Fi"],
  [zh("wifi_join", { place: "公司" }), "21:03 连上了公司的 Wi-Fi"],
  [zh("workout"), "21:03 开始运动了"],
  [zh("workout", { data: { kind: "跑步" } }), "21:03 开始运动了（跑步）"],
  [zh("carplay", { data: { on: true } }), "21:03 上车了"],
  [zh("carplay", { data: { on: false } }), "21:03 下车了"],
  [zh("wallet", { data: { card: "地铁卡" } }), "21:03 刷了 地铁卡"],
  [zh("sound", { data: { sound: "敲门" } }), "21:03 她那边有敲门声"],
];
const bad = want.filter(([g, w]) => g !== w);
check("每种小报告写成人话", bad.length === 0, bad.map(([g, w]) => `${g} ≠ ${w}`).join(" / "));

// 默认：九种都不叫醒（11-04 Ting 定）
k = mk();
x = await k.send({ type: "sound", sound: "敲门", t: at(D, "21:03") });
const x2 = await k.send({ type: "alarm_stop", t: at(D, "07:12") });
check("默认九种都不叫醒：敲门、关闹钟也不叫", x.wake === false && x2.wake === false, JSON.stringify([x.wake, x2.wake]));

// 该叫醒的叫醒
k = await mkOn();
await k.send({ type: "wifi_join", place: "家", t: at(D, "20:50") });
await k.send({ type: "screenshot", t: at(D, "20:55") });
x = await k.send({ type: "sound", sound: "敲门", t: at(D, "21:03") });
check("敲门声叫醒", x.wake === true && x.rule === "report_sound", x.outcome || x.blocked);
const sb = (await k.env.DB.prepare("SELECT briefing FROM wakes WHERE rule = 'report_sound'").first()).briefing;
check("敲门的简报：为什么叫你、时间线都是中文", sb.startsWith("〔守门人敲门 · 这次是真的〕") && sb.includes("为什么叫你：21:03 她那边有敲门声")
  && sb.includes("- 20:50 连上了家里的 Wi-Fi") && sb.includes("- 20:55 截了一张屏"), sb.split("\n").slice(1, 2).join(""));
for (const kind of ["门铃", "警报", "婴儿哭", "火警"]) {
  k = await mkOn();
  x = await k.send({ type: "sound", sound: kind, t: at(D, "21:03") });
  check(`「${kind}」叫醒`, x.wake === true && x.rule === "report_sound", x.outcome || x.blocked);
}
k = await mkOn();
await k.send({ type: "sleep", t: at(D, "00:30") });
x = await k.send({ type: "alarm_stop", t: at(D, "07:12") });
st = await k.admin("/state");
check("关掉闹钟叫醒，而且算醒了（不再是睡觉状态）", x.wake === true && x.rule === "report_alarm_stop" && st.asleep === false, x.outcome || x.blocked);
const ab = (await k.env.DB.prepare("SELECT briefing FROM wakes WHERE rule = 'report_alarm_stop'").first()).briefing;
check("闹钟的简报写「07:12 关掉了闹钟」", ab.includes("为什么叫你：07:12 关掉了闹钟"));

// 不该叫醒的不叫醒
k = await mkOn();
let quiet = true;
for (const [type, extra] of Object.entries({ ...NEW_TYPES, alarm_stop: undefined, sound: { sound: "狗叫" } })) {
  if (!extra) continue;
  x = await k.send({ type, ...extra, t: at(D, "21:03") });
  if (x.wake || x.rule) { quiet = false; console.log("  不该叫：", type, JSON.stringify(x)); }
}
for (const sd of ["流水", "猫叫", "警笛"]) { x = await k.send({ type: "sound", sound: sd, t: at(D, "21:10") }); if (x.wake || x.rule) quiet = false; }
check("截屏、通知、助眠、Wi-Fi、运动、CarPlay、钱包、狗叫猫叫流水警笛都不叫醒", quiet && (await k.admin("/wakes")).length === 0);

// 硬底线
k = await mkOn();
x = await k.send({ type: "sound", sound: "敲门", t: at(D, "02:10") });
check("夜里（1–5 点）敲门：挡下", x.wake === false && /夜里 1–5 点/.test(x.blocked || ""), x.blocked);
x = await k.send({ type: "alarm_stop", t: at(D, "04:30") });
check("凌晨 4:30 关闹钟：也挡下", x.wake === false && /夜里/.test(x.blocked || ""), x.blocked);
k = await mkOn();
await k.send({ type: "sleep", t: at(D, "22:00") });
x = await k.send({ type: "sound", sound: "门铃", t: at(D, "22:30") });
check("她在睡觉时门铃：挡下", x.wake === false && /她在睡觉/.test(x.blocked || ""), x.blocked);
k = await mkOn();
await k.send({ type: "focus_change", mode: "work", active: true, t: at(D, "14:00") });
x = await k.send({ type: "sound", sound: "门铃", t: at(D, "14:30") });
check("工作专注模式下门铃：挡下", x.wake === false && /工作专注模式/.test(x.blocked || ""), x.blocked);
k = await mkOn();
await k.send({ type: "alarm_stop", t: at(D, "07:00") });
x = await k.send({ type: "sound", sound: "敲门", t: at(D, "07:20") });
check("关闹钟叫过 20 分钟后有敲门：被冷却挡下", x.wake === false && /冷却/.test(x.blocked || ""), x.blocked);
await k.admin("/config", "PUT", { cooldown_min: 0, daily_cap: 2 });
x = await k.send({ type: "sound", sound: "敲门", t: at(D, "07:30") });
x = await k.send({ type: "sound", sound: "警报", t: at(D, "07:40") });
check("每天上限照样算", x.wake === false && /上限 2/.test(x.blocked || ""), x.blocked);

// 管理页的开关
k = mk();
let rc = (await k.admin("/config")).reports;
check("默认开关：九种都不叫醒", Object.entries(rc).filter(([, v]) => v && v.wake).length === 0
  && rc.notify.dedupe_min === 10 && rc.screenshot.dedupe_min === 5 && rc.sound.dedupe_min === 3 && rc.sound.wake_kinds.join("/") === "门铃/敲门/警报/婴儿哭");
await k.admin("/config", "PUT", { reports: { alarm_stop: { wake: false }, sound: { wake: false }, notify: { wake: true } } });
rc = (await k.admin("/config")).reports;
check("只改了 wake：别的数字照默认补上", rc.sound.wake === false && rc.sound.dedupe_min === 3 && rc.sound.wake_kinds.length === 4 && rc.notify.dedupe_min === 10 && rc.wallet.wake === false);
x = await k.send({ type: "alarm_stop", t: at(D, "07:12") });
check("关掉 alarm_stop.wake：关闹钟不叫", x.wake === false && !x.rule);
x = await k.send({ type: "sound", sound: "敲门", t: at(D, "07:20") });
check("关掉 sound.wake：敲门也不叫", x.wake === false && !x.rule);
x = await k.send({ type: "notify", app: "微信", t: at(D, "07:30") });
check("打开 notify.wake：收到通知就叫（照样过底线）", x.wake === true && x.rule === "report_notify", x.outcome || x.blocked);
k = mk();
await k.admin("/config", "PUT", { reports: { night_quiet: false, sound: { wake: true } } });
x = await k.send({ type: "sound", sound: "警报", t: at(D, "03:00") });
check("night_quiet 关掉：夜里警报能叫（冷却、上限还在）", x.wake === true, x.outcome || x.blocked);

// 防刷屏（声音那段要看"跳过的不叫醒"，所以先把声音叫醒打开）
k = await mkOn();
for (const [hm, extra] of [["21:00", {}], ["21:03", {}], ["21:06", {}]]) await k.send({ type: "screenshot", ...extra, t: at(D, hm) });
check("截屏 5 分钟内只记一条", (await rows(k, "screenshot")).length === 2);
x = await k.send({ type: "screenshot", t: at(D, "21:08") });
check("被跳过的那条回 ok、写明原因", x.ok && x.wake === false && /5 分钟内已经记过/.test(x.skipped || ""), x.skipped);
for (const [hm, app] of [["21:00", "微信"], ["21:05", "微信"], ["21:05", "QQ"], ["21:09", "微信"], ["21:11", "微信"]]) await k.send({ type: "notify", app, t: at(D, hm) });
const nr = (await rows(k, "notify")).map(r => r.app).join(",");
check("通知：同一个 App 10 分钟内只记一条，别的 App 照记", nr === "微信,QQ,微信", nr);
for (const [hm, sd] of [["21:00", "敲门"], ["21:02", "敲门"], ["21:02", "门铃"], ["21:04", "敲门"]]) await k.send({ type: "sound", sound: sd, t: at(D, hm) });
const sr = (await rows(k, "sound")).map(r => JSON.parse(r.data).sound).join(",");
check("声音：同一种 3 分钟内只记一条，别的声音照记", sr === "敲门,门铃,敲门", sr);
const sw = (await k.admin("/wakes")).map(w => w.outcome);
check("被防刷屏跳过的那次不会叫醒、也不进叫醒记录", sw.length === 3 && sw.filter(o => !/挡下/.test(o)).length === 1, sw.join(" | "));
await k.admin("/config", "PUT", { reports: { screenshot: { dedupe_min: 0 } } });
await k.send({ type: "screenshot", t: at(D, "21:09") });
check("dedupe_min 改成 0：不再防刷屏", (await rows(k, "screenshot")).length === 3);

// 没动静检测：截屏、关闹钟、刷卡算她在用手机；通知、声音不算
k = mk();
await k.send({ type: "notify", app: "微信", t: ago(30) });
await k.send({ type: "sound", sound: "狗叫", t: ago(20) });
check("通知、声音不算她在用手机", !(await k.admin("/state")).last_activity_ts);
await k.send({ type: "screenshot", t: ago(10) });
check("截屏算", Math.abs((await k.admin("/state")).last_activity_ts - (Date.now() - 10 * 60e3)) < 5e3);

// CarPlay 连着：她现在写"在车上"，断开就没了
k = mk();
await k.send({ type: "carplay", on: true, t: ago(25) });
st = await k.admin("/state");
check("连上 CarPlay：她现在「在车上」", /在车上（\d\d:\d\d 连上 CarPlay）/.test(st["现在"]), st["现在"]);
await k.send({ type: "carplay", on: false, t: ago(2) });
check("断开 CarPlay：不再写在车上", !/在车上/.test((await k.admin("/state"))["现在"]));

// 原来的种类不受影响：note 照样把字段原样存下
k = mk();
await k.send({ type: "note", text: "原来的备注", t: at(D, "20:00") });
check("原来的种类照旧：note 的字段原样存", (await rows(k, "note"))[0].data === '{"text":"原来的备注"}');

console.log(fails ? `\n${fails} 项失败` : "\n全部通过");
process.exit(fails ? 1 : 0);
