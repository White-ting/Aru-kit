// 测试 1、2、8、9，以及 healthz / models / 413 / App 断开。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fakeUpstream, fakeXinchao, startGateway, call, chatBody, waitFor, sleep,
  OPENAI_REPLY_BYTES, GW_KEY, UP_KEY, XC_TOKEN,
} from './helpers.mjs';
import { VERSION, BUILD } from '../lib/version.mjs';

test('1 非流式：内容一字不差；心潮收到心跳、now、exchange，exchange 里没有此刻块', async () => {
  const up = await fakeUpstream();
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    const r = await call(g.base, '/v1/chat/completions', { body: chatBody('我回来啦') });
    assert.equal(r.status, 200);
    assert.ok(r.body.equals(OPENAI_REPLY_BYTES), 'App 拿到的字节要和上游完全一样');
    await g.gw.settle();
    assert.equal(xc.calls.heartbeat.length, 1);
    assert.match(xc.calls.heartbeat[0].event_id, /^hb-\d{10}-[0-9a-f]+$/);
    assert.equal(xc.calls.now.length, 1);
    assert.equal(xc.calls.event.length, 1);
    const ev = xc.calls.event[0];
    assert.match(ev.event_id, /^gw-\d{10}-[0-9a-f]+$/);
    assert.equal(ev.exchange, '她说：我回来啦\n他回：我在，刚看到你的消息。');
    assert.ok(!ev.exchange.includes('〔心潮·此刻〕'));
    assert.ok(xc.calls.auth.every((a) => a === `Bearer ${XC_TOKEN}`));
    // 上游那边确实附上了
    const lastUp = up.calls[0].json.messages.at(-1).content;
    assert.ok(lastUp.startsWith('我回来啦\n\n〔心潮·此刻〕\n'));
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('1b exchange 截断：她说前 600 字、他回前 900 字', async () => {
  const longReply = '回'.repeat(1200);
  const up = await fakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: longReply }, finish_reason: 'stop' }] }));
  });
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    await call(g.base, '/v1/chat/completions', { body: chatBody('说'.repeat(800)) });
    await g.gw.settle();
    assert.equal(xc.calls.event[0].exchange, `她说：${'说'.repeat(600)}\n他回：${'回'.repeat(900)}`);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('2 流式：每一块原样、按顺序、立刻转给 App；拼好的回复被回传', async () => {
  // 故意把 SSE 的一行、甚至一个汉字的字节切在两块中间
  const full = Buffer.from(
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n'
    + 'data: {"choices":[{"index":0,"delta":{"content":"今晚"}}]}\n\n'
    + 'data: {"choices":[{"index":0,"delta":{"content":"雨好大，"}}]}\n\n'
    + ': keep-alive\n\n'
    + 'data: {"choices":[{"index":0,"delta":{"content":"你那边呢？"},"finish_reason":null}]}\n\n'
    + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
    + 'data: [DONE]\n\n',
  );
  const cuts = [0, 40, 95, 101, 160, 230, 300, full.length];
  const pieces = cuts.slice(1).map((c, i) => full.subarray(cuts[i], c));
  const gotChunk = [];
  let waiter = null;
  const up = await fakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (let i = 0; i < pieces.length; i++) {
      res.write(pieces[i]);
      // 等 App 那头真的收到这一块再发下一块：证明网关没有攒着
      await new Promise((r) => { waiter = r; if (gotChunk.length > i) r(); });
    }
    res.end();
  });
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    let received = Buffer.alloc(0);
    const r = await call(g.base, '/v1/chat/completions', {
      body: chatBody('下雨了', { stream: true }),
      onChunk: (c) => {
        received = Buffer.concat([received, c]);
        // 每收到足够覆盖下一块的字节，就放行上游
        let total = 0;
        for (let i = 0; i < pieces.length; i++) {
          total += pieces[i].length;
          if (received.length >= total && gotChunk.length <= i) gotChunk.push(i);
        }
        if (waiter) waiter();
      },
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.equals(full), 'App 收到的字节流要和上游完全一样');
    assert.equal(gotChunk.length, pieces.length, '每一块都是在上游发下一块之前就到了 App');
    assert.equal(r.headers['content-type'], 'text/event-stream');
    await g.gw.settle();
    assert.equal(xc.calls.event.length, 1);
    assert.equal(xc.calls.event[0].exchange, '她说：下雨了\n他回：今晚雨好大，你那边呢？');
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('2b 流式没有 [DONE]、连接直接结束：也回传', async () => {
  const up = await fakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"index":0,"delta":{"content":"好"}}]}\n\n');
  });
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    await call(g.base, '/v1/chat/completions', { body: chatBody('在吗', { stream: true }) });
    await g.gw.settle();
    assert.equal(xc.calls.event[0].exchange, '她说：在吗\n他回：好');
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('8 口令：没带、带错都回 401；上游收到的是 UPSTREAM_KEY', async () => {
  const up = await fakeUpstream();
  const g = await startGateway({ upstreamUrl: up.url, overrides: { NOW_ENABLED: 'false', EVENT_ENABLED: 'false' } });
  try {
    const none = await call(g.base, '/v1/chat/completions', { key: null, body: chatBody('hi') });
    assert.equal(none.status, 401);
    const wrong = await call(g.base, '/v1/chat/completions', { key: 'nope', body: chatBody('hi') });
    assert.equal(wrong.status, 401);
    const models = await call(g.base, '/v1/models', { method: 'GET', key: 'nope' });
    assert.equal(models.status, 401);
    assert.equal(up.calls.length, 0, '口令不对时根本不碰上游');
    const ok = await call(g.base, '/v1/chat/completions', { body: chatBody('hi') });
    assert.equal(ok.status, 200);
    assert.equal(up.calls[0].headers.authorization, `Bearer ${UP_KEY}`);
    assert.ok(!JSON.stringify(up.calls[0].headers).includes(GW_KEY), 'App 的那串不能带给上游');
  } finally { await g.close(); await up.close(); }
});

