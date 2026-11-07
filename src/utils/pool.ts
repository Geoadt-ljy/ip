/**
 * 通用并发任务池，用于延迟复测、下载测速、丢包测试等“一批 IP 逐个测”的场景。
 *
 * - 任务领取：多个 worker 共用一个队列游标，同步领取，保证每个任务只被领取一次；
 * - 异常隔离：单个任务抛异常只记为“异常”，不会终止整批任务；
 * - 任务计数：成功、失败、异常都计入“已处理”；被中断放弃的计入“中断”；
 * - 完整性校验：按任务索引核对状态，已处理 + 中断 + 未领取 必须等于总数；
 * - 中断检测：中断后能给出已处理数量和剩余未处理数量；
 * - 结果保存：任务自己把结果写到外部，池本身永远不抛异常，已完成的结果不会因为后面出错而丢掉。
 */
export type PoolOutcome = 'ok' | 'fail' | 'skip';

export interface PoolStats {
    total: number;
    processed: number;    // 已处理 = 成功 + 失败 + 异常
    ok: number;
    failed: number;       // 任务正常返回，但判定为失败
    errored: number;      // 任务抛出了异常
    skipped: number;      // 已领取但被中断放弃（任务返回 'skip'）
    unprocessed: number;  // 还没领取就结束了（中断时剩下的）
    aborted: boolean;
    integrityOk: boolean; // 按索引核对：已处理 + 中断 + 未领取 === 总数，且没有“领取了却没结果”的任务
    errors: { index: number; message: string }[]; // 前 10 个异常，便于诊断
}

export function emptyPoolStats(total: number): PoolStats {
    return { total, processed: 0, ok: 0, failed: 0, errored: 0, skipped: 0, unprocessed: total, aborted: false, integrityOk: true, errors: [] };
}

export async function runPool<T>(
    items: readonly T[],
    concurrency: number,
    task: (item: T, index: number) => Promise<PoolOutcome | void>,
    opts: { signal?: AbortSignal; onProgress?: (processed: number, total: number) => void } = {},
): Promise<PoolStats> {
    const total = items.length;
    const stats = emptyPoolStats(total);
    if (total === 0) return stats;
    // 每个任务索引的状态：0 未领取，1 已领取，2 已处理，3 已领取但被中断放弃
    const state = new Uint8Array(total);
    let cursor = 0;

    const worker = async () => {
        while (!opts.signal?.aborted) {
            const index = cursor++; // 同步领取：JS 单线程，不会有两个 worker 领到同一个索引
            if (index >= total) return;
            state[index] = 1;
            try {
                const outcome = await task(items[index], index);
                if (outcome === 'skip') {
                    state[index] = 3;
                    stats.skipped++;
                    continue;
                }
                state[index] = 2;
                stats.processed++;
                if (outcome === 'fail') stats.failed++; else stats.ok++;
            } catch (error) {
                state[index] = 2;
                stats.processed++;
                stats.errored++;
                if (stats.errors.length < 10) stats.errors.push({ index, message: error instanceof Error ? error.message : String(error) });
            }
            try { opts.onProgress?.(stats.processed, total); } catch { /* 进度回调出错不影响任务 */ }
        }
    };

    const n = Math.max(1, Math.min(Math.floor(concurrency) || 1, total));
    await Promise.all(Array.from({ length: n }, () => worker()));

    let unclaimed = 0;
    let stuck = 0;
    for (let i = 0; i < total; i++) {
        if (state[i] === 0) unclaimed++;
        else if (state[i] === 1) stuck++;
    }
    stats.unprocessed = unclaimed;
    stats.aborted = !!opts.signal?.aborted;
    stats.integrityOk = stuck === 0 && stats.processed + stats.skipped + unclaimed === total;
    return stats;
}

/** 有问题时返回一句说明（异常、未处理、完整性不一致），一切正常返回 null */
export function describePool(label: string, s: PoolStats): string | null {
    const parts: string[] = [];
    if (s.errored > 0) parts.push(`异常 ${s.errored} 个`);
    if (s.skipped > 0) parts.push(`中断 ${s.skipped} 个`);
    if (s.unprocessed > 0) parts.push(`剩余未处理 ${s.unprocessed} 个`);
    if (!s.integrityOk) parts.push('任务数核对不一致');
    if (parts.length === 0) return null;
    const first = s.errors[0] ? `（首个异常：${s.errors[0].message}）` : '';
    return `${label}：已处理 ${s.processed}/${s.total}，${parts.join('，')}${first}`;
}
