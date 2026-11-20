// knock 守门人 v2.2.1（2026-11-20）· White-ting · 构建 dev
// 原版在 github.com/White-ting/Aru-kit。合成的单文件，别直接改这里，改 src/ 再跑 python3 build.py
// 使用权限：可以自己部署、自己改着用；不许转给别人或传到别处（分享请给 github.com/White-ting/Aru-kit）；不许商用。
// 全文见 LICENSE。其中「seal.js」一段改写自 aru-host 的 wake-send.mjs（https://github.com/Aevella/aru-host），照 Apache-2.0（不受上面限制），见 LICENSE-APACHE。

// ===== rules.js =====
// 守门人的规则：纯函数，不碰网络和数据库，方便单独测。
// 规则是我们自己写的；"叫醒说明"(config) 是 AI 用自己的口气写、能自己改的那份参数。

const DEFAULT_CONFIG = {
  tz: "Asia/Shanghai",
  // AI 写给守门人的话：它在意她什么、它是什么脾气。原样放进简报，让醒来的它对得上自己。
  note: "",
  daily_cap: 5,            // 一天最多叫醒几次（硬底线）
  cooldown_min: 60,        // 两次叫醒至少隔多久（硬底线）
  late_night: { enabled: true, from: 1, to: 5, once_per_night: true },
  places: { enabled: true, watch: [] },                       // 到达/离开这些地方叫醒，比如 ["医院"]
  long_session: { enabled: true, minutes: 120, apps: [] },    // 在某个 App 里待太久；apps 空 = 全部
  // 小模型：规则管不到的时候替 TA 看一眼。from–to 点之间每 every_min 分钟看一次，事件"差一点"碰到规则时也看
  model: { enabled: false, style: "少叫", every_min: 30, from: 9, to: 23, daily_cap: 2, name: "" },   // style：少叫 / 适中 / 多叫
  // 心情（快捷指令菜单里她自己点的）：想独处 → 这几小时不叫；想聊天 → 直接叫醒 TA（冷却比平常短，每天上限照样算）
  mood: { alone_hours: 4, request: true, cooldown_min: 15, keep_hours: 6 },
  // 很久没动静：手机报上来的打开 App、到达离开这些，隔了 hours 小时一条都没有。from–to 点之间才看。
  // wake=false 时只记在"检查记录"里、不敲门（先看几天对不对再打开）
  inactivity: { enabled: true, wake: false, hours: 3, from: 9, to: 23 },
  // 下班：工作专注模式关掉、confirm_min 分钟内没再打开，就算下班。wake=false 时只记下、不敲门
  work_end: { enabled: true, wake: false, confirm_min: 15 },
  // 更多小报告（截屏、通知、闹钟、助眠、Wi-Fi、运动、CarPlay、钱包、声音识别）：默认只进简报和时间线，不叫醒。
  // wake = 能不能按规则叫醒（叫也要过硬底线）；dedupe_min = 这么多分钟内同一种只记一条（防刷屏）；
  // night_quiet = 夜里（late_night 的 from–to 点）小报告一律不叫醒
  reports: {
    night_quiet: true,
    screenshot: { wake: false, dedupe_min: 5 },
    notify: { wake: false, dedupe_min: 10 },          // 同一个 App 10 分钟内只记一条
    alarm_stop: { wake: false },          // 11-04 Ting：九种都默认不叫醒，想要的在管理页打开
    wind_down: { wake: false },
    wifi_join: { wake: false },
    workout: { wake: false },
    carplay: { wake: false },
    wallet: { wake: false },
    sound: { wake: false, wake_kinds: ["门铃", "敲门", "警报", "婴儿哭"], dedupe_min: 3 },   // 只有这几种声音叫醒；同一种声音 3 分钟内只记一条
  },
};

// 小报告的种类，和每种允许存下的字段（别的字段收到了也直接丢掉，不进数据库）
const REPORT_FIELDS = {
  screenshot: [], notify: ["app"], alarm_stop: [], wind_down: [], wifi_join: ["place"],
  workout: ["kind"], carplay: ["on"], wallet: ["card"], sound: ["sound"],
};

// 只检查 PUT 这次带来的项。返回第一处写错的说明；没有错误就返回 null。
function validateConfig(body) {
  const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const range = (v, lo, hi, integer = false) => Number.isFinite(v) && v >= lo && v <= hi && (!integer || Number.isInteger(v));
  const positive = v => Number.isFinite(v) && v > 0;
  const text = (v, max) => typeof v === "string" && [...v].length <= max;
  if (!object(body)) return "叫醒说明要用一对花括号包住各项设置（JSON 对象）。";
  for (const k of ["late_night", "places", "long_session", "model", "mood", "inactivity", "work_end", "reports"]) {
    if (own(body, k) && !object(body[k])) return `${k} 是一组设置，请用花括号填写，例如 {}。`;
  }
  if (own(body, "tz")) {
    try {
      if (typeof body.tz !== "string" || !body.tz.trim()) throw new Error();
      new Intl.DateTimeFormat("zh-CN", { timeZone: body.tz });
    } catch { return 'tz 时区不认识，请填有效的时区名字，例如 "Asia/Shanghai"。'; }
  }
  if (own(body, "note") && !text(body.note, 2000)) return "note 请填文字，最多 2000 字。";
  const checks = [
    [body, "daily_cap", "daily_cap", v => range(v, 0, 20, true), "0–20 的整数"],
    [body, "cooldown_min", "cooldown_min", v => range(v, 0, 1440), "0–1440 之间的分钟数"],
    [body.model, "daily_cap", "model.daily_cap", v => range(v, 0, 20, true), "0–20 的整数"],
    [body.model, "every_min", "model.every_min", v => range(v, 10, 1440), "10–1440 之间的分钟数"],
    [body.long_session, "minutes", "long_session.minutes", positive, "大于 0 的分钟数"],
    [body.mood, "cooldown_min", "mood.cooldown_min", positive, "大于 0 的分钟数"],
    [body.mood, "alone_hours", "mood.alone_hours", positive, "大于 0 的小时数"],
    [body.mood, "keep_hours", "mood.keep_hours", positive, "大于 0 的小时数"],
    [body.inactivity, "hours", "inactivity.hours", positive, "大于 0 的小时数"],
    [body.work_end, "confirm_min", "work_end.confirm_min", positive, "大于 0 的分钟数"],
  ];
  for (const k of ["late_night", "model", "inactivity"]) {
    checks.push([body[k], "from", `${k}.from`, v => range(v, 0, 23, true), "0–23 的整数（几点）"]);
    checks.push([body[k], "to", `${k}.to`, v => range(v, 0, 24, true), "0–24 的整数（几点；24 = 到半夜，0 点到 24 点就是全天）"]);
  }
  for (const [group, key, path, valid, hint] of checks) {
    if (group && own(group, key) && !valid(group[key])) return `${path} 请填${hint}。`;
  }
  if (body.places && own(body.places, "watch")) {
    const watch = body.places.watch;
    if (!Array.isArray(watch) || watch.length > 50) return "places.watch 请填地点列表（用方括号），最多 50 项。";
    for (const [i, name] of watch.entries()) {
      if (!text(name, 60)) return `places.watch 的第 ${i + 1} 项请填地点名称，最多 60 字。`;
    }
  }
  for (const [k, v] of Object.entries(body.reports || {})) {
    if (!object(v)) {
      if (own(REPORT_FIELDS, k)) return `reports.${k} 是一组设置，请用花括号填写，例如 {}。`;
      continue;
    }
    if (own(v, "wake_kinds") && !Array.isArray(v.wake_kinds)) return `reports.${k}.wake_kinds 请填列表（用方括号），例如 ["敲门"]。`;
    if (own(v, "dedupe_min") && !range(v.dedupe_min, 0, 1440)) return `reports.${k}.dedupe_min 请填 0–1440 之间的分钟数（0 = 不防刷屏）。`;
  }
  return null;
}

