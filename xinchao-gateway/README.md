# 心潮念网关 xinchao-gateway

版本 0.1.11 · 作者 White-ting · 构建 dev

> **使用权限**：可以自己部署、自己改着用；原样的、改过的都不许转给别人或传到别处，想分享请给仓库地址 github.com/White-ting/Aru-kit。不许商用（包括收费帮人搭）。全文见 LICENSE。

思路参考了 dylan-heartbeat（Kelivo 网关），代码是重写的。

---

## 这是什么

心潮念（xinchao-nian）是一个给 AI 伴侣算"动态状态"的服务：他的想念、情绪、驱力都由它来算。心潮和 AI 之间要接三根线：

1. **桥**：心潮主动去找 AI。这根线早就做好了，和这个网关没关系，桥照常工作。
2. **此刻**：她每发一句话之前，先给心潮报一次心跳，再取一小块"此刻"状态，附在她这句话后面一起交给模型。这样他回话的时候知道自己此刻的状态。
3. **回传**：他回完以后，把"她说 + 他回"这一轮发给心潮，心潮自己判断这算什么互动。

Claude Code 有钩子，能自己接第 2、3 根线。Aru、Kelivo 这类聊天 App 没有钩子，但都能自己填"模型服务地址"。这个网关就是给它们用的：App 的地址填成网关，网关把请求原样转给真正的模型，路上顺手把第 2、3 根线接好。

```
App ──→ 网关 ──→ 上游（真正的模型 API，或者另一个网关）
App ←── 网关 ←── 上游
          ↕
        心潮念
```

几个要点：

- **心潮出问题不影响聊天。** 心潮没开、太慢（每次最多等 3 秒）、报错，网关都照常转发，最多多等一个超时。
- **只改她最新那一句。** "此刻"只附在最后一条用户消息后面，前面的聊天记录一个字都不动，所以不会破坏上游的提示缓存。
- **回复原样转。** 模型回的每一块都原样、立刻转给 App，流式（打字机效果）照常。
- **日志不记内容。** 日志里只有时间、做了哪一步、成功还是失败、用了多久、字数。不记聊天内容，不记任何钥匙和口令。
- **只接 OpenAI 兼容格式**：`/v1/chat/completions`、`/v1/models`，大多数 App 都是这种。程序里还留着 Anthropic 格式（`/v1/messages`）和透传、分上游的代码（0.1.2 加的），但没有真机测过，不提供、不教，见下面「没有做的」。

## 第一步：装 Node.js

需要 **Node.js 20.6 或更高**。不用装任何别的东西，也不用 `npm install`。

在终端里输入 `node --version` 看版本：
- 显示 `v20.6.0` 或更大的数字（比如 `v22.x`），就可以了。
- 没有 Node，或者版本太低，就去 https://nodejs.org 下载 LTS 版装上。

## 第二步：填 `.env`

在 `xinchao-gateway` 文件夹里：

```bash
cp .env.example .env
```

用文本编辑器打开 `.env`，至少改这几项：

| 名字 | 填什么 |
|---|---|
| `GATEWAY_KEY` | 自己编一串够长的随机字符。App 里"API Key"那一栏就填这个。可以用这条命令生成：`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` |
| `UPSTREAM_URL` | 真正的模型服务地址，写到 `/v1` 为止，例如 `https://api.example.com/v1`。如果你已经在用别的网关（比如记忆网关），这里就填那个网关的地址，两个叠着用。 |
| `UPSTREAM_KEY` | 上游的钥匙，也就是原来填在 App 里的那串。从现在起它只存在这台电脑上，不再交给 App。 |
| `XINCHAO_URL` | 心潮念的地址，例如 `http://127.0.0.1:18110` |
| `XINCHAO_TOKEN` | 心潮的口令，也就是心潮 `.env` 里的 `DYNAMIC_MIND_TOKEN` |

