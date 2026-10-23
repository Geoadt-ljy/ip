interface Env {
    IP_KV: KVNamespace;
}

const KV_KEY = 'pipeline_presets';
const MAX_PRESETS = 30;
const MAX_BODY_BYTES = 100 * 1024;

const BOOL_KEYS = ['afterScan', 'latencyOn', 'dlOn', 'lossOn', 'retestLatency', 'retestDownload', 'retestLoss', 'showFullResult'];
const STR_KEYS = ['candidates', 'latencyMax', 'regions', 'perRegion', 'dlMin', 'dlTopN', 'lossMax', 'keep', 'rounds', 'retestConcurrency', 'dlSeconds'];
const ENUMS: Record<string, string[]> = {
    sortKey: ['default', 'latency', 'download', 'loss'],
    retestStat: ['mean', 'median'],
    dlMode: ['size', 'time'],
};

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });

/** 只保留已知字段并校验类型，防止写入任意数据 */
function sanitizePreset(input: unknown): Record<string, unknown> | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const src = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of BOOL_KEYS) if (typeof src[k] === 'boolean') out[k] = src[k];
    for (const k of STR_KEYS) {
        const v = src[k];
        if (typeof v === 'string' && v.length <= 500) out[k] = v;
    }
    for (const [k, allowed] of Object.entries(ENUMS)) {
        const v = src[k];
        if (typeof v === 'string' && allowed.includes(v)) out[k] = v;
    }
    return out;
}

// 读取全部流水线配置预设：{ "名称": { ...配置 } }
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
    const raw = await env.IP_KV.get(KV_KEY);
    return new Response(raw || '{}', {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
};

// 覆盖保存全部预设（前端会先读取云端再合并，避免覆盖其他设备的修改）
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
    try {
        const text = await request.text();
        if (text.length > MAX_BODY_BYTES) return json({ message: '数据过大' }, 413);
        const data = JSON.parse(text);
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            return json({ message: '数据格式错误' }, 400);
        }
        const entries = Object.entries(data as Record<string, unknown>);
        if (entries.length > MAX_PRESETS) return json({ message: `最多保存 ${MAX_PRESETS} 套配置` }, 400);
        const cleaned: Record<string, Record<string, unknown>> = {};
        for (const [rawName, preset] of entries) {
            const name = rawName.trim();
            if (!name || name.length > 40) return json({ message: '配置名称需为 1-40 个字符' }, 400);
            const p = sanitizePreset(preset);
            if (!p) return json({ message: `配置“${name.slice(0, 20)}”格式错误` }, 400);
            cleaned[name] = p;
        }
        await env.IP_KV.put(KV_KEY, JSON.stringify(cleaned));
        return new Response(null, { status: 204 });
    } catch {
        return json({ message: '解析请求失败' }, 400);
    }
};