test('9 上游回 500：App 也收到 500 和同样的内容；不回传', async () => {
  const errBody = '{"error":{"message":"upstream boom","type":"server_error"}}';
  const up = await fakeUpstream((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json', 'x-request-id': 'r-9' });
    res.end(errBody);
  });
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    const r = await call(g.base, '/v1/chat/completions', { body: chatBody('hi') });
    assert.equal(r.status, 500);
    assert.equal(r.body.toString(), errBody);
    assert.equal(r.headers['x-request-id'], 'r-9');
    await g.gw.settle();
    assert.equal(xc.calls.event.length, 0);
    // 429 也一样原样转
    up.calls.length = 0;
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('GET /healthz 不要口令；GET /v1/models 原样转给上游', async () => {
  const modelsBody = '{"object":"list","data":[{"id":"m1","object":"model"}]}';
  const up = await fakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(modelsBody);
  });
  const g = await startGateway({ upstreamUrl: up.url });
  try {
    const h = await call(g.base, '/healthz', { method: 'GET', key: null });
    assert.equal(h.status, 200);
    assert.deepEqual(JSON.parse(h.body), { ok: true, version: VERSION, build: BUILD, by: 'White-ting' });
    const m = await call(g.base, '/v1/models?limit=5', { method: 'GET' });
    assert.equal(m.status, 200);
    assert.equal(m.body.toString(), modelsBody);
    assert.equal(up.calls[0].method, 'GET');
    assert.equal(up.calls[0].url, '/v1/models?limit=5');
    assert.equal(up.calls[0].headers.authorization, `Bearer ${UP_KEY}`);
  } finally { await g.close(); await up.close(); }
});

test('请求体超过上限回 413，不碰上游', async () => {
  const up = await fakeUpstream();
  const g = await startGateway({ upstreamUrl: up.url, overrides: { MAX_BODY_MB: '0.001', NOW_ENABLED: 'false', EVENT_ENABLED: 'false' } });
  try {
    const r = await call(g.base, '/v1/chat/completions', { body: chatBody('长'.repeat(2000)) });
    assert.equal(r.status, 413);
    assert.equal(up.calls.length, 0);
  } finally { await g.close(); await up.close(); }
});

test('App 中途断开：网关也断开上游；不回传', async () => {
  let upRes;
  const up = await fakeUpstream((req, res) => {
    upRes = res;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"一"}}]}\n\n');
    // 之后不再发，等着被断开
  });
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    const ac = new AbortController();
    const p = call(g.base, '/v1/chat/completions', {
      body: chatBody('嗯', { stream: true }), signal: ac.signal, onChunk: () => ac.abort(),
    }).catch((e) => e);
    await p;
    const closed = await waitFor(() => up.calls[0] && up.calls[0].aborted, 2000);
    assert.ok(closed, '上游的连接应该被断开');
    await sleep(50);
    await g.gw.settle();
    assert.equal(xc.calls.event.length, 0);
    upRes?.destroy();
  } finally { await g.close(); await up.close(); await xc.close(); }
});