其他项都有默认值，`.env.example` 里每一项都写了中文说明。常用的几个：
- `NOW_ENABLED` / `EVENT_ENABLED`：分别控制"此刻"和"回传"两根线，默认都开。
- `XINCHAO_TIMEOUT_MS`：每次找心潮最多等多久，默认 3000 毫秒。
- `ONLY_STREAM`：见下面的「常见问题」。

`.env` 里有钥匙，不要发给别人，也不要传到网上。`.gitignore` 已经把它排除了。

## 第三步：启动

```bash
cd xinchao-gateway
node gateway.mjs
```

看到下面这行就是启动好了：

```
心潮念网关 0.1.11 已启动：http://127.0.0.1:8790/v1（此刻 开，回传 开，心潮超时 3000ms）
```

如果 `.env` 有漏填的项，它会用中文告诉你缺什么，然后退出。

停止网关就在终端里按 `Ctrl + C`。想让它一直在后台跑，可以用 macOS 的 launchd、Linux 的 systemd，或者 `pm2`，和启动心潮的方法一样。

## 第四步：App 里怎么填

在 App 的"自定义模型服务 / OpenAI 兼容"设置里：

- **服务地址（Base URL）**：`http://网关地址:8790/v1`
  - App 和网关在同一台电脑上：`http://127.0.0.1:8790/v1`
  - 给手机用：填 HTTPS 地址，见下一节
- **API Key**：`.env` 里的 `GATEWAY_KEY`
- **模型名**：照原来的填。网关不改模型名，原样转给上游。

### 多个中转站换着用（0.1.4）

`.env` 里每家写两行，名字只用大写字母和数字：

```
UPSTREAM_JUMENG_URL=https://聚梦的地址/v1
UPSTREAM_JUMENG_KEY=聚梦的钥匙
UPSTREAM_NOIR_URL=https://noir的地址/v1
UPSTREAM_NOIR_KEY=noir的钥匙
```

重启一次网关，启动时会多一行 `渠道：jumeng、noir`。之后 App 的地址写：

- `https://你的地址/jumeng/v1` → 走聚梦（换上聚梦的钥匙）；
- `https://你的地址/noir/v1` → 走 noir；
- `https://你的地址/v1` → 照旧走 `UPSTREAM_URL`。

想换哪家，在 App 里改地址（或者建几个供应商各填一个）就行，网关不用再改。API Key 一律填 `GATEWAY_KEY`。此刻、回传、节流是同一份，不管从哪家出去，心潮看到的都是同一个她。日志里 `request ok … ch=jumeng` 写着走的是哪家。某一家的钥匙写成 `passthrough`，那一家就用 App 自己带的钥匙，网关口令改写在地址里：`https://你的地址/你的GATEWAY_KEY/那一家/v1`。


## 给手机用：外面一定要套 HTTPS

手机上的 App 要通过网络连到这台电脑上的网关。**千万不要把 `http://` 网关直接暴露到公网**，否则口令和聊天内容都是明文在网上传。

推荐用 Cloudflare 的免费隧道 cloudflared：

1. 装 cloudflared：macOS 用 `brew install cloudflared`，其他系统看 Cloudflare 官网。
2. `.env` 里的 `HOST` 保持 `127.0.0.1`。隧道就在这台电脑上，不需要改成 `0.0.0.0`。
3. 运行 `cloudflared tunnel --url http://127.0.0.1:8790`，它会给你一个 `https://xxxx.trycloudflare.com` 的地址。
4. 手机 App 的服务地址填 `https://xxxx.trycloudflare.com/v1`，API Key 照样填 `GATEWAY_KEY`。

注意：
- 临时隧道的地址每次重启都会变。想要固定地址，就在 Cloudflare 里建一个正式的 named tunnel，绑你自己的域名。
- 反向代理（Caddy、nginx）跟网关在同一台机器上的，`HOST` 也保持 `127.0.0.1`。只有反代在另一台机器上、或者只在家里局域网用时，才改成 `0.0.0.0`，而且要确认防火墙没把 8790 放到外网。
- 不管哪种方式，`GATEWAY_KEY` 都要够长、够随机。

