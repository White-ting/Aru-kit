// 0.1.2 追加：按格式分上游（ANTHROPIC_UPSTREAM_URL / ANTHROPIC_UPSTREAM_KEY）。
// 比如 DeepSeek（OpenAI 格式、钥匙）和 Claude 订阅（Anthropic 格式、透传）混着用，节流共用一份。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fakeUpstream, fakeXinchao, startGateway, call, chatBody, makeClock, MIN, DEFAULT_NOW, GW_KEY, UP_KEY, XC_TOKEN,
} from './helpers.mjs';
import { loadConfig, checkConfig } from '../lib/config.mjs';

const SUB = 'sub-oauth-FAKE-credential-split-42';
const ANT_KEY = 'ant-key-for-B-fake';
const VER = '2023-06-01';
const BLOCK = `\n\n〔心潮·此刻〕\n${DEFAULT_NOW.text}`;
const ANT_REPLY = '{"id":"m","type":"message","role":"assistant","content":[{"type":"text","text":"嗯，我在。"}],"stop_reason":"end_turn"}';

function msgBody(content) {
  return {
    model: 'claude-x', max_tokens: 1024,
    messages: [{ role: 'user', content: '早' }, { role: 'assistant', content: '早呀' }, { role: 'user', content }],
  };
}
function antUpstream() {
  return fakeUpstream((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(ANT_REPLY); });
}
function assertCleanLogs(g, extra = []) {
  const all = g.logs.join('\n');
  for (const bad of [GW_KEY, SUB, UP_KEY, ANT_KEY, XC_TOKEN, ...extra]) assert.ok(!all.includes(bad), `日志里出现了：${bad}\n${all}`);
  return all;
}

