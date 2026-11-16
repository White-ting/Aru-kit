// 第二阶段：Anthropic 格式 POST /v1/messages。另外检查日志里没有正文、钥匙、口令。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeUpstream, fakeXinchao, startGateway, call, DEFAULT_NOW, GW_KEY, UP_KEY, XC_TOKEN } from './helpers.mjs';

const BLOCK = `\n\n〔心潮·此刻〕\n${DEFAULT_NOW.text}`;

function msgBody(content, extra = {}) {
  return {
    model: 'claude-x', max_tokens: 512, system: '你是他。',
    messages: [
      { role: 'user', content: '早' },
      { role: 'assistant', content: '早呀' },
      { role: 'user', content },
    ],
    ...extra,
  };
}

test('A1 非流式：x-api-key 认口令；上游收到 x-api-key=UPSTREAM_KEY；字节一字不差；附此刻；回传', async () => {
  const reply = '{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"我在。"}],"stop_reason":"end_turn"}';
  const up = await fakeUpstream((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(reply); });
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    const sent = msgBody([{ type: 'text', text: '晚安', cache_control: { type: 'ephemeral' } }]);
    const r = await call(g.base, '/v1/messages', { key: null, headers: { 'x-api-key': GW_KEY, 'anthropic-version': '2023-06-01' }, body: sent });
    assert.equal(r.status, 200);
    assert.equal(r.body.toString(), reply);
    const u = up.calls[0];
    assert.equal(u.url, '/v1/messages');
    assert.equal(u.headers['x-api-key'], UP_KEY);
    assert.equal(u.headers.authorization, undefined);
    assert.equal(u.headers['anthropic-version'], '2023-06-01');
    assert.deepEqual(u.json.messages.slice(0, -1), sent.messages.slice(0, -1));
    assert.deepEqual(u.json.messages.at(-1).content, [...sent.messages[2].content, { type: 'text', text: BLOCK }]);
    assert.equal(u.json.system, '你是他。');
    await g.gw.settle();
    assert.equal(xc.calls.event[0].exchange, '她说：晚安\n他回：我在。');
    const bad = await call(g.base, '/v1/messages', { key: null, headers: { 'x-api-key': 'nope' }, body: sent });
    assert.equal(bad.status, 401);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('A2 流式：原样转；text_delta 拼起来回传', async () => {
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
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    const r = await call(g.base, '/v1/messages', { body: msgBody('雨停了吗', { stream: true }) });
    assert.equal(r.body.toString(), sse.join(''));
    assert.equal(up.calls[0].json.messages.at(-1).content, '雨停了吗' + BLOCK);
    await g.gw.settle();
    assert.equal(xc.calls.event[0].exchange, '她说：雨停了吗\n他回：雨停了。');
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('A3 tool_result 回合不算她说话；stop_reason: tool_use 不回传', async () => {
  const up = await fakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'tool_use', id: 't1', name: 'w', input: {} }], stop_reason: 'tool_use' }));
  });
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    const toolRound = msgBody([{ type: 'tool_result', tool_use_id: 't0', content: '小雨' }]);
    await call(g.base, '/v1/messages', { body: toolRound });
    assert.deepEqual(up.calls[0].json, toolRound);
    assert.equal(xc.calls.heartbeat.length, 0);
    await call(g.base, '/v1/messages', { body: msgBody('天气？') });
    await g.gw.settle();
    assert.equal(xc.calls.heartbeat.length, 1);
    assert.equal(xc.calls.event.length, 0);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('日志里没有正文、没有钥匙和口令；只有步骤、成败、耗时、字数', async () => {
  const up = await fakeUpstream();
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    const secretText = '这是她的私房话不能进日志';
    await call(g.base, '/v1/chat/completions', { body: { model: 'm', messages: [{ role: 'user', content: secretText }] } });
    await call(g.base, '/v1/chat/completions', { key: 'wrong-key-zzz', body: { model: 'm', messages: [] } });
    await g.gw.settle();
    const all = g.logs.join('\n');
    assert.ok(g.logs.length >= 5, all);
    for (const bad of [secretText, '私房话', GW_KEY, UP_KEY, XC_TOKEN, 'wrong-key-zzz', DEFAULT_NOW.text, '我在，刚看到你的消息']) {
      assert.ok(!all.includes(bad), `日志里出现了不该有的：${bad}`);
    }
    assert.match(all, / heartbeat ok /);
    assert.match(all, / now-attach ok chars=\d+/);
    assert.match(all, / event ok /);
    assert.match(all, / auth fail /);
  } finally { await g.close(); await up.close(); await xc.close(); }
});
