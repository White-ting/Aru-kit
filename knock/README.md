# knock（敲门）

让 AI 像自己想到了一样来找你。

手机上的小事（打开了什么 App、到了哪、睡了醒了）攒成一条时间线；守门人按 AI 自己写的「叫醒说明」判断值不值得叫醒它；醒来的它读完简报，**自己决定说不说、说什么**——也可以选择不说。

```
iPhone 快捷指令（打小报告）
      ↓
守门人（你自己的 Cloudflare Worker：记下来，规则 + 可选的小模型判断，硬底线兜着）
      ↓  值得的话，写一份简报，加密
Aru Host（只当门铃，读不到内容）
      ↓
Aru 里的 AI 被叫醒，自己决定找不找你
```

## 现在有哪些

- **[aru/](aru/)**：接 [Aru](https://github.com/Aevella/aru-host)（iPhone 上的 AI 协作者 App）的那一支。
  - **小白教程：[aru/教程.md](aru/教程.md)**，从域名、隧道、触发器、守门人、快捷指令到小模型，一步一步来。可以把全文复制给 AI，让它带着你装。
  - 部署和接口说明：[aru/README.md](aru/README.md)。

以后要接别的 App，再开别的目录，规则可以共用。

## 实测过的

- 快捷指令报事件 → 守门人 → Aru Host 外部触发 → 手机上的 Aru 被叫醒，整条链在真机上跑通过。
- Aru 里的 AI 读完简报后**选择了不说**（它判断"现在没必要打扰她"），并自己记下了为什么。
- 小模型在真的 Workers AI（Qwen3）上跑通过：它看了最近两小时"频繁开关 App、但没有异常"，判断不叫。

## 隐私

作息、位置、App 使用都很私密：所有记录只存在**你自己的** Cloudflare 账号里，14 天后自动删；送进 Aru 的简报全程端到端加密。别把别人的数据放进你的守门人。

## 许可证

可以自己部署、自己改着用；原样的、改过的都不许转给别人或传到别处，想分享请给仓库地址 github.com/White-ting/Aru-kit。不许商用。全文见 [LICENSE](LICENSE)。`aru/worker/src/seal.js` 改写自 aru-host 的 `wake-send.mjs`，这部分照 Apache-2.0（[LICENSE-APACHE](LICENSE-APACHE)），见 [NOTICE](NOTICE)。更新记录见 [CHANGELOG.md](CHANGELOG.md)。