function mergeConfig(saved) {
  const c = structuredCloneSafe(DEFAULT_CONFIG);
  if (!saved || typeof saved !== "object") return c;
  for (const [k, v] of Object.entries(saved)) {
    const group = c[k] && typeof c[k] === "object" && !Array.isArray(c[k]);   // late_night、model 这种一组的
    if (group && v && typeof v === "object" && !Array.isArray(v)) c[k] = { ...c[k], ...v };
    else if (group) continue;   // 一组的被写成 null、数字这些：用默认的，别让守门人整个报错
    else c[k] = v;
  }
  // reports 里每一种又是一组：只改了 sound.wake 的，wake_kinds、dedupe_min 照默认的补上
  if (saved.reports && typeof saved.reports === "object" && !Array.isArray(saved.reports)) {
    const d = DEFAULT_CONFIG.reports;
    for (const [k, v] of Object.entries(saved.reports)) {
      if (d[k] && typeof d[k] === "object") c.reports[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...d[k], ...v } : structuredCloneSafe(d[k]);
    }
  }
  return c;
}

function structuredCloneSafe(o) { return JSON.parse(JSON.stringify(o)); }

// 某个时刻在她时区里是几点、哪一天
function localParts(ts, tz) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  const hour = Number(p.hour) % 24;
  return { date: `${p.year}-${p.month}-${p.day}`, hour, minute: Number(p.minute), hm: `${String(hour).padStart(2, "0")}:${p.minute}` };
}

// "这一夜"：凌晨的算前一天晚上，免得 0 点前后算成两夜
function nightKey(ts, tz) {
  return localParts(ts - 12 * 3600e3, tz).date;
}

