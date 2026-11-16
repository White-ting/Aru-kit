// 测试用的小工具：假上游、假心潮、起网关、发请求。全是本机 http server。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../lib/server.mjs';
import { loadConfig } from '../lib/config.mjs';
import { makeLogger } from '../lib/log.mjs';

export const GW_KEY = 'gw-key-for-app';
export const UP_KEY = 'up-key-secret';
export const XC_TOKEN = 'xc-token';

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}
function readAll(req) {
  return new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假上游。handler(req, res, bodyBuf) 自己决定怎么回；默认回一个固定的非流式 JSON。 */
export async function fakeUpstream(handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const body = await readAll(req);
    const call = { method: req.method, url: req.url, headers: req.headers, body, json: null, aborted: false };
    try { call.json = JSON.parse(body.toString('utf8')); } catch { /* 不是 JSON */ }
    res.on('close', () => { if (!res.writableFinished) call.aborted = true; });
    calls.push(call);
    if (handler) return handler(req, res, call);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(OPENAI_REPLY_BYTES);
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}/v1`, calls, close: () => closeServer(server) };
}

// 故意带不规则空格和中文，用来检查"一字不差"
export const OPENAI_REPLY_BYTES = Buffer.from(
  '{"id":"x1",  "object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"我在，刚看到你的消息。"},"finish_reason":"stop"}]}\n',
);

export const DEFAULT_NOW = { ok: true, text: '她今天来过 3 次\n刚才有点想她', lines: 2, digest: 'dg-1' };

/** 假心潮。opts.now 可以是对象或函数；opts.delayMs 让每个请求都慢；opts.status 让它报错。 */
export async function fakeXinchao(opts = {}) {
  const calls = { heartbeat: [], now: [], event: [], auth: [] };
  const server = http.createServer(async (req, res) => {
    const body = await readAll(req);
    calls.auth.push(req.headers.authorization);
    if (opts.delayMs) await sleep(opts.delayMs);
    if (res.destroyed) return;
    if (opts.status) { res.writeHead(opts.status); res.end('{}'); return; }
    let json = null;
    try { json = JSON.parse(body.toString('utf8')); } catch { /* */ }
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && req.url === '/v1/heartbeat') { calls.heartbeat.push(json); return send({ ok: true }); }
    if (req.method === 'GET' && req.url === '/v1/now') {
      calls.now.push(true);
      const n = typeof opts.now === 'function' ? opts.now() : (opts.now || DEFAULT_NOW);
      return send(n);
    }
    if (req.method === 'POST' && req.url === '/v1/conversation-event') { calls.event.push(json); return send({ ok: true }); }
    res.writeHead(404); res.end();
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, calls, close: () => closeServer(server), opts };
}

function closeServer(server) {
  server.closeAllConnections?.();
  return new Promise((r) => server.close(() => r()));
}

/** 一个现在没在用的端口（用来模拟"心潮没开"）。 */
export async function deadPort() {
  const s = http.createServer();
  const port = await listen(s);
  await closeServer(s);
  return `http://127.0.0.1:${port}`;
}

/** 起一个网关。clock 是可控的假时钟：{ t, now(), advance(ms) }。 */
export async function startGateway({ upstreamUrl, xinchaoUrl, overrides = {}, clock, stateDir } = {}) {
  const dir = stateDir || fs.mkdtempSync(path.join(os.tmpdir(), 'xcgw-'));
  const cfg = loadConfig({
    envFile: false,
    env: {},
    overrides: {
      GATEWAY_KEY: GW_KEY, UPSTREAM_URL: upstreamUrl, UPSTREAM_KEY: UP_KEY,
      XINCHAO_URL: xinchaoUrl || '', XINCHAO_TOKEN: XC_TOKEN, XINCHAO_TIMEOUT_MS: '3000',
      STATE_DIR: dir, ...overrides,
    },
  });
  const logs = [];
  const gw = createGateway({ cfg, clock: clock ? () => clock.t : undefined, log: makeLogger({ sink: (l) => logs.push(l) }) });
  const addr = await gw.listen(0, '127.0.0.1');
  return { gw, cfg, logs, dir, base: `http://127.0.0.1:${addr.port}`, close: () => gw.close() };
}

export function makeClock(start = Date.UTC(2026, 10, 4, 8, 0, 0)) {
  return { t: start, advance(ms) { this.t += ms; } };
}
export const MIN = 60 * 1000;

/**
 * 发一个请求给网关，收原始字节。onChunk(buf, i) 每到一块就调一次。
 * 返回 { status, headers, body: Buffer, chunks: Buffer[] }。
 */
export function call(base, pathname, { method = 'POST', key = GW_KEY, body, headers = {}, onChunk, signal } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers };
    if (key) h.authorization = `Bearer ${key}`;
    if (data) { h['content-type'] = 'application/json'; h['content-length'] = data.length; }
    const req = http.request(base + pathname, { method, headers: h, signal }, (res) => {
      const chunks = [];
      res.on('data', (c) => { chunks.push(c); if (onChunk) onChunk(c, chunks.length - 1); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), chunks }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(data || undefined);
  });
}

export function chatBody(text, extra = {}) {
  return {
    model: 'm1',
    messages: [
      { role: 'system', content: '你是他。' },
      { role: 'user', content: '早' },
      { role: 'assistant', content: '早呀' },
      { role: 'user', content: text },
    ],
    ...extra,
  };
}

/** 等到条件成立（最多 ms 毫秒）。 */
export async function waitFor(fn, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(10); }
  return fn();
}
