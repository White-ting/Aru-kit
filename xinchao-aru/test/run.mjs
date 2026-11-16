// 本机测试：假 Aru Host（验口令、解密）+ 用心潮念官方桥的 deliverToInjector 调适配器。
// node test/run.mjs <心潮念官方桥 src 目录>
import http from "node:http";
import { createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";

const BRIDGE_SRC = process.argv[2];
const { deliverToInjector } = await import(join(BRIDGE_SRC, "injector.js"));
const dir = mkdtempSync(join(tmpdir(), "xa-"));
const key = randomBytes(32), token = randomBytes(16).toString("hex");
const got = [];
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    if (req.headers.authorization !== "Bearer " + token) { res.writeHead(401); return res.end(); }
    const e = JSON.parse(b), raw = Buffer.from(e.sealedPayload, "base64");
    const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12)); d.setAuthTag(raw.subarray(raw.length - 16));
    const p = JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8"));
    got.push({ ...p, outer: e.eventId }); res.writeHead(202); res.end("{}");
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${srv.address().port}/aru/v1/wake-bridge/endpoints/x/events`;
const bundleFile = join(dir, "bundle.json");
writeFileSync(bundleFile, JSON.stringify({ schema: "aru.wake-bridge.sender-bundle.v2", triggerId: "trig-123456", submitURL: url, submitToken: token, encryptionKey: key.toString("base64") }));
const ADAPTER = new URL("../aru-adapter.mjs", import.meta.url).pathname;
process.env.ARU_BUNDLE_FILE = bundleFile;
process.env.XINCHAO_ADAPTER_STATE_DIR = join(dir, "state");
process.env.ARU_ADAPTER_TEST_ALLOW_HTTP = "1";
const config = { injector: { mode: "process", executable: process.execPath, args: [ADAPTER] }, timeouts: { injectMs: 30000 } };
let pass = 0, fail = 0;
const ok = (c, w) => { c ? pass++ : fail++; console.log(c ? "通过" : "失败", w); };
const env = (id, reason, message) => ({ protocol: "xinchao-runtime-wake/1", deliveryId: id, reason, message });

ok(execFileSync(process.execPath, [ADAPTER, "check"], { encoding: "utf8" }).includes("…123456"), "check 认得出发送凭证");
await deliverToInjector(env("01JTESTSELF0001", "self_signal", "想她了。"), config, {});
ok(got.length === 1 && got[0].content.includes("【心潮】想她了。") && got[0].content.includes("你自己在心潮里浮上来") && got[0].triggerId === "trig-123456", "self_signal 投到了、解得开、写明是他自己的");
ok(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(got[0].eventId) && got[0].eventId === got[0].outer, "事件编号是 UUID 的样子，里外一致");
await deliverToInjector(env("01JTESTCABIN001", "user_interaction", "她  抱了你一下"), config, {});
ok(got.length === 2 && got[1].content.includes("【小屋桥·互动】她 抱了你一下（小屋桥递的") && got[1].content.includes("不是她在 Aru 里发的"), "小屋互动照官方的样子渲染");
await deliverToInjector(env("01JTESTCABIN001", "user_interaction", "她  抱了你一下"), config, {});
ok(got.length === 2, "同一条再来一次不重投（回执丢了的情况）");
const before = got.length;
writeFileSync(bundleFile, JSON.stringify({ schema: "aru.wake-bridge.sender-bundle.v2", triggerId: "trig-123456", submitURL: url, submitToken: "wrong", encryptionKey: key.toString("base64") }));
let err = "";
try { await deliverToInjector(env("01JTESTWRONG001", "user_note", "留一句"), config, {}); } catch (e) { err = e.message; }
ok(err.includes("不认这份发送凭证") && got.length === before, "口令不对：桥收到失败和原因，不算送到");
process.env.ARU_ADAPTER_TEST_ALLOW_HTTP = "0";
writeFileSync(bundleFile, JSON.stringify({ schema: "aru.wake-bridge.sender-bundle.v2", triggerId: "trig-123456", submitURL: url, submitToken: token, encryptionKey: key.toString("base64") }));
err = ""; try { await deliverToInjector(env("01JTESTHTTP0001", "user_note", "留一句"), config, {}); } catch (e) { err = e.message; }
ok(err.includes("https"), "正式用时只认 https 的 Host 地址");
process.env.ARU_ADAPTER_TEST_ALLOW_HTTP = "1";
const t = (await promisify(execFile)(process.execPath, [ADAPTER, "test", "你好"], { encoding: "utf8" })).stdout;   // 要异步：同步会卡住这个进程里的假 Host
ok(t.includes("收下了") && got.at(-1).content.includes("测试") && got.at(-1).content.includes("你好"), "test 能发测试");
srv.close(); rmSync(dir, { recursive: true, force: true });
console.log(fail ? `${fail} 项失败` : `全部通过（${pass} 项）`);
process.exit(fail ? 1 : 0);