function inHours(h, from, to) {
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

// 一条事件进来，看哪条规则想叫醒它。返回 {rule, reason} 或 null。
// ctx: { config, state, sessionMin }  sessionMin = app_close 时算出的这次待了几分钟
function evaluate(ev, ctx) {
  const c = ctx.config, t = localParts(ev.ts, c.tz);
  if (ev.type === "mood" && ev.data.mood === "need_company" && c.mood.request) {
    return { rule: "mood_request", reason: `${t.hm} 她在快捷指令里点了「想聊天」` };
  }
  if (ev.type === "app_open" && c.late_night.enabled && inHours(t.hour, c.late_night.from, c.late_night.to)) {
    return { rule: "late_night", reason: `${t.hm} 还在用「${ev.app || "手机"}」` };
  }
  if ((ev.type === "arrive" || ev.type === "leave") && c.places.enabled && ev.place) {
    const hit = (c.places.watch || []).find(w => w && String(ev.place).includes(w));
    if (hit) return { rule: "place", reason: `${t.hm} ${ev.type === "arrive" ? "到了" : "离开了"}「${ev.place}」` };
  }
  if (ev.type === "app_close" && c.long_session.enabled && ctx.sessionMin != null) {
    const apps = c.long_session.apps || [];
    if (ctx.sessionMin >= c.long_session.minutes && (!apps.length || apps.some(a => String(ev.app || "").includes(a)))) {
      return { rule: "long_session", reason: `在「${ev.app || "手机"}」里待了 ${Math.round(ctx.sessionMin)} 分钟（到 ${t.hm}）` };
    }
  }
  // 小报告：开关打开的才叫；声音只认 wake_kinds 里的几种
  const rc = REPORT_FIELDS[ev.type] && (c.reports || {})[ev.type];
  if (rc && rc.wake) {
    if (ev.type === "sound") {
      const s = String((ev.data || {}).sound || "");
      if (!(rc.wake_kinds || []).some(k => k && s.includes(k))) return null;
    }
    return { rule: `report_${ev.type}`, reason: describe(ev, c.tz) };
  }
  return null;
}

// 没碰到规则、但差一点：交给小模型看。返回一句描述或 null
function nearMiss(ev, ctx) {
  const c = ctx.config, t = localParts(ev.ts, c.tz);
  if (ev.type === "app_close" && c.long_session.enabled && ctx.sessionMin != null && ctx.sessionMin >= c.long_session.minutes * 0.6) {
    return `在「${ev.app || "手机"}」里待了 ${Math.round(ctx.sessionMin)} 分钟（规则是 ${c.long_session.minutes} 分钟）`;
  }
  if (ev.type === "app_open" && c.late_night.enabled && inHours(t.hour, (c.late_night.from + 23) % 24, c.late_night.from)) {
    return `${t.hm} 还在用「${ev.app || "手机"}」（熬夜规则从 ${c.late_night.from} 点算）`;
  }
  if ((ev.type === "arrive" || ev.type === "leave") && ev.place) {
    return `${ev.type === "arrive" ? "到了" : "离开了"}「${ev.place}」（不在关注的地点里）`;
  }
  return null;
}

// 今天的大概：每个 App 开了几次、待了多久，去过哪，几点起的
function daySummary(events, tz) {
  const apps = {}, open = {}, places = [];
  let wake = null;
  for (const e of events) {
    const a = e.app;
    if (e.type === "app_open" && a) { (apps[a] ||= { n: 0, min: 0 }).n++; open[a] = e.ts; }
    if (e.type === "app_close" && a && open[a] != null) {
      const m = (e.ts - open[a]) / 60e3;
      if (m < 360) (apps[a] ||= { n: 0, min: 0 }).min += m;
      delete open[a];
    }
    if (e.type === "arrive" && e.place) places.push(`${localParts(e.ts, tz).hm} 到${e.place}`);
    if (e.type === "wake_up" && !wake) wake = localParts(e.ts, tz).hm;
  }
  const parts = [];
  if (wake) parts.push(`${wake} 起床`);
  const list = Object.entries(apps).sort((x, y) => y[1].min - x[1].min || y[1].n - x[1].n).slice(0, 8)
    .map(([a, v]) => `${a} 开了 ${v.n} 次${v.min >= 1 ? `、约 ${Math.round(v.min)} 分钟` : ""}`);
  if (list.length) parts.push(list.join("，"));
  if (places.length) parts.push(places.join("，"));
  return parts.join("；");
}

// 硬底线：不管规则和 AI 怎么想都要守。返回 null = 放行，否则是挡下的原因。
// 工作、勿扰专注模式下拦的规则：这几种是"平常的关心"，等她忙完再说。到了关注的地点、她点了想聊天照常放行
const QUIET_RULES = new Set(["long_session", "model", "inactivity", "work_end"]);
const FOCUS_ZH = { work: "工作", dnd: "勿扰", sleep: "睡眠" };
const FAIL_COOLDOWN = 10 * 60e3;

// 现在有没有"别打扰她"的状态（工作/勿扰/想独处），没有返回 null。小模型、定时检查也用它，省得白问
function quietReason(state, now, tz) {
  if (state.focus_mode === "work" || state.focus_mode === "dnd") return `她开着${FOCUS_ZH[state.focus_mode]}专注模式`;
  if (state.alone_until && now < state.alone_until) return `她说想独处（到 ${localParts(state.alone_until, tz).hm}）`;
  return null;
}

function failureReason(state, now) {
  if (state.last_fail_ts == null || now - state.last_fail_ts >= FAIL_COOLDOWN) return null;
  return "投递失败冷却（上次失败后 10 分钟内不再投递）";
}

function guard(hit, ev, ctx) {
  const c = ctx.config, s = ctx.state, now = ctx.now ?? ev.ts;
  const asked = hit.rule === "mood_request";   // 她自己点的想聊天：睡觉、专注、独处都不拦，只守上限和冷却
  const report = String(hit.rule || "").startsWith("report_");   // 小报告（声音、闹钟这些）叫醒
  if (s.asleep && hit.rule !== "late_night" && !asked) return "她在睡觉";
  if (report && (c.reports || {}).night_quiet !== false && inHours(localParts(ev.ts, c.tz).hour, c.late_night.from, c.late_night.to)) {
    return `夜里 ${c.late_night.from}–${c.late_night.to} 点，小报告不叫醒`;
  }
  if (!asked) {
    if ((s.focus_mode === "work" || s.focus_mode === "dnd") && (QUIET_RULES.has(hit.rule) || report)) return `她开着${FOCUS_ZH[s.focus_mode]}专注模式`;
    if (s.alone_until && now < s.alone_until && hit.rule !== "place") return `她说想独处（到 ${localParts(s.alone_until, c.tz).hm}）`;
  }
  const today = localParts(now, c.tz).date;
  const count = s.wakes_date === today ? (s.wakes_count || 0) : 0;
  if (count >= c.daily_cap) return `今天已经叫醒 ${count} 次（上限 ${c.daily_cap}）`;
  const cool = asked ? (c.mood.cooldown_min ?? 15) : c.cooldown_min;
  if (s.last_wake_ts != null && now - s.last_wake_ts < cool * 60e3) {
    return `离上次叫醒才 ${Math.max(0, Math.round((now - s.last_wake_ts) / 60e3))} 分钟（冷却 ${cool}）`;
  }
  if (hit.rule === "late_night" && c.late_night.once_per_night && s.late_night_key === nightKey(now, c.tz)) return "今晚已经为熬夜叫过一次";
  if (hit.rule === "model") {
    const mc = s.model_date === today ? (s.model_count || 0) : 0;
    if (mc >= (c.model.daily_cap ?? 2)) return `小模型今天已经叫过 ${mc} 次（上限 ${c.model.daily_cap}）`;
  }
  return null;
}

// 投递成功才更新状态。这里的 ts 是收到的时间。
function afterWake(hit, ev, ctx) {
  const c = ctx.config, s = { ...ctx.state }, ts = Math.max(ev.ts, s.last_wake_ts ?? ev.ts), today = localParts(ts, c.tz).date;
  s.wakes_count = (s.wakes_date === today ? (s.wakes_count || 0) : 0) + 1;
  s.wakes_date = today;
  s.last_wake_ts = ts;
  if (hit.rule === "late_night") s.late_night_key = nightKey(ts, c.tz);
  if (hit.rule === "model") {
    s.model_count = (s.model_date === today ? (s.model_count || 0) : 0) + 1;
    s.model_date = today;
  }
  return s;
}

// 算"她在用手机"的事件：没动静检测只认这些。充电、电量、专注模式、备注、健康数据可能是自动化自己跑的，不算；
// 心情是她手动点的菜单，算
// 小报告里截屏、关闹钟、刷卡是她亲手做的，也算；通知、声音、Wi-Fi、CarPlay、助眠、运动可能是自己发生的，不算
const ACTIVITY = new Set(["app_open", "app_close", "arrive", "leave", "wake_up", "mood", "screenshot", "alarm_stop", "wallet"]);

// 事件改状态（不叫醒）。每种状态按自己的发生时间排序，迟到的报告只补时间线。
function applyState(ev, state, config) {
  const s = { ...state }, d = ev.data || {}, c = config || DEFAULT_CONFIG;
  const fresh = k => !(s[k] > ev.ts);
  const sleep = asleep => {
    if (fresh("sleep_at")) { s.asleep = asleep; s.sleep_at = ev.ts; }
  };
  if (ACTIVITY.has(ev.type) && fresh("last_activity_ts")) {
    s.last_activity_ts = ev.ts;
    delete s.inactivity_pending_since;
  }
  if (ev.type === "sleep") sleep(true);
  if (ev.type === "wake_up" || ev.type === "alarm_stop") sleep(false);   // 关掉闹钟 = 醒了
  if (ev.type === "carplay" && fresh("carplay_at") && fresh("in_car_at")) {
    s.carplay_at = ev.ts;
    if (d.on) s.in_car_at = ev.ts; else delete s.in_car_at;
  }
  if (ev.type === "battery_low" && fresh("battery_at")) {
    s.battery_low = true; s.battery_level = d.level; s.battery_at = ev.ts;
  }
  if ((ev.type === "battery_ok" || ev.type === "charge_start") && fresh("battery_at")) {
    if (s.battery_low) s.battery_low = false;
    s.battery_at = ev.ts;
    if (ev.type === "battery_ok" && d.level != null) s.battery_level = d.level;
  }
  if (ev.type === "focus_change" && fresh("focus_at")) {
    const was = s.focus_mode || null;
    if (d.active) {
      if (was === "work" && d.mode !== "work") s.pending_work_end_at = ev.ts;   // 从工作直接切到别的模式，也算关了工作
      if (d.mode === "work") {
        if (s.pending_work_end_at) delete s.pending_work_end_at;   // 刚关又开：不算下班，开始时间照旧
        else s.work_started_at = ev.ts;
      }
      s.focus_mode = d.mode;
    } else if (was === d.mode) {   // 关的不是现在这个（顺序乱了）就不管
      s.focus_mode = null;
      if (d.mode === "work") s.pending_work_end_at = ev.ts;
    }
    if (d.mode === "sleep") sleep(!!d.active);   // 睡眠专注模式 = 睡觉
    s.focus_at = ev.ts;
  }
  if (ev.type === "mood" && fresh("mood_at")) {
    s.mood = d.mood; s.mood_at = ev.ts;
    s.alone_until = d.mood === "alone" ? ev.ts + (c.mood.alone_hours ?? 4) * 3600e3 : 0;   // 点了别的心情，想独处就作废
  }
  return s;
}

// 下班确认：工作模式关掉满 confirm_min 分钟、没再打开 → 下班。返回 {state, ended: {start, end} | null}
function confirmWorkEnd(state, now, config) {
  const c = config.work_end || {}, s = { ...state };
  if (!s.pending_work_end_at || now - s.pending_work_end_at < (c.confirm_min ?? 15) * 60e3) return { state, ended: null };
  const ended = { start: s.work_started_at || null, end: s.pending_work_end_at };
  s.work_ended_at = Math.max(s.work_ended_at ?? ended.end, ended.end);
  delete s.pending_work_end_at;
  return { state: s, ended };
}

// 很久没动静：返回要做的事。{state, step: null | "pending" | "confirmed", hit}
// 第一次过了时限先记 pending，下一次定时检查（隔 ≥20 分钟）还没动静才算数；同一段没动静只算一次
// 从哪一刻算起：最后一次动静，但不早于今天检查时段开始那一刻（from 点）。
// 不然早上 9 点一开门就会把一整夜（她在睡觉）算成没动静
function checkInactivity(state, now, config) {
  const c = config.inactivity || {}, s = { ...state };
  const clear = () => { if (s.inactivity_pending_since) { delete s.inactivity_pending_since; return { state: s, step: null }; } return { state, step: null }; };
  if (!c.enabled || !s.last_activity_ts) return clear();
  const t = localParts(now, config.tz), from = c.from ?? 9;
  if (!inHours(t.hour, from, c.to ?? 23)) return clear();   // 不在时段里：上一段没确认完的作废，明天重新算
  let open = now - ((t.hour * 60 + t.minute) * 60e3 + (now % 60e3)) + from * 3600e3;   // 今天 from 点
  if (open > now) open -= 86400e3;   // 跨午夜的时段（比如 20 点到 2 点），凌晨时算昨天 20 点
  const last = Math.max(s.last_activity_ts, open), gap = now - last;
  if (gap < (c.hours ?? 3) * 3600e3) return clear();
  if (s.inactivity_done_for === last) return { state, step: null };
  if (!s.inactivity_pending_since || s.inactivity_pending_since < last) { s.inactivity_pending_since = now; return { state: s, step: "pending", gap }; }
  if (now - s.inactivity_pending_since < 20 * 60e3) return { state, step: null };
  s.inactivity_done_for = last;
  delete s.inactivity_pending_since;
  const at = localParts(last, config.tz).hm, h = Math.floor(gap / 3600e3), m = Math.round((gap % 3600e3) / 60e3);
  const head = last === s.last_activity_ts ? `从 ${at} 起` : `从今天 ${at}（检查时段开始）起`;
  return { state: s, step: "confirmed",
    hit: { rule: "inactivity", reason: `${head} ${h} 小时${m ? ` ${m} 分钟` : ""}没有动静（打开 App、到达离开这些一条都没报上来；也可能是快捷指令没跑）` } };
}

// 她现在的状态，一句话：放进简报、小模型的提示、管理页
function statusLine(state, now, config) {
  const s = state || {}, tz = config.tz, hm = ts => localParts(ts, tz).hm, parts = [];
  if (s.asleep) parts.push("在睡觉");
  if (s.focus_mode === "work") parts.push(`在工作${s.work_started_at ? `（${hm(s.work_started_at)} 开始）` : ""}`);
  else if (s.focus_mode && s.focus_mode !== "sleep") parts.push(`开着「${FOCUS_ZH[s.focus_mode] || s.focus_mode}」专注模式`);
  if (s.pending_work_end_at) parts.push(`${hm(s.pending_work_end_at)} 关了工作模式（还没确认下班）`);
  else if (s.work_ended_at && now - s.work_ended_at < 3 * 3600e3) {
    const dur = s.work_started_at && s.work_started_at < s.work_ended_at ? `，工作了约 ${Math.round((s.work_ended_at - s.work_started_at) / 3600e3 * 10) / 10} 小时` : "";
    parts.push(`${hm(s.work_ended_at)} 下班${dur}`);
  }
  if (s.alone_until && now < s.alone_until) parts.push(`说想独处（到 ${hm(s.alone_until)}）`);
  else if (s.mood && s.mood !== "alone" && s.mood_at && now - s.mood_at < (config.mood.keep_hours ?? 6) * 3600e3) parts.push(`${hm(s.mood_at)} 选的心情是「${MOOD_ZH[s.mood] || s.mood}」`);
  if (s.in_car_at && now - s.in_car_at < 4 * 3600e3) parts.push(`在车上（${hm(s.in_car_at)} 连上 CarPlay）`);
  if (s.battery_low) parts.push(`手机电量低${s.battery_level != null ? `（${s.battery_level}%）` : ""}`);
  const failed = failureReason(s, now);
  if (failed) parts.push(`${failed}，到 ${hm(s.last_fail_ts + FAIL_COOLDOWN)}`);
  return parts.join("，");
}

const MOOD_ZH = { happy: "开心", low: "低落", alone: "想独处", need_company: "想聊天" };

const TYPE_ZH = {
  app_open: "打开", app_close: "关掉", arrive: "到达", leave: "离开", sleep: "就寝", wake_up: "起床",
  charge_start: "开始充电", charge_stop: "拔掉充电", health: "健康数据", note: "备注",
  battery_low: "电量低", battery_ok: "电量回来了", focus_change: "专注模式", mood: "心情",
  screenshot: "截屏", notify: "通知", alarm_stop: "关闹钟", wind_down: "助眠", wifi_join: "连 Wi-Fi",
  workout: "运动", carplay: "CarPlay", wallet: "刷卡", sound: "声音",
};

// 小报告写成人话（只用白名单里的字段）
function describeReport(ev, t) {
  const d = ev.data || {};
  switch (ev.type) {
    case "screenshot": return `${t} 截了一张屏`;
    case "notify": return ev.app ? `${t} 收到了 ${ev.app} 的通知` : `${t} 收到了一条通知`;
    case "alarm_stop": return `${t} 关掉了闹钟`;
    case "wind_down": return `${t} 开始助眠，准备睡了`;
    case "wifi_join": return ev.place ? `${t} 连上了${ev.place === "家" ? "家里" : ev.place}的 Wi-Fi` : `${t} 连上了 Wi-Fi`;
    case "workout": return `${t} 开始运动了${d.kind ? `（${d.kind}）` : ""}`;
    case "carplay": return `${t} ${d.on ? "上车了" : "下车了"}`;
    case "wallet": return d.card ? `${t} 刷了 ${d.card}` : `${t} 刷了一张卡`;
    case "sound": return `${t} 她那边有${d.sound || "动静"}声`;
  }
  return null;
}

function describe(ev, tz) {
  const t = localParts(ev.ts, tz).hm, d = ev.data || {};
  if (REPORT_FIELDS[ev.type]) return describeReport(ev, t);
  if (ev.type === "focus_change") return `${t} ${d.active ? "打开" : "关掉"}了「${FOCUS_ZH[d.mode] || d.mode}」专注模式`;
  if (ev.type === "mood") return `${t} 点了心情「${MOOD_ZH[d.mood] || d.mood}」`;
  if (ev.type === "battery_low" || ev.type === "battery_ok") return `${t} ${TYPE_ZH[ev.type]}${d.level != null ? `（${d.level}%）` : ""}`;
  let s = `${t} ${TYPE_ZH[ev.type] || ev.type}`;
  if (ev.app) s += `「${ev.app}」`;
  if (ev.place) s += `「${ev.place}」`;
  const extra = Object.entries(d).filter(([k]) => !["app", "place", "type", "t", "ts"].includes(k)).map(([k, v]) => `${k}=${v}`);
  if (extra.length) s += `（${extra.join("，")}）`;
  return s;
}

// 递给 Aru 里那位的简报。守门人不替它说话，只告诉它发生了什么、为什么叫它。
// 测试和真的分开写清楚：TA 被测试敲过几次以后，容易把真的也当成测试。
function buildBriefing({ hit, ev, config, timeline, summary, status }) {
  const lines = hit.rule === "test" ? [
    "〔守门人 · 测试敲门〕这是她在守门人管理页点的测试，不是真的有事。可以简单回一句收到，也可以什么都不说。",
  ] : hit.rule === "mood_request" ? [
    "〔守门人敲门 · 这次是真的〕这不是测试：她刚在手机上点了「想聊天」，是她自己想让你来找她。",
    `为什么叫你：${hit.reason}`,
  ] : [
    "〔守门人敲门 · 这次是真的〕这不是她发的消息，也不是测试：是你交代的叫醒条件真的碰到了。看完自己决定要不要找她；不想说可以不说，记得用工具记下为什么。",
    hit.rule === "model" ? `为什么叫你：守门人的小模型看了觉得——${hit.reason}` : `为什么叫你：${hit.reason}`,
  ];
  if (config.note) lines.push(`你之前交代我的：${config.note}`);
  if (status) lines.push(`她现在：${status}`);
  if (summary) lines.push(`她今天：${summary}`);
  if (timeline.length) {
    lines.push("她最近几小时：");
    for (const e of timeline) lines.push(`- ${describe(e, config.tz)}`);
  }
  return lines.join("\n");
}

// ===== seal.js =====
// 照 aru-host 的 wake-send.mjs（Apache-2.0）用 WebCrypto 重写：把简报封进 Aru 外部触发的信封，投给 Host。
// bundle 是手机导出的发送凭证：{schema, triggerId, submitURL, submitToken, encryptionKey(base64, 32 字节)}

function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function checkBundle(bundle) {
  if (bundle?.schema !== "aru.wake-bridge.sender-bundle.v2"
      || typeof bundle.triggerId !== "string" || !bundle.triggerId
      || typeof bundle.submitToken !== "string" || !bundle.submitToken) {
    throw new Error("发送凭证格式不对");
  }
  try {
    if (typeof bundle.submitURL !== "string" || !/^https:\/\//i.test(bundle.submitURL) || new URL(bundle.submitURL).protocol !== "https:") throw new Error();
  } catch { throw new Error("发送凭证里的投递地址必须是有效的 HTTPS 地址"); }
  if (b64ToBytes(bundle.encryptionKey || "").length !== 32) throw new Error("发送凭证里的密钥不是 32 字节");
}

async function sealWakeEvent(bundle, content, eventId = crypto.randomUUID(), nonce = crypto.getRandomValues(new Uint8Array(12))) {
  checkBundle(bundle);
  const text = String(content ?? "").trim();
  if (!text) throw new Error("简报是空的");
  const payload = new TextEncoder().encode(JSON.stringify({
    schema: "aru.wake-bridge.payload.v2",
    eventId,
    triggerId: bundle.triggerId,
    content: text,
  }));
  const key = await crypto.subtle.importKey("raw", b64ToBytes(bundle.encryptionKey), "AES-GCM", false, ["encrypt"]);
  // WebCrypto 的 AES-GCM 输出 = 密文 || 16 字节标签，跟 Node 的 ciphertext+tag 拼法一样
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, payload));
  const sealed = new Uint8Array(nonce.length + ct.length);
  sealed.set(nonce, 0);
  sealed.set(ct, nonce.length);
  return { schema: "aru.wake-bridge.sealed-event.v1", eventId, sealedPayload: bytesToB64(sealed) };
}

