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

export const SCORE_WEIGHTS = { latency: 0.4, speed: 0.35, purity: 0.25 } as const;
export const SCORE_LATENCY_CAP_MS = 300;
export const SCORE_SPEED_CAP_MBPS = 100;

export interface ScoreInput {
    latency?: number;
    downloadMbps?: number;
    purity?: { purityScore?: number } | null;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function compositeScore(item: ScoreInput): number {
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

    const score = 100 * (
        SCORE_WEIGHTS.latency * latencyPart +
        SCORE_WEIGHTS.speed * speedPart +
        SCORE_WEIGHTS.purity * purityPart
    );
    return Math.round(score * 10) / 10;
}
