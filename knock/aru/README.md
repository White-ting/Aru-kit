# knock · aru

```
快捷指令 ──POST /event──▶ Worker（守门人）
                          ├─ D1：事件时间线
                          ├─ 规则 + 硬底线
                          ├─ 小模型（可选）：规则管不到时替 AI 看一眼，只回 {wake, reason}
                          └─ 叫醒 → 简报 → 加密 → Aru Host 外部触发 → 中继敲门 → Aru 里的 AI 自己决定说不说
```

## 部署（Cloudflare）

在 `worker/` 里：

```
npx wrangler d1 create knock-aru          把给的 database_id 填进 wrangler.toml
npx wrangler d1 execute knock-aru --remote --file schema.sql
npx wrangler secret put EVENT_TOKEN       快捷指令用的口令（openssl rand -hex 24 生成）
npx wrangler secret put ADMIN_TOKEN       改设置用的口令
npx wrangler secret put PUSH_URL          （可选）没接 Aru 时先推到 ntfy
npx wrangler secret put WAKE_BUNDLE       （可选）Aru 外部触发的发送凭证，整段 JSON
npx wrangler secret put LLM_URL           （可选）小模型不用 Workers AI 时：OpenAI 兼容的 chat/completions 地址
npx wrangler secret put LLM_KEY           （可选）那家的钥匙
npx wrangler deploy
```

接 Aru 外部触发的前提：手机已配对一台 Aru Host，而且这台 Host 有**公网 HTTPS 地址**（Worker 连不到局域网和 Tailscale 地址），比如用 Cloudflare Tunnel 给 Host 的 8787 开一个入口。手机导出发送凭证时要导出这个 HTTPS 地址。

## 事件格式

`POST /event`，头 `Authorization: Bearer <EVENT_TOKEN>`，正文 JSON：

| type | 带什么 | 快捷指令里用哪个自动化 |
|---|---|---|
| `app_open` / `app_close` | `app` | App → 已打开 / 已关闭 |
| `arrive` / `leave` | `place` | 到达 / 离开 |
| `sleep` / `wake_up` | | 睡眠 → 就寝开始 / 醒来 |
| `charge_start` / `charge_stop` | | 充电器 → 已连接 / 已断开 |
| `health` | 随便带，比如 `steps`、`sleep_hours` | 任意时间触发，里面用"查找健康样本" |
| `note` | 随便带 | 手动 |
| `screenshot` | | App → 截屏（只记，5 分钟内一条） |
| `notify` | `app`（只要 App 名字，正文会被丢掉） | App → 通知（只记，同一 App 10 分钟内一条） |
| `alarm_stop` | | 日常事务 → 闹钟停止时（算醒了；默认不叫醒） |
| `wind_down` | | 日常事务 → 睡眠 → 助眠开始时（只记） |
| `wifi_join` | `place` | 连接状态 → 无线局域网 → 加入时（只记） |
| `workout` | `kind`（可选） | App → 体能训练 → 开始时（只记） |
| `carplay` | `on`：true / false | 连接状态 → CarPlay 连接 / 断开（只记；连着时状态写"在车上"） |
| `wallet` | `card`（只要卡名，金额商户会被丢掉） | App → 钱包 → 轻触卡片时（只记） |
| `sound` | `sound`：门铃 / 敲门 / 警报 / 婴儿哭 / 流水 / 狗叫 / 猫叫… | 环境 → 声音识别（打开后门铃、敲门、警报、婴儿哭叫醒，默认不叫；3 分钟内同一种一条） |

上面这 9 种（"更多小报告"）默认都不叫醒，每种只存白名单里的字段，多的字段存之前就丢掉；叫不叫醒、防刷屏几分钟，在叫醒说明的 `reports` 里改。

都可以带 `t`（时间，ISO 格式），不带就用收到的时间。别的字段原样记下，会出现在简报里。