async function submitWakeEvent(bundle, content, signal) {
  const env = await sealWakeEvent(bundle, content);
  const r = await fetch(bundle.submitURL, {
    method: "POST",
    headers: { authorization: `Bearer ${bundle.submitToken}`, "content-type": "application/json" },
    body: JSON.stringify(env),
    signal,
    redirect: "manual",   // Cloudflare Workers 不认 "error"：手动看，被重定向就当失败（官方发送器也拒绝重定向）
  });
  if (r.status >= 300 && r.status < 400) throw new Error(`投递地址被重定向了（HTTP ${r.status}），不投`);
  if (!r.ok) throw new Error(`投递失败：HTTP ${r.status}`);
  return env.eventId;
}

// ===== model.js =====
// 看门的小模型：规则管不到的时候，替 TA 看一眼"这时候 TA 会不会想找她"。
// 只回 {wake, reason}：不跟她说话、不自己发消息；叫不叫最后还要过硬底线。
// 默认用 Cloudflare 自己的 Workers AI（绑定名 AI，数据不出 Cloudflare）；
// 设了 LLM_URL + LLM_KEY 就改走 OpenAI 兼容的接口（DeepSeek、百炼等），模型名写在叫醒说明的 model.name。

// 11-20：原来的 @cf/qwen/qwen3-30b-a3b-fp8 被 Cloudflare 下架（从 2026-11-20 起回 HTTP 410、错误码 5028）。
// 换成官方推荐的小模型里便宜的那个 gemma-4（价钱跟原来差不多）；另一个推荐的 @cf/qwen/qwen3.8-27b 中文更好，但贵将近十倍。
const DEFAULT_MODEL = "@cf/google/gemma-4-26b-a4b-it";
// 新模型都会先「想一想」再回答，想的字也算在上限里：上限放宽到 1000，免得想完了没字写答案（只回一行 JSON，用不了多少）
const MAX_TOKENS = 1000;

