import { useState } from 'react';
import { usePipelineConfig, usePipelinePresets, savePipelinePreset, loadPipelinePreset, deletePipelinePreset, resetPipelineConfig, parseRegionRules, stringifyRegionRules, type PipelineSortKey } from '../utils/pipelineConfig';
import { useToast } from './Toast';
import { coloMap, getColoText } from '../utils/colo';

const numCls = 'rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-0.5';

/** 流水线统一配置：扫描阶段（延迟上限、地区、每地区上限）与优选阶段（候选、下载、丢包等）共用 */
export function PipelineSettings({ disabled = false }: { disabled?: boolean }) {
    const [c, set] = usePipelineConfig();
    const { showToast } = useToast();
    const presets = usePipelinePresets();
    const [presetName, setPresetName] = useState('');
    const [presetSel, setPresetSel] = useState('');
    const [showTable, setShowTable] = useState(false);
    const handleSavePreset = () => {
        const name = presetName.trim();
        if (!name) { showToast('请输入配置名称', 'warning'); return; }
        savePipelinePreset(name);
        setPresetSel(name);
        showToast(`流水线配置“${name}”已保存`, 'success');
    };
    const handleLoadPreset = () => {
        if (!presetSel || !loadPipelinePreset(presetSel)) { showToast('请先选择一个已保存的配置', 'warning'); return; }
        showToast(`已载入流水线配置“${presetSel}”`, 'success');
    };
    const handleDeletePreset = () => {
        if (!presetSel) return;
        deletePipelinePreset(presetSel);
        showToast(`已删除流水线配置“${presetSel}”`, 'success');
        setPresetSel('');
    };
    const [query, setQuery] = useState('');
    const rules = parseRegionRules(c.regions);
    const selected = new Set(rules.map(r => r.code));
    const toggleRegion = (code: string) => {
        set({ regions: stringifyRegionRules(selected.has(code) ? rules.filter(r => r.code !== code) : [...rules, { code }]) });
    };
    const toNum = (v: string, int: boolean) => {
        if (v.trim() === '') return undefined;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) return undefined;
        return int ? Math.floor(n) : n;
    };
    const setLimit = (code: string, v: string) => {
        set({ regions: stringifyRegionRules(rules.map(r => (r.code === code ? { ...r, limit: toNum(v, true) } : r))) });
    };
    const setDlMin = (code: string, v: string) => {
        set({ regions: stringifyRegionRules(rules.map(r => (r.code === code ? { ...r, dlMin: toNum(v, false) } : r))) });
    };
    const q = query.trim().toUpperCase();
    const tableCodes = Object.keys(coloMap).filter(code => !q || code.includes(q) || (coloMap[code] || '').toUpperCase().includes(q));
    return (
        <div className="mb-4 w-full rounded-lg border border-gray-200 dark:border-gray-600 p-3 flex flex-col gap-2">
            <label className="flex items-center gap-1.5 text-sm font-bold text-gray-700 dark:text-gray-200 cursor-pointer">
                <input type="checkbox" checked={c.enabled} onChange={(e) => set({ enabled: e.target.checked })} disabled={disabled} />
                启用流水线（扫描 → 筛选 → 多轮平均测试 → 排序勾选）
            </label>
            {!c.enabled && (
                <div className="text-[11px] text-gray-500 dark:text-gray-400">未启用时按上方常规设置扫描，结果列表里的"自动优选"也不可用。</div>
            )}
            {c.enabled && (
                <>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-gray-700 dark:text-gray-200">
                        <span>已保存配置:</span>
                        <select value={presetSel} onChange={(e) => setPresetSel(e.target.value)} disabled={disabled} className={numCls}>
                            <option value="">选择已保存的配置</option>
                            {Object.keys(presets).map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                        <button type="button" onClick={handleLoadPreset} disabled={disabled || !presetSel} className="px-2 py-1 rounded-full bg-blue-100 text-blue-700 hover:bg-blue-200 disabled:opacity-50 dark:bg-blue-900/40 dark:text-blue-300">载入</button>
                        <button type="button" onClick={handleDeletePreset} disabled={disabled || !presetSel} className="px-2 py-1 rounded-full bg-red-100 text-red-700 hover:bg-red-200 disabled:opacity-50 dark:bg-red-900/40 dark:text-red-300">删除</button>
                        <input type="text" value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="配置名称" disabled={disabled} className={`w-28 ${numCls}`} />
                        <button type="button" onClick={handleSavePreset} disabled={disabled} className="px-2 py-1 rounded-full bg-emerald-100 text-emerald-700 hover:bg-emerald-200 disabled:opacity-50 dark:bg-emerald-900/40 dark:text-emerald-300">保存当前</button>
                        <button type="button" onClick={() => { resetPipelineConfig(); showToast('已恢复默认流水线配置', 'info'); }} disabled={disabled} className="px-2 py-1 rounded-full bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-200">恢复默认</button>
                    </div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400">当前设置会自动记住（下次打开仍在）；“保存当前”可以存成多套命名配置，方便切换。</div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-700 dark:text-gray-200">
                        <label className="flex items-center gap-1">
                            <input type="checkbox" checked={c.latencyOn} onChange={(e) => set({ latencyOn: e.target.checked })} disabled={disabled} />
                            延迟 ≤
                            <input type="number" min={1} value={c.latencyMax} onChange={(e) => set({ latencyMax: e.target.value })} disabled={disabled || !c.latencyOn} className={`w-16 ${numCls}`} /> ms
                        </label>
                        <label className="flex items-center gap-1">地区
                            <input type="text" value={c.regions} onChange={(e) => set({ regions: e.target.value })} disabled={disabled} placeholder="如 HKG:5@20,SJC:3,NRT，留空=不限" className={`w-44 ${numCls}`} />
                        </label>
                        <label className="flex items-center gap-1">每个地区最多
                            <input type="number" min={0} max={1000} value={c.perRegion} onChange={(e) => set({ perRegion: e.target.value })} disabled={disabled} className={`w-14 ${numCls}`} /> 个（0=不限）
                        </label>
                        <label className="flex items-center gap-1">候选数量
                            <input type="number" min={1} max={500} value={c.candidates} onChange={(e) => set({ candidates: e.target.value })} disabled={disabled} className={`w-16 ${numCls}`} />
                        </label>
                        <label className="flex items-center gap-1">
                            <input type="checkbox" checked={c.dlOn} onChange={(e) => set({ dlOn: e.target.checked })} disabled={disabled} />
                            下载 ≥
                            <input type="number" min={0} value={c.dlMin} onChange={(e) => set({ dlMin: e.target.value })} disabled={disabled || !c.dlOn} className={`w-16 ${numCls}`} /> Mbps
                        </label>
                        <label className="flex items-center gap-1">下载只测延迟前
                            <input type="number" min={0} max={500} value={c.dlTopN} onChange={(e) => set({ dlTopN: e.target.value })} disabled={disabled} className={`w-14 ${numCls}`} title="先测延迟，只对延迟最好的前 N 个做下载测速；0=全部都测" /> 个（0=全部）
                        </label>
                        <label className="flex items-center gap-1">
                            <input type="checkbox" checked={c.lossOn} onChange={(e) => set({ lossOn: e.target.checked })} disabled={disabled} />
                            丢包 ≤
                            <input type="number" min={0} max={100} value={c.lossMax} onChange={(e) => set({ lossMax: e.target.value })} disabled={disabled || !c.lossOn} className={`w-14 ${numCls}`} /> %
                        </label>
                        <label className="flex items-center gap-1">测试轮数
                            <input type="number" min={1} max={10} value={c.rounds} onChange={(e) => set({ rounds: e.target.value })} disabled={disabled} className={`w-14 ${numCls}`} />
                        </label>
                        <label className="flex items-center gap-1">复测并发数
                            <input type="number" min={1} max={10} value={c.retestConcurrency} onChange={(e) => set({ retestConcurrency: e.target.value })} disabled={disabled} className={`w-14 ${numCls}`} title="同时测几个 IP；测下载速度时建议设为 1" /> 个
                        </label>
                        <label className="flex items-center gap-1">统计方式
                            <select value={c.retestStat} onChange={(e) => set({ retestStat: e.target.value as 'mean' | 'median' })} disabled={disabled} className={numCls}>
                                <option value="mean">平均值</option>
                                <option value="median">中位数</option>
                            </select>
                        </label>
                        <label className="flex items-center gap-1">最终保留
                            <input type="number" min={1} max={500} value={c.keep} onChange={(e) => set({ keep: e.target.value })} disabled={disabled} className={`w-16 ${numCls}`} /> 个
                        </label>
                        <label className="flex items-center gap-1">排序依据
                            <select value={c.sortKey} onChange={(e) => set({ sortKey: e.target.value as PipelineSortKey })} disabled={disabled} className={numCls}>
                                <option value="default">默认（扫描顺序）</option>
                                <option value="latency">平均延迟（低→高）</option>
                                <option value="download">下载速度（高→低）</option>
                                <option value="loss">丢包率（低→高）</option>
                            </select>
                        </label>
                        <label className="flex items-center gap-1">
                            <input type="checkbox" checked={c.afterScan} onChange={(e) => set({ afterScan: e.target.checked })} />
                            扫描完成后自动执行优选
                        </label>
                    </div>
                    <div className="flex flex-col gap-2 text-xs text-gray-700 dark:text-gray-200">
                        {rules.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                                {rules.map(r => (
                                    <span key={r.code} className="inline-flex items-center gap-1 rounded-full bg-indigo-50 dark:bg-indigo-900/30 px-2 py-1">
                                        <span className="font-mono">{r.code}</span>
                                        <span className="text-gray-500 dark:text-gray-400">{coloMap[r.code] ? getColoText(r.code) : '未知代码'}</span>
                                        <input type="number" min={0} value={r.limit ?? ''} onChange={(e) => setLimit(r.code, e.target.value)} disabled={disabled} placeholder={c.perRegion && c.perRegion !== '0' ? c.perRegion : '不限'} title="该地区最多保留个数，留空=使用上面的“每个地区最多”" className="w-14 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-1 py-0.5" />
                                        <span className="text-gray-500 dark:text-gray-400">下载≥</span>
                                        <input type="number" min={0} value={r.dlMin ?? ''} onChange={(e) => setDlMin(r.code, e.target.value)} disabled={disabled} placeholder={c.dlOn ? c.dlMin : '不限'} title="该地区的下载速度下限（Mbps），留空=使用全局“下载 ≥”" className="w-14 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-1 py-0.5" />
                                        <button type="button" onClick={() => toggleRegion(r.code)} disabled={disabled} className="text-gray-400 hover:text-red-500" aria-label={`移除 ${r.code}`}>×</button>
                                    </span>
                                ))}
                            </div>
                        )}
                        <div>
                            <button type="button" onClick={() => setShowTable(v => !v)} className="rounded-full bg-gray-100 dark:bg-gray-700 px-3 py-1 text-xs hover:bg-gray-200 dark:hover:bg-gray-600">{showTable ? '收起地区对照表' : '展开地区对照表（机场代码 ↔ 地区）'}</button>
                        </div>
                        {showTable && (
                            <div className="rounded-md border border-gray-200 dark:border-gray-600 p-2">
                                <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索代码或地区，如 HKG、香港、东京" className="mb-2 w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-xs" />
                                <div className="max-h-56 overflow-y-auto flex flex-wrap gap-1.5">
                                    {tableCodes.length === 0 && <span className="text-gray-400">没有匹配的地区</span>}
                                    {tableCodes.map(code => (
                                        <button type="button" key={code} onClick={() => toggleRegion(code)} disabled={disabled} className={`rounded px-2 py-1 text-xs ${selected.has(code) ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-indigo-100 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-indigo-900/40'}`}>
                                            <span className="font-mono">{code}</span> {getColoText(code)}
                                        </button>
                                    ))}
                                </div>
                                <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">点击加入/取消地区；已选地区里第一个数字框是该地区最多保留几个，“下载≥”是该地区单独的下载速度下限（Mbps），留空则使用全局设置。文字写法：HKG:5@20 表示最多 5 个、下载不低于 20。</div>
                            </div>
                        )}
                    </div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400">
                        扫描阶段直接使用：延迟上限（覆盖上方“延迟上限”）、地区白名单、每个地区上限（没有地区信息的结果会保留）。优选阶段再按候选数量、下载、丢包、保留个数和排序处理。
                    </div>
                </>
            )}
        </div>
    );
}
