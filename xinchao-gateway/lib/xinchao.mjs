// 找心潮念的三个请求。都带超时，失败只返回 null / false，从不抛错。
import crypto from 'node:crypto';

export function eventId(prefix, clock = Date.now) {
  return `${prefix}-${Math.floor(clock() / 1000)}-${crypto.randomBytes(4).toString('hex')}`;
}

export function makeXinchao({ cfg, log, clock = () => Date.now() }) {
  const headers = { authorization: `Bearer ${cfg.xinchaoToken}` };

  async function call(step, method, path, body, signal) {
    const t0 = Date.now();
    try {
      const res = await fetch(cfg.xinchaoUrl + path, {
        method,
        headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
      const text = await res.text();
      if (!res.ok) { log(step, false, { status: res.status, ms: Date.now() - t0 }); return null; }
      let json = null;
      try { json = JSON.parse(text); } catch { json = {}; }
      log(step, true, { status: res.status, ms: Date.now() - t0 });
      return json;
    } catch (e) {
      const why = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'error';
      log(step, false, { why, ms: Date.now() - t0 });
      return null;
    }
  }

  return {
    /**
     * 心跳 + 取 now。两步共用一个超时预算（XINCHAO_TIMEOUT_MS），
     * 所以最坏也只多等一个超时，不会是两个。
     */
    async heartbeatAndNow() {
      const signal = AbortSignal.timeout(cfg.xinchaoTimeoutMs);
      await call('heartbeat', 'POST', '/v1/heartbeat', { event_id: eventId('hb', clock) }, signal);
      if (signal.aborted) return null;
      return call('now', 'GET', '/v1/now', null, signal);
    },

    async sendEvent(exchange) {
      const signal = AbortSignal.timeout(cfg.xinchaoTimeoutMs);
      const r = await call('event', 'POST', '/v1/conversation-event', { event_id: eventId('gw', clock), exchange }, signal);
      return r !== null;
    },
  };
}