// 性子：model.style 填哪个，判断标准就换成哪段。不认识的当"少叫"
const STYLES = {
  "少叫": [
    "- 只有 TA 看了大概会想找她的时候才叫：比如她可能不太好、熬着、在重要的地方、一反常态、或者 TA 交代过的情况。",
    "- 平常的刷手机、正常的作息、跟上次叫醒是同一件事，都不叫。拿不准就不叫：少叫一次没关系，叫多了 TA 会烦她。",
  ],
  "适中": [
    "- TA 交代过的情况、她可能不太好、作息明显不对（该睡没睡、一直没停下来）、去了不常去的地方，都叫。",
    "- 完全平常的刷手机和作息不叫，跟上次叫醒是同一件事也不叫。拿不准时：跟 TA 交代过的话沾边就叫，不沾边就不叫。",
  ],
  "多叫": [
    "- 只要有一点 TA 可能在意的迹象就叫：刷得久、熬夜、换了地方、一反常态、TA 交代过的情况都算。",
    "- 只有完全平常、而且跟上次叫醒是同一件事的才不叫。叫多了也没关系，后面还有冷却和每天上限兜着。",
  ],
};

function buildMessages({ trigger, config, now, summary, recent, lastWake, status }) {
  const sys = [
    "你是一个守门人。她有一位 AI 伙伴（下面叫 TA），平时在她手机的 Aru 里。你不跟她说话，也不替 TA 说话，",
    "你只做一件事：看她手机报上来的动静，判断现在要不要敲门把 TA 叫醒。叫醒以后由 TA 自己决定找不找她、说什么。",
    "",
    "判断标准：",
    ...(STYLES[(config.model || {}).style] || STYLES["少叫"]),
    "- 只看下面给你的记录，别编没发生的事。",
    "",
    "只回一行 JSON，别的什么都不写：",
    '{"wake": true 或 false, "reason": "一句话，写给 TA 看的：你看到了什么、为什么觉得该叫或不该叫"}',
  ];
  if (config.note) sys.push("", "TA 交代过你的话（TA 自己的口气）：", config.note);
  const user = [
    `现在：${now}（${trigger}）`,
    `她现在：${status || "没有特别的状态"}`,
    `她今天：${summary || "还没有记录"}`,
    "最近两小时：",
    ...(recent.length ? recent.map(x => "- " + x) : ["- 没有动静"]),
    `上次叫醒 TA：${lastWake || "今天还没叫过"}`,
    "",
    "要不要叫醒 TA？ /no_think",
  ];
  return [{ role: "system", content: sys.join("\n") }, { role: "user", content: user.join("\n") }];
}

// 模型回的字里找出那段 JSON。思考过程（<think>…</think>）先去掉。
function parseDecision(text) {
  const t = String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("小模型没回 JSON：" + t.slice(0, 80));
  let o;
  try { o = JSON.parse(m[0]); } catch { throw new Error("小模型回的 JSON 读不出来：" + m[0].slice(0, 80)); }
  const wake = o.wake === true || o.wake === "true";
  const reason = String(o.reason || "").trim().slice(0, 200) || "（没写理由）";
  return { wake, reason };
}

function textOf(r) {
  if (!r) return "";
  if (typeof r === "string") return r;
  if (typeof r.response === "string") return r.response;
  const c = r.choices && r.choices[0];
  if (c) return (c.message && c.message.content) || c.text || "";
  return "";
}

async function askModel(env, config, messages) {
  const m = config.model || {}, url = String(env.LLM_URL || "").trim();
  if (url) {
    try {
      if (!/^https:\/\//i.test(url) || new URL(url).protocol !== "https:") throw new Error();
    } catch { throw new Error("LLM_URL 必须使用有效的 HTTPS 地址"); }
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + String(env.LLM_KEY || "").trim() },
      body: JSON.stringify({ model: m.name, messages, max_tokens: MAX_TOKENS, temperature: 0.3 }),
      redirect: "manual",   // 不跟着跳到另一个地址，免得把简报发给没配置的服务
    });
    if (r.status >= 300 && r.status < 400) throw new Error(`小模型地址被重定向了（HTTP ${r.status}），请填最终的 HTTPS 地址`);
    if (!r.ok) throw new Error(`小模型接口 HTTP ${r.status}：${(await r.text()).slice(0, 120)}`);
    return textOf(await r.json());
  }
  if (!env.AI) throw new Error("没绑定 Workers AI（绑定名要叫 AI），也没设 LLM_URL");
  const name = m.name && m.name.startsWith("@") ? m.name : DEFAULT_MODEL;
  const opt = { messages, max_tokens: MAX_TOKENS, temperature: 0.3 };
  if (/^@cf\/qwen\/qwen3\.8/.test(name)) opt.reasoning_effort = "low";   // qwen3.8 默认想得最深（xhigh），又慢又贵；这里只要判断叫不叫，最浅一档就够
  return textOf(await env.AI.run(name, opt));
}

