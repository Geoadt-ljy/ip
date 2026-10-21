/**
 * 流水线统一配置：扫描阶段和优选阶段共用同一份设置，保存在浏览器本地。
 * 总开关 enabled 关闭时，扫描完全按“扫描配置”里的常规设置运行。
 */
import { useSyncExternalStore } from 'react';
import type { ScanResult } from './scanner';
import { getPipelinePresets, savePipelinePresets } from '../api';

export type PipelineSortKey = 'default' | 'latency' | 'download' | 'loss';

export interface PipelineConfig {
    enabled: boolean;       // 流水线总开关
    afterScan: boolean;     // 扫描完成后自动执行优选
    candidates: string;     // 候选数量
    latencyOn: boolean;
    latencyMax: string;     // 延迟上限(ms)：扫描时作为延迟上限，优选时作为平均延迟上限
    regions: string;        // 地区(colo)白名单，逗号分隔，留空=不限
    perRegion: string;      // 每个地区最多保留个数，0=不限
    dlOn: boolean;
    dlMin: string;          // 下载速度下限 Mbps
    dlTopN: string;         // 下载只测延迟最好的前 N 个，0=全部
    lossOn: boolean;
    lossMax: string;        // 丢包率上限 %
    keep: string;           // 最终保留个数
    rounds: string;         // 多轮平均测试轮数
    sortKey: PipelineSortKey;
    retestLatency: boolean;       // 复测项目：延迟
    retestDownload: boolean;      // 复测项目：下载速度
    retestLoss: boolean;          // 复测项目：丢包率
    retestConcurrency: string;    // 复测并发数（同时测几个 IP）
    retestStat: 'mean' | 'median'; // 复测统计方式：平均值 / 中位数
    dlMode: 'size' | 'time';      // 下载方式：size=按文件大小；time=限时测速
    dlSeconds: string;            // 限时测速的时长（秒）
}

const KEY = 'ip-main:pipeline-config';
const DEFAULTS: PipelineConfig = {
    enabled: false,
    afterScan: false,
    candidates: '30',
    latencyOn: true,
    latencyMax: '300',
    regions: '',
    perRegion: '0',
    dlOn: false,
    dlMin: '10',
    dlTopN: '0',
    lossOn: false,
    lossMax: '10',
    keep: '20',
    rounds: '3',
    sortKey: 'default',
    retestLatency: true,
    retestDownload: false,
    retestLoss: false,
    retestConcurrency: '3',
    retestStat: 'mean',
    dlMode: 'size',
    dlSeconds: '6',
};

function load(): PipelineConfig {
    try {
        const raw = localStorage.getItem(KEY);
        return { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
    } catch {
        return { ...DEFAULTS };
    }
}

let state: PipelineConfig = load();
const listeners = new Set<() => void>();

export const getPipelineConfig = (): PipelineConfig => state;

export function setPipelineConfig(patch: Partial<PipelineConfig>): void {
    state = { ...state, ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* 存储不可用时忽略 */ }
    listeners.forEach(l => l());
}

const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => { listeners.delete(l); };
};

export function usePipelineConfig(): [PipelineConfig, typeof setPipelineConfig] {
    const s = useSyncExternalStore(subscribe, getPipelineConfig);
    return [s, setPipelineConfig];
}

export const getPipelineDefaults = (): PipelineConfig => ({ ...DEFAULTS });

/** 恢复默认配置（保留总开关状态） */
export function resetPipelineConfig(): void {
    setPipelineConfig({ ...DEFAULTS, enabled: state.enabled });
}

// ---------- 已保存的流水线预设（不含总开关） ----------
export type PipelinePreset = Omit<PipelineConfig, 'enabled'>;
const PRESET_KEY = 'ip-main:pipeline-presets';

function loadPresets(): Record<string, PipelinePreset> {
    try {
        const raw = JSON.parse(localStorage.getItem(PRESET_KEY) || '{}');
        return raw && typeof raw === 'object' ? raw : {};
    } catch {
        return {};
    }
}

let presets: Record<string, PipelinePreset> = loadPresets();
const presetListeners = new Set<() => void>();
const getPresets = () => presets;
const subscribePresets = (l: () => void) => {
    presetListeners.add(l);
    return () => { presetListeners.delete(l); };
};
function commitPresets(next: Record<string, PipelinePreset>): void {
    presets = next; // 每次生成新对象，保证 useSyncExternalStore 能感知变化
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(presets)); } catch { /* 存储不可用时忽略 */ }
    presetListeners.forEach(l => l());
}

export function usePipelinePresets(): Record<string, PipelinePreset> {
    return useSyncExternalStore(subscribePresets, getPresets);
}

export interface PresetSyncResult { cloud: boolean; error?: string }

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const asCloud = (p: Record<string, PipelinePreset>) => p as unknown as Record<string, Record<string, unknown>>;

/** 保存当前配置为预设（同名覆盖）：先本地生效，再合并云端最新数据后写入云端 KV */
export async function savePipelinePreset(name: string): Promise<PresetSyncResult> {
    const rest: Partial<PipelineConfig> = { ...state };
    delete rest.enabled;
    const preset = rest as PipelinePreset;
    commitPresets({ ...presets, [name]: preset });
    try {
        const remote = (await getPipelinePresets()) as unknown as Record<string, PipelinePreset>;
        const next = { ...remote, [name]: preset };
        await savePipelinePresets(asCloud(next));
        commitPresets(next);
        return { cloud: true };
    } catch (e) {
        return { cloud: false, error: errText(e) };
    }
}

