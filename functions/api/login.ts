import { signToken, timingSafeEqual } from '../_lib/auth';

interface Env {
  LOGINPW?: string;
  JWT_SECRET?: string;
  APITOKEN?: string;
  IP_KV?: KVNamespace;
}

// 登录失败限速：同一来源 IP 在窗口期内连续失败 MAX_FAILS 次后，暂时拒绝登录。
// 复用已有的 IP_KV 存计数（key 前缀 rl:login:，不影响 scene: 数据）。
// KV 最终一致，这是“软限速”，足以挡住在线暴力猜密码。
const MAX_FAILS = 5;
const WINDOW_SECONDS = 900;

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  try {
    const body = await request.json() as { password?: unknown };
    const password = body?.password;

    if (!env.LOGINPW || !env.JWT_SECRET) {
        console.error("FATAL: LOGINPW or JWT_SECRET is not configured in environment variables.");
        return json({ success: false, message: '错误: 环境变量未配置！' }, 500);
    }

    if (typeof password !== 'string' || password.length === 0 || password.length > 256) {
        return json({ success: false, message: '请求无效' }, 400);
    }

    const rlKey = `rl:login:${request.headers.get('CF-Connecting-IP') || 'unknown'}`;
    let fails = 0;
    if (env.IP_KV) {
        try { fails = parseInt((await env.IP_KV.get(rlKey)) || '0', 10) || 0; } catch { /* 限速不可用时不影响登录 */ }
    }
    if (fails >= MAX_FAILS) {
        return json({ success: false, message: '尝试次数过多，请 15 分钟后再试' }, 429, { 'Retry-After': String(WINDOW_SECONDS) });
    }

    if (await timingSafeEqual(password, env.LOGINPW)) {
      if (env.IP_KV && fails > 0) {
        try { await env.IP_KV.delete(rlKey); } catch { /* 忽略 */ }
      }
      // 密码正确：签发 7 天有效的签名令牌（不再返回 JWT_SECRET 原文）。
      // 同时返回 APITOKEN 供前端展示给用户用于公共接口调用。
      return json({
        success: true,
        token: await signToken(env.JWT_SECRET),
        apiToken: env.APITOKEN
      });
    }

    if (env.IP_KV) {
      try { await env.IP_KV.put(rlKey, String(fails + 1), { expirationTtl: WINDOW_SECONDS }); } catch { /* 忽略 */ }
    }
    return json({ success: false, message: '密码错误' }, 401);
  } catch (e) {
    return json({ success: false, message: '请求无效' }, 400);
  }
};
