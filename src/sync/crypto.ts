// AES-256-GCM 封装。KEK（key-encryption key）来自 Workers Secret `REFRESH_TOKEN_KEK`
// （base64 编码的 32 字节随机数）；密文格式 = base64(iv[12] || ciphertext||tag)。
// Workers Secrets / Secrets Store 在 Worker 内只读，放不了会轮换的 refresh token，
// 所以 token 密文存 Durable Object storage，KEK 才是 secret。

const IV_BYTES = 12;

function b64encode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function b64decode(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function importKek(base64Key: string): Promise<CryptoKey> {
  const raw = b64decode(base64Key.trim());
  if (raw.byteLength !== 32) {
    throw new Error(`REFRESH_TOKEN_KEK must be 32 bytes (got ${raw.byteLength})`);
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function seal(kek: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(plaintext);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, data));
  const out = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(ciphertext, iv.byteLength);
  return b64encode(out);
}

export async function open(kek: CryptoKey, sealed: string): Promise<string> {
  const bytes = b64decode(sealed);
  if (bytes.byteLength <= IV_BYTES) throw new Error("sealed payload too short");
  const iv = bytes.slice(0, IV_BYTES);
  const ciphertext = bytes.slice(IV_BYTES);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, kek, ciphertext);
  return new TextDecoder().decode(plain);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/// 常量时间比较（长度不同直接 false——只泄漏长度）。
export function timingSafeEqualString(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}
