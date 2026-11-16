# Aru-kit

为 Aru 这个 iOS 手机应用做的一些项目和教程。转发请直接给 GitHub 地址，不能私传商用，二改只可私用。有建议可以提交，会更新改进。

作者 White-ting。每样都带中文教程，写给没有编程基础的人。

| 文件夹 | 是什么 | 教程 |
|---|---|---|
| [knock/](knock/) | knock 守门人：让 Aru 里的 TA 主动来找你（手机快捷指令报事件，守门人决定要不要叫醒 TA） | `knock/aru/教程.md` |
| [xinchao-aru/](xinchao-aru/) | 心潮念 → Aru 适配器：把心潮念里的动静递到 Aru 里的 TA | `xinchao-aru/教程.md` |
| [xinchao-gateway/](xinchao-gateway/) | 心潮念网关：Aru 的模型地址填它，接上"此刻"和对话回传（随适配器一起发） | `xinchao-gateway/教程.md` |
| [qun/](qun/) | 群服务：让人和 Aru 里的 AI 一起进一个群 | `qun/README.md` |

## 怎么拿

**照教程做的话，下载 [Releases](../../releases) 里的压缩包**：里面有排好版、双击就能打开的 `教程.html`（要复制的地方点一下就复制）和要用的程序。仓库里的是同一份源码。

每样的更新说明在各自文件夹的 `CHANGELOG.md`。

## 使用权限

- 可以自己部署、自己改着用。
- 原样的、改过的都**不许**转给别人，也不许传到网盘、群文件、别的仓库、帖子附件。想分享，请直接给这个仓库的地址。
- 不许商用（包括收费帮人搭）。
- 全文见各文件夹里的 `LICENSE`。其中 `seal.js` / 适配器里「加密投递」那一段改写自 [aru-host](https://github.com/Aevella/aru-host) 的 `wake-send.mjs`，那部分照 Apache-2.0（见 `LICENSE-APACHE`）。
- 2026-11-16 之前作者私下发出的压缩包，照它们自带的许可。

Aru、Aru Host、心潮念都是各自作者的项目；这里的东西是独立做的，跟它们没有隶属关系。

按原样提供，不提供任何担保。
