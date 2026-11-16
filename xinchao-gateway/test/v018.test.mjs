// 0.1.8：照二号 c12e 的真实日志——工具走完 Aru 再发请求时，工具结果后面又跟一条只有附注的 user 消息
// （roles 末尾 a t u，那条去完附注是 0 个字）。以前被当成 skip why=annotation，这一轮的回传丢了。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeUpstream, fakeXinchao, startGateway, call } from './helpers.mjs';
import { toolBeforeTail } from '../lib/turn.mjs';

const ENV = '<environment>\n地点：家里\n' + '备注'.repeat(300) + '\n</environment>';
const toolCall = (id) => ({ id, type: 'function', function: { name: 'w', arguments: '{}' } });
const base = () => [{ role: 'system', content: '你是他。' }, { role: 'user', content: '早' }, { role: 'assistant', content: '早呀' }];

test('toolBeforeTail：工具结果后面跟着几条 user 才算', () => {
  const o = (...m) => ({ messages: m });
  assert.equal(toolBeforeTail(o({ role: 'assistant', tool_calls: [toolCall('c1')] }, { role: 'tool', content: 'x' }, { role: 'user', content: ENV }), 'openai'), true);
  assert.equal(toolBeforeTail(o({ role: 'tool', content: 'x' }, { role: 'user', content: ENV }, { role: 'user', content: '<sent_at 2026-11-06 22:43>' }), 'openai'), true);
  assert.equal(toolBeforeTail(o({ role: 'assistant', content: '嗯' }, { role: 'user', content: ENV }), 'openai'), false);
  // 0.1.9：中间夹着 system（二号 598c：roles=…tssu）也算；assistant 后面夹 system 不算
  assert.equal(toolBeforeTail(o({ role: 'tool', content: 'x' }, { role: 'system', content: 's1' }, { role: 'system', content: 's2' }, { role: 'user', content: ENV }), 'openai'), true);
  assert.equal(toolBeforeTail(o({ role: 'assistant', content: '嗯' }, { role: 'system', content: 's1' }, { role: 'user', content: ENV }), 'openai'), false);
  assert.equal(toolBeforeTail(o({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] }, { role: 'user', content: ENV }), 'anthropic'), true);
  assert.equal(toolBeforeTail(o({ role: 'user', content: ENV }), 'anthropic'), false);
});

test('OpenAI：她说一句 → TA 连调两次工具（每次后面都跟一条附注）→ 回话：配成一轮回传', async () => {
  let n = 0;
  const up = await fakeUpstream((req, res) => {
    n++;
    res.writeHead(200, { 'content-type': 'application/json' });
    const msg = n < 3 ? { role: 'assistant', content: null, tool_calls: [toolCall('c' + n)] } : { role: 'assistant', content: '带伞吧。' };
    res.end(JSON.stringify({ choices: [{ index: 0, message: msg, finish_reason: n < 3 ? 'tool_calls' : 'stop' }] }));
  });
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, overrides: { DEBUG_SHAPE: '1' } });
  try {
    const m = [...base(), { role: 'user', content: ENV }, { role: 'user', content: '要带伞吗\n\n<sent_at 2026-11-06 22:43>' }];
    await call(g.base, '/v1/chat/completions', { body: { model: 'm1', messages: m } });
    m.push({ role: 'assistant', content: null, tool_calls: [toolCall('c1')] }, { role: 'tool', tool_call_id: 'c1', content: '小雨' }, { role: 'user', content: ENV });
    await call(g.base, '/v1/chat/completions', { body: { model: 'm1', messages: m } });
    m.push({ role: 'assistant', content: null, tool_calls: [toolCall('c2')] }, { role: 'tool', tool_call_id: 'c2', content: '12 度' }, { role: 'system', content: '记忆' }, { role: 'system', content: '提示' }, { role: 'user', content: ENV });
    await call(g.base, '/v1/chat/completions', { body: { model: 'm1', messages: m } });
    await g.gw.settle();
    assert.equal(xc.calls.heartbeat.length, 1, '只有她那句报心跳');
    assert.equal(xc.calls.event.length, 1, '配上了');
    assert.equal(xc.calls.event[0].exchange, '她说：要带伞吗\n他回：带伞吧。');
    const logs = g.logs.join('\n');
    assert.equal((logs.match(/ turn ok kind=tool after=annotation/g) || []).length, 2);
    assert.ok(!/why=annotation/.test(logs));
    assert.ok(!logs.includes('家里') && !logs.includes('要带伞吗'));
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('Anthropic：tool_result 后面跟一条附注，同样配上', async () => {
  let n = 0;
  const up = await fakeUpstream((req, res) => {
    n++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(n === 1
      ? { content: [{ type: 'tool_use', id: 't1', name: 'w', input: {} }], stop_reason: 'tool_use' }
      : { content: [{ type: 'text', text: '带伞吧。' }], stop_reason: 'end_turn' }));
  });
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    const m = [{ role: 'user', content: '早' }, { role: 'assistant', content: '早呀' }, { role: 'user', content: '要带伞吗' }];
    await call(g.base, '/v1/messages', { body: { model: 'm1', max_tokens: 1000, messages: m } });
    m.push({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'w', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '小雨' }] }, { role: 'user', content: ENV });
    await call(g.base, '/v1/messages', { body: { model: 'm1', max_tokens: 1000, messages: m } });
    await g.gw.settle();
    assert.equal(xc.calls.event.length, 1);
    assert.equal(xc.calls.event[0].exchange, '她说：要带伞吗\n他回：带伞吧。');
  } finally { await g.close(); await up.close(); await xc.close(); }
});
