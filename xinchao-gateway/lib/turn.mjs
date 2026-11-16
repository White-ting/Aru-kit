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
    if (Array.isArray(last.content) && last.content.some((b) => b && b.type === 'tool_result')) return { kind: 'tool' };
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

export function startsWithSkip(text, prefixes) {
  const t = String(text || '').replace(/^\s+/, '');
  return prefixes.some((p) => p && t.startsWith(p));
}

/**
 * 心潮返回的 now 能不能附。全部满足才返回 true。
 *  ok === true；0 < lines <= 8；0 < text.length <= 400；
 *  text 去掉"数字+条/句"和 xinchao_context 以后，不能再有 \d.\d，也不能有 6 个以上连续小写字母或下划线。
 */
export function passesGate(now) {
  if (!now || typeof now !== 'object') return false;
  if (now.ok !== true) return false;
  const lines = Number(now.lines);
  if (!Number.isFinite(lines) || lines <= 0 || lines > 8) return false;
  if (typeof now.text !== 'string') return false;
  const len = now.text.length;
  if (len <= 0 || len > 400) return false;
  const cleaned = now.text.replace(/\d+\s*[条句]/g, '').replace(/xinchao_context/g, '');
  if (/\d\.\d/.test(cleaned)) return false;
  if (/[a-z_]{6,}/.test(cleaned)) return false;
  return true;
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
  if (!json || typeof json !== 'object') return { text: '', toolCall: false };
  if (format === 'openai') {
    const c = Array.isArray(json.choices) ? json.choices[0] : null;
    if (!c) return { text: '', toolCall: false };
    const msg = c.message || {};
    const toolCall = c.finish_reason === 'tool_calls' || c.finish_reason === 'function_call'
      || (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) || !!msg.function_call;
    return { text: contentText(msg.content), toolCall };
  }
  const blocks = Array.isArray(json.content) ? json.content : [];
  const toolCall = json.stop_reason === 'tool_use' || blocks.some((b) => b && b.type === 'tool_use');
  return { text: contentText(blocks), toolCall };
}

/**
 * 流式回复的拼接器：喂进原始字节，自己切 SSE 的行，把文字拼起来。
 * 只读，不改任何东西；转给 App 的仍然是原始字节。
 */
export function makeStreamCollector(format) {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  const st = { text: '', toolCall: false, done: false };

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
        if (c.finish_reason === 'tool_calls' || c.finish_reason === 'function_call') st.toolCall = true;
      }
    } else {
      if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') st.toolCall = true;
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
    if (format === 'anthropic' && Array.isArray(m.content) && m.content.some((b) => b && b.type === 'tool_result')) break;
    out.unshift(contentText(m.content));
  }
  return out;
}
