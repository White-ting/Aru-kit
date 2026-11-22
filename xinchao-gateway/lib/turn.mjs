// 判断"这一轮是不是她在说话"、把"此刻"附到她这句后面、硬门、从回复里取文字。
// 两种格式：openai（/v1/chat/completions）和 anthropic（/v1/messages）。

export const NOW_HEADER = '〔心潮·此刻〕';

/** content 可能是字符串，也可能是 [{type:"text",text}, {type:"image_url"...}] 数组；只取文字。 */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  return '';
}

/**
 * 看请求体的最后一条消息，返回：
 *   { kind: 'user', text }    她在说话（还没看跳过前缀）
 *   { kind: 'tool' }          工具调用的中间回合
 *   { kind: 'other' }         别的（没有 messages、最后一条是 assistant 等）
 */
export function classifyLast(body, format) {
  const msgs = body && Array.isArray(body.messages) ? body.messages : null;
  if (!msgs || msgs.length === 0) return { kind: 'other' };
  const last = msgs[msgs.length - 1];
  if (!last || typeof last !== 'object') return { kind: 'other' };

  if (format === 'openai') {
    if (last.role === 'tool' || last.role === 'function') return { kind: 'tool' };
    if (last.role === 'assistant' && Array.isArray(last.tool_calls) && last.tool_calls.length) return { kind: 'tool' };
    if (last.role === 'user') return { kind: 'user', text: contentText(last.content) };
    return { kind: 'other' };
  }
  // anthropic：工具结果是放在 user 消息里的 tool_result 块
  if (last.role === 'user') {
    if (Array.isArray(last.content) && last.content.some((b) => b && b.type === 'tool_result')) {
      // 0.1.14：Aru 的语音条——TA 调 generateVoice 以后不接着发，等她回话时把「语音回执 + <environment> + 她的话」放在同一条里（测试者 DEBUG_SHAPE=3 日志）。
      // 回执旁边有文字块的先当她在说话；去掉附注一个字不剩的，后面照旧当工具回合（toolBeforeTail）
      const t = contentText(last.content);
      if (t.trim()) return { kind: 'user', text: t, withResult: true };
      return { kind: 'tool' };
    }
    return { kind: 'user', text: contentText(last.content) };
  }
  return { kind: 'other' };
}

/**
 * 像不像 App 在后台发的杂活（起标题、摘要、打标签……），而不是她在说话（0.1.1，测试反馈 8929 抓到的）。
 * 两条，任一条成立就算后台：
 *  1. 请求里限了很小的 max_tokens（≤ bgMaxTokens）。起标题、摘要一般只要几十个字，正常聊天不会这么限。
 *  2. 单发请求（messages 里一条 assistant 都没有），而且 system 或她这句里出现 bgPatterns 里的词。
 *     正常聊天几乎总带着前面的对话；有前文时她说"帮我总结一下"照样算她在说话。
 */
export function looksBackground(body, lastText, { bgMaxTokens = 0, bgPatterns = [] } = {}) {
  const mt = Number(body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens);
  if (bgMaxTokens > 0 && Number.isFinite(mt) && mt > 0 && mt <= bgMaxTokens) return 'max_tokens';
  if (!bgPatterns.length) return '';
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  if (msgs.some((m) => m && m.role === 'assistant')) return '';
  const sys = [typeof body.system === 'string' ? body.system : contentText(body.system),
    ...msgs.filter((m) => m && (m.role === 'system' || m.role === 'developer')).map((m) => contentText(m.content))].join('\n');
  const hay = (sys + '\n' + String(lastText || '')).toLowerCase();
  return bgPatterns.some((p) => p && hay.includes(p.toLowerCase())) ? 'pattern' : '';
}

/**
 * 0.1.11：Aru 用 user 身份发、但不是她打的字（朋友反馈，Aru Host 0.39.1）。role 都是 user，只能看字：
 *  - 工具取回的图另起一条 user："Images returned by the completed tool call…" → 当工具回合（appNoteKind = 'tool'）
 *  - 桥叫醒："External event data, not an authored user message…" → 不算她（appNoteKind = 'external'）
 *  - 引用回复 → 开头整块剥掉（stripLeadMeta）。朋友 DEBUG_SHAPE=2 抓到的骨架是四层：
 *      [Replying to quoted text · reference data]⏎{多行 JSON：引用的摘录、编号、role}⏎[五个字]⏎她的话⏎⏎<sent_at …>
 * 工具那几个开头可以用 TOOL_PREFIXES 改；桥叫醒那句 Aru 自己写明了不是她，写死。前面多一个 [ 也认。
 */
