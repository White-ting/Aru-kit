// 本机测试用：假装是 Aru Host 的外部触发接收口，收到就用密钥解开，把内容追加进 test/received.jsonl
import { createServer } from "node:http";
import { createDecipheriv } from "node:crypto";
import { appendFileSync } from "node:fs";

const [port, keyB64, token] = process.argv.slice(2);
const key = Buffer.from(keyB64, "base64");
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      if (req.headers.authorization !== `Bearer ${token}`) throw new Error("token 不对");
      const env = JSON.parse(body);
      const raw = Buffer.from(env.sealedPayload, "base64");
      const iv = raw.subarray(0, 12), tag = raw.subarray(raw.length - 16), ct = raw.subarray(12, raw.length - 16);
      const d = createDecipheriv("aes-256-gcm", key, iv);
      d.setAuthTag(tag);
      const payload = JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString());
      appendFileSync(new URL("./received.jsonl", import.meta.url), JSON.stringify(payload) + "\n");
      res.writeHead(202).end("{}");
    } catch (e) {
      appendFileSync(new URL("./received.jsonl", import.meta.url), JSON.stringify({ error: e.message }) + "\n");
      res.writeHead(400).end("{}");
    }
  });
}).listen(Number(port), "127.0.0.1");
