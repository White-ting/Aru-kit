#!/bin/zsh
# 11-24：打一个假构建号，看几处水印都换上了、合成的单文件照样过全部测试，最后打回 dev
setopt pipefail
cd "${0:A:h}/.." || exit 1
B=t3st
python3 build.py $B >/dev/null || exit 1
D=dist/worker.js
n=$(grep -c 'White-ting' $D); echo "单文件里 White-ting 出现 $n 次"
grep -q "BUILD = \"$B\"" $D && grep -q 'RULES_REV = "rts3t"' $D && grep -q '<main data-k="3stt">' $D || { echo "构建号没换全"; python3 build.py >/dev/null; exit 1; }
grep -qE 'RULES_REV = "dev"|data-k="dev"|BUILD = "dev"' $D && { echo "还留着 dev"; python3 build.py >/dev/null; exit 1; }
WORKER=../dist/worker.js WANT_REV=rts3t WANT_K=3stt node test/run.mjs | tail -2; r=$?
python3 build.py >/dev/null
exit $r