## App 塞进她那句的附注（0.1.4）

Aru 在一条消息带附注的时候，会往她的话里加东西（0.1.6 照真机日志核过）：

- **发送时间**：她那句后面另起一行，写成只有开头的单个标签 `<sent_at 2026-11-06 21:46>`；
- **环境信息**：拆成单独一条消息，紧跟在她那条后面，整块包在 `<environment>…</environment>` 里，能有两千多字。
网关在**回传给心潮、判断是不是桥递来的、是不是后台杂活**之前，先把这种成对的标签整块去掉，只留她自己打的字；**发给模型的那份不动**，TA 照样看得到时间和环境。

- 默认 `STRIP_TAGS=*`：所有成对的 `<英文标签>…</英文标签>` 和单独的 `<标签/>` 都去掉。也可以只写几个：`STRIP_TAGS=environment|sent_at`；写 `STRIP_TAGS=`（空）就不去。
- 只有开头没有结尾的单个标签（`<sent_at …>`）也去掉。
- "她这一轮说了什么"＝最后一条 TA 的回复之后、她连着发的那几条，每条去掉附注再拼起来。所以她的话在前一条、环境在后一条也取得到。
- 这一轮去掉附注以后一个字都不剩（只有附注、没有她的话），不算她在说话：日志 `turn ok kind=skip why=annotation`，不报心跳、不回传。
- `STRIP_TAGS=` 留空时什么都不去，跟 0.1.3 一样。
- **0.1.11 起另外认三种 Aru 自己写、用她的身份发的英文消息**（Aru Host 0.39）：
  - 引用回复：开头 `[Replying to quoted text · reference data]`，换行一段 JSON（被引用的那句、编号），再一行短方括号，然后才是她的话。这几层整块去掉，只回传她的话；只引用、没说话的不算她在说话。
  - 桥叫醒：`External event data, not an authored user message…`，不算她在说话（`turn ok kind=skip why=external`）。
  - 工具取回的图：`Images returned by the completed tool call…` 单独一条，当工具回合，跟她前面那句配成一轮回传（`turn ok kind=tool after=tool-note`）。别的开头写进 `TOOL_PREFIXES`（用 `|` 分隔）。
  - 以后 Aru 再出新写法：开 `DEBUG_SHAPE=2` 抓骨架发给作者；等不及的话，桥那类加进 `SKIP_PREFIXES`、工具那类加进 `TOOL_PREFIXES`。
- 想核对：开 `DEBUG_SHAPE=1`，日志多一行 `shape ok clean=26 raw=2650 n=1`：`clean` 是去掉附注后几个字，应该跟她打的差不多；`raw` 是这一轮她那几条原来一共几个字；`n` 是去掉附注后还有字的有几条。**`clean` 跟 `raw` 一样大，就是一个字都没去掉**：附注不是成对标签的写法。开 `DEBUG_SHAPE=2` 再多记一行 `skel`（她那句话的骨架：标签名照写、属性值遮成 `…`、文字只留字数），把那几行发给作者看写法。

## 没有做的：Anthropic 格式、订阅账号

0.1.2 给"Aru 里用订阅账号登录 Claude"的人加过透传模式（`UPSTREAM_KEY=passthrough`、地址里带口令）和按格式分上游（`ANTHROPIC_UPSTREAM_*`），代码和测试都还在。但真机测试时发现 **Aru 只肯把订阅凭证发给 api.anthropic.com**，地址换成网关就在 Aru 里被拦下（`Claude subscription credentials can only be sent to api.anthropic.com`），请求根本到不了网关。Anthropic 格式也没有人用真实上游测过。所以从 0.1.3 正式版起**只提供 OpenAI 兼容格式**，这几项不教、不建议用。

