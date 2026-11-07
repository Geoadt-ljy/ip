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
    latencyTolerance: string;     // 延迟复测容差（%）：复测延迟允许超出上限的比例
    lossStrict: boolean;          // 丢包判定：false=只算请求失败；true=延迟尖峰（疑似重传）也算
    mergeLatencyLoss: boolean;    // 延迟和丢包一起复测：一次探测同时得到延迟和丢包，省去单独的延迟复测
    showFullResult: boolean;      // 显示完整优选结果：成功和失败的都显示
    retestLatency: boolean;       // 复测项目：延迟
    retestDownload: boolean;      // 复测项目：下载速度
    retestLoss: boolean;          // 复测项目：丢包率
    retestConcurrency: string;    // 复测并发数（同时测几个 IP）
    retestStat: 'mean' | 'median'; // 复测统计方式：平均值 / 中位数
    dlMode: 'size' | 'time';      // 下载方式：size=按文件大小；time=限时测速
    dlSeconds: string;            // 限时测速的时长（秒）
}

const LEGACY_KEY = 'ip-main:pipeline-config';      // 旧版：所有模式共用一份配置
const KEY = 'ip-main:pipeline-configs-v2';          // 新版：每个 IP 来源模式各一份配置
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
    latencyTolerance: '30',
    lossStrict: true,
    mergeLatencyLoss: false,
    showFullResult: false,
    retestLatency: false,
    retestDownload: false,
    retestLoss: false,
    retestConcurrency: '3',
    retestStat: 'mean',
    dlMode: 'size',
    dlSeconds: '6',
};

/** IP 来源模式：官方 IP、CM IP、IP 源（第三方）、自定义 IP，各自有一份流水线配置，可互相导入 */
export type PipelineMode = 'cf' | 'cm' | 'third' | 'custom';
export const PIPELINE_MODES: PipelineMode[] = ['cf', 'cm', 'third', 'custom'];
export const PIPELINE_MODE_LABELS: Record<PipelineMode, string> = { cf: '官方 IP', cm: 'CM IP', third: 'IP 源', custom: '自定义 IP' };

function loadAll(): Record<PipelineMode, PipelineConfig> {
    const result = {} as Record<PipelineMode, PipelineConfig>;
    try {
        const raw = localStorage.getItem(KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            for (const m of PIPELINE_MODES) result[m] = { ...DEFAULTS, ...(parsed?.[m] || {}) };
            return result;
        }
        // 从旧版迁移：原来共用的那一份配置，先复制给每个模式，之后各自独立
        const legacyRaw = localStorage.getItem(LEGACY_KEY);
        const legacy = { ...DEFAULTS, ...(legacyRaw ? JSON.parse(legacyRaw) : {}) };
        for (const m of PIPELINE_MODES) result[m] = { ...legacy };
        return result;
    } catch {
        for (const m of PIPELINE_MODES) result[m] = { ...DEFAULTS };
        return result;
    }
}

let allConfigs: Record<PipelineMode, PipelineConfig> = loadAll();
let activeMode: PipelineMode = 'cf';
let state: PipelineConfig = allConfigs[activeMode]; // 当前模式的配置
const listeners = new Set<() => void>();

export const getPipelineConfig = (): PipelineConfig => state;

function persist(): void {
    try { localStorage.setItem(KEY, JSON.stringify(allConfigs)); } catch { /* 存储不可用时忽略 */ }
}

export function setPipelineConfig(patch: Partial<PipelineConfig>): void {
    state = { ...state, ...patch };
    allConfigs = { ...allConfigs, [activeMode]: state };
    persist();
    listeners.forEach(l => l());
}

export const getPipelineMode = (): PipelineMode => activeMode;

/** 切换当前模式（由“扫描配置”里选中的 IP 来源决定），读写的配置随之切换 */
export function setPipelineMode(mode: PipelineMode): void {
    if (mode === activeMode) return;
    activeMode = mode;
    state = allConfigs[mode];
    listeners.forEach(l => l());
}

export function usePipelineMode(): PipelineMode {
    return useSyncExternalStore(subscribe, getPipelineMode);
}

/** 把另一个模式的流水线配置导入到当前模式（保持当前模式的总开关状态） */
export function importPipelineConfigFrom(mode: PipelineMode): boolean {
    if (mode === activeMode || !allConfigs[mode]) return false;
    setPipelineConfig({ ...allConfigs[mode], enabled: state.enabled });
    return true;
}

/** 把当前模式的流水线配置复制到其他所有模式（各自保持原来的总开关状态） */
export function copyPipelineConfigToAll(): void {
    const next = { ...allConfigs };
    for (const m of PIPELINE_MODES) {
        if (m !== activeMode) next[m] = { ...state, enabled: allConfigs[m].enabled };
    }
    allConfigs = next;
    persist();
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
const PRESET_MIGRATED_KEY = 'ip-main:pipeline-presets-migrated';

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

const markCloudSynced = () => { try { localStorage.setItem(PRESET_MIGRATED_KEY, '1'); } catch { /* 忽略 */ } };
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
        markCloudSynced();
        return { cloud: true };
    } catch (e) {
        return { cloud: false, error: errText(e) };
    }
}

/** 首次/定期从云端拉取预设；云端为空而本地已有时，把本地的迁移上去 */
export async function syncPipelinePresetsFromCloud(): Promise<PresetSyncResult & { migrated?: boolean }> {
    try {
        const remote = (await getPipelinePresets()) as unknown as Record<string, PipelinePreset>;
        let migratedBefore = false;
        try { migratedBefore = localStorage.getItem(PRESET_MIGRATED_KEY) === '1'; } catch { /* 忽略 */ }
        // 只在“云端为空、本地已有、且从未同步过”时把本地配置迁移上去；
        // 同步过之后云端就是准的，别的设备删光了配置，本地不能再把它们“复活”
        if (Object.keys(remote).length === 0 && Object.keys(presets).length > 0 && !migratedBefore) {
            await savePipelinePresets(asCloud(presets));
            markCloudSynced();
            return { cloud: true, migrated: true };
        }
        markCloudSynced();
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
    // 预设里没有的字段（旧版本保存的预设）保持当前值，不被重置成默认值
    setPipelineConfig({ ...state, ...pr, enabled: state.enabled });
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
        markCloudSynced();
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
 * 扫描完成后按流水线配置筛选：只按地区白名单筛选。
 * 注意：“每个地区最多保留”只在最终结果里生效，这里不做数量限制，保证所有合格 IP 都能进入后续测试。
 * 没有地区信息（colo 为空）的结果无法判断归属，予以保留。
 */
export function applyScanFilter(results: ScanResult[], cfg: PipelineConfig): { results: ScanResult[]; removed: number } {
    let out = results;
    const rules = parseRegionRules(cfg.regions);
    if (rules.length > 0) {
        const codes = rules.map(r => r.code);
        out = out.filter(r => !r.colo || codes.includes(r.colo.toUpperCase()));
    }
    return { results: out, removed: results.length - out.length };
}
