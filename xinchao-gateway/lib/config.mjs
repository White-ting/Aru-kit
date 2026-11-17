// 读 .env 和环境变量，整理成一份配置。
import fs from 'node:fs';
import path from 'node:path';

/** 读一个 .env 文件，返回 {键: 值}。不存在就返回空对象。只认 KEY=VALUE，# 开头是注释。 */
export function readEnvFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function isPassthrough(v) { return String(v || '').trim().toLowerCase() === 'passthrough'; }

function bool(v, dflt) {
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
function num(v, dflt) {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * 合成配置。优先级：overrides > 真环境变量 > .env 文件 > 默认值。
 * baseDir 用来找 .env 和放 state 目录。
 */
export function loadConfig({ baseDir = process.cwd(), env = process.env, envFile, overrides = {} } = {}) {
  const fileVals = envFile === false ? {} : readEnvFile(envFile || path.join(baseDir, '.env'));
  const get = (k) => (k in overrides ? overrides[k] : (env[k] !== undefined ? env[k] : fileVals[k]));
  // 多渠道（0.1.4，测试反馈 3bcb）：UPSTREAM_<名字>_URL / UPSTREAM_<名字>_KEY 成对写，App 的地址写 /<名字小写>/v1 就走这一组
  const chNames = new Set();
  for (const k of [...Object.keys(fileVals), ...Object.keys(env), ...Object.keys(overrides)]) {
    const m = /^UPSTREAM_([A-Z0-9]+)_(URL|KEY)$/.exec(k);
    if (m) chNames.add(m[1]);
  }
  const channels = [...chNames].sort().map((N) => ({
    name: N.toLowerCase(),
    url: String(get(`UPSTREAM_${N}_URL`) || '').replace(/\/+$/, ''),
    key: get(`UPSTREAM_${N}_KEY`) || '',
    passthrough: isPassthrough(get(`UPSTREAM_${N}_KEY`)),
  }));
  const strip = get('STRIP_TAGS');

  const upstream = String(get('UPSTREAM_URL') || '').replace(/\/+$/, '');
  const stateDir = get('STATE_DIR') || path.join(baseDir, 'state');
  const skip = get('SKIP_PREFIXES');
  const bgp = get('BG_PATTERNS');
  const toolp = get('TOOL_PREFIXES');

  return {
    port: num(get('PORT'), 8790),
    host: get('HOST') || '127.0.0.1',
    gatewayKey: get('GATEWAY_KEY') || '',
    upstreamUrl: upstream,
    upstreamKey: get('UPSTREAM_KEY') || '',
    // 透传模式（0.1.2）：UPSTREAM_KEY=passthrough。App 带来的 authorization / x-api-key / anthropic-* 原样转给上游，
    // 网关自己的口令改成写在地址里：/<GATEWAY_KEY>/v1/...
    passthrough: isPassthrough(get('UPSTREAM_KEY')),
    // 按格式分上游（0.1.2 追加）：填了这一组，/v1/messages 走它；别的路径还走 UPSTREAM_URL / UPSTREAM_KEY。
    // 这一组的 KEY 也可以单独写 passthrough。不填就跟以前一样，全部走 UPSTREAM_URL。
    anthropicUpstreamUrl: String(get('ANTHROPIC_UPSTREAM_URL') || '').replace(/\/+$/, ''),
    anthropicUpstreamKey: get('ANTHROPIC_UPSTREAM_KEY') || '',
    anthropicPassthrough: isPassthrough(get('ANTHROPIC_UPSTREAM_KEY')),
    channels,
    // App 塞进她那句的附注（0.1.4，测试反馈 ca3e：Aru 会并进 <sent_at>…</sent_at>、<environment>…</environment>）。
    // 回传、判断桥消息和后台杂活之前先整块去掉。* = 所有成对的 <英文标签>…</英文标签>；也可以写名单 environment|sent_at；留空 = 不去
    stripTags: strip === undefined || strip === null ? '*' : (String(strip).trim() === '*' ? '*' : String(strip).split('|').map((x) => x.trim()).filter(Boolean)),
    xinchaoUrl: String(get('XINCHAO_URL') || '').replace(/\/+$/, ''),
    xinchaoToken: get('XINCHAO_TOKEN') || '',
    xinchaoTimeoutMs: num(get('XINCHAO_TIMEOUT_MS'), 3000),
    skipPrefixes: (skip === undefined || skip === null ? '【|〔心潮念' : String(skip)).split('|').filter(Boolean),
    // 0.1.11：这些开头的 user 消息是工具结果（Aru 把工具取回的图另起一条 user 发），当工具回合配对，不当她说话
    toolPrefixes: (toolp === undefined || toolp === null ? 'Images returned by|Tool result|Tool output' : String(toolp)).split('|').map((x) => x.trim()).filter(Boolean),
    nowEnabled: bool(get('NOW_ENABLED'), true),
    eventEnabled: bool(get('EVENT_ENABLED'), true),
    onlyStream: bool(get('ONLY_STREAM'), false),
    // 后台杂活（0.1.1）：max_tokens 不超过这个数的请求不算她在说话（0 = 不看）；单发请求里出现这些词的也不算
    bgMaxTokens: num(get('BG_MAX_TOKENS'), 120),
    bgPatterns: (bgp === undefined || bgp === null ? '标题|title|摘要|总结|概括|summar|关键词|keyword|标签|分类|classif' : String(bgp)).split('|').map((x) => x.trim()).filter(Boolean),
    // 此刻的节流。0.1.3 起默认 0 = 每轮都附：网关只改发出去的那一份，App 自己存的聊天记录里没有此刻，
    // 不每轮附的话，AI 只在附上的那一轮看得到（测试反馈 ca3e，Aru）。App 会把发出去的整份存进记录的，可以填 30。
    nowRepeatMin: num(get('NOW_REPEAT_MIN'), 0),
    nowForceGapMin: num(get('NOW_FORCE_GAP_MIN'), 90),
    // 回传的节流
    eventForceGapMin: num(get('EVENT_FORCE_GAP_MIN'), 45),
    eventMinIntervalMin: num(get('EVENT_MIN_INTERVAL_MIN'), 8),
    eventMaxPerHour: num(get('EVENT_MAX_PER_HOUR'), 4),
    // 调试（0.1.3）：只在日志里记她那句话的结构（分几块、每段多长、有哪些 <标签>），不记正文。测完关掉。
    // 2（0.1.5）= 再多记她那句话的「骨架」：标签名照写、属性值遮成 …、文字只留字数（·26），看附注是怎么写的
    debugShape: String(get('DEBUG_SHAPE') ?? '').trim() === '2' ? 2 : (bool(get('DEBUG_SHAPE'), false) ? 1 : 0),
    maxBodyBytes: Math.round(num(get('MAX_BODY_MB'), 20) * 1024 * 1024),
    stateDir,
    logLevel: get('LOG_LEVEL') || 'info',
  };
}

/** 启动前检查必填项，返回问题列表（空数组 = 没问题）。 */
export function checkConfig(cfg) {
  const problems = [];
  if (!cfg.gatewayKey) problems.push('GATEWAY_KEY 没填：App 里要填的那串口令');
  else if ((cfg.passthrough || (cfg.anthropicUpstreamUrl && cfg.anthropicPassthrough)) && !/^[A-Za-z0-9._~-]+$/.test(cfg.gatewayKey)) {
    problems.push('透传模式下 GATEWAY_KEY 要写进地址里，只能用字母、数字和 . _ ~ -（用 openssl rand -hex 24 生成的就行）');
  }
  if (!/^https?:\/\//.test(cfg.upstreamUrl)) problems.push('UPSTREAM_URL 没填或不是 http(s):// 开头');
  if (cfg.anthropicUpstreamUrl && !/^https?:\/\//.test(cfg.anthropicUpstreamUrl)) problems.push('ANTHROPIC_UPSTREAM_URL 不是 http(s):// 开头');
  if (cfg.anthropicUpstreamUrl && !cfg.anthropicUpstreamKey) problems.push('填了 ANTHROPIC_UPSTREAM_URL 就要填 ANTHROPIC_UPSTREAM_KEY（钥匙，或者 passthrough）');
  if (!cfg.anthropicUpstreamUrl && cfg.anthropicUpstreamKey) problems.push('填了 ANTHROPIC_UPSTREAM_KEY 就要填 ANTHROPIC_UPSTREAM_URL；不分上游的话两项都留空');
  for (const c of cfg.channels || []) {
    const N = c.name.toUpperCase();
    if (!/^https?:\/\//.test(c.url)) problems.push(`渠道 ${c.name}：UPSTREAM_${N}_URL 没填或不是 http(s):// 开头（两行要一起写）`);
    if (!c.key) problems.push(`渠道 ${c.name}：UPSTREAM_${N}_KEY 没填（钥匙，或者 passthrough）`);
    if (c.name === 'v1' || c.name === 'healthz') problems.push(`渠道名不能叫 ${c.name}`);
    if (cfg.gatewayKey && cfg.gatewayKey.toLowerCase() === c.name) problems.push(`渠道名 ${c.name} 跟 GATEWAY_KEY 撞了，换一个`);
    if (c.passthrough && cfg.gatewayKey && !/^[A-Za-z0-9._~-]+$/.test(cfg.gatewayKey)) problems.push('有渠道是透传的，GATEWAY_KEY 要写进地址里，只能用字母、数字和 . _ ~ -');
  }
  if ((cfg.nowEnabled || cfg.eventEnabled) && !/^https?:\/\//.test(cfg.xinchaoUrl)) {
    problems.push('XINCHAO_URL 没填：不接心潮的话请把 NOW_ENABLED 和 EVENT_ENABLED 都设成 false');
  }
  return problems;
}
