# Aru-kit

为 Aru 这个 iOS 手机应用做的一些项目和教程。转发请直接给 GitHub 地址，不能私传商用，二改只可私用。有建议可以提交，会更新改进。

作者 White-ting。每样都带中文教程，写给没有编程基础的人。

| 文件夹 | 是什么 | 教程 |
|---|---|---|
| [knock/](knock/) | knock 守门人：让 Aru 里的 TA 主动来找你（手机快捷指令报事件，守门人决定要不要叫醒 TA） | `knock/aru/教程.md` |
| [xinchao-aru/](xinchao-aru/) | 心潮念 → Aru 适配器：把心潮念里的动静递到 Aru 里的 TA | `xinchao-aru/教程.md` |
| [xinchao-gateway/](xinchao-gateway/) | 心潮念网关：Aru 的模型地址填它，接上"此刻"和对话回传（随适配器一起发） | `xinchao-gateway/教程.md` |
| [qun/](qun/) | 群服务：让人和 Aru 里的 AI 一起进一个群 | `qun/README.md` |

## 另外：在 Aru 里和 TA 一起听歌（music-ears，单独的仓库）

[music-ears](https://github.com/White-ting/music-ears) 把一首歌拆开、量出来，写成一张给 AI 读的「乐谱卡」：调、拍速、和弦、每句的旋律、换气、长音，再加上模型听出来的感觉。TA 听不见声音，但读了卡就能跟你聊到具体哪一句。它还带一个黑胶播放器：在 Aru 里当网页应用打开，放网易云的歌，点「一起听」，TA 就知道你放到哪一句了，还能给你点歌。

- 跟上面几样不同，它要跑在**一台常开的电脑**上（Windows、Mac 都行，要装 Docker），第一次装大约 1～2 小时。听感要模型钥匙，不配也能先只量不听。
- 已经有人在 Windows 上装好、接进了 Aru。卡住了请到那个仓库的 Issues 问。
- 教程在那个仓库的 [`docs/教程-aru.md`](https://github.com/White-ting/music-ears/blob/main/docs/教程-aru.md)。
- 它的许可是 **MIT**：可以自由使用、修改、转给别人，保留署名就行，不受本仓库下面「使用权限」那几条管。

## 怎么拿

**照教程做的话，下载 [Releases](../../releases) 里的压缩包**：里面有排好版、双击就能打开的 `教程.html`（要复制的地方点一下就复制）和要用的程序。仓库里的是同一份源码。

每样的更新说明在各自文件夹的 `CHANGELOG.md`。

## 最近更新

- **2026-11-24 knock 守门人 v2.4**：快捷指令换了做法——先建两个共用快捷指令「knock上报」「knock补发」，以后每条自动化只要「字典 + 运行 knock上报」两步，断网时报告先存在手机里，连上 Wi-Fi 或充电时自动补发（教程第 6 步，配了截图）；起床、关专注模式那条漏跑一次不再卡一整天；晚到 1 小时以上的报告只记不敲门，同一条补发两遍只记一次；开了小模型的少问几次。旧的快捷指令照样能用。已装好的照教程 4.3 换 `worker.js`、点 Deploy。详见 [knock/CHANGELOG.md](knock/CHANGELOG.md)。
- **2026-11-23 knock 守门人 v2.3.1**：修一处——开了小模型的，「刷太久差一点」同一段只问一次小模型（v2.3 来回切 App 时每关一次都问，白花额度）。没开小模型的可以不换。
- **2026-11-23 knock 守门人 v2.3**：「刷太久」把几个 App 接起来算——关掉一个 App、5 分钟内又打开下一个，算同一段连着刷，从最早那次打开算起；同一段只敲一次，放下手机超过 5 分钟、重新开始一段才再算。叫醒说明 `long_session` 里多了 `gap_min`（默认 5，填 0 = 只算单个 App）和 `once`（默认 true）；改 `long_session` 要整块写全。已装好的照教程 4.3 换 `worker.js`、点 Deploy。详见 [knock/CHANGELOG.md](knock/CHANGELOG.md)。
- **2026-11-22 心潮念网关 0.1.16**：新开关 `NOW_MODE`。默认 `always` 照旧每句贴此刻；写 `NOW_MODE=signal` 是临界点模式，只在有驱力新到「涌」、情绪变了、冒出念头/还在气/矛盾/刚醒/睡着、她隔了 90 分钟以上才说话时贴，对话照常回传。换 `xinchao-gateway/lib/`、重启网关。详见 [xinchao-aru/CHANGELOG.md](xinchao-aru/CHANGELOG.md)。

## 使用权限

以下只管本仓库里的文件（music-ears 照它自己的 MIT）。

- 可以自己部署、自己改着用。
- 原样的、改过的都**不许**转给别人，也不许传到网盘、群文件、别的仓库、帖子附件。想分享，请直接给这个仓库的地址。
- 不许商用（包括收费帮人搭）。
- 全文见各文件夹里的 `LICENSE`。其中 `seal.js` / 适配器里「加密投递」那一段改写自 [aru-host](https://github.com/Aevella/aru-host) 的 `wake-send.mjs`，那部分照 Apache-2.0（见 `LICENSE-APACHE`）。
- 2026-11-16 之前作者私下发出的压缩包，照它们自带的许可。

Aru、Aru Host、心潮念都是各自作者的项目；这里的东西是独立做的，跟它们没有隶属关系。

按原样提供，不提供任何担保。
