// 0.1.5：DEBUG_SHAPE=2 记她那句话的骨架（看附注怎么写的），不漏内容。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeUpstream, fakeXinchao, startGateway, call, chatBody } from './helpers.mjs';
import { skeleton } from '../lib/turn.mjs';

test('skeleton：标签名照写、属性值遮掉、文字只留字数', () => {
  const s = skeleton('<environment place="杭州家里" t=20:10>\n天气小雨 温度12度\n</environment>\n\n今天好累呀');
  assert.equal(s.head, '<environment ·5="·4" ·1=·2:·2>⏎·4 ·5⏎</environment>⏎⏎·5', '0.1.6 起标签里只留标签名');
  assert.equal(s.tail, '');
  assert.equal(skeleton('[sent_at: 20:10] 你好').head, '[·4_·2: ·2:·2] ·2', '不是 <> 的标签也只留字数');
});

test('DEBUG_SHAPE=2：日志多 skel 几行，里面没有她的话、没有附注内容；=1 时没有 skel', async () => {
  const msg = '<environment>\n地点：西湖边的家\n天气：小雨\n' + '备注'.repeat(200) + '\n</environment>\n\n<sent_at>2026-11-06 20:10</sent_at>\n\n今天加班好累';
  for (const lv of ['2', '1']) {
    const up = await fakeUpstream();
    const xc = await fakeXinchao();
    const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, overrides: { DEBUG_SHAPE: lv } });
    try {
      await call(g.base, '/v1/chat/completions', { body: chatBody(msg) });
      await g.gw.settle();
      const logs = g.logs.join('\n');
      assert.equal(/ skel ok /.test(logs), lv === '2');
      for (const w of ['西湖', '小雨', '备注', '加班', '地点', '天气'])   // 日志行首本来就有时间，日期数字不拿来查 assert.ok(!logs.includes(w), `日志里不该有「${w}」`);
      if (lv === '2') {
        const sk = g.logs.filter((l) => / skel ok /.test(l)).map((l) => l.split(' skel ok ')[1].replace(/(^| )[ht]\d+=/g, '')).join('');
        assert.ok(sk.startsWith('<environment>⏎·2：·5⏎'), sk);
        assert.ok(sk.includes('</environment>⏎⏎<sent_at>·4-·2-·2_·2:·2</sent_at>⏎⏎·6'), sk);
      }
    } finally { await g.close(); await up.close(); await xc.close(); }
  }
});
