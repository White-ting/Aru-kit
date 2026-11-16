// 测试 7：心潮挂了（端口没开、很慢、报错），聊天照常，而且不会多等超过 XINCHAO_TIMEOUT_MS。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeUpstream, fakeXinchao, startGateway, call, chatBody, deadPort, sleep, OPENAI_REPLY_BYTES } from './helpers.mjs';

const UP_DELAY = 150;
const TIMEOUT = 400;
const SLACK = 250; // 本机调度的余量

function slowUpstream() {
  return fakeUpstream(async (req, res) => {
    await sleep(UP_DELAY);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(OPENAI_REPLY_BYTES);
  });
}

test('7a 心潮端口没开：聊天照常成功', async () => {
  const up = await slowUpstream();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: await deadPort(), overrides: { XINCHAO_TIMEOUT_MS: String(TIMEOUT) } });
  try {
    const t0 = Date.now();
    const r = await call(g.base, '/v1/chat/completions', { body: chatBody('在吗') });
    const ms = Date.now() - t0;
    assert.equal(r.status, 200);
    assert.ok(r.body.equals(OPENAI_REPLY_BYTES));
    assert.ok(ms <= UP_DELAY + TIMEOUT + SLACK, `总耗时 ${ms}ms`);
    await g.gw.settle();
    assert.equal(up.calls[0].json.messages.at(-1).content, '在吗');
  } finally { await g.close(); await up.close(); }
});

test('7b 心潮每个请求都要 5 秒：聊天照常，总耗时 ≤ 上游耗时 + XINCHAO_TIMEOUT_MS', async () => {
  const up = await slowUpstream();
  const xc = await fakeXinchao({ delayMs: 5000 });
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, overrides: { XINCHAO_TIMEOUT_MS: String(TIMEOUT) } });
  try {
    const t0 = Date.now();
    const r = await call(g.base, '/v1/chat/completions', { body: chatBody('在吗', { stream: false }) });
    const ms = Date.now() - t0;
    assert.equal(r.status, 200);
    assert.ok(r.body.equals(OPENAI_REPLY_BYTES));
    assert.ok(ms <= UP_DELAY + TIMEOUT + SLACK, `总耗时 ${ms}ms，应 ≤ ${UP_DELAY + TIMEOUT}+余量`);
    assert.ok(ms >= TIMEOUT, '确实等了心潮（但只等一个超时）');
    assert.equal(xc.calls.now.length, 0, '心跳就超时了，不再去取 now');
    const t1 = Date.now();
    await g.gw.settle(); // 后台回传也会在超时后放弃
    assert.ok(Date.now() - t1 <= TIMEOUT + SLACK);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('7c 心潮回 500：聊天照常，不附', async () => {
  const up = await fakeUpstream();
  const xc = await fakeXinchao({ status: 500 });
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    const sent = chatBody('在吗');
    const r = await call(g.base, '/v1/chat/completions', { body: sent });
    assert.equal(r.status, 200);
    assert.deepEqual(up.calls[0].json, sent);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('上游连不上：回 502，不挂', async () => {
  const g = await startGateway({ upstreamUrl: (await deadPort()) + '/v1', overrides: { NOW_ENABLED: 'false', EVENT_ENABLED: 'false' } });
  try {
    const r = await call(g.base, '/v1/chat/completions', { body: chatBody('在吗') });
    assert.equal(r.status, 502);
  } finally { await g.close(); }
});
