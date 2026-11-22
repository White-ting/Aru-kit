// 0.1.13：DEBUG_SHAPE=3（0.1.14 起这条语音样本算她说话） 记最后几条消息每一块是什么（查语音条被当成工具回合），不记内容、不记工具字段的值。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeUpstream, fakeXinchao, startGateway, call } from './helpers.mjs';
import { describeTail } from '../lib/turn.mjs';

const SECRET = '只有她知道的悄悄话';
const VOICE = '今晚想你了，早点睡';
// 猜的样子：TA 调语音工具，下一条里回执和她的新话在一起
const voiceBody = () => ({
  model: 'm', stream: true, max_tokens: 1000,
  messages: [
    { role: 'user', content: '在吗' },
    { role: 'assistant', content: [{ type: 'text', text: '在' }, { type: 'tool_use', id: 'tu1', name: 'send_voice_message', input: { text: VOICE, emotion: 'soft', speed: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: '语音已发送' }] }, { type: 'text', text: `<sent_at 2026-11-22 00:10>${SECRET}` }] },
  ],
});

test('describeTail：每块的类型、工具名、字段名和字数、回执；最后一条有骨架', () => {
  const rows = describeTail(voiceBody(), 'anthropic');
  assert.deepEqual(rows[0], { at: -3, r: 'u', b1: 'text:2' });
  assert.deepEqual(rows[1], { at: -2, r: 'a', b1: 'text:1', b2: 'use:send_voice_message', 'f1.1': 'text=9', 'f1.2': 'emotion=4', 'f1.3': 'speed=number' });
  assert.deepEqual(rows[2], { at: -1, r: 'u', b1: 'res:text5', b2: 'text:35' });
  assert.ok(rows[3].sk1.startsWith('·5⏎|⏎<sent_at'), rows[3].sk1);
  assert.match(rows[3].sk1, /<sent_at/);
});

test('describeTail：openai 格式的工具调用和工具结果', () => {
  const rows = describeTail({ messages: [
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'speak', arguments: JSON.stringify({ text: VOICE }) } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ] }, 'openai');
  assert.equal(rows[0].b1, 'use:speak');
  assert.equal(rows[0]['f1.1'], 'text=9');
  assert.equal(rows[1].b1, 'res:text:2');
});

test('DEBUG_SHAPE=3：记 msg 行；日志里没有她的话、没有语音内容；2 和不开都没有 msg 行', async () => {
  for (const level of ['3', '2', '']) {
    const up = await fakeUpstream();
    const xc = await fakeXinchao();
    const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, overrides: level ? { DEBUG_SHAPE: level } : {} });
    try {
      await call(g.base, '/v1/messages', { body: voiceBody() });
      await g.gw.settle();
      const logs = g.logs.join('\n');
      assert.match(logs, /turn ok kind=her/, '0.1.14：回执旁边有她的字，算她说话');
      assert.equal(/ msg ok /.test(logs), level === '3');
      if (level === '3') assert.match(logs, / msg ok at=-2 r=a b1=text:1 b2=use:send_voice_message f1\.1=text=9/);
      for (const s of [SECRET, VOICE, '悄悄', '想你', '语音已发送', 'soft']) assert.ok(!logs.includes(s), s);
    } finally { await g.close(); await up.close(); await xc.close(); }
  }
});