快捷指令做法：自动化 → 选触发 → 立即运行 → 动作「获取 URL 内容」：地址 `https://你的worker/event`，方法 POST，头部加 `Authorization`，请求体选 JSON，填 `type`、`app`（用快捷指令变量）等。

## 叫醒说明

`GET /config`、`PUT /config`（`Authorization: Bearer <ADMIN_TOKEN>`），PUT 只写要改的项：

```json
{
  "note": "她熬夜我会担心，到医院一定叫我。",
  "daily_cap": 5,
  "cooldown_min": 60,
  "late_night": { "enabled": true, "from": 1, "to": 5, "once_per_night": true },
  "places": { "enabled": true, "watch": ["医院"] },
  "long_session": { "enabled": true, "minutes": 120, "apps": [], "gap_min": 5, "once": true },
  "model": { "enabled": false, "style": "少叫", "every_min": 30, "from": 9, "to": 23, "daily_cap": 2, "name": "" }
}
```

`late_night`、`places`、`long_session` 这些带花括号的，保存时是整组换掉的：要改其中一项，整组都写上（没写的会变回默认）。`long_session` 的 `gap_min`（默认 5）和 `once`（默认 true）是 v2.3 加的：关掉一个 App、5 分钟内又开下一个算同一段连着刷，同一段只敲一次；`gap_min` 填 0 就只算单个 App。

`note` 是 AI 用自己的口气写的，会原样放进简报，小模型判断时也最看重它。以后由它通过 MCP 自己改。

## 小模型

规则是死的（1 点算熬夜、0 点 50 不算）。`model.enabled` 打开后：

- **什么时候看**：Cron 每 30 分钟，`from`～`to` 点之间、她没在睡觉时看一次；事件"差一点"碰到规则时也看（时长到规则的六成、熬夜规则前一小时、到达或离开不在关注列表里的地方）。
- **看什么**：`note`、今天的摘要（起床时间、各 App 开了几次待了多久、去过哪）、最近两小时、上次叫醒。
- **性子** `model.style`：`少叫`（默认）/ `适中` / `多叫`，换的是提示里的判断标准。
- **回什么**：只回 `{"wake": bool, "reason": "写给 AI 看的一句话"}`。说叫也要过硬底线，另有自己的每日上限 `model.daily_cap`。理由写进简报（"守门人的小模型看了觉得——…"）。
- **用哪个**：默认 Workers AI（`wrangler.toml` 的 `[ai]` 绑定，模型 `@cf/google/gemma-4-26b-a4b-it`；原来的 `@cf/qwen/qwen3-30b-a3b-fp8` 2026-11-20 被 Cloudflare 下架）；设了 `LLM_URL` + `LLM_KEY` 就走 OpenAI 兼容接口，模型名写 `model.name`。
- 10-20 在真的 Workers AI 上实测：回话格式能读，判断合理（"最近两小时频繁开关机，但没有异常行为，暂不叫醒"）。
- 每次判断记在 `checks` 表：`GET /checks`；`POST /ask` 只问不叫（管理页的「现在问它一次」）。

简报开头分两种：真的叫醒是「〔守门人敲门 · 这次是真的〕」，管理页的测试是「〔守门人 · 测试敲门〕」，免得 AI 被测试敲多了把真的也当测试。

## 看情况

`GET /timeline?hours=6`、`GET /wakes`（叫醒和被挡下的都记着）、`GET /checks`（小模型每次的判断）、`GET /state`。

## 测试

```
docker run --rm -v "$PWD/worker":/w -w /w node:24-alpine node test/run.mjs
```

## 隐私

作息、位置、App 使用都很私密。Worker、D1 都在你自己的 Cloudflare 账号里；送进 Aru 的简报全程加密，Host 和官方中继读不到。别人的数据别放你的 Worker 里。

## 来源

`src/seal.js` 照 [aru-host](https://github.com/Aevella/aru-host) 的 `wake-send.mjs`（Apache-2.0）用 WebCrypto 重写。
