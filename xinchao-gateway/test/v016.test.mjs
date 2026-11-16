// 0.1.6：照二号 b71a 的真实日志——<sent_at 2026-11-06 21:46> 是只有开头的单个标签、接在她的话后面；
// 带环境时 Aru 拆成两条：先是她的话，再单独一条 <environment>…</environment>。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeUpstream, fakeXinchao, startGateway, call } from './helpers.mjs';
import { stripAnnotations, skeleton, tailUserTexts } from '../lib/turn.mjs';

const ENV = '<environment>\n地点：家里\n天气：小雨，' + '备注'.repeat(300) + '\n</environment>';
const body = (...users) => ({ model: 'm1', messages: [
  { role: 'system', content: '你是他。' }, { role: 'user', content: '早' }, { role: 'assistant', content: '早呀' },
  ...users.map((c) => ({ role: 'user', content: c })),
] });

test('单个标签 <sent_at 时间> 去掉；骨架里标签只留名字', () => {
  assert.equal(stripAnnotations('今天好累\n\n<sent_at 2026-11-06 21:46>'), '今天好累');
  assert.equal(stripAnnotations('<sent_at 2026-11-06 21:46>', '*', false), '');
  assert.equal(skeleton('你好\n\n<sent_at 2026-11-06 21:46>').head, '·2⏎⏎<sent_at ·4-·2-·2 ·2:·2>');
  assert.deepEqual(tailUserTexts(body('一', '二'), 'openai'), ['一', '二']);
  assert.deepEqual(tailUserTexts({ messages: [{ role: 'assistant', content: 'x' }] }, 'openai'), []);
});

test('她的话一条、环境另一条：回传只有她的话；shape clean=她的字数 n=1', async () => {
  const up = await fakeUpstream();
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, overrides: { DEBUG_SHAPE: '1' } });
  try {
    await call(g.base, '/v1/chat/completions', { body: body('今天好累\n\n<sent_at 2026-11-06 21:46>', ENV) });
    await g.gw.settle();
    assert.equal(xc.calls.heartbeat.length, 1);
    assert.equal(xc.calls.event.length, 1);
    assert.match(xc.calls.event[0].exchange, /^她说：今天好累\n他回：/);
    const logs = g.logs.join('\n');
    assert.match(logs, / turn ok kind=her chars=4/);
    assert.match(logs, / shape ok clean=4 raw=\d{3,} n=1/);
    assert.ok(!logs.includes('家里') && !logs.includes('今天好累'));
    const sent = up.calls[0].json.messages;
    assert.ok(sent.at(-2).content === '今天好累\n\n<sent_at 2026-11-06 21:46>' && sent.at(-1).content.startsWith(ENV), '发给模型的原样');
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('这一轮只有附注、没有她一个字：不算她说话（kind=skip why=annotation），不报心跳、不回传', async () => {
  const up = await fakeUpstream();
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    await call(g.base, '/v1/chat/completions', { body: body(ENV) });
    await call(g.base, '/v1/chat/completions', { body: body('<sent_at 2026-11-06 21:50>') });
    await g.gw.settle();
    assert.equal(xc.calls.heartbeat.length, 0);
    assert.equal(xc.calls.event.length, 0);
    assert.equal((g.logs.join('\n').match(/ turn ok kind=skip why=annotation/g) || []).length, 2);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('桥递来的消息后面跟着 <sent_at …>、或者另起一条环境：照样认成 skip', async () => {
  const up = await fakeUpstream();
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    await call(g.base, '/v1/chat/completions', { body: body('【小屋桥·留话】她说想你了\n\n<sent_at 2026-11-06 21:55>') });
    await call(g.base, '/v1/chat/completions', { body: body('〔心潮念 · 动态桥〕这是她在心潮小屋里做的事', ENV) });
    await g.gw.settle();
    assert.equal(xc.calls.heartbeat.length, 0);
    assert.equal((g.logs.join('\n').match(/ turn ok kind=skip/g) || []).length, 2);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('0.1.7 调试：DEBUG_SHAPE 开着时每个用户回合（她说的、跳过的）都记一行 tail：谁发的、每条去附注前后几个字；不记内容', async () => {
  const up = await fakeUpstream();
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, overrides: { DEBUG_SHAPE: '1' } });
  try {
    await call(g.base, '/v1/chat/completions', { body: body('今天好累\n\n<sent_at 2026-11-06 21:46>', ENV) });
    await call(g.base, '/v1/chat/completions', { body: body(ENV) });
    const logs = g.logs.join('\n');
    assert.match(logs, / tail ok roles=suauu lens=\d+>4,\d+>0\n.* turn ok kind=her/);
    assert.match(logs, / tail ok roles=suau lens=\d+>0\n.* turn ok kind=skip why=annotation/);
    assert.ok(!logs.includes('家里') && !logs.includes('今天好累'));
  } finally { await g.close(); await up.close(); await xc.close(); }
});
