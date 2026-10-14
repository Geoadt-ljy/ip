// 综合评分：把延迟、下载速度、纯净度合成一个 0-100 的分数，供订阅接口（sort=score）
// 和前端「已保存列表」排序共用，保证两边口径一致。
//
// 说明：业界常见做法（例如 CloudflareSpeedTest）是“先按延迟/丢包筛选，再按速度排序”的分阶段筛选，
// 并没有统一的综合评分公式，所以这里的权重和封顶值是本项目自己的设计，可按需修改下面的常量。
//
// 规则：
//   延迟分 = 1 - 延迟 / 300ms（≥300ms 记 0；未测或失败记 0）
//   速度分 = 下载速度 / 100Mbps（≥100Mbps 记满分；未测速记 0）
//   纯净度分 = 纯净度 / 100（未检测记 0）
//   综合分 = 100 × (0.40 × 延迟分 + 0.35 × 速度分 + 0.25 × 纯净度分)
// 因此“只测了延迟”的 IP 最高只有 40 分，测过速度和纯净度的 IP 才可能拿到高分。
// 权重可以自定义（前端“评分权重”面板、订阅接口 w_latency / w_speed / w_purity），传入后会自动归一化。

export interface ScoreWeights {
    latency: number;
    speed: number;
    purity: number;
}

export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = { latency: 0.4, speed: 0.35, purity: 0.25 };
export const SCORE_WEIGHTS = DEFAULT_SCORE_WEIGHTS;

/** 把任意非负权重归一化为总和 1；非法值按 0 计，三项都为 0 时回退到默认权重。 */
export function normalizeWeights(w: Partial<ScoreWeights> | null | undefined): ScoreWeights {
    const pick = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
    const latency = pick(w?.latency);
    const speed = pick(w?.speed);
    const purity = pick(w?.purity);
    const sum = latency + speed + purity;
    if (sum <= 0) return { ...DEFAULT_SCORE_WEIGHTS };
    return { latency: latency / sum, speed: speed / sum, purity: purity / sum };
}
export const SCORE_LATENCY_CAP_MS = 300;
export const SCORE_SPEED_CAP_MBPS = 100;

export interface ScoreInput {
    latency?: number;
    downloadMbps?: number;
    purity?: { purityScore?: number } | null;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function compositeScore(item: ScoreInput, weights: Partial<ScoreWeights> = DEFAULT_SCORE_WEIGHTS): number {
    const w = normalizeWeights(weights);
    const latency = Number(item.latency);
    const latencyPart = Number.isFinite(latency) && latency > 0
        ? clamp01(1 - latency / SCORE_LATENCY_CAP_MS)
        : 0;

    const speed = Number(item.downloadMbps);
    const speedPart = Number.isFinite(speed) && speed > 0
        ? clamp01(speed / SCORE_SPEED_CAP_MBPS)
        : 0;

    const purity = Number(item.purity?.purityScore);
    const purityPart = Number.isFinite(purity) && purity >= 0
        ? clamp01(purity / 100)
        : 0;

    const score = 100 * (w.latency * latencyPart + w.speed * speedPart + w.purity * purityPart);
    return Math.round(score * 10) / 10;
}
