// 照 aru-host 的 wake-send.mjs（Apache-2.0）用 WebCrypto 重写：把简报封进 Aru 外部触发的信封，投给 Host。
// bundle 是手机导出的发送凭证：{schema, triggerId, submitURL, submitToken, encryptionKey(base64, 32 字节)}

function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function checkBundle(bundle) {
  if (bundle?.schema !== "aru.wake-bridge.sender-bundle.v2"
      || typeof bundle.triggerId !== "string" || !bundle.triggerId
      || typeof bundle.submitToken !== "string" || !bundle.submitToken) {
    throw new Error("发送凭证格式不对");
  }
  try {
    if (typeof bundle.submitURL !== "string" || !/^https:\/\//i.test(bundle.submitURL) || new URL(bundle.submitURL).protocol !== "https:") throw new Error();
  } catch { throw new Error("发送凭证里的投递地址必须是有效的 HTTPS 地址"); }
  if (b64ToBytes(bundle.encryptionKey || "").length !== 32) throw new Error("发送凭证里的密钥不是 32 字节");
}

export async function sealWakeEvent(bundle, content, eventId = crypto.randomUUID(), nonce = crypto.getRandomValues(new Uint8Array(12))) {
  checkBundle(bundle);
  const text = String(content ?? "").trim();
  if (!text) throw new Error("简报是空的");
  const payload = new TextEncoder().encode(JSON.stringify({
    schema: "aru.wake-bridge.payload.v2",
    eventId,
    triggerId: bundle.triggerId,
    content: text,
  }));
  const key = await crypto.subtle.importKey("raw", b64ToBytes(bundle.encryptionKey), "AES-GCM", false, ["encrypt"]);
  // WebCrypto 的 AES-GCM 输出 = 密文 || 16 字节标签，跟 Node 的 ciphertext+tag 拼法一样
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, payload));
  const sealed = new Uint8Array(nonce.length + ct.length);
  sealed.set(nonce, 0);
  sealed.set(ct, nonce.length);
  return { schema: "aru.wake-bridge.sealed-event.v1", eventId, sealedPayload: bytesToB64(sealed) };
}

export async function submitWakeEvent(bundle, content, signal) {
  const env = await sealWakeEvent(bundle, content);
  const r = await fetch(bundle.submitURL, {
    method: "POST",
    headers: { authorization: `Bearer ${bundle.submitToken}`, "content-type": "application/json" },
    body: JSON.stringify(env),
    signal,
    redirect: "manual",   // Cloudflare Workers 不认 "error"：手动看，被重定向就当失败（官方发送器也拒绝重定向）
  });
  if (r.status >= 300 && r.status < 400) throw new Error(`投递地址被重定向了（HTTP ${r.status}），不投`);
  if (!r.ok) throw new Error(`投递失败：HTTP ${r.status}`);
  return env.eventId;
}
