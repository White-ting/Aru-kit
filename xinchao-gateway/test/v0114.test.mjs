// 0.1.14：Aru 语音条（测试者 11-22 DEBUG_SHAPE=3 日志）。
//   TA 一轮 = 思考 + 一小段字 + 调 generateVoice{text}；Aru 不接着发，等她回话时一条 user 里放「语音回执 + <environment> + 她的话」。
//   以前见到回执就整条当工具回合：不附此刻、不回传。现在：回执旁边有她的字算她说话；generateVoice 的 text 算 TA 的回话；真的工具续接那次再带上此刻。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeUpstream, fakeXinchao, startGateway, call, DEFAULT_NOW } from './helpers.mjs';

const BLOCK = `\n\n〔心潮·此刻〕\n${DEFAULT_NOW.text}`;
const VOICE1 = '我在呢，刚刚在想你今天累不累';
const VOICE2 = '那早点睡，明天我叫你起床';
const ENV = '<environment>\nCurrent time: 2026-11-22 09:50\nbattery=87\n</environment>';
const RECEIPT = '已生成语音「voice_20261122_0950_a.mp3」。';
const QUIET = { EVENT_MIN_INTERVAL_MIN: '0', EVENT_MAX_PER_HOUR: '100' };

const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
function sse(text, tools = []) {
  const out = [ev({ type: 'message_start', message: { id: 'm', content: [] } })];
  let i = 0;
  if (text) {
    out.push(ev({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }));
    out.push(ev({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text } }));
    out.push(ev({ type: 'content_block_stop', index: i })); i++;
  }
  for (const [name, input] of tools) {
    const j = JSON.stringify(input), half = Math.floor(j.length / 2);
    out.push(ev({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: 'tu' + i, name, input: {} } }));
    out.push(ev({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: j.slice(0, half) } }));
    out.push(ev({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: j.slice(half) } }));
    out.push(ev({ type: 'content_block_stop', index: i })); i++;
  }
  out.push(ev({ type: 'message_delta', delta: { stop_reason: tools.length ? 'tool_use' : 'end_turn' } }));
  out.push(ev({ type: 'message_stop' }));
  return out;
}
function upstreamQueue(list) {
  let n = 0;
  return fakeUpstream(async (req, res) => {
    const parts = list[Math.min(n++, list.length - 1)];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const s of parts) res.write(s);
    res.end();
  });
}
const body = (messages) => ({ model: 'claude-x', max_tokens: 512, stream: true, system: '你是他。', messages });
const turn1 = [{ role: 'user', content: '在吗' }];
const turn2 = [...turn1,
  { role: 'assistant', content: [{ type: 'text', text: '（发了一条语音）' }, { type: 'tool_use', id: 'tu1', name: 'generateVoice', input: { text: VOICE1 } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: RECEIPT }, { type: 'text', text: ENV }, { type: 'text', text: '<sent_at 2026-11-22 09:52>今天好累' }] },
];

