"""把 src/ 的四个文件合成一个 dist/worker.js：在 Cloudflare 网页后台建 Worker 时整段粘贴进去就行。"""
import os
import re
import sys

here = os.path.dirname(os.path.abspath(__file__))
build = sys.argv[1] if len(sys.argv) > 1 else "dev"   # 构建号：打包时按拿到的人给一个，记在发放记录里（11-01 加水印）
if not re.fullmatch(r"[0-9a-z]{1,12}", build):
    sys.exit("构建号只能是小写字母和数字")
idx = open(os.path.join(here, "src", "index.js"), encoding="utf-8").read()
ver, rel = re.search(r'VERSION = "([^"]+)", RELEASED = "([^"]+)"', idx).groups()
parts = ["// knock 守门人 v%s（%s）· White-ting · 构建 %s\n" % (ver, rel, build) +
         "// 原版在 github.com/White-ting/Aru-kit。合成的单文件，别直接改这里，改 src/ 再跑 python3 build.py\n"
         "// 使用权限：可以自己部署、自己改着用；不许转给别人或传到别处（分享请给 github.com/White-ting/Aru-kit）；不许商用。\n"
         "// 全文见 LICENSE。其中「seal.js」一段改写自 aru-host 的 wake-send.mjs（https://github.com/Aevella/aru-host），照 Apache-2.0（不受上面限制），见 LICENSE-APACHE。\n"]
for name in ("rules.js", "seal.js", "model.js", "index.js"):
    s = open(os.path.join(here, "src", name), encoding="utf-8").read()
    s = re.sub(r"^import [^;]*?;\n", "", s, flags=re.M)           # 去掉文件之间的 import（可以跨行）
    s = re.sub(r"^export (const|function|async function)", r"\1", s, flags=re.M)
    if name == "index.js":
        s = s.replace('BUILD = "dev"', 'BUILD = "%s"' % build, 1)
    parts.append("\n// ===== %s =====\n%s" % (name, s))
os.makedirs(os.path.join(here, "dist"), exist_ok=True)
open(os.path.join(here, "dist", "worker.js"), "w", encoding="utf-8").write("".join(parts))
print("dist/worker.js", sum(len(p) for p in parts), "字")