// ===== index.js =====
// knock · aru：守门人 Worker（最小版）
// 快捷指令 POST /event → 存时间线 → 规则 → 硬底线 → 叫醒（Aru 外部触发；没配就推送；都没配只记下）
// 规则没碰到的，交给小模型看一眼（定时、或者事件"差一点"碰到规则时），它说叫也照样要过硬底线

// 版本和署名（11-01 起）：管理页底部、每个回复的 x-knock 头都带着。BUILD 是构建号，打包时按拿到的人换掉
const VERSION = "2.2.1", RELEASED = "2026-11-20", BUILD = "dev";
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
const KEEP_DAYS = 14;       // 事件、检查、叫醒简报留几天
const WAKE_LEASE_MS = 60e3;

// 表第一次用时自己建（网页后台部署时不用另外跑 schema.sql）
const schemaReady = new WeakSet();
async function ensureSchema(db) {
  if (schemaReady.has(db)) return;
  await db.batch(SCHEMA.split(";").map(x => x.trim()).filter(Boolean).map(x => db.prepare(x)));
  // 老数据库没有收到时间。两份 Worker 同时升级时，有一份先加好也算成功。
  const hasReceived = async () => ((await db.prepare("PRAGMA table_info(events)").all()).results || []).some(c => c.name === "received_ts");
  if (!(await hasReceived())) {
    try { await db.prepare("ALTER TABLE events ADD COLUMN received_ts INTEGER").run(); }
    catch (e) { if (!(await hasReceived())) throw e; }
  }
  schemaReady.add(db);
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL, app TEXT, place TEXT, data TEXT, received_ts INTEGER);
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
  const match = /^Bearer[ \t]+(.+)$/i.exec(req.headers.get("authorization") || "");
  if (!match) return false;
  const got = match[1].trim();
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

// 状态也会被不投递的报告、定时检查改动。读到的版本变了就重算，不能拿旧状态盖掉别人的计数。
async function changeState(db, change) {
  for (let i = 0; i < 50; i++) {
    const row = await db.prepare("SELECT v FROM kv WHERE k = 'state'").first();
    const result = change(row ? JSON.parse(row.v) : {});
    const saved = await db.prepare(`INSERT INTO kv (k, v) VALUES ('state', ?)
      ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE kv.v = ? RETURNING k`)
      .bind(JSON.stringify(result.state), row ? row.v : null).first();
    if (saved) return result;
  }
  throw new Error("状态一直被别的请求改着，这次没写进去");
}

