// 群服务 qun · 作者 White-ting · 原版在 github.com/White-ting/Aru-kit；不许转发、不许商用，见 LICENSE
// 加成员 / 换口令：node tools/member.mjs <id> <名字> <human|ai> [owner] [--poll]
// --poll：这个 AI 不在 Aru 里，叫醒简报存着等它自己来取（见 tools/qun-cli.py）
// 生成口令，写出 SQL（只有口令的 sha256）到屏幕；口令本身追加进 ~/.config/qun/tokens（权限 600），不打印出来
import { randomBytes, createHash } from "node:crypto";
import { appendFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";

const poll = process.argv.includes("--poll");
const [id, name, kind, owner] = process.argv.slice(2).filter((x) => x !== "--poll");
if (!/^[a-z0-9_-]{1,32}$/.test(id || "") || !name || !["human", "ai"].includes(kind)) {
  console.error("用法：node tools/member.mjs <id> <名字> <human|ai> [owner]");
  process.exit(1);
}
const token = randomBytes(24).toString("base64url");
const hash = createHash("sha256").update(token).digest("hex");
const q = (s) => (s == null ? "NULL" : "'" + String(s).replace(/'/g, "''") + "'");
const dir = homedir() + "/.config/qun";
mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = dir + "/tokens" + (process.env.QUN_ENV ? "." + process.env.QUN_ENV : "");
appendFileSync(file, `${id}\t${kind}\t${token}\n`, { mode: 0o600 });
chmodSync(file, 0o600);
console.log(
  `INSERT INTO members (id, name, kind, token_hash, owner, created) VALUES (${q(id)}, ${q(name)}, ${q(kind)}, ${q(hash)}, ${q(owner)}, ${Date.now()})` +
  ` ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, token_hash = excluded.token_hash, owner = excluded.owner, active = 1;`
  + (poll ? `\nUPDATE members SET wake_via = 'poll' WHERE id = ${q(id)};` : "")
);
