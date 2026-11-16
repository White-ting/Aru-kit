// 节流用的状态：放在内存里，同时存一份小 json，重启后还在。
import fs from 'node:fs';
import path from 'node:path';

const MIN = 60 * 1000;

export class GatewayState {
  constructor({ dir, cfg, clock = () => Date.now() }) {
    this.cfg = cfg;
    this.clock = clock;
    this.file = dir ? path.join(dir, 'gateway-state.json') : null;
    this.s = { lastUserAt: 0, now: { digest: null, attachedAt: 0 }, event: { sent: [] } };
    this.pendingTool = null; // 工具调用中途的那一轮，只放内存
    this._load();
  }

  _load() {
    if (!this.file) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (j && typeof j === 'object') {
        this.s.lastUserAt = Number(j.lastUserAt) || 0;
        if (j.now) this.s.now = { digest: j.now.digest ?? null, attachedAt: Number(j.now.attachedAt) || 0 };
        if (j.event && Array.isArray(j.event.sent)) this.s.event.sent = j.event.sent.map(Number).filter(Number.isFinite);
      }
    } catch { /* 没有或者坏了就从头来 */ }
  }

  _save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.s));
      fs.renameSync(tmp, this.file);
    } catch { /* 存不下也不影响聊天 */ }
  }

  /** 她说了一句：返回距离她上一句隔了多久（毫秒，第一次是 Infinity），并记下这次的时间。 */
  markUser() {
    const t = this.clock();
    const gap = this.s.lastUserAt ? t - this.s.lastUserAt : Infinity;
    this.s.lastUserAt = t;
    this._save();
    return gap;
  }

  /** 此刻要不要附：指纹没变且 30 分钟内附过就不附；但距她上一句超过 90 分钟一定附。 */
  shouldAttachNow(digest, gap) {
    const t = this.clock();
    if (!(this.cfg.nowRepeatMin > 0)) return true; // 0 = 每轮都附
    if (gap > this.cfg.nowForceGapMin * MIN) return true;
    const same = digest !== undefined && digest !== null && digest === this.s.now.digest;
    if (same && t - this.s.now.attachedAt < this.cfg.nowRepeatMin * MIN) return false;
    return true;
  }

  markAttached(digest) {
    this.s.now = { digest: digest ?? null, attachedAt: this.clock() };
    this._save();
  }

  /** 回传要不要发：距她上一句超过 45 分钟一定发；否则至少隔 8 分钟、每小时最多 4 次。 */
  shouldSendEvent(gap) {
    const t = this.clock();
    const sent = this.s.event.sent.filter((x) => t - x < 60 * MIN);
    if (gap > this.cfg.eventForceGapMin * MIN) return true;
    const last = sent.length ? Math.max(...sent) : 0;
    if (last && t - last < this.cfg.eventMinIntervalMin * MIN) return false;
    if (sent.length >= this.cfg.eventMaxPerHour) return false;
    return true;
  }

  markEventSent() {
    const t = this.clock();
    this.s.event.sent = [...this.s.event.sent.filter((x) => t - x < 60 * MIN), t];
    this._save();
  }
}
