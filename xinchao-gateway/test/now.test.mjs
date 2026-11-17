// 测试 3、4、5：附"此刻"、硬门、节流。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fakeUpstream, fakeXinchao, startGateway, call, chatBody, makeClock, MIN, DEFAULT_NOW,
} from './helpers.mjs';
import { passesGate, gateCheck } from '../lib/turn.mjs';

const BLOCK = `\n\n〔心潮·此刻〕\n${DEFAULT_NOW.text}`;

test('3 附此刻：最后一条用户消息末尾有此刻块，前面的消息一个字都没改', async () => {
  const up = await fakeUpstream();
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    const sent = chatBody('今天好累', { temperature: 0.7 });
    await call(g.base, '/v1/chat/completions', { body: sent });
    const got = up.calls[0].json;
    assert.deepEqual(got.messages.slice(0, -1), sent.messages.slice(0, -1));
    assert.equal(got.messages.at(-1).role, 'user');
    assert.equal(got.messages.at(-1).content, '今天好累' + BLOCK);
    assert.equal(got.temperature, 0.7);
    assert.equal(got.model, 'm1');
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('3b content 是数组：末尾加一个 text 块，图片原样保留', async () => {
  const up = await fakeUpstream();
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    const img = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } };
    const sent = chatBody('x');
    sent.messages[3] = { role: 'user', content: [{ type: 'text', text: '看这张' }, img] };
    await call(g.base, '/v1/chat/completions', { body: sent });
    const got = up.calls[0].json;
    assert.deepEqual(got.messages.slice(0, -1), sent.messages.slice(0, -1));
    assert.deepEqual(got.messages.at(-1).content, [{ type: 'text', text: '看这张' }, img, { type: 'text', text: BLOCK }]);
    await g.gw.settle();
    assert.equal(xc.calls.event[0].exchange.split('\n')[0], '她说：看这张');
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('4 硬门（单元）', () => {
  const ok = { ok: true, text: '想她\n她说过 12 句', lines: 2, digest: 'a' };
  assert.equal(passesGate(ok), true);
  assert.equal(passesGate({ ...ok, ok: false }), false);
  assert.equal(passesGate({ ...ok, ok: 'true' }), false);
  assert.equal(passesGate({ ...ok, lines: 9 }), false);
  assert.equal(passesGate({ ...ok, lines: 0 }), false);
  assert.equal(passesGate({ ...ok, text: '' }), false);
  assert.equal(passesGate({ ...ok, text: '想'.repeat(401) }), false);
  assert.equal(passesGate({ ...ok, text: '想念 0.5' }), false);
  assert.equal(passesGate({ ...ok, text: 'possess 高' }), false);
  assert.equal(passesGate({ ...ok, text: 'drive_x 高' }), false);
  assert.equal(passesGate({ ...ok, text: '想念 abcde 正常' }), true, '5 个字母不算');
  assert.equal(passesGate({ ...ok, text: '可以看 xinchao_context，3 条新消息' }), true, 'xinchao_context 和 3条 是允许的');
  assert.equal(passesGate({ ...ok, text: '第 1.2 次' }), false);
  assert.equal(passesGate(null), false);
});

test('0.1.12 硬门：黑匣子编号、xinchao_ 工具名放行；挡下时说清规则和第几行', () => {
  // 照心潮念 4.2 context-envelope.js 那行的写法；编号照 black-box.js 的格式（box-时间36进制-6位随机）
  const box = '情绪：平静\n另外：匣子里 2 条（1 条要提醒你：box-mwjcto3u-khyqtd、box-mwjd0a1b-qzpxmn；办完了 burn 掉才会消）。细的在 xinchao_context';
  assert.deepEqual(gateCheck({ ok: true, text: box, lines: 2 }), { ok: true });
  assert.equal(passesGate({ ok: true, text: '你想提醒自己的：9/14 的信（xinchao_box read box-1）', lines: 1 }), true);
  // 编号去掉了，别的键名照样挡，而且说得出是第几行
  assert.deepEqual(gateCheck({ ok: true, text: box + '\n念头：有个关于「possess」的念头一直在绕', lines: 3 }), { ok: false, rule: 'word', line: 3 });
  assert.deepEqual(gateCheck({ ok: true, text: '想她\n想念值 0.5', lines: 2 }), { ok: false, rule: 'decimal', line: 2 });
  assert.equal(passesGate({ ok: true, text: '另外：notebox-abcdefg', lines: 1 }), false, 'box- 前面连着字母的不算编号');
  assert.deepEqual(gateCheck({ ok: true, text: '想她', lines: 9 }), { ok: false, rule: 'lines' });
  assert.deepEqual(gateCheck({ ok: false }), { ok: false, rule: 'not-ok' });
});

test('0.1.12 硬门（经过网关）：带黑匣子编号的此刻附得上；挡下时日志写规则和行号、不带内容', async () => {
  const boxText = '情绪：平静\n另外：匣子里 1 条（1 条要提醒你：box-mwjcto3u-khyqtd；办完了 burn 掉才会消）。细的在 xinchao_context';
  for (const [text, attached] of [[boxText, true], [boxText + '\n念头：有个关于「possess」的念头一直在绕', false]]) {
    const up = await fakeUpstream();
    const xc = await fakeXinchao({ now: { ...DEFAULT_NOW, text, lines: text.split('\n').length } });
    const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
    try {
      await call(g.base, '/v1/chat/completions', { body: chatBody('嗨') });
      const last = up.calls[0].json.messages.at(-1).content;
      assert.equal(last.includes('box-mwjcto3u-khyqtd'), attached);
      const logs = g.logs.join('\n');
      if (!attached) {
        assert.match(logs, / now-attach skip why=gate rule=word line=3/);
        assert.ok(!logs.includes('possess') && !logs.includes('box-'));
      }
    } finally { await g.close(); await up.close(); await xc.close(); }
  }
});

for (const [name, now] of [
  ['ok:false', { ...DEFAULT_NOW, ok: false }],
  ['超过 8 行', { ...DEFAULT_NOW, lines: 9 }],
  ['带 0.5 这种小数', { ...DEFAULT_NOW, text: '想念值 0.5' }],
  ['带 possess 这种英文键名', { ...DEFAULT_NOW, text: 'possess: 高' }],
]) {
  test(`4 硬门（经过网关）：${name} 时不附`, async () => {
    const up = await fakeUpstream();
    const xc = await fakeXinchao({ now });
    const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
    try {
      const sent = chatBody('嗨');
      const r = await call(g.base, '/v1/chat/completions', { body: sent });
      assert.equal(r.status, 200);
      assert.equal(xc.calls.now.length, 1);
      assert.deepEqual(up.calls[0].json, sent, '上游收到的跟 App 发的完全一样');
    } finally { await g.close(); await up.close(); await xc.close(); }
  });
}

test('5 节流（NOW_REPEAT_MIN=30）：同一个 digest 30 分钟内第二次不附；隔 90 分钟以上一定附；digest 变了就附', async () => {
  const up = await fakeUpstream();
  let now = { ...DEFAULT_NOW };
  const xc = await fakeXinchao({ now: () => now });
  const clock = makeClock();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, clock, overrides: { NOW_REPEAT_MIN: '30' } });
  const lastContent = (i) => up.calls[i].json.messages.at(-1).content;
  try {
    await call(g.base, '/v1/chat/completions', { body: chatBody('一') });
    assert.ok(lastContent(0).endsWith(BLOCK), '第一次附');

    clock.advance(5 * MIN);
    await call(g.base, '/v1/chat/completions', { body: chatBody('二') });
    assert.equal(lastContent(1), '二', '同一个 digest、5 分钟后：不附');

    clock.advance(20 * MIN);
    await call(g.base, '/v1/chat/completions', { body: chatBody('三') });
    assert.equal(lastContent(2), '三', '同一个 digest、距上次附 25 分钟：还是不附');

    clock.advance(6 * MIN); // 距上次附 31 分钟
    await call(g.base, '/v1/chat/completions', { body: chatBody('四') });
    assert.ok(lastContent(3).endsWith(BLOCK), '超过 30 分钟：附');

    clock.advance(2 * MIN);
    now = { ...DEFAULT_NOW, digest: 'dg-2', text: '又有点想她' };
    await call(g.base, '/v1/chat/completions', { body: chatBody('五') });
    assert.ok(lastContent(4).endsWith('又有点想她'), 'digest 变了：附');

    clock.advance(1 * MIN);
    await call(g.base, '/v1/chat/completions', { body: chatBody('六') });
    assert.equal(lastContent(5), '六', 'dg-2 1 分钟后：不附');

    clock.advance(91 * MIN); // 她 91 分钟没说话
    await call(g.base, '/v1/chat/completions', { body: chatBody('七') });
    assert.ok(lastContent(6).endsWith('又有点想她'), '隔了 90 分钟以上：同一个 digest 也一定附');
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('5b 节流状态存在 STATE_DIR，重启后还在', async () => {
  const up = await fakeUpstream();
  const xc = await fakeXinchao();
  const clock = makeClock();
  const g1 = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, clock, overrides: { NOW_REPEAT_MIN: '30' } });
  try {
    await call(g1.base, '/v1/chat/completions', { body: chatBody('一') });
    await g1.close();
    clock.advance(3 * MIN);
    const g2 = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, clock, stateDir: g1.dir, overrides: { NOW_REPEAT_MIN: '30' } });
    try {
      await call(g2.base, '/v1/chat/completions', { body: chatBody('二') });
      assert.equal(up.calls[1].json.messages.at(-1).content, '二', '重启后仍记得刚附过');
    } finally { await g2.close(); }
  } finally { await up.close(); await xc.close(); }
});

