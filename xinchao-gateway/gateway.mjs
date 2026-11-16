#!/usr/bin/env node
// 心潮念网关 —— 主程序。启动：node gateway.mjs
// 思路参考了 dylan-heartbeat（Kelivo 网关），代码是重写的。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, checkConfig } from './lib/config.mjs';
import { createGateway } from './lib/server.mjs';
import { makeLogger } from './lib/log.mjs';
import { VERSION } from './lib/version.mjs';

export { createGateway, loadConfig, VERSION };

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20 || (major === 20 && minor < 6)) {
    console.error(`需要 Node.js 20.6 以上，现在是 ${process.versions.node}`);
    process.exit(1);
  }
  const cfg = loadConfig({ baseDir: here });
  const problems = checkConfig(cfg);
  if (problems.length) {
    console.error('配置有问题（.env）：\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
  const log = makeLogger({ level: cfg.logLevel });
  const gw = createGateway({ cfg, log });
  const addr = await gw.listen();
  // 有透传的那一组，地址里要带口令。这里只写占位，不把口令打出来
  const split = !!cfg.anthropicUpstreamUrl;
  const anyPt = cfg.passthrough || (split && cfg.anthropicPassthrough);
  const base = anyPt ? `http://${addr.address}:${addr.port}/<GATEWAY_KEY>/v1` : `http://${addr.address}:${addr.port}/v1`;
  const mode = !split
    ? (cfg.passthrough ? '透传模式，' : '')
    : `按格式分上游：/v1/messages ${cfg.anthropicPassthrough ? '透传' : '用钥匙'}、其他 ${cfg.passthrough ? '透传' : '用钥匙'}，`;
  console.log(`心潮念网关 ${VERSION} 已启动：${base}`
    + `（${mode}此刻 ${cfg.nowEnabled ? '开' : '关'}，回传 ${cfg.eventEnabled ? '开' : '关'}，心潮超时 ${cfg.xinchaoTimeoutMs}ms）`);
  if (cfg.channels.length) {
    console.log(`渠道：${cfg.channels.map((c) => c.name + (c.passthrough ? '（透传）' : '')).join('、')}。地址写 http://${addr.address}:${addr.port}/<渠道名>/v1；不写渠道名走 UPSTREAM_URL`);
  }
  const stop = () => { console.log('正在关闭…'); gw.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
