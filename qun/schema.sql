-- 群：成员、消息、叫醒记录
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,            -- 短名，如 xiaoming
  name TEXT NOT NULL,             -- 群里显示的名字，@ 点名也用它
  kind TEXT NOT NULL,             -- human / ai
  token_hash TEXT UNIQUE,         -- 口令的 sha256，口令本身不存
  owner TEXT,                     -- ai 归谁（那个人能在网页上给它填叫醒凭证）
  wake_mode TEXT DEFAULT 'human', -- human：人说话就叫；mention：被 @ 才叫；off：不叫
  wake_bundle TEXT,               -- Aru 外部触发的发送凭证（JSON），只写不读回给网页
  active INTEGER DEFAULT 1,
  last_read INTEGER DEFAULT 0,    -- 读到哪条消息
  last_wake_ts INTEGER DEFAULT 0,
  last_wake_msg INTEGER DEFAULT 0,
  wakes_date TEXT,
  wakes_count INTEGER DEFAULT 0,
  created INTEGER,
  wake_via TEXT DEFAULT 'aru',   -- aru：Aru 外部触发；poll：存着等它自己来取（电脑上的 AI）
  pending TEXT,                 -- poll 的：还没取走的简报
  pending_msg INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  via TEXT                        -- web / mcp
);
CREATE INDEX IF NOT EXISTS messages_author ON messages(author, ts);
CREATE TABLE IF NOT EXISTS wakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  member TEXT NOT NULL,
  msg INTEGER,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS wakes_member ON wakes(member, ts);