订阅登录的那个模型保持直连；它的回传照《心潮念 → Aru 适配器》教程第 8 步，让 TA 用心潮念的工具自己记。

## 怎么确认通了

1. **网关活着吗**：浏览器打开 `http://127.0.0.1:8790/healthz`，看到 `{"ok":true,"version":"0.1.11","build":"dev","by":"White-ting"}` 就是活着。这个地址不用口令。
2. **在 App 里发一句话**，然后看网关的终端。正常的话会出现这样几行（每行开头是时间）：

```
… turn ok kind=her chars=6            ← 认出是她在说话，这句 6 个字
… heartbeat ok status=200 ms=8        ← 心跳报上了
… now ok status=200 ms=5              ← 取到了此刻
… now-attach ok chars=42              ← 附上了（42 个字）
… request ok path=/v1/chat/completions status=200 ms=2310 stream=1
… event ok status=200 ms=9            ← 回传成功
```

3. **几种常见的"没有发生"**（每行第三个词：`ok` 做成了、`skip` 照规矩跳过、`wait` 等工具走完、`fail` 才是真出错；0.1.10 起这样分）：
   - `event wait why=tool-calls`：TA 这一轮去调工具了，等工具走完再把她那句和最后的回复配成一轮回传。
   - `now-attach skip why=throttled`：只在 `.env` 里把 `NOW_REPEAT_MIN` 改大了才会有：内容和上次一样，这么多分钟内不重复附。默认（0）每轮都附，不会出现。
   - `now-attach skip why=gate`：心潮给的内容没通过检查（太长、行太多、带了数字小数或英文键名），这次没附。也是正常的。
   - `event skip why=throttled`：回传太频繁，这次跳过。规则是两次至少隔 8 分钟、每小时最多 4 次；她隔了 45 分钟以上才说的第一句一定发。
   - `heartbeat fail why=timeout` 或 `why=error`：心潮没开或者太慢。聊天不受影响，但这一轮没有此刻。
   - `turn ok kind=skip`：这句以 `【` 或 `〔心潮念` 开头（桥递进来的消息），按规则跳过。
   - `turn ok kind=tool`：工具调用的中间回合，跳过。
   - `turn ok kind=background`：App 在后台起标题、摘要这类杂活，跳过（见「常见问题」）。
   - `event fail why=empty-reply`：模型这一轮的正文是空的，没什么可回传，就跳过了。常见原因是 `max_tokens` 设得太小、被模型的思考吃光了，正文一个字没剩；把 App 里的回复长度调大就好。
   - `auth fail status=401`：App 里的 API Key 和 `GATEWAY_KEY` 对不上。

## 常见问题

**App 报 401。**
App 里的 API Key 要填 `GATEWAY_KEY`，不是上游的钥匙。改过 `.env` 以后要重启网关。

**App 报 502。**
网关连不上上游。检查 `UPSTREAM_URL` 有没有写错，要写到 `/v1` 为止。

**App 报 413。**
发的东西太大（多半是图片）。把 `MAX_BODY_MB` 调大一点。

**上游返回的错误（比如 429 额度用完、400 参数不对）。**
网关原样转给 App，状态码和内容都一样，所以 App 里看到的错误就是上游的错误。

**有的 App 会偷偷用同一个地址"起标题、整理记忆"，被当成她在说话了。**
0.1.1 起网关自己会挡两种，日志里写 `turn ok kind=background`：
- 请求里限了很小的回复长度（`max_tokens` 不超过 `BG_MAX_TOKENS`，默认 120）。起标题、摘要一般只要几十个字，正常聊天不会这么限。
- 请求里一条 AI 的回复都没有（单发的），而且系统提示或这句话里有"标题、摘要、总结、title、summary"这类词（`BG_PATTERNS` 可以改）。正常聊天都带着前面的对话，所以你在聊天里说"帮我总结一下"照样算你在说话。

