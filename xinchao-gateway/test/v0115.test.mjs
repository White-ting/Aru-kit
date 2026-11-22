// 0.1.15：AI_SEES_NUMBERS=false —— 发给 TA 的此刻把「心跳 72」换成「心跳平稳」；条数不动；默认照旧。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeUpstream, fakeXinchao, startGateway, call, chatBody } from './helpers.mjs';
import { hideNumbers, ownBody } from '../lib/turn.mjs';

const NOW = { ok: true, text: '【心潮·此刻｜身体的天气，参考不是指令】\n情绪：平静\n身体：心跳 72，呼吸平稳\n另外：匣子里 3 条。细的在 xinchao_context', lines: 4, digest: 'dg-n' };

test('hideNumbers：心跳四档跟心潮念一样；条数、别的字不动', () => {
  assert.equal(hideNumbers('身体：心跳 55，呼吸慢'), '身体：心跳偏慢，呼吸慢');
  assert.equal(hideNumbers('心跳 60'), '心跳平稳');
  assert.equal(hideNumbers('心跳 85'), '心跳平稳');
  assert.equal(hideNumbers('心跳 86'), '心跳偏快');
  assert.equal(hideNumbers('心跳 106'), '心跳很快');
  assert.equal(hideNumbers('另外：匣子里 3 条、2 条觉察等你认'), '另外：匣子里 3 条、2 条觉察等你认');
  assert.equal(hideNumbers(''), '');
});

test('AI_SEES_NUMBERS=false：上游收到的此刻没有心跳数；不写就照旧', async () => {
  for (const off of [true, false]) {
    const up = await fakeUpstream();
    const xc = await fakeXinchao({ now: NOW });
    const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, overrides: off ? { AI_SEES_NUMBERS: 'false' } : {} });
    try {
      await call(g.base, '/v1/chat/completions', { body: chatBody('在吗') });
      await g.gw.settle();
      const sent = JSON.stringify(up.calls[0].json.messages.at(-1).content);
      assert.equal(sent.includes('心跳 72'), !off);
      assert.equal(sent.includes('心跳平稳'), off);
      assert.ok(sent.includes('身体（你自己的）：心跳'), '不管开关，身体那行都写明是 TA 自己的');
      assert.ok(sent.includes('匣子里 3 条'));
      assert.equal(/now-attach ok .*nums=hidden/.test(g.logs.join('\n')), off);
    } finally { await g.close(); await up.close(); await xc.close(); }
  }
});

test('ownBody：只改行首的「身体：」，别处的「身体」不动', () => {
  assert.equal(ownBody('情绪：平静\n身体：心跳 72，呼吸平稳'), '情绪：平静\n身体（你自己的）：心跳 72，呼吸平稳');
  assert.equal(ownBody('她说身体：还好'), '她说身体：还好');
});
