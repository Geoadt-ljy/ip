// 登录令牌与恒定时间比较工具。
// 只用到已有的环境变量 JWT_SECRET 作为 HMAC 密钥，不需要新增任何配置。

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 令牌有效期（秒）：7 天。到期后需要重新登录。 */
export const TOKEN_TTL_SECONDS = 7 * 24 * 3600;

function toB64Url(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(s: string): Uint8Array {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function sha256(text: string): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

async function hmacSign(secret: string, data: string): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

/**
 * 恒定时间字符串比较：先各自做 SHA-256 得到定长摘要，再逐字节异或累积，
 * 比较耗时与内容、长度无关，避免通过响应时间逐位猜测密码或令牌。
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
    const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
    let diff = 0;
    for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
    return diff === 0;
}

/** 签发带过期时间的令牌：base64url(payload).base64url(HMAC-SHA256) */
export async function signToken(secret: string, ttlSeconds = TOKEN_TTL_SECONDS): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const payload = toB64Url(enc.encode(JSON.stringify({ v: 1, iat: now, exp: now + ttlSeconds })));
    const sig = toB64Url(await hmacSign(secret, `ip-admin.${payload}`));
    return `${payload}.${sig}`;
}

/** 校验令牌：签名正确且未过期才返回 true。 */
export async function verifyToken(secret: string, token: string): Promise<boolean> {
    try {
        const parts = token.split('.');
        if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
        const [payload, sig] = parts;
        const expected = toB64Url(await hmacSign(secret, `ip-admin.${payload}`));
        if (!(await timingSafeEqual(sig, expected))) return false;
        const data = JSON.parse(dec.decode(fromB64Url(payload))) as { exp?: number };
        return typeof data.exp === 'number' && data.exp > Math.floor(Date.now() / 1000);
    } catch {
        return false;
    }
}
