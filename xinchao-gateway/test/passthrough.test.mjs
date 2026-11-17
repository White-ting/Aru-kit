// 0.1.2 透传模式（UPSTREAM_KEY=passthrough）和路径口令 /<GATEWAY_KEY>/v1/...
// 只用假上游、假心潮，不连真的服务。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fakeUpstream, fakeXinchao, startGateway, call, chatBody, DEFAULT_NOW, GW_KEY, UP_KEY, XC_TOKEN,
} from './helpers.mjs';
import { loadConfig, checkConfig } from '../lib/config.mjs';

const SUB = 'sub-oauth-FAKE-credential-7f3a9c'; // 假订阅凭证
const BETA = 'oauth-fake-beta-1,another-beta-2';
const VER = '2023-06-01';
const BLOCK = `\n\n〔心潮·此刻〕\n${DEFAULT_NOW.text}`;
const PT = { UPSTREAM_KEY: 'passthrough' };

function msgBody(content, extra = {}) {
  return {
    model: 'claude-x', max_tokens: 1024, system: '你是他。',
    messages: [{ role: 'user', content: '早' }, { role: 'assistant', content: '早呀' }, { role: 'user', content }],
    ...extra,
  };
}

/** 日志里找不到口令、凭证（每个测试最后都查一次）。 */
function assertCleanLogs(g, extra = []) {
  const all = g.logs.join('\n');
  for (const bad of [GW_KEY, SUB, UP_KEY, XC_TOKEN, ...extra]) {
    assert.ok(!all.includes(bad), `日志里出现了不该有的：${bad}\n${all}`);
  }
  return all;
}

