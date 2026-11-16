// 测试 6：跳过前缀、工具回合、finish_reason: tool_calls；外加回传节流和 ONLY_STREAM。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeUpstream, fakeXinchao, startGateway, call, chatBody, makeClock, MIN } from './helpers.mjs';

test('6a 以【开头的消息：不报心跳、不附、不回传', async () => {
  const up = await fakeUpstream();
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    for (const text of ['【桥】她三小时没来了', '  【外部触发】x', '〔心潮念〕想她']) {
      const sent = chatBody(text);
      const r = await call(g.base, '/v1/chat/completions', { body: sent });
      assert.equal(r.status, 200);
      assert.deepEqual(up.calls.at(-1).json, sent);
    }
    await g.gw.settle();
    assert.equal(xc.calls.heartbeat.length, 0);
    assert.equal(xc.calls.now.length, 0);
    assert.equal(xc.calls.event.length, 0);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('6b tool 回合（最后一条 role:tool，或 assistant 带 tool_calls）：不报心跳、不附、不回传', async () => {
  const up = await fakeUpstream();
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    const toolRound = chatBody('查下天气');
    toolRound.messages.push(
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '小雨' },
    );
    await call(g.base, '/v1/chat/completions', { body: toolRound });
    const asstLast = chatBody('x');
    asstLast.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'f', arguments: '{}' } }] });
    await call(g.base, '/v1/chat/completions', { body: asstLast });
    await g.gw.settle();
    assert.deepEqual(up.calls[0].json, toolRound);
    assert.deepEqual(up.calls[1].json, asstLast);
    assert.equal(xc.calls.heartbeat.length, 0);
    assert.equal(xc.calls.now.length, 0);
    assert.equal(xc.calls.event.length, 0);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('6c 上游回 finish_reason: tool_calls：不回传（非流式、流式都是）', async () => {
  let streamMode = false;
  const up = await fakeUpstream((req, res) => {
    if (streamMode) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"index":0,"delta":{"content":"我查一下"}}]}\n\n');
      res.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"w","arguments":""}}]}}]}\n\n');
      res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '我查一下', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'w', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }));
  });
  const xc = await fakeXinchao();
  const clock = makeClock();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, clock });
  try {
    await call(g.base, '/v1/chat/completions', { body: chatBody('天气怎样') });
    clock.advance(60 * MIN);
    streamMode = true;
    await call(g.base, '/v1/chat/completions', { body: chatBody('天气怎样', { stream: true }) });
    await g.gw.settle();
    assert.equal(xc.calls.event.length, 0, '工具调用还没说完，不回传');
    // 说明：要不要调工具是模型回了以后才知道的，所以这两轮的心跳和取 now 在转发前已经做了（她确实说话了）
    assert.equal(xc.calls.heartbeat.length, 2);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('6d 工具调用走完以后：把她那句和最后的回复配成一轮回传（只发一次）', async () => {
  const up = await fakeUpstream((req, res, c) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const last = c.json.messages.at(-1);
    if (last.role === 'tool') {
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '外面在下小雨，带伞。' }, finish_reason: 'stop' }] }));
    } else {
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'w', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }));
    }
  });
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    const first = chatBody('要带伞吗');
    await call(g.base, '/v1/chat/completions', { body: first });
    const second = structuredClone(first);
    second.messages.push(
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'w', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '小雨' },
    );
    await call(g.base, '/v1/chat/completions', { body: second });
    await call(g.base, '/v1/chat/completions', { body: second }); // 同一轮重试，不再重复发
    await g.gw.settle();
    assert.equal(xc.calls.event.length, 1);
    assert.equal(xc.calls.event[0].exchange, '她说：要带伞吗\n他回：外面在下小雨，带伞。');
    assert.equal(xc.calls.heartbeat.length, 1, 'tool 回合不报心跳');
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('回传节流：隔不到 8 分钟不发；每小时最多 4 次；隔 45 分钟以上的第一句一定发', async () => {
  const up = await fakeUpstream();
  const xc = await fakeXinchao();
  const clock = makeClock();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, clock });
  const say = async (t) => { await call(g.base, '/v1/chat/completions', { body: chatBody(t) }); await g.gw.settle(); };
  try {
    await say('1'); // 发（第一次）
    clock.advance(3 * MIN); await say('2'); // 3 分钟：不发
    clock.advance(6 * MIN); await say('3'); // 距上次发 9 分钟：发
    clock.advance(9 * MIN); await say('4'); // 发
    clock.advance(9 * MIN); await say('5'); // 发（一小时内第 4 次）
    clock.advance(9 * MIN); await say('6'); // 一小时内已经 4 次：不发
    assert.deepEqual(xc.calls.event.map((e) => e.exchange.slice(3, 4)), ['1', '3', '4', '5']);
    clock.advance(10 * MIN); await say('6b'); // 第 46 分钟：最近一小时里还是 4 次：不发
    clock.advance(15 * MIN); await say('7'); // 第 61 分钟：第一次那条滑出窗口，只剩 3 次：发
    clock.advance(2 * MIN); await say('8'); // 2 分钟：不发
    clock.advance(46 * MIN); await say('9'); // 她隔了 46 分钟才说：一定发
    clock.advance(1 * MIN); await say('10'); // 1 分钟：不发
    assert.deepEqual(xc.calls.event.map((e) => e.exchange.slice(3).split('\n')[0]), ['1', '3', '4', '5', '7', '9']);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('ONLY_STREAM=true：只认 stream:true 的请求', async () => {
  const up = await fakeUpstream();
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, overrides: { ONLY_STREAM: 'true' } });
  try {
    await call(g.base, '/v1/chat/completions', { body: chatBody('给这段对话起个标题') });
    await g.gw.settle();
    assert.equal(xc.calls.heartbeat.length, 0);
    assert.equal(xc.calls.event.length, 0);
    await call(g.base, '/v1/chat/completions', { body: chatBody('嗨', { stream: true }) });
    assert.equal(xc.calls.heartbeat.length, 1);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('6g 后台杂活（0.1.1，测试反馈 8929）：起标题、摘要、小 max_tokens 不算她在说话；有前文的「帮我总结一下」照样算', async () => {
  const up = await fakeUpstream();
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    const title = { model: 'm1', messages: [{ role: 'system', content: 'Generate a short title for this conversation.' },
      { role: 'user', content: '她：今天好累\n他：过来，先别说话' }] };
    const summary = { model: 'm1', messages: [{ role: 'user', content: '把下面这段摘要成一句话：她今天加班到很晚' }] };
    const tiny = chatBody('随便一句', { max_tokens: 40 });
    for (const b of [title, summary, tiny]) {
      const r = await call(g.base, '/v1/chat/completions', { body: b });
      assert.equal(r.status, 200);
      assert.deepEqual(up.calls.at(-1).json, b, '后台请求原样转发，不附此刻');
    }
    await g.gw.settle();
    assert.equal(xc.calls.heartbeat.length, 0, '后台请求不报心跳');
    assert.equal(xc.calls.event.length, 0, '后台请求不回传');

    const real = chatBody('帮我总结一下今天');   // 有前文（早 / 早呀），她自己说的"总结"
    await call(g.base, '/v1/chat/completions', { body: real });
    await g.gw.settle();
    assert.equal(xc.calls.heartbeat.length, 1, '有前文时她说总结照样算她在说话');
    assert.equal(xc.calls.event.length, 1);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('6h BG_MAX_TOKENS=0、BG_PATTERNS 留空：两条都关掉', async () => {
  const up = await fakeUpstream();
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, overrides: { BG_MAX_TOKENS: '0', BG_PATTERNS: '' } });
  try {
    await call(g.base, '/v1/chat/completions', { body: { model: 'm1', max_tokens: 20, messages: [{ role: 'system', content: '起标题' }, { role: 'user', content: '她：在吗' }] } });
    await g.gw.settle();
    assert.equal(xc.calls.heartbeat.length, 1);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('6d2 工具回合（0.1.3，测试反馈 ca3e）：App 每次往她那句里塞的东西不一样，工具走完照样配成一轮回传', async () => {
  const toolCall = { id: 'c1', type: 'function', function: { name: 'w', arguments: '{}' } };
  const up = await fakeUpstream((req, res, c) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (c.json.messages.at(-1).role === 'tool') {
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '带伞吧。' }, finish_reason: 'stop' }] }));
    } else {
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }] }));
    }
  });
  const xc = await fakeXinchao();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url });
  try {
    await call(g.base, '/v1/chat/completions', { body: chatBody('<ctx>09:01</ctx>\n\n要带伞吗') });
    const second = chatBody('<ctx>09:02</ctx>\n\n要带伞吗'); // App 重发时塞的时间变了
    second.messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] }, { role: 'tool', tool_call_id: 'c1', content: '小雨' });
    await call(g.base, '/v1/chat/completions', { body: second });
    await g.gw.settle();
    assert.equal(xc.calls.event.length, 1, '配上了');
    assert.equal(xc.calls.event[0].exchange, '她说：要带伞吗\n他回：带伞吧。', '0.1.4 起附注 <ctx> 去掉了');
    const logs = g.logs.join('\n');
    assert.match(logs, / event wait why=tool-calls/);
    assert.match(logs, / turn ok kind=tool/);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('6d3 工具回合配不上时日志写原因：没有在等的（tool-no-pending）、超过 15 分钟（tool-expired）', async () => {
  const toolCall = { id: 'c1', type: 'function', function: { name: 'w', arguments: '{}' } };
  const up = await fakeUpstream((req, res, c) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (c.json.messages.at(-1).role === 'tool') res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '好。' }, finish_reason: 'stop' }] }));
    else res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }] }));
  });
  const xc = await fakeXinchao();
  const clock = makeClock();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, clock });
  const toolBody = () => {
    const b = chatBody('查一下');
    b.messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] }, { role: 'tool', tool_call_id: 'c1', content: 'x' });
    return b;
  };
  try {
    await call(g.base, '/v1/chat/completions', { body: toolBody() });
    assert.match(g.logs.join('\n'), / event skip why=tool-no-pending/);

    await call(g.base, '/v1/chat/completions', { body: chatBody('查一下') });
    clock.advance(16 * MIN);
    await call(g.base, '/v1/chat/completions', { body: toolBody() });
    await g.gw.settle();
    assert.match(g.logs.join('\n'), / event skip why=tool-expired/);
    assert.equal(xc.calls.event.length, 0);
  } finally { await g.close(); await up.close(); await xc.close(); }
});

