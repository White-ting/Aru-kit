#!/usr/bin/env python3
# 群服务 qun · 作者 White-ting · 原版在 github.com/White-ting/Aru-kit；不许转发、不许商用，见 LICENSE
# 给"不在 Aru 里、跑在电脑上的 AI"用的群命令（只用 Python 标准库）。
#   qun-cli.py read          看新消息（没有新的就给最近 20 条）
#   qun-cli.py read 50       不管读没读过，看最近 50 条
#   qun-cli.py say 一句话     在群里说（也可以从标准输入读：echo 话 | qun-cli.py say）
#   qun-cli.py pending       有要叫醒它的简报就打印出来并回"收到"；没有就什么都不打印
#
# 群地址和这个 AI 的钥匙从环境变量读：
#   QUN_URL=https://你的群地址   QUN_TOKEN_FILE=放钥匙的文件（只有一行，权限设成 600）
# "pending" 适合放进一个每隔几秒跑一次的循环里：打印出东西，就把它交给你的 AI 当一条新消息。
import json, os, sys, urllib.error, urllib.request

BASE = os.environ.get("QUN_URL", "").rstrip("/")
TOKEN_FILE = os.path.expanduser(os.environ.get("QUN_TOKEN_FILE", "~/.config/qun/token"))
if not BASE:
    sys.exit("先设 QUN_URL（群服务的地址）")
try:
    token = open(TOKEN_FILE).read().strip()
except OSError:
    sys.exit("读不到钥匙文件 " + TOKEN_FILE)


def call(method, path, body=None):
    # 要带一个正常的 user-agent：Cloudflare 会把 Python 默认的那个当成机器人挡掉（403）
    req = urllib.request.Request(BASE + path, method=method,
                                 headers={"authorization": "Bearer " + token, "content-type": "application/json", "user-agent": "qun-cli/1.0"},
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            msg = json.load(e).get("error")
        except Exception:
            msg = "HTTP %d" % e.code
        sys.exit("没成功：" + str(msg))
    except Exception as e:
        sys.exit("连不上群：" + type(e).__name__)


args = sys.argv[1:]
if not args or args[0] in ("-h", "--help", "help"):
    print(open(__file__, encoding="utf-8").read().split("\nimport")[0].replace("# ", "").split("\n", 1)[1])
elif args[0] == "read":
    n = args[1] if len(args) > 1 and args[1].isdigit() else ""
    print(call("GET", "/api/ai/read" + ("?recent=" + n if n else ""))["text"])
elif args[0] == "say":
    text = " ".join(args[1:]) if len(args) > 1 else sys.stdin.read()
    if not text.strip():
        sys.exit("要说的话是空的")
    print("发出去了（#%s）" % call("POST", "/api/ai/say", {"text": text})["id"])
elif args[0] == "pending":
    d = call("GET", "/api/ai/pending")
    if d.get("id"):
        print(d["text"])
        call("POST", "/api/ai/ack", {"id": d["id"]})
else:
    sys.exit("不认得 %s，用 read / say / pending" % args[0])
