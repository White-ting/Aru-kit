// 守门人的规则：纯函数，不碰网络和数据库，方便单独测。
// 规则是我们自己写的；"叫醒说明"(config) 是 AI 用自己的口气写、能自己改的那份参数。

export const DEFAULT_CONFIG = {
  tz: "Asia/Shanghai",
  // AI 写给守门人的话：它在意她什么、它是什么脾气。原样放进简报，让醒来的它对得上自己。
  note: "",
  daily_cap: 5,            // 一天最多叫醒几次（硬底线）
  cooldown_min: 60,        // 两次叫醒至少隔多久（硬底线）
  late_night: { enabled: true, from: 1, to: 5, once_per_night: true },
  places: { enabled: true, watch: [] },                       // 到达/离开这些地方叫醒，比如 ["医院"]
  // 刷太久：连着用手机超过 minutes 分钟。apps 空 = 全部 App 都算。
  // gap_min（v2.3）：关掉一个 App、这么多分钟内又打开下一个，就接成同一段，几个 App 来回切也算连着刷；0 = 只算单个 App
  // once（v2.3）：一段只敲一次——放下手机超过 gap_min 分钟、重新开始一段，满了才再敲；false = 冷却过了就再敲
  long_session: { enabled: true, minutes: 120, apps: [], gap_min: 5, once: true },
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
export const REPORT_FIELDS = {
  screenshot: [], notify: ["app"], alarm_stop: [], wind_down: [], wifi_join: ["place"],
  workout: ["kind"], carplay: ["on"], wallet: ["card"], sound: ["sound"],
};

// 只检查 PUT 这次带来的项。返回第一处写错的说明；没有错误就返回 null。
export function validateConfig(body) {
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
    [body.long_session, "gap_min", "long_session.gap_min", v => range(v, 0, 60), "0–60 之间的分钟数（0 = 只算单个 App）"],
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

export function mergeConfig(saved) {
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
export function localParts(ts, tz) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  const hour = Number(p.hour) % 24;
  return { date: `${p.year}-${p.month}-${p.day}`, hour, minute: Number(p.minute), hm: `${String(hour).padStart(2, "0")}:${p.minute}` };
}

// "这一夜"：凌晨的算前一天晚上，免得 0 点前后算成两夜
export function nightKey(ts, tz) {
  return localParts(ts - 12 * 3600e3, tz).date;
}

export function inHours(h, from, to) {
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

// 这一段已经因为刷太久敲过了（一段只敲一次）：同一段的起点不变，敲过就记在状态里
function stretchDone(ctx) {
  return ctx.config.long_session.once !== false && ctx.sessionSince != null && (ctx.state || {}).long_session_since === ctx.sessionSince;
}

// 刷太久那句话的开头：只在一个 App 里是「在「抖音」里待了」，几个 App 接起来是「在抖音、小红书之间连着刷了」
function sessionWhere(ev, ctx) {
  const apps = (ctx.sessionApps || []).filter(Boolean);
  if (apps.length > 1) return `在${apps.slice(0, 4).join("、")}${apps.length > 4 ? "等" : ""}之间连着刷了 `;
  return `在「${ev.app || "手机"}」里待了 `;
}

// 一条事件进来，看哪条规则想叫醒它。返回 {rule, reason} 或 null。
// ctx: { config, state, sessionMin, sessionApps, sessionSince }  sessionMin = app_close 时算出的这次连着用了几分钟，
// sessionApps = 这一段里用过的 App，sessionSince = 这一段从几点开始（毫秒）
export function evaluate(ev, ctx) {
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
  if (ev.type === "app_close" && c.long_session.enabled && ctx.sessionMin != null && !stretchDone(ctx)) {
    const apps = c.long_session.apps || [];
    if (ctx.sessionMin >= c.long_session.minutes && (!apps.length || apps.some(a => String(ev.app || "").includes(a)))) {
      return { rule: "long_session", since: ctx.sessionSince, reason: `${sessionWhere(ev, ctx)}${Math.round(ctx.sessionMin)} 分钟（到 ${t.hm}）` };
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
export function nearMiss(ev, ctx) {
  const c = ctx.config, t = localParts(ev.ts, c.tz);
  // v2.3.1：同一段只算一次「差一点」（几个 App 接成一段后，每关一次 App 都会到这里，不拦会一直问小模型）
  if (ev.type === "app_close" && c.long_session.enabled && ctx.sessionMin != null && !stretchDone(ctx)
    && (ctx.state || {}).near_since !== ctx.sessionSince && ctx.sessionMin >= c.long_session.minutes * 0.6) {
    return `${sessionWhere(ev, ctx)}${Math.round(ctx.sessionMin)} 分钟（规则是 ${c.long_session.minutes} 分钟）`;
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
export function daySummary(events, tz) {
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
export function quietReason(state, now, tz) {
  if (state.focus_mode === "work" || state.focus_mode === "dnd") return `她开着${FOCUS_ZH[state.focus_mode]}专注模式`;
  if (state.alone_until && now < state.alone_until) return `她说想独处（到 ${localParts(state.alone_until, tz).hm}）`;
  return null;
}

export function failureReason(state, now) {
  if (state.last_fail_ts == null || now - state.last_fail_ts >= FAIL_COOLDOWN) return null;
  return "投递失败冷却（上次失败后 10 分钟内不再投递）";
}

export function guard(hit, ev, ctx) {
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
export function afterWake(hit, ev, ctx) {
  const c = ctx.config, s = { ...ctx.state }, ts = Math.max(ev.ts, s.last_wake_ts ?? ev.ts), today = localParts(ts, c.tz).date;
  s.wakes_count = (s.wakes_date === today ? (s.wakes_count || 0) : 0) + 1;
  s.wakes_date = today;
  s.last_wake_ts = ts;
  if (hit.rule === "late_night") s.late_night_key = nightKey(ts, c.tz);
  if (hit.rule === "long_session" && hit.since != null) s.long_session_since = hit.since;
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
export function applyState(ev, state, config) {
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
export function confirmWorkEnd(state, now, config) {
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
export function checkInactivity(state, now, config) {
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
export function statusLine(state, now, config) {
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

export const MOOD_ZH = { happy: "开心", low: "低落", alone: "想独处", need_company: "想聊天" };

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

export function describe(ev, tz) {
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
export function buildBriefing({ hit, ev, config, timeline, summary, status }) {
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
