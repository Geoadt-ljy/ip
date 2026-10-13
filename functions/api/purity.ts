interface FfraudResponse {
  success?: boolean;
  ip?: string;
  fraud_score?: number;
  risk?: string;
  reason?: string;
  proxy?: boolean;
  vpn?: boolean;
  tor?: boolean;
  relay?: boolean;
  hosting?: boolean;
  mobile?: boolean;
  is_abuser?: boolean;
  recent_abuse?: boolean;
  connection_type?: string;
  is_residential_proxy?: boolean;
  ISP?: string;
  organization?: string;
  ASN?: string | number;
  threat_tags?: string[];
  confidence?: string;
  geo?: { country?: string; region?: string; city?: string };
}

function purityFromFraud(r: FfraudResponse): { score: number; label: string } {
  // FFraud's fraud_score is a risk score (higher = worse), so purity is its inverse.
  const fraud = Math.max(0, Math.min(100, Number(r.fraud_score ?? 0)));
  const score = Math.round(100 - fraud);
  return {
    score,
    label: score >= 90 ? '高' : score >= 70 ? '中' : '低',
  };
}

function validIpv4(value: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  return !!m && m.slice(1).every(part => Number(part) <= 255);
}

function validIpv6(value: string): boolean {
  if (value.length > 45 || !value.includes(':') || !/^[0-9a-fA-F:.]+$/.test(value)) return false;
  try {
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

function validIp(value: string): boolean {
  return validIpv4(value) || validIpv6(value);
}

interface Env {
  IP_KV?: KVNamespace;
}

// 纯净度结果缓存 24 小时（存放在已有的 IP_KV，key 前缀 purity:）。
// 注意：每个新查询的 IP 会写一次 KV，免费版 KV 每天约 1000 次写入额度；
// 请求体里传 refresh: true 可忽略缓存并重新查询。
const CACHE_TTL_SECONDS = 24 * 3600;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  try {
    const body = await request.json() as { ips?: string[]; refresh?: boolean };
    const ips = Array.from(new Set((body.ips || [])
      .map(x => String(x).trim())
      .filter(validIp)))
      .slice(0, 20);

    if (ips.length === 0) {
      return new Response(JSON.stringify({ message: '没有有效 IP' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Cloudflare Workers/Pages Functions have a per-invocation subrequest cap.
    // Limit each invocation to 20 upstream calls (well below the usual 50-call
    // cap) and keep them sequential. The frontend also sends batches of 20.
    const results: Record<string, unknown> = {};
    for (const ip of ips) {
      try {
        if (!body.refresh && env.IP_KV) {
          try {
            const cached = await env.IP_KV.get(`purity:${ip}`, { type: 'json' });
            if (cached && typeof cached === 'object') {
              results[ip] = cached;
              continue;
            }
          } catch { /* 缓存读取失败时直接走上游查询 */ }
        }

        const upstream = await fetch(`https://api.ffraud.com/public/ip/${encodeURIComponent(ip)}`, {
          headers: { 'Accept': 'application/json' },
        });
        if (!upstream.ok) continue;

        const data = await upstream.json() as FfraudResponse;
        if (data.success === false) continue;

        const purity = purityFromFraud(data);
        results[ip] = {
          purityScore: purity.score,
          purityLabel: purity.label,
          fraudScore: Number(data.fraud_score ?? 0),
          risk: data.risk || '',
          reason: data.reason || '',
          vpn: !!data.vpn,
          mobile: !!data.mobile,
          proxy: !!data.proxy,
          tor: !!data.tor,
          relay: !!data.relay,
          isDatacenter: !!data.hosting,
          isAbuser: !!data.is_abuser,
          recentAbuse: !!data.recent_abuse,
          residentialProxy: !!data.is_residential_proxy,
          connectionType: data.connection_type || '',
          country: data.geo?.country || '',
          region: data.geo?.region || '',
          city: data.geo?.city || '',
          company: data.organization || data.ISP || '',
          isp: data.ISP || '',
          organization: data.organization || '',
          asn: data.ASN != null ? String(data.ASN) : '',
          threatTags: Array.isArray(data.threat_tags) ? data.threat_tags : [],
          confidence: data.confidence || '',
        };
        if (env.IP_KV) {
          try {
            await env.IP_KV.put(`purity:${ip}`, JSON.stringify(results[ip]), { expirationTtl: CACHE_TTL_SECONDS });
          } catch { /* 缓存写入失败（如额度用尽）不影响本次结果 */ }
        }
      } catch {
        // A failed upstream lookup only skips this IP; it must not abort the batch.
        continue;
      }
    }

    return new Response(JSON.stringify({ results }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({
      message: e instanceof Error ? e.message : String(e),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
