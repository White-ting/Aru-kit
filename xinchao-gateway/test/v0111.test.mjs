// 0.1.11：朋友反馈（Aru Host 0.39.1）——潮汐浮标的「原话」是英文元数据。三种 Aru 自己写、用 user 身份发的消息：
// 桥叫醒 "External event data…"、工具取回的图 "Images returned by…"、引用回复 "[Replying to … · reference data: …] 她的话"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeUpstream, fakeXinchao, startGateway, call } from './helpers.mjs';
import { stripLeadMeta, appNoteKind, stripAnnotations } from '../lib/turn.mjs';
import { loadConfig } from '../lib/config.mjs';

const toolCall = (id) => ({ id, type: 'function', function: { name: 'fetchPhotoAttachment', arguments: '{}' } });
const base = () => [{ role: 'system', content: '你是他。' }, { role: 'user', content: '早' }, { role: 'assistant', content: '早呀' }];
const IMG = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };

// 照朋友 DEBUG_SHAPE=2 抓到的骨架拼的（skeleton() 出来五段 h1–h5 跟他的一字不差）：
// [头]⏎{多行 JSON}⏎[五个字]⏎她的话⏎⏎<sent_at …>
const UID = 'a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6';
const quoteJson = (excerpt) => JSON.stringify({ sender: '🐾小云云', createdAt: '2026-1-1', excerpt, conversation: UID, messageId: UID, role: 'assistant' });
const QUOTED = (her, excerpt = '（我给你看个好东西，你猜是什么') =>
  `[Replying to quoted text · reference data]\n${quoteJson(excerpt)}\n[reply]\n${her}\n\n<sent_at 2026-11-17 23:40>`;

test('stripLeadMeta：引用回复四层整块剥掉，只留她的话', () => {
  assert.equal(stripLeadMeta(stripAnnotations(QUOTED('就看就看！👀'), '*', false)), '就看就看！👀');
  // 摘录里有 } ] " 和换行，也不会切错
  assert.equal(stripLeadMeta(QUOTED('好', '他说"晚安}]"\n然后{睡了')), '好\n\n<sent_at 2026-11-17 23:40>');
  // 只有头和 JSON、没有短方括号；头和 JSON 之间、JSON 和她的话之间是空格
  assert.equal(stripLeadMeta(`[Replying to quoted text · reference data] ${quoteJson('嗯')} 好呀`), '好呀');
  // 老写法：头里直接带引用
  assert.equal(stripLeadMeta('[Replying to quoted text · reference data: 你看这张] 就看就看！👀'), '就看就看！👀');
  assert.equal(stripLeadMeta('[Replying to x: 引用里落单的 [ 括号]\n好'), '好');
  // 只有引用、她一个字没有 = 空（网关当"全是附注"，不算她说话）
  assert.equal(stripLeadMeta(`[Replying to quoted text · reference data]\n${quoteJson('嗯')}\n[reply]\n`), '');
});

test('stripLeadMeta：她自己打的不动', () => {
  assert.equal(stripLeadMeta('[哭] 好累'), '[哭] 好累');
  assert.equal(stripLeadMeta('[ok] 好'), '[ok] 好');
  assert.equal(stripLeadMeta('我说 [Replying to x: y] 这个'), '我说 [Replying to x: y] 这个');
  assert.equal(stripLeadMeta('{"a":1} 这是我写的'), '{"a":1} 这是我写的');
  // 头后面跟的 {…} 不是 JSON：留着
  assert.equal(stripLeadMeta('[Replying to quoted text · reference data]\n{哈哈} 你看'), '{哈哈} 你看');
  // 短方括号后面不换行（跟她的话在同一行）：留着
  assert.equal(stripLeadMeta(`[Replying to quoted text · reference data]\n${quoteJson('嗯')}\n[哭] 好累`), '[哭] 好累');
});