/** 首次/定期从云端拉取预设；云端为空而本地已有时，把本地的迁移上去 */
export async function syncPipelinePresetsFromCloud(): Promise<PresetSyncResult & { migrated?: boolean }> {
    try {
        const remote = (await getPipelinePresets()) as unknown as Record<string, PipelinePreset>;
        if (Object.keys(remote).length === 0 && Object.keys(presets).length > 0) {
            await savePipelinePresets(asCloud(presets));
            return { cloud: true, migrated: true };
        }
        commitPresets(remote);
        return { cloud: true };
    } catch (e) {
        return { cloud: false, error: errText(e) };
    }
}

/** 载入预设（不改变总开关）；缺失的字段用默认值补齐 */
export function loadPipelinePreset(name: string): boolean {
    const pr = presets[name];
    if (!pr) return false;
    setPipelineConfig({ ...DEFAULTS, ...pr, enabled: state.enabled });
    return true;
}

export async function deletePipelinePreset(name: string): Promise<PresetSyncResult> {
    const local = { ...presets };
    delete local[name];
    commitPresets(local);
    try {
        const remote = (await getPipelinePresets()) as unknown as Record<string, PipelinePreset>;
        const next = { ...remote };
        delete next[name];
        await savePipelinePresets(asCloud(next));
        commitPresets(next);
        return { cloud: true };
    } catch (e) {
        return { cloud: false, error: errText(e) };
    }
}

export interface RegionRule { code: string; limit?: number; dlMin?: number }

/**
 * 解析地区规则：如 "HKG:5@20, SJC:3, NRT@10"（逗号/空格/分号分隔）。
 * 冒号后的数字是该地区最多保留个数（不写则用“每个地区最多”的全局值）；
 * @ 后的数字是该地区的下载速度下限 Mbps（不写则用全局“下载 ≥”）。
 */
export function parseRegionRules(text: string): RegionRule[] {
    const seen = new Set<string>();
    const rules: RegionRule[] = [];
    for (const raw of text.split(/[\s,，;；]+/)) {
        const t = raw.trim();
        if (!t) continue;
        const m = /^([A-Za-z0-9]{2,5})(?:[:：=](\d+))?(?:@(\d+(?:\.\d+)?))?$/.exec(t);
        if (!m) continue;
        const code = m[1].toUpperCase();
        if (seen.has(code)) continue;
        seen.add(code);
        const rule: RegionRule = { code };
        if (m[2] !== undefined) rule.limit = parseInt(m[2], 10);
        if (m[3] !== undefined) rule.dlMin = parseFloat(m[3]);
        rules.push(rule);
    }
    return rules;
}

export function stringifyRegionRules(rules: RegionRule[]): string {
    return rules.map(r => `${r.code}${r.limit !== undefined ? `:${r.limit}` : ''}${r.dlMin !== undefined ? `@${r.dlMin}` : ''}`).join(',');
}

/** 解析地区输入为大写代码列表（忽略各地区的个数设置） */
export function parseRegions(text: string): string[] {
    return parseRegionRules(text).map(r => r.code);
}

/** 地区 -> 单独上限（>0 才有效） */
export function regionLimits(rules: RegionRule[]): Record<string, number> {
    const m: Record<string, number> = {};
    rules.forEach(r => { if (r.limit !== undefined && r.limit > 0) m[r.code] = r.limit; });
    return m;
}

/** 地区 -> 单独的下载速度下限（Mbps） */
export function regionDlMins(rules: RegionRule[]): Record<string, number> {
    const m: Record<string, number> = {};
    rules.forEach(r => { if (r.dlMin !== undefined) m[r.code] = r.dlMin; });
    return m;
}

/** 每个地区最多保留 k 个（按传入顺序）；limits 里的地区使用自己的上限；上限<=0 表示不限 */
export function capByRegion<T extends { colo?: string }>(list: T[], k: number, limits: Record<string, number> = {}): T[] {
    if (k <= 0 && Object.keys(limits).length === 0) return list;
    const c: Record<string, number> = {};
    return list.filter(r => {
        const g = (r.colo || 'Unknown').toUpperCase();
        const cap = limits[g] ?? k;
        if (cap <= 0) return true;
        c[g] = (c[g] || 0) + 1;
        return c[g] <= cap;
    });
}

/**
 * 扫描完成后按流水线配置筛选：地区白名单 + 每个地区上限（可按地区单独设置）。
 * 没有地区信息（colo 为空）的结果无法判断归属，予以保留。
 */
export function applyScanFilter(results: ScanResult[], cfg: PipelineConfig): { results: ScanResult[]; removed: number } {
    let out = results;
    const rules = parseRegionRules(cfg.regions);
    if (rules.length > 0) {
        const codes = rules.map(r => r.code);
        out = out.filter(r => !r.colo || codes.includes(r.colo.toUpperCase()));
    }
    const k = Math.floor(Number(cfg.perRegion)) || 0;
    const limits = regionLimits(rules);
    if (k > 0 || Object.keys(limits).length > 0) {
        const good = (r: ScanResult) => r.isAvailable !== false && r.latency > 0;
        const ok = out.filter(good).sort((a, b) => a.latency - b.latency);
        const rest = out.filter(r => !good(r));
        out = [...capByRegion(ok, k, limits), ...rest];
    }
    return { results: out, removed: results.length - out.length };
}