const EXTERNAL_NOTE_RE = /^\[?\s*External event data|not an authored user message/i;

export function appNoteKind(text, toolPrefixes = []) {
  const t = String(text || '').replace(/^\s+/, '');
  const t2 = t.replace(/^\[\s*/, '');
  if (toolPrefixes.some((p) => p && (t.startsWith(p) || t2.startsWith(p)))) return 'tool';
  if (EXTERNAL_NOTE_RE.test(t.slice(0, 400))) return 'external';
  return '';
}

// 元数据头：认得的几个开头，或者"英文词 + 分隔符（· • ・ : | -）"
const META_HEAD_RE = /^\[\s*(?:(?:Replying to|Quoted?|Reference|Attachments?)\b|[A-Za-z][A-Za-z ]{1,40}(?:[·•・‧:：|]|\s[-–—]\s))/i;

/** 从 t[0] 的开括号数到配对的闭括号；JSON 模式（{）跳过字符串里的括号和转义。找不到返回 -1。 */
function matchEnd(t, json) {
  const open = t[0], close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (json && c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
}

/**
 * 开头的引用元数据整块剥掉，每一块：
 *  1. [元数据头 …]：方括号配对数；引用里有落单的 [ 数不上时，退到第一个后面跟换行的 ]
 *  2. 紧跟着的 {JSON}：括号配对（字符串里的 { } 不算），而且 JSON.parse 得通才剥——她自己打的 {…} 不会被吃
 *  3. 紧跟着、单独一行的短方括号 [≤40 字]
 * 只有第 1 步认出元数据头，才会看第 2、3 步。可以连着好几块。
 */
export function stripLeadMeta(text) {
  const s0 = String(text || '');
  let s = s0;
  for (let n = 0; n < 5; n++) {
    const t = s.replace(/^\s+/, '');
    if (!META_HEAD_RE.test(t)) break;
    let end = matchEnd(t, false);
    if (end < 0) { const m = /\][ \t]*\r?\n/.exec(t); end = m ? m.index : -1; }
    if (end < 0) break;
    let r = t.slice(end + 1).replace(/^\s+/, '');
    if (r[0] === '{') {
      const e = matchEnd(r, true);
      if (e > 0) { try { JSON.parse(r.slice(0, e + 1)); r = r.slice(e + 1).replace(/^\s+/, ''); } catch { /* 不是 JSON，留着 */ } }
    }
    const tag = /^\[[^[\]\r\n]{1,40}\][ \t]*(?:\r?\n|$)/.exec(r);
    if (tag) r = r.slice(tag[0].length);
    s = r;
  }
  return s === s0 ? s : s.replace(/^\s+/, '');
}

export function startsWithSkip(text, prefixes) {
  const t = String(text || '').replace(/^\s+/, '');
  return prefixes.some((p) => p && t.startsWith(p));
}

/**
 * 心潮返回的 now 能不能附。全部满足才返回 true。
 *  ok === true；0 < lines <= 8；0 < text.length <= 400；
 *  text 去掉"数字+条/句"、xinchao_ 工具名、黑匣子编号以后，不能再有 \d.\d，也不能有 6 个以上连续小写字母或下划线。
 */
export function passesGate(now) {
  return gateCheck(now).ok;
}

/**
 * 0.1.12：同一道门，挡下时说清是哪条、第几行（只给日志用，不带内容）。
 *  rule：not-ok / lines / len / decimal（\d.\d）/ word（6 个以上连续小写字母或下划线）；line：第几行（从 1 数）。
 * 判断前先去掉这些，它们是写给 TA 的、不是漏出来的键名：
 *  - "数字+条/句"；
 *  - xinchao_ 开头的工具名（以前只认 xinchao_context，此刻和信封里还会写 xinchao_box read …）；
 *  - 黑匣子条目编号 box-时间-随机（心潮念 black-box.js 生成，比如 box-mwjcto3u-khyqtd；随机那段常有 6 个连着的字母，
 *    「另外：匣子里 N 条（1 条要提醒你：box-…）」那行一出现整块此刻就被挡。使用者反馈）。
 */
export function gateCheck(now) {
  if (!now || typeof now !== 'object' || now.ok !== true) return { ok: false, rule: 'not-ok' };
  const lines = Number(now.lines);
  if (!Number.isFinite(lines) || lines <= 0 || lines > 8) return { ok: false, rule: 'lines' };
  if (typeof now.text !== 'string') return { ok: false, rule: 'not-ok' };
  const len = now.text.length;
  if (len <= 0 || len > 400) return { ok: false, rule: 'len' };
  const rows = now.text.split('\n');
  for (let i = 0; i < rows.length; i++) {
    const cleaned = rows[i].replace(/\d+\s*[条句]/g, '').replace(/xinchao_[a-z_]+/g, '').replace(/\bbox-[0-9a-z]+(?:-[0-9a-z]+)*/g, '');
    if (/\d\.\d/.test(cleaned)) return { ok: false, rule: 'decimal', line: i + 1 };
    if (/[a-z_]{6,}/.test(cleaned)) return { ok: false, rule: 'word', line: i + 1 };
  }
  return { ok: true };
}

export function nowBlock(text) {
  return `\n\n${NOW_HEADER}\n${text}`;
}

/**
 * 返回一份新的请求体：只改最后一条消息，前面的消息对象原样复用（一个字都不动）。
 * 字符串 content：在后面接上；数组 content：末尾加一个 text 块，图片等原样保留。
 */
export function injectNow(body, text) {
  const msgs = body.messages.slice();
  const last = msgs[msgs.length - 1];
  const add = nowBlock(text);
  let content;
  if (Array.isArray(last.content)) content = [...last.content, { type: 'text', text: add }];
  else content = (typeof last.content === 'string' ? last.content : '') + add;
  msgs[msgs.length - 1] = { ...last, content };
  return { ...body, messages: msgs };
}

/** 非流式回复：取出文字、看是不是工具调用。 */
export function finalFromJson(json, format) {
  if (!json || typeof json !== 'object') return { text: '', toolCall: false, tools: [] };
  if (format === 'openai') {
    const c = Array.isArray(json.choices) ? json.choices[0] : null;
    if (!c) return { text: '', toolCall: false, tools: [] };
    const msg = c.message || {};
    const toolCall = c.finish_reason === 'tool_calls' || c.finish_reason === 'function_call'
      || (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) || !!msg.function_call;
    const tools = (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).map((t) => ({ name: String((t && t.function && t.function.name) || ''), args: String((t && t.function && t.function.arguments) || '') }));
    return { text: contentText(msg.content), toolCall, tools };
  }
  const blocks = Array.isArray(json.content) ? json.content : [];
  const toolCall = json.stop_reason === 'tool_use' || blocks.some((b) => b && b.type === 'tool_use');
  const tools = blocks.filter((b) => b && b.type === 'tool_use').map((b) => ({ name: String(b.name || ''), args: JSON.stringify(b.input || {}) }));
  return { text: contentText(blocks), toolCall, tools };
}

/**
 * 流式回复的拼接器：喂进原始字节，自己切 SSE 的行，把文字拼起来。
 * 只读，不改任何东西；转给 App 的仍然是原始字节。
 */
const TOOL_ARGS_CAP = 20000;
export function makeStreamCollector(format) {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  const st = { text: '', toolCall: false, done: false, tools: [] };   // 0.1.14：tools = [{ name, args }]，args 是拼起来的 JSON 文字
  const toolAt = new Map();   // 块序号 → tools 里的那一项

  function onData(line) {
    if (line === '[DONE]') { st.done = true; return; }
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (!ev || typeof ev !== 'object') return;
    if (format === 'openai') {
      const choices = Array.isArray(ev.choices) ? ev.choices : [];
      for (const c of choices) {
        if (!c || (c.index !== undefined && c.index !== 0)) continue;
        const d = c.delta || {};
        if (typeof d.content === 'string') st.text += d.content;
        if ((Array.isArray(d.tool_calls) && d.tool_calls.length) || d.function_call) st.toolCall = true;
        if (Array.isArray(d.tool_calls)) for (const t of d.tool_calls) {
          if (!t || typeof t !== 'object') continue;
          const k = Number.isInteger(t.index) ? t.index : 0;
          let x = toolAt.get(k); if (!x) { x = { name: '', args: '' }; toolAt.set(k, x); st.tools.push(x); }
          if (t.function && typeof t.function.name === 'string') x.name += t.function.name;
          if (t.function && typeof t.function.arguments === 'string' && x.args.length < TOOL_ARGS_CAP) x.args += t.function.arguments;
        }
        if (c.finish_reason === 'tool_calls' || c.finish_reason === 'function_call') st.toolCall = true;
      }
    } else {
      if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') {
        st.toolCall = true;
        const x = { name: String(ev.content_block.name || ''), args: '' };
        const inp = ev.content_block.input;
        if (inp && typeof inp === 'object' && Object.keys(inp).length) x.args = JSON.stringify(inp);
        toolAt.set(ev.index, x); st.tools.push(x);
      }
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'input_json_delta' && typeof ev.delta.partial_json === 'string') {
        const x = toolAt.get(ev.index);
        if (x && x.args.length < TOOL_ARGS_CAP) x.args += ev.delta.partial_json;
      }
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string') st.text += ev.delta.text;
      if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason === 'tool_use') st.toolCall = true;
      if (ev.type === 'message_stop') st.done = true;
    }
  }

  function eat(chunkStr) {
    buf += chunkStr;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.startsWith('data:')) onData(line.slice(5).trim());
    }
  }

  return {
    push(chunk) { eat(decoder.decode(chunk, { stream: true })); },
    end() { eat(decoder.decode() + '\n'); return st; },
    state: st,
  };
}

