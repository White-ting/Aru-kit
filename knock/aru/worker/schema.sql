CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,          -- 发生时间（毫秒）
  type TEXT NOT NULL,
  app TEXT,
  place TEXT,
  data TEXT,                    -- 其余字段（JSON）
  received_ts INTEGER           -- 收到时间（毫秒），老记录可以为空
);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
CREATE INDEX IF NOT EXISTS events_app ON events (app, type, ts);

CREATE TABLE IF NOT EXISTS wakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  rule TEXT,
  reason TEXT,
  outcome TEXT,                 -- 已敲门 / 已推送 / 挡下：原因 / 失败：原因
  briefing TEXT
);

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
