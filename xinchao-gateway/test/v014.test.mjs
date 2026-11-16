// 0.1.4：去掉 App 塞进她那句的附注（测试反馈 ca3e）；多渠道 /<渠道>/v1（测试反馈 3bcb）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeUpstream, fakeXinchao, startGateway, call, chatBody, GW_KEY, UP_KEY } from './helpers.mjs';
import { stripAnnotations } from '../lib/turn.mjs';
import { loadConfig, checkConfig } from '../lib/config.mjs';

test('stripAnnotations：成对标签整块去掉、单独的 <x/> 也去；名单只去名单里的；删光了原样返回', () => {
  const env = '<environment>\n地点：家\n天气：小雨\n</environment>\n\n';
  assert.equal(stripAnnotations(env + '<sent_at>20:10</sent_at>\n\n今天好累'), '今天好累');
  assert.equal(stripAnnotations('<sent_at t="1"/>今天好累'), '今天好累');
  assert.equal(stripAnnotations('今天好累\n\n<sent_at>20:10</sent_at>'), '今天好累');
  assert.equal(stripAnnotations(env + '<memo>x</memo>今天', ['environment']), '<memo>x</memo>今天');
  assert.equal(stripAnnotations('<sent_at>20:10</sent_at>'), '<sent_at>20:10</sent_at>', '删光了就原样');
  assert.equal(stripAnnotations('我喜欢 3<5 这种写法'), '我喜欢 3<5 这种写法', '不是标签的尖括号不动');
  assert.equal(stripAnnotations(env + '今天', []), env + '今天', '空名单 = 不去');
});