还是有漏网的（日志里那一下明明是 App 在后台干活，却写着 `kind=her`），再看下面这条：
如果后台请求是非流式的、而聊天本身是流式的，可以在 `.env` 里写 `ONLY_STREAM=true`，网关就只认流式请求。**打开前一定先确认你的 App 聊天确实是流式的**（回复是一个字一个字蹦出来的那种）：聊天要是非流式的，打开以后两根线就都不工作了，日志里会一直没有 `kind=her`。

**心潮关掉了，聊天会不会坏？**
不会。心潮连不上、超时、报错，网关都照常转发。最多多等 `XINCHAO_TIMEOUT_MS`（默认 3 秒）。如果心潮要长时间关着，可以把 `NOW_ENABLED` 和 `EVENT_ENABLED` 都设成 `false`，连这 3 秒都省了。

**"此刻"每一句都附吗？**
0.1.3 起默认每一句都附，贴在她那句的最后，每轮多几百字的输入。缓存只差上一轮那一小段（上一轮发出去的带着此刻，App 记录里的没带），更早的不受影响。原因：网关只改发出去的那一份，Aru 这类 App 自己存的聊天记录里没有此刻，下一轮 AI 就看不到了。0.1.2 和更早的版本"同样的内容 30 分钟内只附一次"，结果 AI 大部分轮次都看不到此刻（测试反馈 ca3e）。你的 App 会把发出去的整份存进记录的，可以在 `.env` 写 `NOW_REPEAT_MIN=30` 回到旧规矩（她隔了 `NOW_FORCE_GAP_MIN` 分钟以上才说的那一句一定附）。

**用到工具调用的那一轮会回传吗？**
会，等工具调用全部走完、他说完最后一段话以后，才把她那句和他最后的回复配成一轮回传。中间回合不回传。她说完那句以后 15 分钟内走完的工具回合都算这一轮（0.1.3 起不再要求记录里她那句跟当时一字不差，Aru 每次往里塞的东西不一样）。配不上时日志写原因：`event skip why=tool-no-pending`（没有在等的那一句）、`why=tool-expired`（超过 15 分钟）。

**想看 App 往她那句里塞了什么？**
`.env` 写 `DEBUG_SHAPE=1`，重启网关。她每说一句，日志里多两行 `shape`，只有数字和标签名，没有正文：
- `msgs` 总共几条消息，`sys` 系统提示几个字；
- `parts` 她这条分几块、每块几个字（图片之类写类型）；
- `segs` 按空行切开，每段几个字。她只打了三十来字、最后一段是 30 左右，就是塞的东西在前面；
- `hist` 前三条她的消息各几个字。也很长的话，说明 App 存进记录的也带着塞的东西；
- `tags` 出现的 `<标签>` 名字。
看完改回 `0`。

**重启网关以后节流会不会乱？**
不会。节流状态存在 `state/gateway-state.json`（或者你在 `STATE_DIR` 里指定的位置），重启以后还在。

**怎么跑测试？**
在 `xinchao-gateway` 文件夹里运行 `node --test`。测试会在本机起一个假上游和一个假心潮，不连外网，也不碰你真的心潮。

## 文件说明

| 文件 | 干什么 |
|---|---|
| `gateway.mjs` | 主程序，`node gateway.mjs` 启动 |
| `lib/server.mjs` | 转发、接两根线 |
| `lib/turn.mjs` | 判断是不是她在说话、附此刻、硬门检查、从回复里取文字 |
| `lib/state.mjs` | 节流状态（内存里一份，`state/` 里存一份） |
| `lib/xinchao.mjs` | 找心潮的三个请求（心跳、此刻、回传），都带超时 |
| `lib/config.mjs` | 读 `.env` |
| `lib/log.mjs` | 日志（不记正文） |
| `lib/version.mjs` | 版本号 |
| `test/` | 测试 |
| `.env.example` | 配置模板 |