test('语音一来一回：只调 generateVoice 就算这一轮说完了，马上回传（语音的话在「他回」里）；她回话那条（回执+环境+她的话）算她说话、附此刻、回传她的话', async () => {
  const up = await upstreamQueue([sse('（发了一条语音）', [['generateVoice', { text: VOICE1 }]]), sse('（发了一条语音）', [['generateVoice', { text: VOICE2 }]])]);
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, overrides: QUIET });
  try {
    await call(g.base, '/v1/messages', { body: body(turn1) });
    await g.gw.settle();
    assert.equal(xc.calls.event.length, 1);
    assert.equal(xc.calls.event[0].exchange, `她说：在吗\n他回：（发了一条语音）\n${VOICE1}`);
    await call(g.base, '/v1/messages', { body: body(turn2) });
    await g.gw.settle();
    const logs = g.logs.join('\n');
    assert.match(logs, /turn ok kind=her chars=4/);
    assert.doesNotMatch(logs, /event wait/);
    assert.equal((logs.match(/now-attach ok/g) || []).length, 2);
    const last = up.calls[1].json.messages.at(-1).content;
    assert.equal(last[0].type, 'tool_result', '回执还在第一块');
    assert.deepEqual(last.at(-1), { type: 'text', text: BLOCK });
    assert.equal(xc.calls.event[1].exchange, `她说：今天好累\n他回：（发了一条语音）\n${VOICE2}`);
    for (const s of [VOICE1, VOICE2, '今天好累', 'battery']) assert.ok(!logs.includes(s), '日志里不该有：' + s);
    assert.match(logs, /reply-tool ok n=1 chars=/);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('回执旁边只有附注（<environment>），没有她一个字：照旧当工具回合', async () => {
  const up = await upstreamQueue([sse('好')]);
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, overrides: QUIET });
  try {
    const m = [...turn2.slice(0, 2), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: RECEIPT }, { type: 'text', text: ENV }] }];
    await call(g.base, '/v1/messages', { body: body(m) });
    await g.gw.settle();
    const logs = g.logs.join('\n');
    assert.match(logs, /turn ok kind=tool after=annotation/);
    assert.doesNotMatch(logs, /kind=her/);
    assert.equal(xc.calls.now.length, 0);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('真的工具续接（读附件这类）：TA 写回复的那一次也带上她那句的此刻；回传把调工具前说的和最后说的拼起来', async () => {
  const up = await upstreamQueue([sse('我看看', [['readZipAttachmentEntry', { id: 'z1', path: 'a.txt' }]]), sse('看完了，是去年的照片')]);
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, overrides: QUIET });
  try {
    const m1 = [{ role: 'user', content: '帮我看下附件' }];
    await call(g.base, '/v1/messages', { body: body(m1) });
    await g.gw.settle();
    assert.equal(xc.calls.event.length, 0);
    assert.match(g.logs.join('\n'), /event wait why=tool-calls/);
    const m2 = [...m1,
      { role: 'assistant', content: [{ type: 'text', text: '我看看' }, { type: 'tool_use', id: 'tu1', name: 'readZipAttachmentEntry', input: { id: 'z1', path: 'a.txt' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '附件里的字' }] }];
    await call(g.base, '/v1/messages', { body: body(m2) });
    await g.gw.settle();
    const logs = g.logs.join('\n');
    assert.match(logs, /turn ok kind=tool/);
    assert.match(logs, /now-attach ok chars=\d+ again=1/);
    assert.equal(xc.calls.now.length, 1, '续接那次不再去心潮取，用她那句取到的');
    assert.deepEqual(up.calls[1].json.messages.at(-1).content.at(-1), { type: 'text', text: BLOCK });
    assert.equal(xc.calls.event[0].exchange, '她说：帮我看下附件\n他回：我看看\n看完了，是去年的照片');
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('REPLY_TOOLS 留空：generateVoice 当普通工具，照旧等它走完', async () => {
  const up = await upstreamQueue([sse('（发了一条语音）', [['generateVoice', { text: VOICE1 }]])]);
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, overrides: { ...QUIET, REPLY_TOOLS: '' } });
  try {
    await call(g.base, '/v1/messages', { body: body(turn1) });
    await g.gw.settle();
    assert.equal(xc.calls.event.length, 0);
    assert.match(g.logs.join('\n'), /event wait why=tool-calls/);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('非流式也认：generateVoice 的 text 进回传', async () => {
  const reply = JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'generateVoice', input: { text: VOICE1 } }], stop_reason: 'tool_use' });
  const up = await fakeUpstream((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(reply); });
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, overrides: QUIET });
  try {
    await call(g.base, '/v1/messages', { body: { ...body(turn1), stream: false } });
    await g.gw.settle();
    assert.equal(xc.calls.event[0].exchange, `她说：在吗\n他回：${VOICE1}`);
  } finally { await g.close(); await up.close(); await xc.close(); }
});
