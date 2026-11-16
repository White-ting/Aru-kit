// 0.1.3：DEBUG_SHAPE 只记她那句话的结构，不记正文。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeUpstream, fakeXinchao, startGateway, call, chatBody } from './helpers.mjs';
import { describeShape } from '../lib/turn.mjs';

test('describeShape：块、段、前几条、标签', () => {
  const [a, b] = describeShape({
    messages: [
      { role: 'system', content: '你是他。' },
      { role: 'user', content: '<ctx t="1">九点</ctx>\n\n早' },
      { role: 'assistant', content: '早呀' },
      { role: 'user', content: [{ type: 'text', text: '<ctx>九点半</ctx>\n\n<memory>她怕冷</memory>\n\n今天好累' }, { type: 'image_url', image_url: { url: 'x' } }] },
    ],
  });
  assert.deepEqual(a, { msgs: 4, sys: 4, parts: '42,image_url', segs: '14,20,4' });
  assert.equal(b.hist, '22');
  assert.equal(b.tags, 'ctx,memory');
});

test('DEBUG_SHAPE=1：日志多一行 shape，里面没有她的话、没有标签里的内容；不开就没有这一行', async () => {
  const secret = '只有她知道的一句悄悄话';
  const body = chatBody(`<ctx>${secret}</ctx>\n\n今天好累`);
  for (const on of [true, false]) {
    const up = await fakeUpstream();
    const xc = await fakeXinchao();
    const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, overrides: on ? { DEBUG_SHAPE: '1' } : {} });
    try {
      await call(g.base, '/v1/chat/completions', { body });
      await g.gw.settle();
      const logs = g.logs.join('\n');
      assert.equal(/ shape ok /.test(logs), on);
      assert.ok(!logs.includes('悄悄话') && !logs.includes('今天好累'));
      if (on) assert.match(logs, / shape ok .*tags=ctx/);
    } finally { await g.close(); await up.close(); await xc.close(); }
  }
});