test('附注：回传里只有她自己的话；shape 记 clean 和 raw；附注在前面的桥消息照样认成 skip', async () => {
  const up = await fakeUpstream();
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, overrides: { DEBUG_SHAPE: '1' } });
  try {
    const env = '<environment>\n地点：家里\n' + '天气'.repeat(300) + '\n</environment>\n\n<sent_at>20:10</sent_at>\n\n';
    await call(g.base, '/v1/chat/completions', { body: chatBody(env + '今天好累') });
    await g.gw.settle();
    assert.equal(xc.calls.event.length, 1);
    assert.match(xc.calls.event[0].exchange, /^她说：今天好累\n他回：/);
    const logs = g.logs.join('\n');
    assert.match(logs, / turn ok kind=her chars=4/);
    assert.match(logs, / shape ok clean=4 raw=\d{3,}/);
    assert.ok(!logs.includes('今天好累') && !logs.includes('家里'));
    assert.ok(up.calls[0].json.messages.at(-1).content.startsWith(env + '今天好累'), '发给模型的那份原样保留附注');

    await call(g.base, '/v1/chat/completions', { body: chatBody('<sent_at>20:11</sent_at>\n\n【小屋桥·留话】她说想你了') });
    assert.match(g.logs.join('\n'), / turn ok kind=skip/);
    assert.equal(xc.calls.heartbeat.length, 1, '桥消息不报心跳');
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('STRIP_TAGS 留空：不去附注（跟 0.1.3 一样）', async () => {
  const up = await fakeUpstream();
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, overrides: { STRIP_TAGS: '' } });
  try {
    await call(g.base, '/v1/chat/completions', { body: chatBody('<sent_at>20:10</sent_at>\n\n今天好累') });
    await g.gw.settle();
    assert.match(xc.calls.event[0].exchange, /^她说：<sent_at>20:10<\/sent_at>\n\n今天好累/);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('多渠道：/<渠道>/v1 走 UPSTREAM_<渠道>_*，换上那一组的钥匙；不写渠道走默认；两根线照常', async () => {
  const A = await fakeUpstream();   // 默认
  const J = await fakeUpstream();   // jumeng
  const N = await fakeUpstream();   // noir（透传）
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: A.url, xinchaoUrl: xc.url, overrides: {
    UPSTREAM_JUMENG_URL: J.url, UPSTREAM_JUMENG_KEY: 'jm-key',
    UPSTREAM_NOIR_URL: N.url, UPSTREAM_NOIR_KEY: 'passthrough',
  } });
  try {
    assert.deepEqual(g.cfg.channels.map((c) => c.name), ['jumeng', 'noir']);
    const r1 = await call(g.base, '/jumeng/v1/chat/completions', { body: chatBody('一') });
    assert.equal(r1.status, 200);
    assert.equal(J.calls.length, 1); assert.equal(A.calls.length, 0);
    assert.equal(J.calls[0].url, '/v1/chat/completions');
    assert.equal(J.calls[0].headers.authorization, 'Bearer jm-key');
    const r2 = await call(g.base, '/JUMENG/v1/models', { method: 'GET' });
    assert.equal(r2.status, 200, '渠道名不分大小写'); assert.equal(J.calls.length, 2);

    await call(g.base, '/v1/chat/completions', { body: chatBody('二') });
    assert.equal(A.calls.length, 1); assert.equal(A.calls[0].headers.authorization, `Bearer ${UP_KEY}`);

    // 透传渠道：只认地址口令，App 的钥匙原样带过去
    const r3 = await call(g.base, '/noir/v1/chat/completions', { key: null, headers: { authorization: 'Bearer app-own-key' }, body: chatBody('三') });
    assert.equal(r3.status, 401, '透传渠道不带地址口令不放'); assert.equal(N.calls.length, 0);
    const r4 = await call(g.base, `/${GW_KEY}/noir/v1/chat/completions`, { key: null, headers: { authorization: 'Bearer app-own-key' }, body: chatBody('四') });
    assert.equal(r4.status, 200); assert.equal(N.calls[0].headers.authorization, 'Bearer app-own-key');
    assert.equal(N.calls[0].url, '/v1/chat/completions');

    // 没这个渠道：当成地址口令，对不上 401，日志里渠道名照写、口令遮住
    const r5 = await call(g.base, '/nosuch/v1/chat/completions', { body: chatBody('五') });
    assert.equal(r5.status, 401);
    const logs = g.logs.join('\n');
    assert.match(logs, / request ok path=\/v1\/chat\/completions ch=jumeng /);
    assert.match(logs, / auth fail path=\/noir\/v1\/chat\/completions /);
    assert.match(logs, / auth fail path=\/\*\*\*\/v1\/chat\/completions /);
    assert.ok(!logs.includes(GW_KEY) && !logs.includes('jm-key') && !logs.includes('app-own-key'));
    await g.gw.settle();
    assert.equal(xc.calls.heartbeat.length, 3, '一、二、四三句都报了心跳（五被拒了）');

    const h = await call(g.base, '/jumeng/healthz', { method: 'GET', key: null });
    assert.equal(h.status, 200);
  } finally { await g.close(); await A.close(); await J.close(); await N.close(); await xc.close(); }
});

test('多渠道配置检查：两行要一起写、名字不能叫 v1、不能跟 GATEWAY_KEY 撞', () => {
  const mk = (o) => checkConfig(loadConfig({ envFile: false, env: {}, overrides: { GATEWAY_KEY: 'k1', UPSTREAM_URL: 'https://a/v1', UPSTREAM_KEY: 'x', XINCHAO_URL: 'http://x', ...o } }));
  assert.deepEqual(mk({ UPSTREAM_JM_URL: 'https://j/v1', UPSTREAM_JM_KEY: 'k' }), []);
  assert.ok(mk({ UPSTREAM_JM_URL: 'https://j/v1' }).some((p) => p.includes('UPSTREAM_JM_KEY')));
  assert.ok(mk({ UPSTREAM_JM_KEY: 'k' }).some((p) => p.includes('UPSTREAM_JM_URL')));
  assert.ok(mk({ UPSTREAM_V1_URL: 'https://j/v1', UPSTREAM_V1_KEY: 'k' }).some((p) => p.includes('不能叫 v1')));
  assert.ok(mk({ UPSTREAM_K1_URL: 'https://j/v1', UPSTREAM_K1_KEY: 'k' }).some((p) => p.includes('撞了')));
});