/** 一串数字压成 ≤40 字的一段：放得下就全写，放不下写头三个..尾三个。 */
function compactNums(arr) {
  const all = arr.join(',');
  if (all.length <= 40) return all || '-';
  return `${arr.slice(0, 3).join(',')}..${arr.slice(-3).join(',')}(${arr.length})`;
}
const charLen = (s) => Array.from(String(s || '')).length;

/**
 * 调试用（0.1.3，DEBUG_SHAPE=1）：她这句话的"结构"，不含正文。
 * 用来看 App 往她那句里塞了什么、塞在前面还是后面：
 *   msgs 总条数、sys 系统提示字数、parts 最后一条分几块（每块字数，非文字块写类型）、
 *   segs 按空行切开每段字数、hist 前三条她的消息各几个字（看 App 存进记录的是不是也带着塞的东西）、
 *   tags 出现的 <标签> 名字。
 * 返回要记的几行（每行一个字段对象，交给日志）。
 */
export function describeShape(body) {
  const msgs = Array.isArray(body && body.messages) ? body.messages : [];
  const last = msgs[msgs.length - 1] || {};
  const parts = Array.isArray(last.content) ? last.content : [{ type: 'text', text: typeof last.content === 'string' ? last.content : '' }];
  const partLens = parts.map((p) => (p && p.type === 'text' && typeof p.text === 'string' ? charLen(p.text) : String((p && p.type) || '?').slice(0, 10)));
  const text = contentText(last.content);
  const segs = text.split(/\n\s*\n/).map((s) => charLen(s.trim())).filter((n) => n > 0);
  const sysText = [typeof body.system === 'string' ? body.system : contentText(body.system),
    ...msgs.filter((m) => m && (m.role === 'system' || m.role === 'developer')).map((m) => contentText(m.content))].join('');
  const hist = msgs.slice(0, -1).filter((m) => m && m.role === 'user').slice(-3).map((m) => charLen(contentText(m.content)));
  const tags = [...new Set([...text.matchAll(/<\/?([A-Za-z_][\w:.-]{0,24})(?=[\s>/])/g)].map((m) => m[1]))];
  const tagStr = tags.join(',');
  return [
    { msgs: msgs.length, sys: charLen(sysText), parts: compactNums(partLens), segs: compactNums(segs) },
    { hist: compactNums(hist), tags: tagStr.slice(0, 40) || '-', tags2: tagStr.length > 40 ? tagStr.slice(40, 80) : undefined },
  ];
}


