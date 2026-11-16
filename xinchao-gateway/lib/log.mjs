// 日志：只记时间、哪一步、成功失败、耗时、字数。绝不传正文、钥匙、口令进来。
export function makeLogger({ level = 'info', sink = (line) => process.stdout.write(line + '\n') } = {}) {
  const quiet = level === 'silent';
  return function log(step, ok, fields = {}) {
    if (quiet) return;
    // 0.1.10：ok 也可以是 'skip'（照规矩跳过，不是出错）、'wait'（等工具走完），fail 只留给真出错
    const parts = [new Date().toISOString(), step, typeof ok === 'string' ? ok : (ok ? 'ok' : 'fail')];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      // 只允许数字和很短的状态词（比如 "timeout" "401" "skip:prefix"），防止误把正文传进来
      if (typeof v === 'number') parts.push(`${k}=${Math.round(v)}`);
      else parts.push(`${k}=${String(v).replace(/\s+/g, '_').slice(0, 40)}`);
    }
    sink(parts.join(' '));
  };
}
