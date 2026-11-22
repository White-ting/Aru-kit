// 网关本体：收 App 的请求 → （她在说话时）心跳 + 取此刻 + 附上 → 原样转给上游 → 原样转回 App → 后台回传。
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { VERSION, BUILD } from './version.mjs';
import { makeLogger } from './log.mjs';
import { GatewayState } from './state.mjs';
import { makeXinchao } from './xinchao.mjs';
import {
  classifyLast, startsWithSkip, looksBackground, gateCheck, injectNow, finalFromJson, makeStreamCollector, describeShape, stripAnnotations, skeleton, tailUserTexts, toolBeforeTail, describeTail, replyToolText, hideNumbers, ownBody, stripLeadMeta, appNoteKind,
} from './turn.mjs';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'proxy-connection',
]);
// 这些头不从 App 带给上游：口令换成上游的，长度重新算，压缩关掉（网关要读回复）
const DROP_TO_UPSTREAM = new Set([...HOP_BY_HOP, 'host', 'authorization', 'x-api-key', 'content-length', 'accept-encoding']);
// 透传模式：authorization、x-api-key 是 App 的上游凭证（比如订阅凭证），原样带过去
const DROP_TO_UPSTREAM_PASSTHROUGH = new Set([...HOP_BY_HOP, 'host', 'content-length', 'accept-encoding']);
const PENDING_TOOL_MAX_MS = 15 * 60 * 1000;
const COLLECT_CAP = 16 * 1024 * 1024; // 非流式回复最多读这么多来取文字；更大的照样转，只是不回传

function cut(s, n) { return Array.from(String(s || '')).slice(0, n).join(''); }

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
function sameSecret(a, b) { return !!a && !!b && crypto.timingSafeEqual(sha(a), sha(b)); }

function sendJson(res, status, obj, extraHeaders = {}) {
  if (res.headersSent) { res.destroy(); return; }
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, ...extraHeaders });
  res.end(body);
}

function presentedKey(req) {
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  const x = req.headers['x-api-key'];
  return typeof x === 'string' ? x.trim() : '';
}

/**
 * 拆出地址里的口令：/<口令>/v1/... → { key: '<口令>', rest: '/v1/...' }。
 * 第一段就是 v1（或者是 healthz）的，没有路径口令：key 为 null。
 */
function splitPathKey(pathname) {
  const m = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m || m[1] === 'v1' || m[1] === 'healthz') return { key: null, rest: pathname };
  let key = m[1];
  try { key = decodeURIComponent(key); } catch { /* 原样用 */ }
  return { key, rest: m[2] || '/' };
}

/** 日志里的 path：路径口令那一段换成 ***；渠道名照写。 */
function maskedPath(pathname, chNames = new Set()) {
  const m = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  if (m && chNames.has(m[1].toLowerCase())) return '/' + m[1].toLowerCase() + maskedPath(m[2] || '', chNames).replace(/^\/$/, '');
  const { key, rest } = splitPathKey(pathname);
  return key === null ? pathname : '/***' + (rest === '/' ? '' : rest);
}