/**
 * 去掉 App 塞进她那句的附注（0.1.4）：整块删掉成对的 <标签 …>…</标签>，和单独的 <标签 …/>。
 * tags 是 '*'（所有英文名的标签）或名单数组；空的就原样返回。删完一个字都不剩的，原样返回（宁可多传，不把她的话弄丢）。
 */
export function stripAnnotations(text, tags = '*', fallback = true) {
  const s0 = String(text || '');
  if (!s0 || !tags || (Array.isArray(tags) && !tags.length)) return s0;
  const name = tags === '*' ? '[A-Za-z_][\\w:.-]{0,40}' : tags.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const paired = new RegExp(`<(${name})(?:\\s[^<>]*)?>[\\s\\S]*?</\\1\\s*>`, 'g');
  const single = new RegExp(`<(?:${name})(?:\\s[^<>]*)?/>`, 'g');
  // 0.1.6：只有开头没有结尾的单个标签（Aru 的 <sent_at 2026-11-06 21:46>，时间写在标签里）也去掉
  const lone = new RegExp(`</?(?:${name})(?:\\s[^<>]*)?/?>`, 'g');
  let s = s0, prev;
  do { prev = s; s = s.replace(paired, '').replace(single, ''); } while (s !== prev);
  s = s.replace(lone, '');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s || (fallback ? s0 : '');
}


