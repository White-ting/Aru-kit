// 小零件的单元测试：取文字、判断回合、SSE 拼接、日志不带正文、配置。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentText, classifyLast, startsWithSkip, makeStreamCollector, finalFromJson } from '../lib/turn.mjs';
import { makeLogger } from '../lib/log.mjs';
import { loadConfig, checkConfig } from '../lib/config.mjs';

test('contentText 认字符串和数组', () => {
  assert.equal(contentText('a'), 'a');
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'image_url', image_url: {} }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(contentText(null), '');
});

test('classifyLast', () => {
  assert.equal(classifyLast({ messages: [{ role: 'user', content: 'x' }] }, 'openai').kind, 'user');
  assert.equal(classifyLast({ messages: [{ role: 'tool', content: 'x' }] }, 'openai').kind, 'tool');
  assert.equal(classifyLast({ messages: [{ role: 'assistant', content: '', tool_calls: [{}] }] }, 'openai').kind, 'tool');
  assert.equal(classifyLast({ messages: [{ role: 'assistant', content: 'x' }] }, 'openai').kind, 'other');
  assert.equal(classifyLast({}, 'openai').kind, 'other');
  assert.equal(classifyLast({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'r' }] }] }, 'anthropic').kind, 'tool');
  assert.equal(startsWithSkip(' 【桥】', ['【']), true);
  assert.equal(startsWithSkip('说【', ['【']), false);
});

test('SSE 拼接：\\r\\n、切开的汉字、多个 choice 只取第 0 个', () => {
  const c = makeStreamCollector('openai');
  const s = Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"你好"}},{"index":1,"delta":{"content":"别"}}]}\r\n\r\ndata: {"choices":[{"index":0,"delta":{"content":"呀"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
  for (let i = 0; i < s.length; i += 7) c.push(s.subarray(i, i + 7));
  const st = c.end();
  assert.equal(st.text, '你好呀');
  assert.equal(st.done, true);
  assert.equal(st.toolCall, false);
});

test('finalFromJson', () => {
  assert.deepEqual(finalFromJson({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }, 'openai'), { text: 'x', toolCall: false });
  assert.equal(finalFromJson({ choices: [{ message: { content: null, tool_calls: [{}] }, finish_reason: 'tool_calls' }] }, 'openai').toolCall, true);
  assert.deepEqual(finalFromJson({ content: [{ type: 'text', text: 'a' }], stop_reason: 'end_turn' }, 'anthropic'), { text: 'a', toolCall: false });
  assert.equal(finalFromJson({ content: [{ type: 'tool_use' }], stop_reason: 'tool_use' }, 'anthropic').toolCall, true);
});

test('日志：字段里的长字符串会被截短、空白被替换，只能放短状态词', () => {
  const lines = [];
  const log = makeLogger({ sink: (l) => lines.push(l) });
  log('event', true, { ms: 12.4, chars: 30, why: 'throttled' });
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT.* event ok ms=12 chars=30 why=throttled$/);
  log('event', 'skip', { why: 'throttled' });
  log('event', 'wait', { why: 'tool-calls' });
  assert.match(lines[1], / event skip why=throttled$/);
  assert.match(lines[2], / event wait why=tool-calls$/);
  log('x', false, { why: '一段 很长 的'.repeat(20) });
  assert.ok(lines[3].length < 120 && lines[3].includes(" x fail "));
});

test('配置默认值和检查', () => {
  const c = loadConfig({ envFile: false, env: {} });
  assert.equal(c.port, 8790);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.xinchaoTimeoutMs, 3000);
  assert.deepEqual(c.skipPrefixes, ['【', '〔心潮念']);
  assert.equal(c.nowEnabled, true);
  assert.equal(c.eventEnabled, true);
  assert.equal(c.onlyStream, false);
  assert.equal(c.maxBodyBytes, 20 * 1024 * 1024);
  assert.ok(checkConfig(c).length >= 2);
  const c2 = loadConfig({ envFile: false, env: { GATEWAY_KEY: 'k', UPSTREAM_URL: 'https://x/v1/', XINCHAO_URL: 'http://127.0.0.1:18110', NOW_ENABLED: 'false' } });
  assert.equal(c2.upstreamUrl, 'https://x/v1');
  assert.equal(c2.nowEnabled, false);
  assert.deepEqual(checkConfig(c2), []);
});