test('NOW_ENABLED=false：不心跳、不附，但照样回传', async () => {
  const up = await fakeUpstream();
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, overrides: { NOW_ENABLED: 'false' } });
  try {
    const sent = chatBody('嗨');
    await call(g.base, '/v1/chat/completions', { body: sent });
    await g.gw.settle();
    assert.equal(xc.calls.heartbeat.length, 0);
    assert.equal(xc.calls.now.length, 0);
    assert.deepEqual(up.calls[0].json, sent);
    assert.equal(xc.calls.event.length, 1);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('5c 默认（0.1.3，NOW_REPEAT_MIN=0）：每一轮都附，同一个 digest 也附；不往前面的消息里加', async () => {
  const up = await fakeUpstream();
  const xc = await fakeXinchao();
  const clock = makeClock();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, clock });
  try {
    assert.equal(g.cfg.nowRepeatMin, 0);
    for (const [i, w] of ['一', '二', '三'].entries()) {
      clock.advance(1 * MIN);
      const b = chatBody(w);
      await call(g.base, '/v1/chat/completions', { body: b });
      const sent = up.calls[i].json.messages;
      assert.ok(sent.at(-1).content.startsWith(w) && sent.at(-1).content.endsWith(DEFAULT_NOW.text), `第 ${i + 1} 句附了`);
      assert.deepEqual(sent.slice(0, -1), b.messages.slice(0, -1), '前面的消息一个字都没动');
    }
    assert.doesNotMatch(g.logs.join('\n'), /now-attach skip why=throttled/);
  } finally { await g.close(); await up.close(); await xc.close(); }
});
