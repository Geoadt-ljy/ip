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

function validIp(value: string): boolean {
  // Accept IPv4 and IPv6. The upstream API performs the final validation.
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || value.includes(':');
}

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

    // Cloudflare Workers/Pages Functions have a per-invocation subrequest cap.
    // Limit each invocation to 20 upstream calls (well below the usual 50-call
    // cap) and keep them sequential. The frontend also sends batches of 20.
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