function parseEvent(body, received) {
  const type = String(body.type || "").trim();
  if (!TYPES.has(type)) throw new Error(`不认识的 type：${type || "（空）"}`);
  let ts = received;
  if (body.t != null && body.t !== "") {
    const p = typeof body.t === "number" ? body.t : Date.parse(body.t);
    if (Number.isFinite(p) && p >= received - 24 * 3600e3 && p <= received + 5 * 60e3) ts = p;
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

// 防刷屏和写入放在同一句 SQL。旧记录没有收到时间，升级时用发生时间作短暂兼容。
async function storeEvent(db, ev, config, received) {
  const rc = REPORT_FIELDS[ev.type] && (config.reports || {})[ev.type], min = Number(rc && rc.dedupe_min);
  const args = [ev.ts, ev.type, ev.app, ev.place, JSON.stringify(ev.data), received];
  let sql = "INSERT INTO events (ts, type, app, place, data, received_ts) SELECT ?, ?, ?, ?, ?, ?";
  if (min > 0) {
    sql += " WHERE NOT EXISTS (SELECT 1 FROM events WHERE type = ? AND (received_ts > ? OR (received_ts IS NULL AND ts > ? AND ts <= ?))";
    const since = received - min * 60e3;
    args.push(ev.type, since, since, received);
    if (ev.type === "notify") { sql += ev.app ? " AND app = ?" : " AND app IS NULL"; if (ev.app) args.push(ev.app); }
    if (ev.type === "sound") { sql += " AND json_extract(data, '$.sound') = ?"; args.push(ev.data.sound); }
    sql += ")";
  }
  const r = await db.prepare(sql + " RETURNING id").bind(...args).first();
  return r ? null : min;
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

async function deliver(env, briefing, signal) {
  if (env.WAKE_BUNDLE) {
    const id = await submitWakeEvent(JSON.parse(env.WAKE_BUNDLE), briefing, signal);
    return `已敲门（Aru 外部触发 ${id}）`;
  }
  if (env.PUSH_URL) {   // 先拿推送代替：ntfy 的主题地址，正文就是简报
    const r = await fetch(env.PUSH_URL, { method: "POST", headers: { Title: "knock" }, body: briefing, signal });
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

async function recordWake(db, now, hit, outcome, briefing = null) {
  await db.prepare("INSERT INTO wakes (ts, rule, reason, outcome, briefing) VALUES (?, ?, ?, ?, ?)")
    .bind(now, hit.rule, hit.reason, outcome, briefing).run();
}

// 真正要投递的入口。拿不到锁就只记理由；拿到锁再读最新状态，锁内完成投递和写回。
async function tryWake(env, hit, ev, config, now) {
  const db = env.DB, test = hit.rule === "test";
  const denied = async blocked => {
    await recordWake(db, now, hit, `挡下：${blocked}`);
    return { blocked, outcome: `挡下：${blocked}`, sent: false };
  };
  const started = Date.now(), until = started + WAKE_LEASE_MS;
  const lease = JSON.stringify({ until, owner: crypto.randomUUID() });
  const locked = await db.prepare(`INSERT INTO kv (k, v) VALUES ('wake_lock', ?)
    ON CONFLICT(k) DO UPDATE SET v = excluded.v
    WHERE json_extract(kv.v, '$.until') <= ? RETURNING k`).bind(lease, started).first();
  if (!locked) return denied("另一次叫醒正在进行");
  try {
    const state = await kvGet(db, "state", {});
    // 手动「测试敲门」不受失败冷却、不改状态：刚搭好时常要改完配置马上再试（11-19 枢复审改）
    const blocked = !test && (failureReason(state, now) || guard(hit, ev, { config, state, now }));
    if (blocked) return await denied(blocked);
    const timeline = test ? [] : await eventsSince(db, ev.ts - TIMELINE_HOURS * 3600e3);
    const summary = test ? "" : daySummary(await eventsSince(db, dayStart(ev.ts, config.tz)), config.tz);
    const briefing = buildBriefing({ hit, ev, config, timeline, summary, status: test ? "" : statusLine(state, now, config) });
    // 网络请求最多等 25 秒，也给租约留出写记录、写状态的时间。
    const budget = Math.min(25e3, until - Date.now() - 10e3);
    if (budget <= 0) return await denied("叫醒准备太久，这次没有投递");
    let outcome, sent = false;
    try {
      outcome = await deliver(env, briefing, AbortSignal.timeout(budget));
      sent = true;   // 没配置渠道的演练仍照旧记账；手动测试不扣日常次数
    } catch (e) {
      outcome = `失败：${e.message || String(e)}（不计次数）`;
    }
    if (!test) {
      await changeState(db, state => ({
        state: sent ? afterWake(hit, { ts: now }, { config, state })
          : { ...state, last_fail_ts: Math.max(state.last_fail_ts ?? now, now) },
      }));
    }
    await recordWake(db, now, hit, outcome, briefing);
    return { sent, outcome };
  } finally {
    // 只删自己的租约，不能删掉过期后由另一次请求拿到的锁。
    await db.prepare("DELETE FROM kv WHERE k = 'wake_lock' AND v = ?").bind(lease).run();
  }
}

// 问小模型一次。dry = 只问、不叫（管理页的「现在问一次」）
async function modelCheck(env, trigger, { dry = false, now = Date.now() } = {}) {
  const db = env.DB;
  const config = mergeConfig(await kvGet(db, "config", null));
  const today = await eventsSince(db, dayStart(now, config.tz));
  const recent = (await eventsSince(db, now - 2 * 3600e3)).map(e => describe(e, config.tz));
  const last = await db.prepare(`SELECT ts, reason FROM wakes WHERE outcome NOT LIKE '挡下%' AND outcome NOT LIKE '失败%'
    AND rule != 'test' ORDER BY ts DESC LIMIT 1`).first();
  const messages = buildMessages({
    trigger, config, now: localParts(now, config.tz).hm, summary: daySummary(today, config.tz), recent,
    status: statusLine(await kvGet(db, "state", {}), now, config),
    lastWake: last ? `${localParts(last.ts, config.tz).hm}，因为 ${last.reason}` : "",
  });
  let decision, outcome;
  try {
    decision = parseDecision(await askModel(env, config, messages));
  } catch (e) {
    await db.prepare("INSERT INTO checks (ts, trigger, wake, reason, outcome) VALUES (?, ?, ?, ?, ?)").bind(now, trigger, 0, "", `出错：${e.message}`).run();
    return { ok: false, error: e.message, messages };
  }
  if (decision.wake && !dry) {
    const w = await tryWake(env, { rule: "model", reason: decision.reason }, { ts: now }, config, now);
    outcome = w.outcome;
  } else outcome = dry ? "只是问问，没敲门" : "不叫";
  await db.prepare("INSERT INTO checks (ts, trigger, wake, reason, outcome) VALUES (?, ?, ?, ?, ?)").bind(now, trigger, decision.wake ? 1 : 0, decision.reason, outcome).run();
  return { ok: true, ...decision, outcome, messages };
}

// 定时检查出来的事（下班、很久没动静）：要不要叫、叫了没有，都记进 checks。hold = 不叫的理由（只记录）
async function decide(env, { trigger, hit, now, received, config, hold }) {
  const outcome = hold ? `只记下：${hold}` : (await tryWake(env, hit, { ts: now }, config, received)).outcome;
  await env.DB.prepare("INSERT INTO checks (ts, trigger, wake, reason, outcome) VALUES (?, ?, ?, ?, ?)").bind(now, trigger, hold ? 0 : 1, hit.reason, outcome).run();
}

// 每次定时：下班确认、很久没动静。不管小模型开没开都跑
async function settle(env, config, now, received) {
  const db = env.DB;
  const { state, we, ia } = await changeState(db, state => {
    const we = confirmWorkEnd(state, now, config);
    const ia = checkInactivity(we.state, now, config);
    return { state: ia.state, we, ia };
  });
  if (we.ended && config.work_end.enabled) {
    const { start, end } = we.ended, hm = ts => localParts(ts, config.tz).hm;
    const dur = start && start < end ? `，从 ${hm(start)} 起工作了约 ${Math.round((end - start) / 3600e3 * 10) / 10} 小时` : "";
    await decide(env, { trigger: "下班确认", now, received, config,
      hit: { rule: "work_end", reason: `${hm(end)} 关了工作模式、${config.work_end.confirm_min} 分钟没再打开，算下班了${dur}` },
      hold: config.work_end.wake ? null : "work_end.wake 没打开" });
  }
  if (ia.step === "pending") {
    const h = Math.round(ia.gap / 3600e3 * 10) / 10;
    await db.prepare("INSERT INTO checks (ts, trigger, wake, reason, outcome) VALUES (?, ?, ?, ?, ?)")
      .bind(now, "没动静检查", 0, `已经 ${h} 小时没有动静`, "先等等，下次检查还没动静才算").run();
  }
  if (ia.step === "confirmed") {
    const hold = !config.inactivity.wake ? "inactivity.wake 没打开（先看几天记得对不对）"
      : state.battery_low ? "手机电量低，可能是没电关机了，不当成没动静" : null;
    await decide(env, { trigger: "没动静检查", hit: ia.hit, now, received, config, hold });
  }
  return kvGet(db, "state", {});
}

async function handleEvent(req, env, ectx, received) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "要 JSON" }, 400); }
  let ev;
  try { ev = parseEvent(body, received); } catch (e) { return json({ ok: false, error: e.message }, 400); }
  const db = env.DB;
  const config = mergeConfig(await kvGet(db, "config", null));
  const dup = await storeEvent(db, ev, config, received);
  if (dup) return json({ ok: true, wake: false, skipped: `${dup} 分钟内已经记过一条同样的，这条不记` });

  const { state } = await changeState(db, state => ({ state: applyState(ev, state, config) }));
  const ctx = { config, state, sessionMin: await sessionMinutes(db, ev) };
  const hit = evaluate(ev, ctx);
  let result = { ok: true, wake: false };
  if (hit) {
    const w = await tryWake(env, hit, ev, config, received);
    result = w.blocked ? { ok: true, wake: false, rule: hit.rule, blocked: w.blocked }
      : { ok: true, wake: w.sent, rule: hit.rule, outcome: w.outcome };
  }
  // 没碰到规则、但差一点：回完快捷指令再让小模型看（不让手机等）
  const near = !hit && config.model.enabled && !state.asleep && !quietReason(state, received, config.tz) ? nearMiss(ev, ctx) : null;
  if (near) {
    const job = modelCheck(env, "差一点：" + near, { now: received });
    if (ectx && ectx.waitUntil) ectx.waitUntil(job); else await job;
    result.model = "交给小模型看了";
  }
  return json(result);
}

export default {
  async fetch(req, env, ectx) {
    const received = Date.now(), url = new URL(req.url), p = url.pathname;
    if (!env.DB) return json({ ok: false, error: "还没绑定 D1 数据库（变量名要叫 DB）" }, 500);
    await ensureSchema(env.DB);
    if (p === "/event" && req.method === "POST") {
      if (!String(env.EVENT_TOKEN || "").trim()) return json({ ok: false, error: "守门人还没设 EVENT_TOKEN（或者设了没点 Deploy）" }, 401);
      if (!authed(req, env.EVENT_TOKEN)) return json({ ok: false, error: "事件口令不对" }, 401);
      return handleEvent(req, env, ectx, received);
    }
    // 管理页本身不带数据，谁都能打开；页面里取数据要带管理口令
    if ((p === "/" || p === "/admin") && req.method === "GET") return new Response(ADMIN_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-knock": SIGN_HDR } });
    if (!String(env.ADMIN_TOKEN || "").trim()) return json({ ok: false, error: "守门人还没设 ADMIN_TOKEN（名字要一模一样，设了要点 Deploy）" }, 401);
    if (!authed(req, env.ADMIN_TOKEN)) return json({ ok: false, error: "管理口令不对（在管理页重新粘贴 ADMIN_TOKEN）" }, 401);
    const db = env.DB;
    if (p === "/config" && req.method === "GET") return json(mergeConfig(await kvGet(db, "config", null)));
    if (p === "/config" && req.method === "PUT") {
      let body; try { body = await req.json(); } catch { return json({ ok: false, error: "要 JSON" }, 400); }
      const error = validateConfig(body);
      if (error) return json({ ok: false, error }, 400);
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
    if (p === "/ask" && req.method === "POST") return json(await modelCheck(env, "管理页手动问", { dry: true, now: received }));
    if (p === "/test" && req.method === "POST") {   // 不看普通叫醒规则，不扣日常配额
      const config = mergeConfig(await kvGet(db, "config", null));
      const w = await tryWake(env, { rule: "test", reason: "测试敲门" }, { ts: received }, config, received);
      return json({ ok: true, outcome: w.outcome });
    }
    return json({ ok: false, error: "没有这个地址" }, 404);
  },

  // 定时（Cron 建议每 30 分钟）：清旧记录；开了小模型的话，白天到点让它看一眼
  async scheduled(ev, env, ectx) {
    const db = env.DB, received = Date.now(), now = (ev && ev.scheduledTime) || received;
    await ensureSchema(db);
    for (const table of ["events", "checks", "wakes"]) {
      await db.prepare(`DELETE FROM ${table} WHERE ts < ?`).bind(now - KEEP_DAYS * 86400e3).run();
    }
    const config = mergeConfig(await kvGet(db, "config", null)), m = config.model;
    const state = await settle(env, config, now, received);   // 下班、没动静：跟小模型开没开无关
    if (!m.enabled) return;
    const h = localParts(now, config.tz).hour;
    if (state.asleep || quietReason(state, now, config.tz) || !(m.from <= m.to ? h >= m.from && h < m.to : h >= m.from || h < m.to)) return;
    const lastAsk = await kvGet(db, "model_last", 0);
    if (now - lastAsk < (m.every_min - 2) * 60e3) return;   // Cron 比 every_min 勤的话跳过几次
    await kvPut(db, "model_last", now);
    const job = modelCheck(env, "定时看一眼", { now: received });
    if (ectx && ectx.waitUntil) ectx.waitUntil(job); else await job;
  },
};

// 管理页：地址井号里的口令不会发到服务器。读完去掉，留在当前标签页的 sessionStorage。
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
<p id="legacy" hidden>以后改用 #key=，?key= 会留在浏览器记录里。</p>
<section id="login" hidden><form id="loginform"><label for="key">粘贴管理口令</label> <input id="key" type="password" autocomplete="off" required> <button>打开管理页</button></form><div id="loginmsg" role="status"></div></section>
<div id="panel" hidden>
<section><h2>叫醒说明</h2><p class="s">note 是 TA 用自己的口气写给守门人的话，会原样放进简报。其余是开关和数字，改完点保存。</p>
<textarea id="cfg"></textarea><div style="margin-top:10px"><button id="save">保存</button><button class="g" id="test">测试敲门</button></div><div id="msg"></div></section>
<section><h2>她现在</h2><div id="now" class="d">读取中…</div></section>
<section><h2>小模型和定时检查</h2><p class="s">小模型：规则管不到的时候它替 TA 看一眼，只决定叫不叫，叫了也要过硬底线。在叫醒说明里把 model.enabled 改成 true 才会开始看。定时检查（下班、很久没动静）不管小模型开没开都会跑，结果也记在下面。</p>
<button class="g" id="ask">现在问它一次（不会真的敲门）</button><div id="askr" class="row" style="display:none"></div><div id="checks" class="d" style="margin-top:8px">读取中…</div></section>
<section><h2>叫醒记录</h2><div id="wakes" class="d">读取中…</div></section>
<section><h2>最近 6 小时收到的事</h2><div id="tl" class="d">读取中…</div></section>
</div>
<p class="s" style="text-align:center;font-size:12px;margin-top:22px">${SIGN}<br>原版在 github.com/White-ting/Aru-kit · 不许转发、不许商用</p>
</main><script>
const $=id=>document.getElementById(id), msg=t=>$('msg').textContent=t;
const u=new URL(location.href), f=new URLSearchParams(u.hash.slice(1));
const fromHash=f.has('key'), legacy=u.searchParams.has('key');
const incoming=(f.get('key')||u.searchParams.get('key')||'').trim();
if(fromHash||legacy){
 u.searchParams.delete('key');
 if(fromHash){f.delete('key');u.hash=f.toString();}
 history.replaceState(null,'',u.pathname+u.search+u.hash);
}
$('legacy').hidden=!legacy;
const slot='knock.admin.key';
let K='';
try{K=sessionStorage.getItem(slot)||'';}catch{}
function remember(k){
 K=k;
 try{if(k)sessionStorage.setItem(slot,k);else sessionStorage.removeItem(slot);}catch{}
}
if(incoming)remember(incoming);
function login(reason=''){
 $('login').hidden=false;$('panel').hidden=true;$('loginmsg').textContent=reason;
}
const t=ms=>new Date(ms).toLocaleString('zh-CN',{hour12:false});
const esc=s=>String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function api(p,o){
 const headers={Authorization:'Bearer '+K,'Content-Type':'application/json'};
 const r=await fetch(p,Object.assign({headers,cache:'no-store'},o||{}));
 const j=await r.json();
 if(r.status===401){remember('');login(j.error||'口令不对');}
 if(!r.ok)throw new Error(j.error||('请求失败：HTTP '+r.status));
 return j;
}
async function load(){
 if(!K){login();return;}
 try{
 $('cfg').value=JSON.stringify(await api('/config'),null,2);
 $('login').hidden=true;$('panel').hidden=false;
 const w=await api('/wakes');$('wakes').innerHTML=w.length?w.map(x=>'<div class="row">'+t(x.ts)+' · '+esc(x.rule)+' · '+esc(x.reason)+'<br><span class="d">'+esc(x.outcome)+'</span></div>').join(''):'还没有';
 const st=await api('/state');$('now').textContent=st['现在'];
 const c=await api('/checks');$('checks').innerHTML=c.length?c.map(x=>'<div class="row">'+t(x.ts)+' · '+esc(x.trigger)+' · <b>'+(x.wake?'想叫':'不叫')+'</b> '+esc(x.reason)+'<br><span class="d">'+esc(x.outcome)+'</span></div>').join(''):'还没看过';
 const e=await api('/timeline?hours=6');$('tl').innerHTML=e.length?e.slice().reverse().map(x=>'<div class="row">'+t(x.ts)+' · '+esc(x.type)+' '+esc(x.app||x.place||'')+((x.type=='app_open'||x.type=='app_close')&&!x.app?' <b style="color:var(--acc)">没带 App 名字（快捷指令请求体里加 app）</b>':'')+' <span class="d">'+esc(x.data&&x.data!='{}'?x.data:'')+'</span></div>').join(''):'还没有';
 }catch(e){if($('panel').hidden){if(K)login(e.message);}else msg(e.message);}
}
$('loginform').onsubmit=e=>{
 e.preventDefault();
 const k=$('key').value.trim();$('key').value='';
 if(!k){login('请粘贴管理口令');return;}
 remember(k);load();
};
$('save').onclick=async()=>{let c;try{c=JSON.parse($('cfg').value);}catch(e){return msg('格式不对：'+e.message);}
 try{await api('/config',{method:'PUT',body:JSON.stringify(c)});msg('保存好了');load();}catch(e){msg(e.message);}};
$('ask').onclick=async()=>{const b=$('askr');b.style.display='block';b.textContent='问着…';
 try{const r=await api('/ask',{method:'POST'});b.innerHTML=r.ok?('<b>'+(r.wake?'想叫':'不叫')+'</b> · '+esc(r.reason)):('出错：'+esc(r.error));load();}catch(e){b.textContent=e.message;}};
$('test').onclick=async()=>{msg('敲门中…');try{const r=await api('/test',{method:'POST'});msg('结果：'+r.outcome);load();}catch(e){msg(e.message);}};
load();
</script></body></html>`;
