// 0.1.16：NOW_MODE=signal（临界点模式）——此刻不每句贴，到了临界点才贴；回传照常。默认 always 照旧每句贴。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeUpstream, fakeXinchao, startGateway, call, chatBody, makeClock, MIN } from './helpers.mjs';
import { nowSignals, signalWhy } from '../lib/turn.mjs';

const H = '【心潮·此刻｜身体的天气，参考不是指令】';
const mk = (drives, emo, extra = []) => ({ ok: true, text: [H, `驱力：${drives}`, `情绪：${emo}；近一天走过 平静→${emo.split('，')[0]}`, ...extra].join('\n'), lines: 3 + extra.length, digest: 'd-' + drives + emo + extra.join('') });

test('nowSignals：取到「涌」的驱力、情绪名（平静后面的冷暖字不算）、要注意的那几种行', () => {
  const t = [H, '刚醒', '驱力：想她（涌·想黏着）、牵挂（涨）、好奇（平）', '情绪：平静偏暖，松；刚才被夸了', '身体：心跳 72，呼吸平稳', '还在气：刚才为了「迟到」', '念头：有个关于「想她」的念头一直在绕', '另外：昨夜有梦。细的在 xinchao_context'].join('\n');
  assert.deepEqual(nowSignals(t), { surge: ['想她'], emo: '平静', kinds: ['刚醒', '还在气', '念头'] });
  assert.deepEqual(nowSignals('情绪：委屈，想黏着'), { surge: [], emo: '委屈', kinds: [] });
  assert.deepEqual(nowSignals('睡着（她来了才算醒）\n矛盾：又想靠近又生气'), { surge: [], emo: '', kinds: ['睡着', '矛盾'] });
});

test('signalWhy：第一次、新到涌、情绪变、冒出新的行；都没有就不贴', () => {
  const a = { surge: [], emo: '平静', kinds: [] };
  assert.equal(signalWhy(null, a), 'first');
  assert.equal(signalWhy(a, a), '');
  assert.equal(signalWhy(a, { ...a, surge: ['想她'] }), 'surge');
  assert.equal(signalWhy({ ...a, surge: ['想她'] }, { ...a, surge: ['想她'] }), '', '一直涌着不重复贴');
  assert.equal(signalWhy({ ...a, surge: ['想她'] }, a), '', '涌退下去不算');
  assert.equal(signalWhy(a, { ...a, emo: '委屈' }), 'emotion');
  assert.equal(signalWhy(a, { ...a, kinds: ['还在气'] }), 'line');
  assert.equal(signalWhy({ ...a, kinds: ['还在气'] }, { ...a, kinds: ['还在气'] }), '');
});

const STEPS = [
  // [隔几分钟, 此刻, 临界点模式下贴不贴, 原因]
  [0, mk('牵挂（涨）', '平静'), true, 'first'],
  [1, mk('牵挂（涨）', '平静偏暖'), false],
  [1, mk('牵挂（涌·放不下）', '平静'), true, 'surge'],
  [1, mk('牵挂（涌·放不下）', '平静'), false],
  [1, mk('牵挂（涌·放不下）', '委屈，放不下'), true, 'emotion'],
  [1, mk('牵挂（涌·放不下）', '委屈，放不下', ['还在气：刚才为了「迟到」']), true, 'line'],
  [1, mk('牵挂（涌·放不下）', '委屈，放不下', ['还在气：刚才为了「迟到」']), false],
  [100, mk('牵挂（涌·放不下）', '委屈，放不下', ['还在气：刚才为了「迟到」']), true, 'back'],
];

for (const mode of ['signal', 'always']) {
  test(`NOW_MODE=${mode}：${mode === 'signal' ? '只在临界点贴，日志写原因，不贴的写 why=quiet；回传照常' : '不写也一样：每句都贴'}`, async () => {
    let cur = STEPS[0][1];
    const up = await fakeUpstream();
    const xc = await fakeXinchao({ now: () => cur });
    const clock = makeClock();
    const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, clock, overrides: { EVENT_MIN_INTERVAL_MIN: '0', EVENT_MAX_PER_HOUR: '100', ...(mode === 'signal' ? { NOW_MODE: 'signal' } : {}) } });
    try {
      for (let i = 0; i < STEPS.length; i++) {
        const [m, now, attach, why] = STEPS[i];
        clock.advance(m * MIN); cur = now;
        const before = g.logs.length;
        await call(g.base, '/v1/chat/completions', { body: chatBody('第' + i + '句') });
        await g.gw.settle();
        const sent = JSON.stringify(up.calls[i].json.messages.at(-1).content);
        const logs = g.logs.slice(before).join('\n');
        const want = mode === 'signal' ? attach : true;
        assert.equal(sent.includes('〔心潮·此刻〕'), want, `第 ${i} 句`);
        if (mode === 'signal') {
          if (attach) assert.match(logs, new RegExp(`now-attach ok .*sig=${why}`), `第 ${i} 句`);
          else assert.match(logs, /now-attach skip why=quiet/, `第 ${i} 句`);
        } else assert.doesNotMatch(logs, /sig=|why=quiet/);
      }
      assert.equal(xc.calls.event.length, STEPS.length, '回传每句照常');
    } finally { await g.close(); await up.close(); await xc.close(); }
  });
}

test('临界点模式：上一句的要点存着，重启网关后同样的此刻不当成第一次', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcgw-sig-'));
  const now = mk('牵挂（涨）', '平静');
  try {
    for (const [i, want] of [[0, /now-attach ok .*sig=first/], [1, /now-attach skip why=quiet/]]) {
      const up = await fakeUpstream();
      const xc = await fakeXinchao({ now });
      const clock = makeClock(Date.UTC(2026, 10, 4, 8, i));
      const g = await startGateway({ upstreamUrl: up.url, xinchaoUrl: xc.url, clock, stateDir: dir, overrides: { NOW_MODE: 'signal' } });
      try {
        await call(g.base, '/v1/chat/completions', { body: chatBody('第' + i + '次') });
        await g.gw.settle();
        assert.match(g.logs.join('\n'), want, `第 ${i} 次启动`);
      } finally { await g.close(); await up.close(); await xc.close(); }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