/**
 * 调试用（0.1.5，DEBUG_SHAPE=2）：她那句话的「骨架」，用来看 App 塞进来的附注是什么写法，又看不到内容。
 *   <标签 …> 照写标签名和属性名，属性值换成 …；标签外面的文字、数字一律换成「·字数」；换行写成 ⏎；标点照留。
 * 返回 { head, tail }：骨架的前 240 个字、后 120 个字。
 */
export function skeleton(text) {
  const parts = String(text || '').split(/(<\/?[A-Za-z_][^<>]{0,300}>)/);
  let out = '';
  parts.forEach((p, i) => {
    // 0.1.6：标签里只留标签名，别的（属性、写在标签里的时间）也换成字数
    if (i % 2 === 1) out += p.replace(/^(<\/?[A-Za-z_][\w:.-]*)([\s\S]*)$/, (m, a, rest) => a + rest.replace(/[\p{L}\p{N}]+/gu, (x) => '·' + Array.from(x).length).replace(/[\r\n]+/g, '⏎')).slice(0, 80);
    else out += p.replace(/\r?\n/g, '⏎').replace(/[\p{L}\p{N}]+/gu, (m) => '·' + Array.from(m).length);
  });
  const a = Array.from(out);
  return { head: a.slice(0, 240).join(''), tail: a.length > 240 ? a.slice(-120).join('') : '' };
}


/**
 * 0.1.6：这一轮她连着发的几条（最后一条 TA 的回复之后、全是 user 的那几条），从前到后。
 * Aru 带环境信息时会拆成两条：先是她的话，再单独一条 <environment>…</environment>。
 */
/**
 * 0.1.8：这一轮她那几条 user 消息再往前一条是不是工具结果。
 * Aru 工具走完再发请求时，会在工具结果后面再塞一条只有附注（<environment>、<sent_at …>）的 user 消息，
 * 最后一条是 user，classifyLast 就认不出这是工具回合的后半段（二号 c12e 日志 roles=…atu）。
 */
export function toolBeforeTail(body, format) {
  const msgs = Array.isArray(body && body.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || typeof m !== 'object') return false;
    if (format === 'openai' && (m.role === 'tool' || m.role === 'function')) return true;
    if (m.role === 'system' || m.role === 'developer') continue;   // 0.1.9：Aru 会在工具结果和附注中间夹 system（二号 598c 日志 roles=…tssu）
    if (m.role !== 'user') return false;
    if (format === 'anthropic' && Array.isArray(m.content) && m.content.some((b) => b && b.type === 'tool_result')) return true;
  }
  return false;
}

