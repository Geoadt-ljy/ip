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
  // FFraud 的 fraud_score 是风险分（越高越差），纯净度取其反向值。
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

// 纯净度检测本身不读写 KV：结果只返回给页面，放在页面内存里（和延迟一样），
// 用户点“保存到场景”时才随 IP 一起整体写入一次 KV，避免查一个写一个而消耗免费版每天约 1000 次的写入额度。
export const onRequestPost: PagesFunction = async ({ request }) => {
  try {
    const body = await request.json() as { ips?: string[] };
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

    // Cloudflare Workers / Pages Functions 对单次调用的子请求数量有上限。
    // 每次调用最多向上游发 20 次请求（远低于常见的 50 次上限），
    // 并且按顺序执行。前端按每批 5 个发送，结果逐批返回。
    const results: Record<string, unknown> = {};
    for (const ip of ips) {
      try {
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
      } catch {
        // 某个 IP 上游查询失败时只跳过该 IP，不能中断整批请求。
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
