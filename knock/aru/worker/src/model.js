// 看门的小模型：规则管不到的时候，替 TA 看一眼"这时候 TA 会不会想找她"。
// 只回 {wake, reason}：不跟她说话、不自己发消息；叫不叫最后还要过硬底线。
// 默认用 Cloudflare 自己的 Workers AI（绑定名 AI，数据不出 Cloudflare）；
// 设了 LLM_URL + LLM_KEY 就改走 OpenAI 兼容的接口（DeepSeek、百炼等），模型名写在叫醒说明的 model.name。

// 11-20：原来的 @cf/qwen/qwen3-30b-a3b-fp8 被 Cloudflare 下架（从 2026-11-20 起回 HTTP 410、错误码 5028）。
// 换成官方推荐的小模型里便宜的那个 gemma-4（价钱跟原来差不多）；另一个推荐的 @cf/qwen/qwen3.8-27b 中文更好，但贵将近十倍。
export const DEFAULT_MODEL = "@cf/google/gemma-4-26b-a4b-it";
// 新模型都会先「想一想」再回答，想的字也算在上限里。11-20 在真 Workers AI 上量过：gemma-4 默认想 1000～3000 多字，
// 上限 300 次次没答案、1000 也三次里断一次；关掉思考（enable_thinking: false）1～3 秒出答案、只用 30 来个，8 个场景判断都对。
// 所以 gemma 关思考；上限留 1000 兜着别的模型
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

export function buildMessages({ trigger, config, now, summary, recent, lastWake, status }) {
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
export function parseDecision(text) {
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

export async function askModel(env, config, messages) {
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
  if (/^@cf\/qwen\/qwen3\.8/.test(name)) opt.reasoning_effort = "low";   // qwen3.8 默认想得最深（xhigh），又慢又贵；这里只要判断叫不叫，最浅一档就够（实测 5 秒、想 170 字）
  if (/^@cf\/google\/gemma-4/.test(name)) opt.chat_template_kwargs = { enable_thinking: false };   // gemma-4 不关思考会想到上限还没答案
  return textOf(await env.AI.run(name, opt));
}
