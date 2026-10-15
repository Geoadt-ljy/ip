interface Env {
    IP_KV: KVNamespace;
}

// 定义类型，提高代码安全性
interface CloudflareIPsResponse {
    result: {
        ipv4_cidrs: string[];
        ipv6_cidrs: string[];
        etag: string;
    };
    success: boolean;
    errors: any[];
    messages: any[];
}

interface StoredCloudflareIPs {
    ipv4_cidrs: string[];
    cm_cidrs: string[];
    etag: string;
}

// 返回 JSON 响应的辅助函数
const jsonResponse = (data: any, status = 200, headers: HeadersInit = {}) => {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...headers, 'Content-Type': 'application/json' },
    });
};

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const { env } = context;
    try {
        const cached = await env.IP_KV.get<StoredCloudflareIPs>("CF_IPS_DATA", "json");
        return jsonResponse(cached || null);
    } catch (e) {
        return jsonResponse({ message: (e as Error).message }, 500);
    }
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const { env } = context;
    try {
        const cached = await env.IP_KV.get<StoredCloudflareIPs>("CF_IPS_DATA", "json");

        const headers: HeadersInit = {};
        if (cached?.etag) {
            headers['If-None-Match'] = cached.etag;
        }

        const [cfResp, cmResp] = await Promise.all([
            fetch("https://api.cloudflare.com/client/v4/ips", { headers }),
            fetch("https://raw.githubusercontent.com/cmliu/cmliu/main/CF-CIDR.txt")
        ]);

        if (!cfResp.ok) throw new Error(`Cloudflare API request failed with status ${cfResp.status}`);

        const data = await cfResp.json<CloudflareIPsResponse>();
        
        let cmCidrs: string[] = [];
        if (cmResp.ok) {
            const text = await cmResp.text();
            cmCidrs = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        }

        if (data.success) {
            const result = {
                ipv4_cidrs: data.result.ipv4_cidrs,
                cm_cidrs: cmCidrs,
                etag: data.result.etag
            };
            await env.IP_KV.put("CF_IPS_DATA", JSON.stringify(result));
            return jsonResponse(result);
        }
        return jsonResponse({ message: "从 Cloudflare API 获取失败", errors: data.errors }, 500);
    } catch (e) {
        return jsonResponse({ message: (e as Error).message }, 500);
    }
}