export function tailUserTexts(body, format) {
  const msgs = Array.isArray(body && body.messages) ? body.messages : [];
  const out = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== 'user') break;
    if (format === 'anthropic' && Array.isArray(m.content) && m.content.some((b) => b && b.type === 'tool_result')) {
      if (i === msgs.length - 1) out.unshift(contentText(m.content));   // 0.1.14：只拿文字块，不拿回执
      break;
    }
    out.unshift(contentText(m.content));
  }
  return out;
}

/**
 * 调试用（0.1.13，DEBUG_SHAPE=3）：最后几条消息「每一块」是什么，查语音条（测试者 11-22 日志：45 次隔一分钟以上的回合被当成工具回合）。
 * 每条一行：r 是谁（u 她 a TA t 工具 s 系统），b1、b2… 是每一块：
 *   文字 text:字数；工具调用 use:工具名；工具回执 res:回执里每块的类型和字数（err 表示出错）；图 image。
 * 工具调用的字段另起 f1.1、f1.2…（第几个工具.第几个字段）：字段名=字数（不是文字的写类型），最多 8 个。不记任何内容、不记字段的值。
 * 文字块和回执里的文字另记骨架（跟 DEBUG_SHAPE=2 一样：标签名照写、文字只留字数），sk1…，只看最后一条。
 */
export function describeTail(body, format, n = 4) {
  const msgs = Array.isArray(body && body.messages) ? body.messages : [];
  const role = (r) => ({ system: 's', developer: 's', user: 'u', assistant: 'a', tool: 't', function: 't' })[r] || '?';
  const fieldsOf = (input) => {
    let o = input;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return ['str' + charLen(o)]; } }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return [typeof o];
    return Object.entries(o).slice(0, 8).map(([k, v]) => `${String(k).slice(0, 24)}=${typeof v === 'string' ? charLen(v) : Array.isArray(v) ? 'arr' : typeof v}`);
  };
  const resOf = (c) => {
    if (typeof c === 'string') return 'text' + charLen(c);
    if (!Array.isArray(c)) return c == null ? '0' : typeof c;
    return c.map((p) => (p && p.type === 'text' ? 'text' + charLen(p.text) : String((p && p.type) || '?').slice(0, 8))).join('+') || '0';
  };
  const out = [];
  const start = Math.max(0, msgs.length - n);
  for (let i = start; i < msgs.length; i++) {
    const m = msgs[i] || {};
    const row = { at: i - msgs.length, r: role(m.role) };
    const blocks = [], fields = [], texts = [];
    const c = m.content;
    if (typeof c === 'string') { blocks.push('text:' + charLen(c)); texts.push(c); }
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (!b || typeof b !== 'object') { blocks.push('?'); continue; }
        if (b.type === 'text') { blocks.push('text:' + charLen(b.text)); texts.push(String(b.text || '')); }
        else if (b.type === 'tool_use') { blocks.push('use:' + String(b.name || '?').slice(0, 30)); fields.push(fieldsOf(b.input)); }
        else if (b.type === 'tool_result') {
          blocks.push('res:' + resOf(b.content) + (b.is_error ? ':err' : ''));
          if (typeof b.content === 'string') texts.push(b.content);
          else if (Array.isArray(b.content)) for (const p of b.content) if (p && p.type === 'text') texts.push(String(p.text || ''));
        } else blocks.push(String(b.type || '?').slice(0, 12));
      }
    } else if (c != null) blocks.push(typeof c);
    // openai 的工具调用和工具结果
    if (Array.isArray(m.tool_calls)) for (const t of m.tool_calls) { blocks.push('use:' + String((t && t.function && t.function.name) || '?').slice(0, 30)); fields.push(fieldsOf(t && t.function && t.function.arguments)); }
    if (m.role === 'tool' || m.role === 'function') blocks[0] = 'res:' + (blocks[0] || '0');
    blocks.forEach((x, k) => { row['b' + (k + 1)] = x; });
    fields.forEach((list, k) => list.forEach((x, j) => { row[`f${k + 1}.${j + 1}`] = x; }));
    out.push(row);
    if (i === msgs.length - 1) {
      const { head } = skeleton(texts.join('⏎|⏎'));
      const parts = head.match(/[\s\S]{1,40}/gu) || [];
      if (parts.length) out.push(Object.fromEntries(parts.slice(0, 4).map((x, k) => ['sk' + (k + 1), x])));
    }
  }
  return out;
}