test('P1 透传·非流式（Anthropic）：authorization、anthropic-*、?beta=true 原样到上游；路径里没有口令；两根线照常', async () => {
  const reply = '{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"我在。"}],"stop_reason":"end_turn"}';
  const up = await fakeUpstream((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(reply); });
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, overrides: PT });
  try {
    const r = await call(g.base, `/${GW_KEY}/v1/messages?beta=true`, {
      key: null,
      headers: { authorization: `Bearer ${SUB}`, 'anthropic-beta': BETA, 'anthropic-version': VER, 'anthropic-dangerous-direct-browser-access': 'true' },
      body: msgBody('晚安'),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.toString(), reply);
    assert.equal(up.calls.length, 1);
    const u = up.calls[0];
    assert.equal(u.url, '/v1/messages?beta=true');
    assert.ok(!u.url.includes(GW_KEY));
    assert.equal(u.headers.authorization, `Bearer ${SUB}`);
    assert.equal(u.headers['x-api-key'], undefined, '没带 x-api-key 就不凭空加');
    assert.equal(u.headers['anthropic-beta'], BETA);
    assert.equal(u.headers['anthropic-version'], VER);
    assert.equal(u.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.ok(!JSON.stringify(u.headers).includes(UP_KEY));
    assert.ok(!JSON.stringify(u.headers).includes(GW_KEY));
    // 两根线
    assert.equal(u.json.messages.at(-1).content, '晚安' + BLOCK);
    await g.gw.settle();
    assert.equal(xc.calls.heartbeat.length, 1);
    assert.equal(xc.calls.event.length, 1);
    assert.equal(xc.calls.event[0].exchange, '她说：晚安\n他回：我在。');
    assert.ok(xc.calls.auth.every((a) => a === `Bearer ${XC_TOKEN}`), '找心潮用的还是 XINCHAO_TOKEN');
    const all = assertCleanLogs(g);
    assert.match(all, / turn ok kind=her /);
    assert.match(all, / request ok path=\/v1\/messages status=200 /);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('P1b 透传：App 用 x-api-key 带凭证的，也原样带过去', async () => {
  const up = await fakeUpstream((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"content":[{"type":"text","text":"嗯"}]}'); });
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, overrides: PT });
  try {
    const r = await call(g.base, `/${GW_KEY}/v1/messages`, { key: null, headers: { 'x-api-key': SUB, 'anthropic-version': VER }, body: msgBody('在吗') });
    assert.equal(r.status, 200);
    assert.equal(up.calls[0].headers['x-api-key'], SUB);
    assert.equal(up.calls[0].headers.authorization, undefined);
    assert.equal(up.calls[0].url, '/v1/messages');
    await g.gw.settle();
    assertCleanLogs(g);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('P2 透传·流式（Anthropic）：SSE 原样转，回复拼对，回传', async () => {
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","content":[]}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"雨停"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"了。"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const up = await fakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const s of sse) { res.write(s); await new Promise((r) => setTimeout(r, 5)); }
    res.end();
  });
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, overrides: PT });
  try {
    const r = await call(g.base, `/${GW_KEY}/v1/messages?beta=true`, {
      key: null, headers: { authorization: `Bearer ${SUB}`, 'anthropic-beta': BETA, 'anthropic-version': VER },
      body: msgBody('雨停了吗', { stream: true }),
    });
    assert.equal(r.body.toString(), sse.join(''));
    assert.equal(up.calls[0].headers.authorization, `Bearer ${SUB}`);
    assert.equal(up.calls[0].url, '/v1/messages?beta=true');
    assert.equal(up.calls[0].json.messages.at(-1).content, '雨停了吗' + BLOCK);
    await g.gw.settle();
    assert.equal(xc.calls.event[0].exchange, '她说：雨停了吗\n他回：雨停了。');
    assert.match(assertCleanLogs(g), / stream=1/);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('P3 透传·OpenAI 格式：authorization 原样带过去，也能用', async () => {
  const up = await fakeUpstream();
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, overrides: PT });
  try {
    const r = await call(g.base, `/${GW_KEY}/v1/chat/completions`, { key: SUB, body: chatBody('今天好累') });
    assert.equal(r.status, 200);
    assert.equal(up.calls[0].url, '/v1/chat/completions');
    assert.equal(up.calls[0].headers.authorization, `Bearer ${SUB}`);
    assert.equal(up.calls[0].json.messages.at(-1).content, '今天好累' + BLOCK);
    await g.gw.settle();
    assert.equal(xc.calls.event.length, 1);
    // /v1/models 这种别的接口也照样透传
    const m = await call(g.base, `/${GW_KEY}/v1/models`, { method: 'GET', key: SUB });
    assert.equal(m.status, 200);
    assert.equal(up.calls[1].url, '/v1/models');
    assert.equal(up.calls[1].headers.authorization, `Bearer ${SUB}`);
    assertCleanLogs(g);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('P4 透传：路径口令错了、没带、只在请求头里带，都是 401，上游一个请求都没收到', async () => {
  const up = await fakeUpstream();
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, overrides: PT });
  const WRONG = 'wrong-path-key-zzz';
  try {
    const h = { authorization: `Bearer ${SUB}`, 'anthropic-version': VER };
    const cases = [
      [`/${WRONG}/v1/messages`, { key: null, headers: h }],
      ['/v1/messages', { key: null, headers: h }],
      ['/v1/messages', { key: GW_KEY }], // 口令放在请求头里：透传模式不认
      ['/v1/messages', { key: null, headers: { 'x-api-key': GW_KEY } }],
      [`/${GW_KEY.slice(0, -1)}/v1/messages`, { key: null, headers: h }], // 差一个字
      [`/${WRONG}/v1/chat/completions`, { key: SUB }],
    ];
    for (const [p, o] of cases) {
      const r = await call(g.base, p, { ...o, body: msgBody('嗨') });
      assert.equal(r.status, 401, p);
    }
    assert.equal(up.calls.length, 0, '上游一个请求都没收到');
    assert.equal(xc.calls.heartbeat.length, 0, '也没去找心潮');
    const all = assertCleanLogs(g, [WRONG, GW_KEY.slice(0, -1)]);
    assert.match(all, / auth fail path=\/\*\*\*\/v1\/messages status=401/);
    assert.match(all, / auth fail path=\/v1\/messages status=401/);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('P5 普通模式下用路径口令：能过，上游收到的是 UPSTREAM_KEY，不是 App 带的；请求头口令照旧能用', async () => {
  const up = await fakeUpstream();
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    const r = await call(g.base, `/${GW_KEY}/v1/chat/completions?x=1`, { key: 'something-the-app-put-here', body: chatBody('嗨') });
    assert.equal(r.status, 200);
    assert.equal(up.calls[0].url, '/v1/chat/completions?x=1');
    assert.equal(up.calls[0].headers.authorization, `Bearer ${UP_KEY}`);
    const a = await call(g.base, `/${GW_KEY}/v1/messages`, { key: null, headers: { 'x-api-key': 'app-side-junk' }, body: msgBody('嗨') });
    assert.equal(a.status, 200);
    assert.equal(up.calls[1].headers['x-api-key'], UP_KEY);
    assert.equal(up.calls[1].headers.authorization, undefined);
    // 原来的请求头口令
    const b = await call(g.base, '/v1/chat/completions', { body: chatBody('嗨') });
    assert.equal(b.status, 200);
    assert.equal(up.calls[2].headers.authorization, `Bearer ${UP_KEY}`);
    // 路径口令错了：就算请求头口令是对的也不放（写了路径口令就按路径口令算）
    const c = await call(g.base, '/not-the-key/v1/chat/completions', { body: chatBody('嗨') });
    assert.equal(c.status, 401);
    assert.equal(up.calls.length, 3);
    await g.gw.settle();
    // 普通模式下 UPSTREAM_KEY 本来就不会进日志；App 带来的东西也不会
    assertCleanLogs(g, ['something-the-app-put-here', 'app-side-junk', 'not-the-key']);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('P6 /healthz 不要口令；/<口令>/healthz 也给看；/<错的>/healthz 回 401', async () => {
  for (const overrides of [PT, {}]) {
    const up = await fakeUpstream();
    const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: 'http://127.0.0.1:9', overrides });
    try {
      const a = await call(g.base, '/healthz', { method: 'GET', key: null });
      assert.equal(a.status, 200);
      assert.equal(JSON.parse(a.body).version, '0.1.11');
      const b = await call(g.base, `/${GW_KEY}/healthz`, { method: 'GET', key: null });
      assert.equal(b.status, 200);
      const c = await call(g.base, '/nope/healthz', { method: 'GET', key: null });
      assert.equal(c.status, 401);
      assert.equal(up.calls.length, 0);
      assertCleanLogs(g, ['nope']);
    } finally { await g.close(); await up.close(); }
  }
});

test('P7 配置：UPSTREAM_KEY=passthrough 打开透传；透传模式下 GATEWAY_KEY 不能有地址里放不下的字', () => {
  const base = { GATEWAY_KEY: 'abc123', UPSTREAM_URL: 'https://up.example/v1', XINCHAO_URL: 'http://127.0.0.1:1' };
  const c1 = loadConfig({ envFile: false, env: {}, overrides: { ...base, UPSTREAM_KEY: 'passthrough' } });
  assert.equal(c1.passthrough, true);
  assert.deepEqual(checkConfig(c1), []);
  const c2 = loadConfig({ envFile: false, env: {}, overrides: { ...base, UPSTREAM_KEY: 'sk-real' } });
  assert.equal(c2.passthrough, false);
  const c3 = loadConfig({ envFile: false, env: {}, overrides: { ...base, GATEWAY_KEY: 'a/b c', UPSTREAM_KEY: 'passthrough' } });
  assert.equal(checkConfig(c3).length, 1);
  assert.match(checkConfig(c3)[0], /GATEWAY_KEY/);
});
