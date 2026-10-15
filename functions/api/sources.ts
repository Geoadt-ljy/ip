interface Env {
    IP_KV: KVNamespace;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const { env } = context;
    // 使用 wrangler.toml 中定义的 IP_KV
    const sources = await env.IP_KV.get('third_party_sources');
    return new Response(sources || '[]', {
        headers: { 'Content-Type': 'application/json' }
    });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const { request, env } = context;
    try {
        const sources = await request.json();
        if (!Array.isArray(sources) || sources.length > 50) {
            return new Response(JSON.stringify({ message: '数据格式错误（最多 50 个源）' }), { status: 400 });
        }
        const cleaned: string[] = [];
        for (const item of sources) {
            const text = typeof item === 'string' ? item.trim() : '';
            if (!text) continue; // 忽略空行
            let u: URL | null = null;
            try { u = new URL(text); } catch { /* 无效 */ }
            if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:') || text.length > 2048) {
                return new Response(JSON.stringify({ message: `源地址无效（需为 http/https 链接）：${text.slice(0, 80)}` }), { status: 400 });
            }
            cleaned.push(text);
        }
        // 存储到 KV
        await env.IP_KV.put('third_party_sources', JSON.stringify(cleaned));
        return new Response(null, { status: 204 });
    } catch (err) {
        return new Response(JSON.stringify({ message: '解析请求失败' }), { status: 400 });
    }
};