/** 读请求体，超过上限返回 null（调用方回 413）。 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) { resolve(null); return; }
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createGateway({ cfg, clock = () => Date.now(), log = makeLogger({ level: cfg.logLevel }) }) {
  const state = new GatewayState({ dir: cfg.stateDir, cfg, clock });
  const xc = makeXinchao({ cfg, log, clock });
  const background = new Set(); // 后台回传，测试里可以等它们

  function track(p) { background.add(p); p.finally(() => background.delete(p)); return p; }

  // 上游分组：默认一组（UPSTREAM_URL / UPSTREAM_KEY）；填了 ANTHROPIC_UPSTREAM_URL 的，/v1/messages 走另一组
  const mainUp = { url: cfg.upstreamUrl, key: cfg.upstreamKey, passthrough: !!cfg.passthrough, anthropic: false };
  const antUp = cfg.anthropicUpstreamUrl
    ? { url: cfg.anthropicUpstreamUrl, key: cfg.anthropicUpstreamKey, passthrough: !!cfg.anthropicPassthrough, anthropic: true }
    : null;
  function upstreamFor(path) {
    if (antUp && (path === '/v1/messages' || path.startsWith('/v1/messages/'))) return antUp;
    return mainUp;
  }
  // 多渠道（0.1.4）：/<渠道>/v1/... 走 UPSTREAM_<渠道>_*，整条请求都走这一组
  const channels = new Map((cfg.channels || []).map((c) => [c.name, { url: c.url, key: c.key, passthrough: c.passthrough, anthropic: false, name: c.name }]));
  const chNames = new Set(channels.keys());
  function takeChannel(p) {
    const m = /^\/([^/]+)(\/.*)?$/.exec(p);
    const c = m && channels.get(m[1].toLowerCase());
    return c ? { ch: c, rest: m[2] || '/' } : { ch: null, rest: p };
  }

  function upstreamHeaders(req, bodyLen, format, up) {
    const h = {};
    const drop = up.passthrough ? DROP_TO_UPSTREAM_PASSTHROUGH : DROP_TO_UPSTREAM;
    for (const [k, v] of Object.entries(req.headers)) if (!drop.has(k)) h[k] = v;
    if (!up.passthrough) {
      if (format === 'anthropic' || up.anthropic) h['x-api-key'] = up.key;
      else h.authorization = `Bearer ${up.key}`;
    }
    h['accept-encoding'] = 'identity';
    if (bodyLen !== null) h['content-length'] = String(bodyLen);
    return h;
  }

  function maybeSendEvent(her, reply, gap) {
    if (!cfg.eventEnabled || !cfg.xinchaoUrl) return;
    if (!reply || !reply.trim()) { log('event', false, { why: 'empty-reply' }); return; }
    if (!state.shouldSendEvent(gap)) { log('event', 'skip', { why: 'throttled' }); return; }
    const exchange = `她说：${cut(her, 600)}\n他回：${cut(reply, 900)}`;
    track(xc.sendEvent(exchange).then((ok) => { if (ok) state.markEventSent(); }));
  }

  async function handle(req, res) {
    const t0 = Date.now();
    req.socket.setNoDelay(true);
    const url = new URL(req.url, 'http://gateway.local');
    const rawPath = url.pathname.replace(/\/+$/, '') || '/';
    const healthz = () => sendJson(res, 200, { ok: true, version: VERSION, build: BUILD, by: 'White-ting' });
    const deny = () => {
      // 日志里的 path 已经把路径口令换成 ***；请求头里的东西（口令、订阅凭证）从不进日志
      log('auth', false, { path: maskedPath(rawPath, chNames), status: 401 });
      req.resume();
      sendJson(res, 401, { error: { message: 'invalid gateway key', type: 'invalid_request_error' } });
    };

    if (req.method === 'GET' && rawPath === '/healthz') { healthz(); return; }

    // ---------- 门禁 ----------
    // 路径口令 /<GATEWAY_KEY>/v1/...：两种模式都认。透传模式只认它（请求头是上游凭证，不拿来认人）。
    // 普通模式下没有路径口令的，照旧看请求头。
    // 渠道（0.1.4）：/<渠道>/v1/... 或 /<口令>/<渠道>/v1/...
    let path = rawPath;
    let ch = null;
    let keyed = false;
    const c1 = takeChannel(path);
    if (c1.ch) { ch = c1.ch; path = c1.rest; } else {
      const { key: pathKey, rest } = splitPathKey(path);
      if (pathKey !== null) {
        if (!sameSecret(pathKey, cfg.gatewayKey)) { deny(); return; }
        keyed = true;
        path = rest;
        const c2 = takeChannel(path);
        if (c2.ch) { ch = c2.ch; path = c2.rest; }
      }
    }
    path = path.replace(/\/+$/, '') || '/';
    if ((keyed || ch) && req.method === 'GET' && path === '/healthz') { healthz(); return; }
    if (!keyed && (path.startsWith('/v1/') || path === '/v1')) {
      // 这条要去的那一组是透传的，就只认路径口令；不是透传的，看请求头口令
      if ((ch || upstreamFor(path)).passthrough || !sameSecret(presentedKey(req), cfg.gatewayKey)) { deny(); return; }
    }
    if (!path.startsWith('/v1/') && path !== '/v1') { sendJson(res, 404, { error: { message: 'not found' } }); return; }

    let format = null;
    if (req.method === 'POST' && path === '/v1/chat/completions') format = 'openai';
    else if (req.method === 'POST' && path === '/v1/messages') format = 'anthropic';

    let raw = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      raw = await readBody(req, cfg.maxBodyBytes);
      if (raw === null) {
        log('request', false, { path, status: 413 });
        sendJson(res, 413, { error: { message: 'request body too large' } }, { connection: 'close' });
        return;
      }
    }

    // App 断开 → 不再做事，也断开上游
    const upstreamAbort = new AbortController();
    let clientGone = false;
    res.on('close', () => {
      if (!res.writableFinished) { clientGone = true; upstreamAbort.abort(); }
    });

    // ---------- 第 2 根线：此刻 ----------
    let turn = { kind: 'other' };
    let parts = [];   // 0.1.6：这一轮她发的几条，去掉附注以后还有字的
    let noteKinds = [];   // 0.1.11：每条是不是 Aru 自己写的（tool / external / ''）
    let isHer = false;
    let herText = '';
    let gap = Infinity;
    let outBody = raw;
    let body = null;
    let attachedNow = '';   // 0.1.14：这一句附上的此刻，TA 接着调工具时那几次也带上
    if (format && raw && raw.length) {
      try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; }
    }
    if (body) {
      turn = classifyLast(body, format);
      // 0.1.4：App 塞进来的附注先去掉，再判断是不是桥递来的、是不是后台杂活；回传也只传她自己的话。
      // 0.1.6：这一轮她连着发的几条都算（Aru 会把她的话和 <environment> 拆成两条）；全是附注、没有她一个字的，不算她在说话
      let said = '', annoOnly = false;
      if (turn.kind === 'user') {
        const texts = tailUserTexts(body, format);
        turn.rawTurn = texts.join('\n');
        // 0.1.11：先看每条是不是 Aru 自己写的（工具图 / 桥叫醒），再把开头的引用元数据（[Replying to …] + JSON + 短方括号）剥掉
        const noAnno = texts.map((x) => stripAnnotations(x, cfg.stripTags, false));
        noteKinds = noAnno.filter((x) => x.trim()).map((x) => appNoteKind(x, cfg.toolPrefixes));
        const cleanedAll = noAnno.map((x) => stripLeadMeta(x));
        parts = cleanedAll.filter((x) => x.trim());
        if (cfg.debugShape) {
          // 0.1.7 调试：最近 10 条是谁发的（s 系统 u 她 a TA t 工具），这一轮她那几条各几个字（去附注前>后）。不记内容
          const msgs = Array.isArray(body.messages) ? body.messages : [];
          const roles = msgs.slice(-10).map((m) => ({ system: 's', developer: 's', user: 'u', assistant: 'a', tool: 't', function: 't' })[m && m.role] || '?').join('');
          const len = (x) => Array.from(String(x)).length;
          log('tail', true, { roles, lens: texts.map((x, k) => `${len(x)}>${len(cleanedAll[k])}`).join(',') });
        }
        said = parts.join('\n');
        if (!said) { annoOnly = texts.some((x) => x.trim()); said = annoOnly ? '' : turn.text; }   // 有字、去完附注全空了 = 全是附注
        turn.said = said;
        // 0.1.8：只有附注、前面紧挨着工具结果 = 工具回合的后半段（Aru 在工具结果后面又塞了一条附注），照工具回合配对回传
        if (annoOnly && toolBeforeTail(body, format)) { turn = { kind: 'tool', after: 'annotation' }; annoOnly = false; }
        // 0.1.11：Aru 把工具取回的图另起一条 user（"Images returned by the completed tool call…"）= 工具回合
        else if (noteKinds.includes('tool')) turn = { kind: 'tool', after: 'tool-note' };
      }
      const external = turn.kind === 'user' && noteKinds.includes('external');
      const bg = turn.kind === 'user' && !annoOnly ? looksBackground(body, said, cfg) : '';
      isHer = turn.kind === 'user'
        && !annoOnly
        && !external
        && !(parts.length ? parts.some((x) => startsWithSkip(x, cfg.skipPrefixes)) : startsWithSkip(said, cfg.skipPrefixes))
        && !bg
        && (!cfg.onlyStream || body.stream === true);
      if (turn.kind === 'user' && !isHer) log('turn', true, { kind: bg ? 'background' : 'skip', why: annoOnly ? 'annotation' : external ? 'external' : (bg || undefined) });
      if (turn.kind === 'tool') log('turn', true, { kind: 'tool', after: turn.after });
      // 0.1.13 调试（DEBUG_SHAPE=3）：她说话和工具回合都记最后 4 条每一块是什么，不记内容（查语音条被当成工具回合）
      if (cfg.debugShape >= 3 && (turn.kind === 'tool' || turn.kind === 'user')) for (const row of describeTail(body, format)) log('msg', true, row);
    }
    if (isHer) {
      herText = turn.said;
      state.pendingTool = null; // 她说了新的一句：之前没走完的工具回合作废，免得配错
      gap = state.markUser();
      log('turn', true, { kind: 'her', chars: herText.length });
      if (cfg.debugShape) {
        for (const line of describeShape(body)) log('shape', true, line);
        log('shape', true, { clean: Array.from(herText).length, raw: Array.from(turn.rawTurn || turn.text).length, n: parts.length || 1 });   // 去掉附注后几个字 / 原来几个字 / 这一轮她发了几条
        if (cfg.debugShape >= 2) {
          // 日志每个字段最多 40 个字，骨架切成几段记
          const { head, tail } = skeleton(turn.text);
          const cut40 = (s, pre) => Object.fromEntries((Array.from(s).join('').match(/[\s\S]{1,40}/gu) || []).map((x, k) => [pre + (k + 1), x]));
          log('skel', true, cut40(head, 'h'));
          if (tail) log('skel', true, cut40(tail, 't'));
        }
      }
      if (cfg.nowEnabled && cfg.xinchaoUrl) {
        const now = await xc.heartbeatAndNow();
        let gate;
        if (clientGone) return;
        if (!now) {
          // 心潮没回，照常转发
        } else if (!(gate = gateCheck(now)).ok) {
          // 0.1.12：写明哪条规则、第几行挡的（不带内容），好对着查是哪一行
          log('now-attach', 'skip', { why: 'gate', rule: gate.rule, line: gate.line });
        } else if (!state.shouldAttachNow(now.digest, gap)) {
          log('now-attach', 'skip', { why: 'throttled' });
        } else {
          const nowText = ownBody(cfg.aiSeesNumbers ? now.text : hideNumbers(now.text));   // 0.1.15：AI_SEES_NUMBERS=false 时把数换成说法；身体那行写明是 TA 自己的
          outBody = Buffer.from(JSON.stringify(injectNow(body, nowText)));
          state.markAttached(now.digest);
          attachedNow = nowText;
          log('now-attach', true, { chars: nowText.length, nums: cfg.aiSeesNumbers ? undefined : 'hidden' });
        }
      }
    }

    // 0.1.14：TA 调完工具再发的那一次，把她那句附上的此刻再带上（不然 TA 写回复时看不到；Aru 存的记录里没有此刻）
    if (!isHer && turn.kind === 'tool' && body && cfg.nowEnabled) {
      const p = state.pendingTool;
      if (p && p.now && clock() - p.at <= PENDING_TOOL_MAX_MS) {
        outBody = Buffer.from(JSON.stringify(injectNow(body, p.now)));
        log('now-attach', true, { chars: p.now.length, again: 1 });
      }
    }

    // ---------- 转发给上游 ----------
    const upGroup = ch || upstreamFor(path);
    let target;
    try { target = new URL(upGroup.url + path.slice(3) + url.search); } catch {
      sendJson(res, 500, { error: { message: 'bad UPSTREAM_URL' } }); return;
    }
    const mod = target.protocol === 'https:' ? https : http;
    const upReq = mod.request(target, {
      method: req.method,
      headers: upstreamHeaders(req, outBody ? outBody.length : null, format, upGroup),
      signal: upstreamAbort.signal,
    });

    upReq.on('error', (e) => {
      if (clientGone) return;
      log('upstream', false, { path, why: e.code || 'error', ms: Date.now() - t0 });
      sendJson(res, 502, { error: { message: 'upstream unreachable', type: 'gateway_error' } });
    });

    upReq.on('response', (up) => {
      const headers = {};
      for (const [k, v] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
      res.writeHead(up.statusCode || 502, headers);
      const isSse = /text\/event-stream/i.test(String(up.headers['content-type'] || ''));
      if (isSse) res.flushHeaders();

      const ok2xx = (up.statusCode || 0) >= 200 && (up.statusCode || 0) < 300;
      const wantReply = !!format && ok2xx && (isHer || turn.kind === 'tool');
      const collector = wantReply && isSse ? makeStreamCollector(format) : null;
      const jsonParts = [];
      let jsonSize = 0;

      up.on('data', (chunk) => {
        res.write(chunk); // 原样、立刻
        if (collector) collector.push(chunk);
        else if (wantReply && jsonSize < COLLECT_CAP) { jsonParts.push(chunk); jsonSize += chunk.length; }
      });
      up.on('end', () => {
        res.end();
        log('request', ok2xx, { path, ch: ch ? ch.name : undefined, status: up.statusCode, ms: Date.now() - t0, stream: isSse ? 1 : 0 });
        if (!wantReply || clientGone) return;
        let final;
        if (collector) final = collector.end();
        else {
          if (jsonSize >= COLLECT_CAP) return;
          try { final = finalFromJson(JSON.parse(Buffer.concat(jsonParts).toString('utf8')), format); } catch { return; }
        }
        afterReply(final);
      });
      up.on('error', () => { if (!res.writableEnded) res.destroy(); });
    });

    function afterReply(final) {
      // ---------- 第 3 根线：回传 ----------
      // 0.1.14：TA 用「说话的工具」（REPLY_TOOLS，默认 Aru 的 generateVoice）说的话也算回话。
      // 只调了这类工具 = 这一轮说完了（Aru 不会接着发，要等她回话），马上回传；还调了别的工具 = 照旧等工具走完，说过的先记着。
      const { said, other } = replyToolText(final.tools, cfg.replyTools);
      if (said.length) log('reply-tool', true, { n: said.length, chars: said.join('').length });
      const joined = (list) => [final.text, ...list].map((x) => String(x || '').trim()).filter(Boolean).join('\n');
      if (final.toolCall && other) {
        if (isHer) state.pendingTool = { her: herText, gap, at: clock(), said: [], now: attachedNow };
        const p = state.pendingTool;
        if (p) { if (final.text && final.text.trim()) p.said.push(final.text.trim()); p.said.push(...said); }
        log('event', 'wait', { why: 'tool-calls' });
        return;
      }
      if (isHer) { maybeSendEvent(herText, joined(said), gap); return; }
      if (turn.kind === 'tool') {
        // 工具调用走完了：把她那句和最后的回复配成一轮回传。
        // 0.1.3 起不再要求记录里她那句跟当时一字不差：Aru 每次往她那句里塞的东西都不一样，一比就对不上（测试反馈 ca3e）。
        // 她说了新的一句会换掉 pendingTool，所以 15 分钟内走完的工具回合就算这一轮的。
        const p = state.pendingTool;
        if (!p) { log('event', 'skip', { why: 'tool-no-pending' }); return; }
        state.pendingTool = null;
        if (clock() - p.at > PENDING_TOOL_MAX_MS) { log('event', 'skip', { why: 'tool-expired' }); return; }
        maybeSendEvent(p.her, [...p.said, joined(said)].filter(Boolean).join('\n'), p.gap);
      }
    }

    upReq.end(outBody || undefined);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      log('request', false, { why: 'internal' });
      sendJson(res, 500, { error: { message: 'gateway internal error' } });
    });
  });

  return {
    server,
    state,
    listen(port = cfg.port, host = cfg.host) {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    async close() {
      await Promise.allSettled([...background]);
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
    /** 等后台回传全部做完（测试用）。 */
    async settle() { await Promise.allSettled([...background]); },
  };
}
