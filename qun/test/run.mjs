// 本机测试：先 wrangler dev --local --port 8788，再起 test/wake-receiver.mjs 18777 <密钥> testtoken123
// node test/run.mjs <密钥>
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const BASE = "http://127.0.0.1:8788";
const KEY = process.argv[2];
const tok = Object.fromEntries(readFileSync(homedir() + "/.config/qun/tokens.local", "utf8").trim().split("\n").map((l) => l.split("\t")).map(([id, , t]) => [id, t]));
const recvFile = new URL("./received.jsonl", import.meta.url);
const received = () => { try { return readFileSync(recvFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(cond, what) { if (cond) { pass++; console.log("  ✓", what); } else { fail++; console.log("  ✗", what); } }

async function login(id) {
  const r = await fetch(`${BASE}/?k=${tok[id]}`, { redirect: "manual" });
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
const web = (cookie) => async (path, body) => {
  const r = await fetch(BASE + path, body ? { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) } : { headers: { cookie } });
  return { status: r.status, j: await r.json() };
};
let rid = 1;
async function mcp(token, method, params, notify) {
  const body = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: rid++, method, params };
  const r = await fetch(BASE + "/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
  return { status: r.status, j: r.status === 202 ? null : await r.json() };
}
const tool = async (token, name, args) => (await mcp(token, "tools/call", { name, arguments: args })).j.result;

console.log("登录");
const bad = await fetch(`${BASE}/?k=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`, { redirect: "manual" });
ok(bad.status === 403, "错的邀请链接 403");
const a = web(await login("a")), b = web(await login("b"));
ok((await web("")("/api/state")).status === 401, "没 Cookie 401");
let s = await a("/api/state");
ok(s.status === 200 && s.j.me.name === "小A" && s.j.members.length === 4, "小A 看到 4 个成员");
ok((await fetch(`${BASE}/?k=${tok.fai}`, { redirect: "manual" })).status === 403, "AI 的口令不能登网页");

console.log("MCP");
ok((await mcp("wrongwrongwrongwrongwrong", "initialize", {})).status === 401, "错口令 401");
ok((await mcp(tok.a, "initialize", {})).status === 401, "人的口令不能用 MCP");
const init = await mcp(tok.fai, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
ok(init.j.result.protocolVersion === "2025-06-18" && init.j.result.capabilities.tools, "initialize");
ok((await mcp(tok.fai, "notifications/initialized", {}, true)).status === 202, "通知回 202");
const tl = await mcp(tok.fai, "tools/list", {});
ok(tl.j.result.tools.map((t) => t.name).join() === "read_group,post_group", "两个工具");
ok((await mcp(tok.fai, "nope", {})).j.error.code === -32601, "没有的方法报错");

console.log("叫醒凭证");
const bundle = { schema: "aru.wake-bridge.sender-bundle.v2", triggerId: "trig-1", submitURL: "http://127.0.0.1:18777/aru/v1/wake-bridge/endpoints/x/events", submitToken: "testtoken123", encryptionKey: KEY };
ok((await a("/api/wake", { ai: "fai", bundle })).status === 403, "小A 不能改别人的 AI");
ok((await b("/api/wake", { ai: "fai", bundle: "{坏的" })).status === 400, "坏 JSON 400");
ok((await b("/api/wake", { ai: "fai", bundle: JSON.stringify(bundle) })).j.ok, "小鱼存凭证");
s = await b("/api/state?mine=1");
ok(s.j.mine[0].has_bundle === 1 && !JSON.stringify(s.j).includes("testtoken123"), "设置里显示已填、不回传凭证");
ok((await b("/api/wake", { ai: "fai", test: true })).j.ok, "试叫一次");
await sleep(300);
ok(received().at(-1)?.content?.includes("测试叫醒") && received().at(-1).triggerId === "trig-1", "假 Host 收到并解开了测试叫醒");

console.log("人说话叫醒 AI");
let n = received().length;
ok((await a("/api/send", { text: "大家好呀" })).status === 200, "小A 发消息");
await sleep(500);
ok(received().length === n + 1 && received().at(-1).content.includes("小A（") && received().at(-1).content.includes("大家好呀"), "叫醒内容带着 小A 的话");
await a("/api/send", { text: "第二句" });
await sleep(500);
ok(received().length === n + 1, "叫了还没来看，第二句不重复叫");

console.log("AI 读和说");
let rd = await tool(tok.fai, "read_group", {});
ok(rd.content[0].text.includes("新消息 2 条") && rd.content[0].text.includes("阿澈（AI，就是你）"), "read_group 拿到 2 条新的");
rd = await tool(tok.fai, "read_group", {});
ok(rd.content[0].text.includes("没有新消息"), "再读：没有新的");
n = received().length;
const pg = await tool(tok.fai, "post_group", { text: "我在～ @小A 你好" });
ok(pg.content[0].text.startsWith("发出去了"), "post_group");
ok((await tool(tok.fai, "post_group", { text: "" })).isError, "空消息报错");
await sleep(400);
ok(received().length === n, "自己说话不叫自己");
s = await a("/api/state");
ok(s.j.messages.at(-1).author === "fai" && s.j.messages.at(-1).text.includes("@小A"), "小A 网页上看到 AI 的话");
await a("/api/send", { text: "看完了再叫你" });
await sleep(500);
ok(received().length === n + 1, "读过以后，人再说话又会叫");

console.log("叫醒方式");
await sleep(10500);   // 前面 小A 连发了几条，等限速窗口过去
await tool(tok.fai, "read_group", {});
await b("/api/wake", { ai: "fai", mode: "mention" });
n = received().length;
await a("/api/send", { text: "没点名" });
await sleep(400);
ok(received().length === n, "只在被 @ 时叫：没点名不叫");
await a("/api/send", { text: "@阿澈 出来一下" });
await sleep(400);
ok(received().length === n + 1, "@ 了就叫");
s = await b("/api/state?mine=1");
ok(s.j.mine[0].wakes.some((w) => w.outcome.includes("只在被 @ 时叫")), "设置里能看到没叫的理由");

console.log("限速");
await sleep(10500);
const r3 = [];
for (let i = 0; i < 4; i++) r3.push((await b("/api/send", { text: "刷屏" + i })).status);
ok(r3.join() === "200,200,200,400", "10 秒内第 4 条被挡");
const long = await a("/api/send", { text: "长".repeat(2001) });
ok(long.status === 400, "超过 2000 字被挡");

console.log(`\n${pass} 过，${fail} 没过`);
process.exit(fail ? 1 : 0);