/**
 * 0.1.14：TA 用工具「说」的话（Aru 的语音条 generateVoice 的 text）。names 是工具名单（小写比），
 * 每个工具取 text 字段；没有 text 的取最长的那个文字字段。返回 { said: [文字…], other: 有没有名单外的工具 }。
 */
export function replyToolText(tools, names) {
  const said = [];
  let other = false;
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!t || !names.includes(String(t.name || '').toLowerCase())) { other = true; continue; }
    let o = null;
    try { o = JSON.parse(t.args || '{}'); } catch { o = null; }
    if (!o || typeof o !== 'object') continue;
    let v = typeof o.text === 'string' ? o.text : '';
    if (!v) for (const x of Object.values(o)) if (typeof x === 'string' && x.length > v.length) v = x;
    if (v.trim()) said.push(v.trim());
  }
  return { said, other };
}


/**
 * 0.1.15：AI_SEES_NUMBERS=false 时，发给 TA 的此刻把数换成说法。心潮念给的此刻本来就不带小数（有小数整块不给），
 * 会出现的数只有「身体：心跳 72，…」这一个跟身体有关的，按心潮念自己的分档（pulse.js heartLabel）换成偏慢 / 平稳 / 偏快 / 很快。
 * 「匣子里 3 条」这种是条数，不是情绪的数，不动。
 */
export function hideNumbers(text) {
  const label = (n) => (n < 60 ? '偏慢' : n < 86 ? '平稳' : n < 106 ? '偏快' : '很快');
  return String(text || '').replace(/心跳\s*(\d{1,3})(?!\d)/g, (m, n) => '心跳' + label(Number(n)));
}

/** 0.1.15：脉那行「身体：心跳…」写明是 TA 自己的（Ting：不然 TA 可能当成她的心跳）。不管开关开没开都写。 */
export function ownBody(text) {
  return String(text || '').replace(/^身体：/m, '身体（你自己的）：');
}


/**
 * 0.1.16：临界点模式（NOW_MODE=signal）用。从心潮念给的此刻文字里取三样要点（心潮念不给结构化数据，只能看字，
 * 照心潮念 4.2 的写法：驱力那行「想她（涌·想黏着）、牵挂（涨）」，驱力分五档 静/平/涨/落/涌；情绪那行「情绪：委屈，想黏着；刚才……」）：
 *   surge：到了「涌」的驱力名；emo：情绪名（「平静」「松弛」后面粘的冷暖字不算）；
 *   kinds：出现了哪几种「要注意」的行——念头、还在气（记仇）、矛盾（拧着）、刚醒、睡着。
 */
export const SIGNAL_KINDS = ['念头', '还在气', '矛盾', '刚醒', '睡着'];
export function nowSignals(text) {
  const surge = [], kinds = [];
  let emo = '';
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('驱力：')) {
      for (const m of line.slice(3).matchAll(/([^、（]+)（([^）·]+)/g)) if (m[2].trim() === '涌') surge.push(m[1].trim());
    } else if (line.startsWith('情绪：')) {
      const head = line.slice(3).split(/[，；]/)[0].trim();
      emo = /^(平静|松弛)/.test(head) ? head.slice(0, 2) : head;
    } else {
      for (const k of SIGNAL_KINDS) if (line.startsWith(k) && !kinds.includes(k)) kinds.push(k);
    }
  }
  return { surge, emo, kinds };
}

/** 跟上一句比，到没到临界点：返回原因（surge 新到涌 / emotion 情绪变了 / line 冒出新的那几种行 / first 第一次），没到返回 '' */
export function signalWhy(prev, cur) {
  if (!prev) return 'first';
  if (cur.surge.some((x) => !prev.surge.includes(x))) return 'surge';
  if (cur.emo && cur.emo !== prev.emo) return 'emotion';
  if (cur.kinds.some((x) => !prev.kinds.includes(x))) return 'line';
  return '';
}