test('S1 混着用：OpenAI 格式到上游 A（换成 A 的钥匙），Anthropic 格式到上游 B（透传）；路径、请求头各自都对', async () => {
  const A = await fakeUpstream();
  const B = await antUpstream();
  const xc = await fakeXinchao();
  const g = await startGateway({
    upstreamUrl: A.url, xinchaoUrl: xc.url,
    overrides: { ANTHROPIC_UPSTREAM_URL: B.url, ANTHROPIC_UPSTREAM_KEY: 'passthrough' },
  });
  try {
    // OpenAI 那组不是透传：请求头口令照旧能用
    const r1 = await call(g.base, '/v1/chat/completions', { body: chatBody('一') });
    assert.equal(r1.status, 200);
    // Anthropic 那组透传：只认路径口令，订阅凭证原样
    const r2 = await call(g.base, `/${GW_KEY}/v1/messages?beta=true`, {
      key: null, headers: { authorization: `Bearer ${SUB}`, 'anthropic-version': VER, 'anthropic-beta': 'fake-beta' },
      body: msgBody('二'),
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.toString(), ANT_REPLY);
    // OpenAI 那组也认路径口令
    const r3 = await call(g.base, `/${GW_KEY}/v1/models`, { method: 'GET', key: 'whatever-app-sends' });
    assert.equal(r3.status, 200);

    assert.equal(A.calls.length, 2);
    assert.equal(B.calls.length, 1);
    assert.equal(A.calls[0].url, '/v1/chat/completions');
    assert.equal(A.calls[0].headers.authorization, `Bearer ${UP_KEY}`);
    assert.equal(A.calls[1].url, '/v1/models');
    assert.equal(A.calls[1].headers.authorization, `Bearer ${UP_KEY}`);
    assert.equal(B.calls[0].url, '/v1/messages?beta=true');
    assert.equal(B.calls[0].headers.authorization, `Bearer ${SUB}`);
    assert.equal(B.calls[0].headers['anthropic-beta'], 'fake-beta');
    assert.equal(B.calls[0].headers['x-api-key'], undefined);
    assert.ok(!JSON.stringify(B.calls[0].headers).includes(UP_KEY), 'A 的钥匙没跑到 B 那里');
    assert.ok(!JSON.stringify(A.calls[0].headers).includes(SUB));
    await g.gw.settle();
    assertCleanLogs(g, ['whatever-app-sends']);
  } finally { await g.close(); await A.close(); await B.close(); await xc.close(); }
});

test('S2 混着用：节流是一份。第一句（OpenAI）附了此刻，5 分钟后第二句（Anthropic）同一个此刻就不再附；回传也共用节流', async () => {
  const A = await fakeUpstream();
  const B = await antUpstream();
  const xc = await fakeXinchao();
  const clock = makeClock();
  const g = await startGateway({
    upstreamUrl: A.url, xinchaoUrl: xc.url, clock,
    overrides: { ANTHROPIC_UPSTREAM_URL: B.url, ANTHROPIC_UPSTREAM_KEY: 'passthrough', NOW_REPEAT_MIN: '30' },
  });
  try {
    await call(g.base, '/v1/chat/completions', { body: chatBody('一') });
    assert.equal(A.calls[0].json.messages.at(-1).content, '一' + BLOCK, '第一句附了');
    await g.gw.settle();
    assert.equal(xc.calls.event.length, 1);

    clock.advance(5 * MIN);
    await call(g.base, `/${GW_KEY}/v1/messages`, { key: null, headers: { authorization: `Bearer ${SUB}`, 'anthropic-version': VER }, body: msgBody('二') });
    assert.equal(B.calls[0].json.messages.at(-1).content, '二', '换了格式、换了上游，节流照样算：不附');
    await g.gw.settle();
    assert.equal(xc.calls.heartbeat.length, 2, '心跳两句都报');
    assert.equal(xc.calls.event.length, 1, '回传 5 分钟内不再发（至少隔 8 分钟）');

    clock.advance(91 * MIN);
    await call(g.base, `/${GW_KEY}/v1/messages`, { key: null, headers: { authorization: `Bearer ${SUB}`, 'anthropic-version': VER }, body: msgBody('三') });
    assert.equal(B.calls[1].json.messages.at(-1).content, '三' + BLOCK, '隔了 90 分钟以上一定附');
    await g.gw.settle();
    assert.equal(xc.calls.event.length, 2);
    assert.equal(xc.calls.event[1].exchange, '她说：三\n他回：嗯，我在。');
    assert.match(assertCleanLogs(g), / now-attach skip why=throttled/);
  } finally { await g.close(); await A.close(); await B.close(); await xc.close(); }
});

test('S3 门禁按组：去透传那组的只认路径口令；去钥匙那组的两种都认', async () => {
  const A = await fakeUpstream();
  const B = await antUpstream();
  const xc = await fakeXinchao();
  const g = await startGateway({
    upstreamUrl: A.url, xinchaoUrl: xc.url,
    overrides: { ANTHROPIC_UPSTREAM_URL: B.url, ANTHROPIC_UPSTREAM_KEY: 'passthrough' },
  });
  try {
    // /v1/messages 去透传那组：请求头里的口令不认
    const a = await call(g.base, '/v1/messages', { key: GW_KEY, body: msgBody('嗨') });
    assert.equal(a.status, 401);
    const b = await call(g.base, '/v1/messages', { key: null, headers: { 'x-api-key': GW_KEY }, body: msgBody('嗨') });
    assert.equal(b.status, 401);
    const c = await call(g.base, '/wrong-key-x/v1/messages', { key: null, headers: { authorization: `Bearer ${SUB}` }, body: msgBody('嗨') });
    assert.equal(c.status, 401);
    assert.equal(B.calls.length, 0);
    // /v1/chat/completions 去钥匙那组：请求头口令错了是 401，对了能过
    const d = await call(g.base, '/v1/chat/completions', { key: 'nope-nope', body: chatBody('嗨') });
    assert.equal(d.status, 401);
    assert.equal(A.calls.length, 0);
    const e = await call(g.base, '/v1/chat/completions', { body: chatBody('嗨') });
    assert.equal(e.status, 200);
    assert.equal(A.calls.length, 1);
    await g.gw.settle();
    assertCleanLogs(g, ['wrong-key-x', 'nope-nope']);
  } finally { await g.close(); await A.close(); await B.close(); await xc.close(); }
});

test('S4 反过来也行：默认那组透传，Anthropic 那组用自己的钥匙（换成 x-api-key）', async () => {
  const A = await fakeUpstream();
  const B = await antUpstream();
  const xc = await fakeXinchao();
  const g = await startGateway({
    upstreamUrl: A.url, xinchaoUrl: xc.url,
    overrides: { UPSTREAM_KEY: 'passthrough', ANTHROPIC_UPSTREAM_URL: B.url, ANTHROPIC_UPSTREAM_KEY: ANT_KEY },
  });
  try {
    // Anthropic 那组不是透传：请求头口令能用，上游收到的是 ANT_KEY
    const a = await call(g.base, '/v1/messages', { key: null, headers: { 'x-api-key': GW_KEY, 'anthropic-version': VER }, body: msgBody('嗨') });
    assert.equal(a.status, 200);
    assert.equal(B.calls[0].headers['x-api-key'], ANT_KEY);
    assert.equal(B.calls[0].headers.authorization, undefined);
    assert.equal(B.calls[0].headers['anthropic-version'], VER);
    // Anthropic 的其他子路径（比如数 token）也走 B
    const t = await call(g.base, `/${GW_KEY}/v1/messages/count_tokens`, { key: null, headers: { 'x-api-key': 'app-junk' }, body: msgBody('嗨') });
    assert.equal(t.status, 200);
    assert.equal(B.calls[1].url, '/v1/messages/count_tokens');
    assert.equal(B.calls[1].headers['x-api-key'], ANT_KEY);
    // 默认那组透传：只认路径口令
    const b = await call(g.base, '/v1/chat/completions', { body: chatBody('嗨') });
    assert.equal(b.status, 401);
    const c = await call(g.base, `/${GW_KEY}/v1/chat/completions`, { key: SUB, body: chatBody('嗨') });
    assert.equal(c.status, 200);
    assert.equal(A.calls.length, 1);
    assert.equal(A.calls[0].headers.authorization, `Bearer ${SUB}`);
    await g.gw.settle();
    assertCleanLogs(g, ['app-junk']);
  } finally { await g.close(); await A.close(); await B.close(); await xc.close(); }
});

test('S5 不填 ANTHROPIC_UPSTREAM_*：跟以前一样，/v1/messages 也走 UPSTREAM_URL', async () => {
  const A = await antUpstream();
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: A.url, xinchaoUrl: xc.url });
  try {
    const r = await call(g.base, '/v1/messages', { key: null, headers: { 'x-api-key': GW_KEY }, body: msgBody('嗨') });
    assert.equal(r.status, 200);
    assert.equal(A.calls[0].url, '/v1/messages');
    assert.equal(A.calls[0].headers['x-api-key'], UP_KEY);
    await g.gw.settle();
  } finally { await g.close(); await A.close(); await xc.close(); }
});