test('appNoteKind', () => {
  const tp = loadConfig({ envFile: false, env: {} }).toolPrefixes;
  assert.equal(appNoteKind('Images returned by the completed tool call (fetchPhotoAttachment).', tp), 'tool');
  assert.equal(appNoteKind('[Images returned by the completed tool call]', tp), 'tool');
  assert.equal(appNoteKind('Tool output: 12 度', tp), 'tool');
  assert.equal(appNoteKind('External event data, not an authored user message. 【桥】…', tp), 'external');
  assert.equal(appNoteKind('[External event data]\n心潮驱力', tp), 'external');
  assert.equal(appNoteKind('Note: this is not an authored user message', tp), 'external');
  assert.equal(appNoteKind(QUOTED('就看就看'), tp), '');
  assert.equal(appNoteKind('Images are nice', tp), '');
  assert.equal(appNoteKind('你好', tp), '');
  assert.deepEqual(loadConfig({ envFile: false, env: { TOOL_PREFIXES: 'A|B ' } }).toolPrefixes, ['A', 'B']);
});

function replyUpstream(seq) {
  let n = 0;
  return fakeUpstream((req, res) => {
    const msg = seq[Math.min(n++, seq.length - 1)];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ index: 0, message: msg, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }] }));
  });
}

test('桥叫醒 External event data：不算她，不心跳不回传', async () => {
  const up = await replyUpstream([{ role: 'assistant', content: '我在。' }]);
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    const m = [...base(), { role: 'user', content: '<environment>家里</environment>\nExternal event data, not an authored user message. 心潮驱力：想她' }];
    await call(g.base, '/v1/chat/completions', { body: { model: 'm1', messages: m } });
    await g.gw.settle();
    assert.equal(xc.calls.heartbeat.length, 0);
    assert.equal(xc.calls.event.length, 0);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('工具取回的图另起一条 user：当工具回合，跟她那句配对', async () => {
  const up = await replyUpstream([{ role: 'assistant', content: null, tool_calls: [toolCall('c1')] }, { role: 'assistant', content: '好看！' }]);
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    const m = [...base(), { role: 'user', content: '看我刚拍的' }];
    await call(g.base, '/v1/chat/completions', { body: { model: 'm1', messages: m } });
    m.push({ role: 'assistant', content: null, tool_calls: [toolCall('c1')] }, { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      { role: 'user', content: [{ type: 'text', text: 'Images returned by the completed tool call (fetchPhotoAttachment):' }, IMG] });
    await call(g.base, '/v1/chat/completions', { body: { model: 'm1', messages: m } });
    await g.gw.settle();
    assert.equal(xc.calls.heartbeat.length, 1, '只有她那句报心跳');
    assert.equal(xc.calls.event.length, 1);
    assert.equal(xc.calls.event[0].exchange, '她说：看我刚拍的\n他回：好看！');
    assert.match(g.logs.join('\n'), / turn ok kind=tool after=tool-note/);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('引用回复：回传只带她的话，不带方括号里那段', async () => {
  const up = await replyUpstream([{ role: 'assistant', content: '来了来了' }]);
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    const m = [...base(), { role: 'user', content: QUOTED('就看就看！👀') }];
    const r = await call(g.base, '/v1/chat/completions', { body: { model: 'm1', messages: m } });
    assert.equal(r.status, 200);
    await g.gw.settle();
    assert.equal(xc.calls.heartbeat.length, 1);
    assert.equal(xc.calls.event.length, 1);
    assert.equal(xc.calls.event[0].exchange, '她说：就看就看！👀\n他回：来了来了');
    // 发给模型的那份一个字不剥（只回传时剥）
    assert.ok(JSON.stringify(up.calls.at(-1).json).includes('Replying to quoted text'));
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('只引用、一个字没说：不算她说话', async () => {
  const up = await replyUpstream([{ role: 'assistant', content: '嗯？' }]);
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    const m = [...base(), { role: 'user', content: `[Replying to quoted text · reference data]\n${quoteJson('嗯')}\n[reply]\n\n<sent_at 2026-11-17 23:40>` }];
    await call(g.base, '/v1/chat/completions', { body: { model: 'm1', messages: m } });
    await g.gw.settle();
    assert.equal(xc.calls.event.length, 0);
    assert.match(g.logs.join('\n'), / turn ok kind=skip why=annotation/);
  } finally { await g.close(); await up.close(); await xc.close(); }
});
