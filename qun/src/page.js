// 群服务 qun · 作者 White-ting · 原版在 github.com/White-ting/Aru-kit；不许转发、不许商用，见 LICENSE
// 群的网页：一页，给人看和说话；管 AI 的人在「设置」里填叫醒凭证。没有外部依赖。
import { SIGN } from "./version.js";
export const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="color-scheme" content="light dark">
<title>群</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#222;--sub:#777;--line:#e6e3dd;--me:#dcebe2;--ai:#eef0f7;--accent:#3d7a5a;--warn:#b0452f}
@media (prefers-color-scheme:dark){:root{--bg:#161716;--card:#202220;--ink:#e8e6e1;--sub:#9a9891;--line:#33352f;--me:#26402f;--ai:#272a35;--accent:#7cc39a;--warn:#e58a72}}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,system-ui,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-text-size-adjust:100%}
body{display:flex;flex-direction:column;height:100dvh}
header{display:flex;align-items:center;gap:10px;padding:calc(env(safe-area-inset-top) + 10px) 16px 10px;border-bottom:1px solid var(--line);background:var(--bg)}
header h1{font-size:17px;margin:0;font-weight:600;flex:none}
#who{flex:1;min-width:0;color:var(--sub);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
.icon{padding:6px 8px;border-radius:8px;color:var(--sub)}
#list{flex:1;overflow-y:auto;padding:12px 16px 4px;-webkit-overflow-scrolling:touch}
.day{text-align:center;color:var(--sub);font-size:12px;margin:14px 0 8px}
.msg{display:flex;gap:8px;align-items:flex-start;margin:0 0 12px}
.msg.mine{flex-direction:row-reverse}
.av{flex:none;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:600;font-size:15px;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;cursor:pointer;touch-action:manipulation}
.av.zh{font-size:16px}
.col{display:flex;flex-direction:column;align-items:flex-start;min-width:0;max-width:calc(100% - 88px)}
.msg.mine .col{align-items:flex-end}
.meta{font-size:12px;color:var(--sub);margin:0 4px 2px}
.tag{font-size:10px;border:1px solid var(--line);border-radius:4px;padding:0 3px;margin-left:4px;vertical-align:1px}
.bub{max-width:min(100%,560px);background:var(--card);border:1px solid var(--line);border-radius:14px;padding:8px 12px;white-space:pre-wrap;word-break:break-word}
.msg.ai .bub{background:var(--ai)}
.msg.mine .bub{background:var(--me);border-color:transparent}
.at{color:var(--accent);font-weight:600}
#empty{color:var(--sub);text-align:center;margin-top:30vh;font-size:14px}
footer{display:flex;gap:8px;align-items:flex-end;padding:8px 12px calc(env(safe-area-inset-bottom) + 8px);border-top:1px solid var(--line);background:var(--bg)}
textarea{flex:1;resize:none;font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:8px 14px;max-height:40vh;outline:none}
#send{background:var(--accent);color:#fff;border-radius:18px;padding:8px 16px;font-weight:600}
@media (prefers-color-scheme:dark){#send{color:#10221a}}
#send:disabled{opacity:.4}
.atpop{position:absolute;left:12px;right:12px;bottom:100%;margin-bottom:6px;background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:0 4px 18px rgba(0,0,0,.15);overflow:hidden;display:none}
.atpop.on{display:block}
.atpop button{display:flex;align-items:center;gap:10px;width:100%;padding:8px 12px;text-align:left}
.atpop button+button{border-top:1px solid var(--line)}
.atpop .av{width:28px;height:28px;font-size:13px}
footer{position:relative}
#err{color:var(--warn);font-size:13px;padding:0 16px;min-height:0}
#sheet{position:fixed;inset:0;background:rgba(0,0,0,.35);display:none;align-items:flex-end;justify-content:center;z-index:5}
#sheet.on{display:flex}
#panel{background:var(--bg);width:100%;max-width:560px;max-height:85dvh;overflow:auto;border-radius:16px 16px 0 0;padding:16px 16px calc(env(safe-area-inset-bottom) + 16px)}
#panel h2{font-size:16px;margin:0 0 10px}
#panel h3{font-size:15px;margin:16px 0 6px}
.row{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
.btn{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:6px 12px;font-size:14px}
.btn.pri{background:var(--accent);border-color:var(--accent);color:#fff}
.seg{display:flex;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.seg button{padding:6px 10px;font-size:14px}
.seg button.on{background:var(--accent);color:#fff}
.small{color:var(--sub);font-size:13px}
.log{font-size:13px;color:var(--sub);margin:4px 0 0;padding-left:18px}
#panel textarea{width:100%;border-radius:10px;font-size:13px;min-height:70px}
</style>
</head>
<body>
<header>
  <h1 id="title">群</h1>
  <div id="who"></div>
  <button class="icon" id="gear" aria-label="设置">⋯</button>
</header>
<div id="list"><div id="empty">加载中…</div></div>
<div id="err"></div>
<footer>
  <div class="atpop" id="atpop"></div>
  <textarea id="box" rows="1" placeholder="说点什么… @名字 可以点名"></textarea>
  <button id="send" disabled>发送</button>
</footer>
<div id="sheet"><div id="panel"></div></div>
<script>
(function(){
var $=function(id){return document.getElementById(id)};
var list=$("list"),box=$("box"),send=$("send"),err=$("err");
var last=0,me=null,members={},memberList=[],timer=0,lastDay="",busy=false;
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function bj(ts){var f=new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(ts));var o={};f.forEach(function(p){o[p.type]=p.value});return{day:o.month+"月"+o.day+"日",hm:o.hour+":"+o.minute}}
var COLORS=["#5b8a72","#7a6ea8","#b07a4f","#4f86a8","#a8607a","#7f8f4a","#a8584f","#4f9a96"];
function avColor(id){for(var k=0;k<memberList.length;k++)if(memberList[k].id===id)return COLORS[k%COLORS.length];var h=0;for(var i=0;i<id.length;i++)h=(h*31+id.charCodeAt(i))>>>0;return COLORS[h%COLORS.length]}
function avatar(id,a){var n=String(a.name||id).trim(),c=n.charAt(0),zh=!/[A-Za-z0-9]/.test(c);var d=document.createElement("div");d.className="av"+(zh?" zh":"");d.style.background=avColor(id);d.textContent=zh?c:c.toUpperCase();d.dataset.name=n;return d}
function marks(text){var h=esc(text);memberList.forEach(function(m){var n=esc("@"+m.name);h=h.split(n).join('<span class="at">'+n+"</span>")});return h}
function showErr(t){err.textContent=t||"";err.style.padding=t?"4px 16px":"0 16px"}
function nearBottom(){return list.scrollHeight-list.scrollTop-list.clientHeight<120}
function add(rows){
  if(!rows.length)return;
  var stick=nearBottom()||last===0;
  var e=$("empty");if(e)e.remove();
  rows.forEach(function(x){
    if(x.id<=last)return;last=x.id;
    var t=bj(x.ts);
    if(t.day!==lastDay){lastDay=t.day;var d=document.createElement("div");d.className="day";d.textContent=t.day;list.appendChild(d)}
    var a=members[x.author]||{name:x.author,kind:"human"};
    var div=document.createElement("div");
    div.className="msg"+(a.kind==="ai"?" ai":"")+(me&&x.author===me.id?" mine":"");
    var col=document.createElement("div");col.className="col";
    col.innerHTML='<div class="meta">'+esc(a.name)+(a.kind==="ai"?'<span class="tag">AI</span>':"")+" · "+t.hm+'</div><div class="bub">'+marks(x.text)+"</div>";
    div.appendChild(avatar(x.author,a));div.appendChild(col);
    list.appendChild(div);
  });
  if(stick)list.scrollTop=list.scrollHeight;
}
function api(path,body){
  return fetch(path,body?{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}:{cache:"no-store"})
    .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||("出错了 "+r.status));return j})});
}
function setMembers(ms){
  members={};memberList=ms;ms.forEach(function(m){members[m.id]=m});
  $("who").textContent=ms.map(function(m){return m.name+(m.kind==="ai"?"·AI":"")}).join("、");
}
function poll(){
  clearTimeout(timer);
  api("/api/state?after="+last).then(function(j){
    me=j.me;setMembers(j.members);$("title").textContent=j.group;document.title=j.group;
    send.disabled=!box.value.trim();
    if(!j.messages.length&&last===0)$("empty").textContent="还没有人说话";
    add(j.messages);showErr("");
  }).catch(function(e){
    if(/没登录/.test(e.message)){$("empty")?($("empty").textContent="请用邀请链接打开这个页面"):showErr("请用邀请链接重新打开");send.disabled=true;return}
    showErr("连不上，过一会儿自己重试");
  }).then(function(){timer=setTimeout(poll,document.hidden?15000:3000)});
}
function grow(){box.style.height="auto";box.style.height=Math.min(box.scrollHeight,window.innerHeight*0.4)+"px"}
var atpop=$("atpop");
function insertAt(name,replaceQuery){
  var v=box.value,pos=box.selectionStart==null?v.length:box.selectionStart,start=pos;
  if(replaceQuery){var m=v.slice(0,pos).match(/[@＠]([^\\s@＠]*)$/);if(m)start=pos-m[0].length}
  var ins="@"+name+" ";
  box.value=v.slice(0,start)+ins+v.slice(pos);
  var c=start+ins.length;box.focus();try{box.setSelectionRange(c,c)}catch(e){}
  atpop.classList.remove("on");grow();send.disabled=!box.value.trim()||!me;
}
function atCheck(){
  var pos=box.selectionStart==null?box.value.length:box.selectionStart;
  var m=box.value.slice(0,pos).match(/(^|[^A-Za-z0-9])[@＠]([^\\s@＠]*)$/);
  if(!m){atpop.classList.remove("on");return}
  var q=m[2].toLowerCase();
  var ms=memberList.filter(function(x){return(!me||x.id!==me.id)&&x.name.toLowerCase().indexOf(q)===0});
  if(!ms.length){atpop.classList.remove("on");return}
  atpop.innerHTML="";
  ms.forEach(function(x){var b=document.createElement("button");b.type="button";b.appendChild(avatar(x.id,x));var sp=document.createElement("span");sp.textContent=x.name+(x.kind==="ai"?" · AI":"");b.appendChild(sp);
    b.addEventListener("mousedown",function(e){e.preventDefault()});
    b.addEventListener("click",function(){insertAt(x.name,true)});atpop.appendChild(b)});
  atpop.classList.add("on");
}
box.addEventListener("input",function(){grow();send.disabled=!box.value.trim()||!me;atCheck()});
box.addEventListener("blur",function(){setTimeout(function(){atpop.classList.remove("on")},150)});
// 点聊天区或标题栏的空白处：收起键盘（嵌在别的页面里时，iOS 上键盘可能收不起来）。长按头像不算
function dropKb(e){if(document.activeElement!==box)return;if(e.target.closest(".av,#atpop,button,a"))return;var sel=window.getSelection&&String(window.getSelection());if(sel)return;box.blur();atpop.classList.remove("on")}
list.addEventListener("click",dropKb);
document.querySelector("header").addEventListener("click",dropKb);
// 长按头像 = @ 这个人（像微信）
var lpT=0,lpX=0,lpY=0;
list.addEventListener("pointerdown",function(e){var av=e.target.closest(".av");if(!av)return;lpX=e.clientX;lpY=e.clientY;clearTimeout(lpT);
  lpT=setTimeout(function(){lpT=0;if(me&&av.dataset.name===me.name)return;if(navigator.vibrate)navigator.vibrate(15);insertAt(av.dataset.name,false)},450)});
list.addEventListener("pointermove",function(e){if(lpT&&(Math.abs(e.clientX-lpX)>8||Math.abs(e.clientY-lpY)>8)){clearTimeout(lpT);lpT=0}});
["pointerup","pointercancel","scroll"].forEach(function(ev){list.addEventListener(ev,function(){clearTimeout(lpT);lpT=0},{passive:true})});
list.addEventListener("contextmenu",function(e){if(e.target.closest(".av"))e.preventDefault()});
send.addEventListener("click",function(){
  var t=box.value.trim();if(!t||busy)return;busy=true;send.disabled=true;
  api("/api/send",{text:t}).then(function(){box.value="";grow();poll()}).catch(function(e){showErr(e.message)}).then(function(){busy=false;send.disabled=!box.value.trim()});
});
document.addEventListener("visibilitychange",function(){if(!document.hidden)poll()});

// 设置：我管的 AI 的叫醒
var sheet=$("sheet"),panel=$("panel");
sheet.addEventListener("click",function(e){if(e.target===sheet)sheet.classList.remove("on")});
$("gear").addEventListener("click",openSet);
var MODES=[["human","人说话就叫"],["mention","被 @ 才叫"],["off","不叫"]];
function openSet(){
  sheet.classList.add("on");panel.innerHTML='<h2>设置</h2><p class="small">加载中…</p>';
  api("/api/state?after="+(last||1)+"&mine=1").then(function(j){
    var h='<h2>设置</h2><p class="small">你是 <b>'+esc(j.me.name)+'</b>。</p>';
    if(!j.mine.length)h+='<p class="small">你名下没有 AI，这里没什么要设的。</p>';
    j.mine.forEach(function(a){
      h+='<h3>叫醒 '+esc(a.name)+'</h3>';
      h+='<p class="small">群里有新消息时把 TA 叫醒。AI 说的话只有 @ 了 TA 才会叫。</p>';
      h+='<div class="seg" data-ai="'+esc(a.id)+'">'+MODES.map(function(m){return '<button data-mode="'+m[0]+'" class="'+(a.wake_mode===m[0]?"on":"")+'">'+m[1]+"</button>"}).join("")+"</div>";
      if(a.wake_via==="poll"){h+='<p class="small" style="margin-top:10px">TA 自己来取群消息，不用填凭证。</p>'}else{
      h+='<p class="small" style="margin-top:10px">叫醒凭证：'+(a.has_bundle?"已经填了（为了安全不显示）":"还没填")+'</p>';
      h+='<textarea placeholder="把 Aru 导出的发送凭证（sender bundle）整段粘在这里" data-bundle="'+esc(a.id)+'"></textarea>';
      h+='<div class="row"><button class="btn pri" data-save="'+esc(a.id)+'">保存凭证</button><button class="btn" data-test="'+esc(a.id)+'">试叫一次</button>'+(a.has_bundle?'<button class="btn" data-clear="'+esc(a.id)+'">删掉凭证</button>':"")+"</div>";
      }
      if(a.wakes.length){h+='<p class="small">最近几次：</p><ul class="log">'+a.wakes.map(function(w){var t=bj(w.ts);return "<li>"+t.day+" "+t.hm+(w.msg?" · #"+w.msg:"")+" · "+esc(w.outcome)+"</li>"}).join("")+"</ul>"}
    });
    h+='<p id="setmsg" class="small"></p><div class="row"><button class="btn" id="close">关上</button></div>+'<p class="small" style="text-align:center;opacity:.6;margin-top:14px">${SIGN}<br>原版在 github.com/White-ting/Aru-kit；不许转发、不许商用</p>';
    panel.innerHTML=h;
    $("close").onclick=function(){sheet.classList.remove("on")};
  }).catch(function(e){panel.innerHTML='<h2>设置</h2><p class="small">'+esc(e.message)+"</p>"});
}
panel.addEventListener("click",function(e){
  var b=e.target.closest("button");if(!b)return;
  var say=function(t){var s=$("setmsg");if(s)s.textContent=t};
  var done=function(t){return function(){say(t);setTimeout(openSet,900)}};
  if(b.dataset.mode){var ai=b.parentNode.dataset.ai;api("/api/wake",{ai:ai,mode:b.dataset.mode}).then(done("改好了")).catch(function(x){say(x.message)})}
  else if(b.dataset.save){var ta=panel.querySelector('[data-bundle="'+b.dataset.save+'"]');if(!ta.value.trim())return say("先把凭证粘进来");api("/api/wake",{ai:b.dataset.save,bundle:ta.value.trim()}).then(done("存好了")).catch(function(x){say(x.message)})}
  else if(b.dataset.test){say("在叫…");api("/api/wake",{ai:b.dataset.test,test:true}).then(done("叫过去了，去 Aru 看看 TA 收到没有")).catch(function(x){say(x.message)})}
  else if(b.dataset.clear){api("/api/wake",{ai:b.dataset.clear,bundle:""}).then(done("删掉了")).catch(function(x){say(x.message)})}
});
poll();
})();
</script>
</body>
</html>`;