test('6d4 她说了新的一句：之前没走完的工具回合作废，后来的工具回合不会配到旧的那句上', async () => {
  const toolCall = { id: 'c1', type: 'function', function: { name: 'w', arguments: '{}' } };
  const up = await fakeUpstream((req, res, c) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const last = c.json.messages.at(-1);
    if (last.role === 'tool') res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '查到了。' }, finish_reason: 'stop' }] }));
    else if (String(last.content).startsWith('查天气')) res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }] }));
    else res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '嗯嗯。' }, finish_reason: 'stop' }] }));
  });
  const xc = await fakeXinchao();
  const clock = makeClock();
  const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, clock });
  try {
    await call(g.base, '/v1/chat/completions', { body: chatBody('查天气') }); // 调了工具，但 App 没把结果送回来
    clock.advance(10 * MIN);
    await call(g.base, '/v1/chat/completions', { body: chatBody('算了不查了') }); // 她说了新的一句，正常回
    await g.gw.settle();
    const b = chatBody('别的');
    b.messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] }, { role: 'tool', tool_call_id: 'c1', content: 'x' });
    await call(g.base, '/v1/chat/completions', { body: b });
    await g.gw.settle();
    assert.equal(xc.calls.event.length, 1, '只有"算了不查了"那一轮');
    assert.match(xc.calls.event[0].exchange, /^她说：算了不查了/);
    assert.match(g.logs.join('\n'), / event skip why=tool-no-pending/);
  } finally { await g.close(); await up.close(); await xc.close(); }
});