test('S6 配置：两项要一起填；只有 Anthropic 那组透传时，GATEWAY_KEY 也要能放进地址', () => {
  const base = { GATEWAY_KEY: 'abc123', UPSTREAM_URL: 'https://a.example/v1', UPSTREAM_KEY: 'sk-a', XINCHAO_URL: 'http://127.0.0.1:1' };
  const ok = loadConfig({ envFile: false, env: {}, overrides: { ...base, ANTHROPIC_UPSTREAM_URL: 'https://b.example/v1/', ANTHROPIC_UPSTREAM_KEY: 'passthrough' } });
  assert.deepEqual(checkConfig(ok), []);
  assert.equal(ok.anthropicUpstreamUrl, 'https://b.example/v1');
  assert.equal(ok.anthropicPassthrough, true);
  assert.equal(ok.passthrough, false);
  const noKey = loadConfig({ envFile: false, env: {}, overrides: { ...base, ANTHROPIC_UPSTREAM_URL: 'https://b.example/v1' } });
  assert.match(checkConfig(noKey).join(), /ANTHROPIC_UPSTREAM_KEY/);
  const noUrl = loadConfig({ envFile: false, env: {}, overrides: { ...base, ANTHROPIC_UPSTREAM_KEY: 'passthrough' } });
  assert.match(checkConfig(noUrl).join(), /ANTHROPIC_UPSTREAM_URL/);
  const badGk = loadConfig({ envFile: false, env: {}, overrides: { ...base, GATEWAY_KEY: 'a b/c', ANTHROPIC_UPSTREAM_URL: 'https://b.example/v1', ANTHROPIC_UPSTREAM_KEY: 'passthrough' } });
  assert.match(checkConfig(badGk).join(), /GATEWAY_KEY/);
  const badGkNoPt = loadConfig({ envFile: false, env: {}, overrides: { ...base, GATEWAY_KEY: 'a b/c' } });
  assert.deepEqual(checkConfig(badGkNoPt), [], '没有透传的组时，GATEWAY_KEY 照旧随便写');
});
