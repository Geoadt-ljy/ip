import { useState, useEffect, useRef, ChangeEvent } from 'react';
import { getScenes, getSceneResults, saveResults, deleteScene, renameScene } from '../api';
import { getLatencyColor, ScanResult, testIpLatency, testBrowserDownloadSpeed, resolveDomainToIp } from '../utils/scanner';
import { compositeScore, normalizeWeights } from '../../functions/_lib/score';
import { classifyHome } from '../../functions/_lib/residential';
import { getColoName } from '../utils/colo';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmDialog'; // 确认对话框
import { ListChecks, Trash2, RotateCw, FileText, File, Copy, Pencil, Settings2, Download, Upload, Activity, Save, Square } from 'lucide-react';
import { RegionDisplay } from './RegionDisplay';

// 保存在 KV 中的数据类型，不包含 `isAvailable`
interface SavedIpData {
    ip: string;
    port: number;
    latency: number;
    colo?: string;
    domain?: boolean; // 是否为域名源
    downloadMbps?: number;
    purity?: {
        purityScore?: number;
        purityLabel?: string;
        // 保存时带上的纯净度详情，用于家宽判定
        connectionType?: string;
        isDatacenter?: boolean;
        vpn?: boolean;
        proxy?: boolean;
        tor?: boolean;
        relay?: boolean;
        mobile?: boolean;
    };
    testedAt?: number; // 最近一次测试/保存时间（毫秒时间戳），旧数据没有该字段
}
interface FlatIpItem extends SavedIpData {
    sceneName: string;
}

type SortKey = 'latency' | 'speed' | 'purity' | 'score' | 'recent';

// 综合评分权重（百分比数字），保存在浏览器本地；订阅接口用 w_latency / w_speed / w_purity 传入
const WEIGHTS_KEY = 'score_weights';
type WeightInputs = { latency: string; speed: string; purity: string };
const DEFAULT_WEIGHT_INPUTS: WeightInputs = { latency: '40', speed: '35', purity: '25' };
const loadWeightInputs = (): WeightInputs => {
    try {
        const raw = localStorage.getItem(WEIGHTS_KEY);
        if (!raw) return DEFAULT_WEIGHT_INPUTS;
        const p = JSON.parse(raw) as Partial<WeightInputs>;
        const pick = (v: unknown, d: string) => (typeof v === 'string' && /^\d*\.?\d*$/.test(v) ? v : d);
        return { latency: pick(p.latency, '40'), speed: pick(p.speed, '35'), purity: pick(p.purity, '25') };
    } catch {
        return DEFAULT_WEIGHT_INPUTS;
    }
};

const itemId = (i: FlatIpItem) => `${i.ip}:${i.port}#${i.sceneName}`;

// 复测参数
const RETEST_TIMEOUT_MS = 3000;       // 延迟复测超时
const RETEST_LATENCY_WORKERS = 8;     // 延迟复测并发
const RETEST_SPEED_WORKERS = 2;       // 速度复测并发
const RETEST_SPEED_BYTES = 25 * 1024 * 1024; // 与首次测速一致，保证数值可比
const SPEED_DROP_RATIO = 0.5;         // 复测速度低于原来的 50% 视为明显下降
const STALE_MS = 7 * 24 * 3600 * 1000; // 超过 7 天标为“较旧”

const formatAge = (ts?: number): string => {
    if (!ts) return '-';
    const minutes = Math.floor((Date.now() - ts) / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    return `${Math.floor(hours / 24)} 天前`;
};

export function SavedIpList() {
    const [items, setItems] = useState<FlatIpItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [selectedScenes, setSelectedScenes] = useState<Set<string>>(new Set());
    const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
    const { showToast } = useToast();
    const { confirm } = useConfirm();

    const [sceneList, setSceneList] = useState<string[]>([]); // 全部分组（包含没有 IP 的空分组）
    const [sortKey, setSortKey] = useState<SortKey>('latency');
    const [homeOnly, setHomeOnly] = useState(false); // 仅家宽，需要保存时带有纯净度数据
    const [showWeights, setShowWeights] = useState(false);
    const [weightInputs, setWeightInputs] = useState<WeightInputs>(loadWeightInputs);
    useEffect(() => {
        try { localStorage.setItem(WEIGHTS_KEY, JSON.stringify(weightInputs)); } catch { /* 忽略 */ }
    }, [weightInputs]);
    const scoreWeights = normalizeWeights({
        latency: Number(weightInputs.latency),
        speed: Number(weightInputs.speed),
        purity: Number(weightInputs.purity),
    });
    const weightPct = (n: number) => Math.round(n * 1000) / 10;
    const apiWeightParams = `w_latency=${Number(weightInputs.latency) || 0}&w_speed=${Number(weightInputs.speed) || 0}&w_purity=${Number(weightInputs.purity) || 0}`;
    const [showManage, setShowManage] = useState(false);
    const [editingScene, setEditingScene] = useState<string | null>(null);
    const [editValue, setEditValue] = useState('');
    const [retesting, setRetesting] = useState(false);
    const [retestDone, setRetestDone] = useState(0);
    const [retestTotal, setRetestTotal] = useState(0);
    const [includeSpeedRetest, setIncludeSpeedRetest] = useState(false);
    const [retestFlags, setRetestFlags] = useState<Record<string, string>>({}); // 失效原因：id -> 说明
    const [dirtyScenes, setDirtyScenes] = useState<Set<string>>(new Set());     // 复测后有改动、尚未保存的分组
    const retestAbortRef = useRef<AbortController | null>(null);

    // 离开页面时中断复测
    useEffect(() => () => { retestAbortRef.current?.abort(); }, []);

    const loadData = async () => {
        setLoading(true);
        setItems([]); // 加载前先清空列表，避免显示旧数据造成混淆
        try {
            // 1. 获取所有场景名
            const scenes = await getScenes();
            setSceneList(scenes.map(sc => sc.name));
            setRetestFlags({});
            setDirtyScenes(new Set());
            
            // 2. 并行获取所有场景的详细数据
            const promises = scenes.map(async (scene) => {
                try {
                    const results = await getSceneResults(scene.name);
                    return results.map(r => ({ ...r, sceneName: scene.name }));
                } catch (e) {
                    console.error(`Failed to load scene ${scene.name}`, e);
                    return [];
                }
            });

            const resultsArray = await Promise.all(promises);
            // 3. 扁平化数组
            const allItems = resultsArray.flat();
            setItems(allItems);
            setSelectedScenes(new Set(allItems.map(i => i.sceneName)));
        } catch (e) {
            console.error('Failed to load saved IPs', e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadData();
    }, []);

    const uniqueScenes = Array.from(new Set(items.map(i => i.sceneName))).sort();
    const filteredItems = items.filter(i => selectedScenes.has(i.sceneName)
        && (!homeOnly || (!!i.purity && classifyHome(i.purity) !== 'other')));
    const latencyOrder = (v: number) => (v > 0 ? v : Number.MAX_SAFE_INTEGER); // 延迟失败（-1）的排最后
    const filteredItemsSorted = [...filteredItems].sort((a, b) => {
        const byLatency = latencyOrder(a.latency) - latencyOrder(b.latency);
        switch (sortKey) {
            case 'speed': return (b.downloadMbps || 0) - (a.downloadMbps || 0) || byLatency;
            case 'purity': return (b.purity?.purityScore ?? -1) - (a.purity?.purityScore ?? -1) || byLatency;
            case 'score': return compositeScore(b, scoreWeights) - compositeScore(a, scoreWeights) || byLatency;
            case 'recent': return (b.testedAt || 0) - (a.testedAt || 0) || byLatency;
            default: return byLatency;
        }
    });

    const handleCheckboxChange = (id: string, checked: boolean) => {
        const newSet = new Set(selectedItems);
        if (checked) newSet.add(id);
        else newSet.delete(id);
        setSelectedItems(newSet);
    };

    const handleSelectAll = (checked: boolean) => {
        const newSet = new Set(selectedItems);
        filteredItems.forEach(item => {
            const id = `${item.ip}:${item.port}#${item.sceneName}`;
            if (checked) newSet.add(id);
            else newSet.delete(id);
        });
        setSelectedItems(newSet);
    };

    const handleDeleteSelected = async () => {
        if (selectedItems.size === 0) return;
        const isConfirmed = await confirm(`确定要删除选中的 ${selectedItems.size} 个IP/域名吗？`, {
            confirmText: '确定删除',
        });
        if (!isConfirmed) return;

        setLoading(true);
        try {
            const scenesToUpdate = new Set<string>();
            items.forEach(item => {
                if (selectedItems.has(`${item.ip}:${item.port}#${item.sceneName}`)) {
                    scenesToUpdate.add(item.sceneName);
                }
            });

            for (const scene of scenesToUpdate) {
                const sceneItems = items.filter(i => i.sceneName === scene);
                const keepItems = sceneItems.filter(item => !selectedItems.has(`${item.ip}:${item.port}#${item.sceneName}`));

                const resultsToSave = keepItems.map(({ sceneName, ...rest }) => rest);
                await saveResults(scene, resultsToSave as ScanResult[], 'overwrite');
            }
            setSelectedItems(new Set());
            await loadData();
        } catch (e) {
            showToast('删除失败', 'error');
            setLoading(false);
        }
    };

    // 把指定分组按当前内存中的数据整体写回（覆盖）
    const persistScenes = async (scenesToSave: Iterable<string>, source: FlatIpItem[]) => {
        for (const scene of scenesToSave) {
            const list = source.filter(i => i.sceneName === scene).map(({ sceneName: _unused, ...rest }) => rest);
            await saveResults(scene, list as ScanResult[], 'overwrite');
        }
    };

    // ---------------- 分组管理 ----------------
    const manageNames = Array.from(new Set([...sceneList, ...items.map(i => i.sceneName)])).sort();

    const submitRename = async (from: string) => {
        const to = editValue.trim();
        if (!to || to === from) {
            setEditingScene(null);
            return;
        }
        try {
            await renameScene(from, to);
            showToast(`已将分组「${from}」重命名为「${to}」`, 'success');
            setEditingScene(null);
            await loadData();
        } catch (e) {
            showToast(`重命名失败: ${e instanceof Error ? e.message : '未知错误'}`, 'error');
        }
    };

    const handleDeleteScene = async (name: string) => {
        const count = items.filter(i => i.sceneName === name).length;
        const ok = await confirm(`确定要删除分组「${name}」吗？其中的 ${count} 个 IP/域名会一并删除，此操作不可恢复。`, { confirmText: '确定删除' });
        if (!ok) return;
        try {
            await deleteScene(name);
            showToast(`已删除分组「${name}」`, 'success');
            await loadData();
        } catch (e) {
            showToast(`删除失败: ${e instanceof Error ? e.message : '未知错误'}`, 'error');
        }
    };

    // ---------------- 复测 ----------------
    const handleRetest = async () => {
        const targets = selectedItems.size > 0
            ? filteredItems.filter(i => selectedItems.has(itemId(i)))
            : filteredItems;
        if (targets.length === 0) {
            showToast('没有可复测的数据', 'warning');
            return;
        }

        const controller = new AbortController();
        retestAbortRef.current = controller;
        const signal = controller.signal;
        setRetesting(true);
        setRetestDone(0);
        setRetestTotal(targets.length);
        setRetestFlags({});

        const updates = new Map<string, Partial<FlatIpItem>>();
        const flags: Record<string, string> = {};
        let done = 0;
        let latencyOk = 0;

        try {
            // 阶段一：复测延迟
            const queue = [...targets];
            const latencyWorker = async () => {
                while (queue.length > 0 && !signal.aborted) {
                    const item = queue.shift();
                    if (!item) return;
                    const id = itemId(item);
                    let host = item.ip;
                    if (item.domain) {
                        const resolved = await resolveDomainToIp(item.ip);
                        if (!resolved) {
                            flags[id] = '域名解析失败';
                            done++;
                            setRetestDone(done);
                            continue;
                        }
                        host = resolved;
                    }
                    const r = await testIpLatency(host, item.port, RETEST_TIMEOUT_MS);
                    if (r.latency > 0) {
                        latencyOk++;
                        updates.set(id, {
                            latency: r.latency,
                            ...(r.colo && r.colo !== '-' ? { colo: r.colo } : {}),
                            testedAt: Date.now(),
                        });
                    } else {
                        flags[id] = '超时/不可达';
                    }
                    done++;
                    setRetestDone(done);
                }
            };
            await Promise.all(Array.from({ length: Math.min(RETEST_LATENCY_WORKERS, targets.length) }, () => latencyWorker()));

            // 阶段二（可选）：只复测“原来测过速度、且延迟复测成功”的 IPv4
            if (includeSpeedRetest && !signal.aborted) {
                const speedTargets = targets.filter(i =>
                    !i.domain && !i.ip.includes(':') && (i.downloadMbps || 0) > 0 && !flags[itemId(i)]
                );
                setRetestDone(0);
                setRetestTotal(speedTargets.length);
                let speedDone = 0;
                const speedQueue = [...speedTargets];
                const speedWorker = async () => {
                    while (speedQueue.length > 0 && !signal.aborted) {
                        const item = speedQueue.shift();
                        if (!item) return;
                        const id = itemId(item);
                        const result = await testBrowserDownloadSpeed(item.ip, item.port, {
                            bytes: RETEST_SPEED_BYTES,
                            timeoutMs: 30000,
                            signal,
                        });
                        if (result.aborted) return;
                        const old = item.downloadMbps || 0;
                        if (result.downloadMbps > 0) {
                            const ratio = result.downloadMbps / old;
                            updates.set(id, { ...(updates.get(id) || {}), downloadMbps: result.downloadMbps, testedAt: Date.now() });
                            if (ratio < SPEED_DROP_RATIO) {
                                flags[id] = `速度下降 ${Math.round((1 - ratio) * 100)}%（${old.toFixed(1)} → ${result.downloadMbps.toFixed(1)} Mbps）`;
                            }
                        } else {
                            flags[id] = '测速失败';
                        }
                        speedDone++;
                        setRetestDone(speedDone);
                    }
                };
                await Promise.all(Array.from({ length: Math.min(RETEST_SPEED_WORKERS, speedTargets.length) }, () => speedWorker()));
            }

            // 把复测得到的新数据写进列表（失败项保持原值，只做标记）
            if (updates.size > 0) {
                setItems(prev => prev.map(i => (updates.has(itemId(i)) ? { ...i, ...updates.get(itemId(i)) } : i)));
                const touched = new Set<string>();
                targets.forEach(i => { if (updates.has(itemId(i))) touched.add(i.sceneName); });
                setDirtyScenes(prev => new Set([...prev, ...touched]));
            }
            setRetestFlags(flags);

            const flagged = Object.keys(flags).length;
            if (signal.aborted) {
                showToast(`已中断复测：已完成 ${done}/${targets.length}，其中 ${flagged} 个标记为失效`, 'warning');
            } else {
                showToast(`复测完成：延迟可用 ${latencyOk}/${targets.length}，失效 ${flagged} 个${updates.size > 0 ? '。点击「保存复测结果」写回' : ''}`, flagged > 0 ? 'warning' : 'success');
            }
        } finally {
            setRetesting(false);
            if (retestAbortRef.current === controller) retestAbortRef.current = null;
        }
    };

    const handleAbortRetest = () => retestAbortRef.current?.abort();

    const handleSaveRetest = async () => {
        if (dirtyScenes.size === 0) return;
        setLoading(true);
        try {
            await persistScenes(dirtyScenes, items);
            setDirtyScenes(new Set());
            showToast('复测结果已保存', 'success');
        } catch (e) {
            showToast(`保存失败: ${e instanceof Error ? e.message : '未知错误'}`, 'error');
        } finally {
            setLoading(false);
        }
    };

    const flaggedCount = items.filter(i => retestFlags[itemId(i)]).length;

    const handleDeleteFlagged = async () => {
        const flagged = items.filter(i => retestFlags[itemId(i)]);
        if (flagged.length === 0) return;
        const ok = await confirm(`确定要删除复测标记为失效的 ${flagged.length} 个 IP/域名吗？`, { confirmText: '确定删除' });
        if (!ok) return;
        setLoading(true);
        try {
            const remaining = items.filter(i => !retestFlags[itemId(i)]);
            const scenesToSave = new Set<string>([...flagged.map(i => i.sceneName), ...dirtyScenes]);
            await persistScenes(scenesToSave, remaining);
            showToast(`已删除 ${flagged.length} 个失效项`, 'success');
            await loadData();
        } catch (e) {
            showToast(`删除失败: ${e instanceof Error ? e.message : '未知错误'}`, 'error');
            setLoading(false);
        }
    };

    // ---------------- 备份 / 恢复 ----------------
    const handleExportBackup = () => {
        if (items.length === 0 && manageNames.length === 0) {
            showToast('没有可备份的数据', 'warning');
            return;
        }
        const scenes: Record<string, unknown[]> = {};
        manageNames.forEach(name => { scenes[name] = []; });
        items.forEach(({ sceneName, ...rest }) => { scenes[sceneName].push(rest); });
        const payload = { app: 'kgcfip-manager', version: 1, exportedAt: new Date().toISOString(), scenes };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `ip_backup_${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showToast(`已导出 ${manageNames.length} 个分组、${items.length} 条数据`, 'success');
    };

    const importInputRef = useRef<HTMLInputElement | null>(null);

    const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // 允许重复选择同一个文件
        if (!file) return;
        if (file.size > 10 * 1024 * 1024) {
            showToast('备份文件过大（超过 10MB）', 'error');
            return;
        }
        try {
            const data = JSON.parse(await file.text());
            const scenesObj = data && typeof data === 'object' && data.scenes && typeof data.scenes === 'object' && !Array.isArray(data.scenes)
                ? data.scenes as Record<string, unknown>
                : null;
            if (!scenesObj) throw new Error('不是有效的备份文件');
            const entries = Object.entries(scenesObj).filter(([, v]) => Array.isArray(v)) as [string, ScanResult[]][];
            if (entries.length === 0) throw new Error('备份中没有可导入的分组');
            const total = entries.reduce((n, [, v]) => n + v.length, 0);
            const ok = await confirm(`备份中包含 ${entries.length} 个分组、共 ${total} 条数据。导入后会与现有同名分组合并（相同 IP 以备份为准），不会删除现有数据。继续吗？`, { confirmText: '开始导入' });
            if (!ok) return;
            setLoading(true);
            for (const [name, list] of entries) {
                await saveResults(name, list, 'append');
            }
            showToast(`已导入 ${entries.length} 个分组、${total} 条数据`, 'success');
            await loadData();
        } catch (err) {
            showToast(`导入失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error');
        } finally {
            setLoading(false);
        }
    };

    const handleExportCsv = () => {
        if (filteredItemsSorted.length === 0) {
            showToast('没有可导出的数据', 'warning');
            return;
        }

        const headers = ['IP地址', '端口', '延迟(ms)', '地区代码', '地区名称', '场景', '下载速度(Mbps)', '纯净度(/100)', '家宽'];
        const csvContent = [
            headers.join(','),
            ...filteredItemsSorted.map(item => [
                item.ip,
                item.port,
                item.latency,
                item.colo || '',
                getColoName(item.colo || ''),
                item.sceneName,
                typeof item.downloadMbps === 'number' && item.downloadMbps > 0 ? item.downloadMbps.toFixed(2) : '',
                typeof item.purity?.purityScore === 'number' ? item.purity.purityScore : '',
                item.purity && classifyHome(item.purity) === 'residential' ? '家宽' : '',
            ].map(field => {
                const stringField = String(field);
                // 如果包含逗号、引号或换行，则转义引号并用引号包裹
                if (stringField.includes(',') || stringField.includes('"') || stringField.includes('\n')) {
                    return `"${stringField.replace(/"/g, '""')}"`;
                }
                return stringField;
            }).join(','))
        ].join('\n');

        // 添加 BOM，保证 Excel 正确识别中文
        const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', `ip_list_export_${new Date().toISOString().slice(0, 10)}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const handleExportTxt = async () => {
        if (filteredItemsSorted.length === 0) {
            showToast('没有可导出的数据', 'warning');
            return;
        }

        try {
            let txtContent = '';
            for (const item of filteredItemsSorted) {
                const regionName = getColoName(item.colo || '');
                const sceneName = item.sceneName;
                const latency = `${item.latency}ms`;
                const speedComment = typeof item.downloadMbps === 'number' && item.downloadMbps > 0 ? `|${item.downloadMbps.toFixed(2)}Mbps` : '';
                const purityComment = typeof item.purity?.purityScore === 'number' ? `|${item.purity.purityScore}/100` : '';
                const homeComment = item.purity && classifyHome(item.purity) === 'residential' ? '|家宽' : '';
                const comment = `${regionName}|${sceneName}|${latency}${homeComment}${speedComment}${purityComment}`;
                txtContent += `${item.ip}:${item.port}#${comment}\n`;
            }

            // 用 TXT 数据创建新文件
            const blob = new Blob([txtContent], { type: 'text/plain;charset=utf-8;' });
            const link = document.createElement('a');
            const url = URL.createObjectURL(blob);
            link.setAttribute('href', url);
            link.setAttribute('download', `ip_list_export_${new Date().toISOString().slice(0, 10)}.txt`);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

        } catch (error) {
            console.error('Failed to export to TXT:', error);
            showToast(`导出TXT失败: ${error instanceof Error ? error.message : '未知错误'}`, 'error');
        }
    };

    const handleCopyToClipboard = () => {
        if (filteredItemsSorted.length === 0) {
            showToast('没有可复制的数据', 'warning');
            return;
        }

        let txtContent = '';
        for (const item of filteredItemsSorted) {
            const regionName = getColoName(item.colo || '').replace(/^(\p{Regional_Indicator}+)\s+/u, '$1');
            const sceneName = item.sceneName;
            const latency = `${item.latency}ms`;
            const speedComment = typeof item.downloadMbps === 'number' && item.downloadMbps > 0 ? `|${item.downloadMbps.toFixed(2)}Mbps` : '';
            const purityComment = typeof item.purity?.purityScore === 'number' ? `|${item.purity.purityScore}/100` : '';
            const homeComment = item.purity && classifyHome(item.purity) === 'residential' ? '|家宽' : '';
            const comment = `${regionName}|${sceneName}|${latency}${homeComment}${speedComment}${purityComment}`;
            txtContent += `${item.ip}:${item.port}#${comment}\n`;
        }

        navigator.clipboard.writeText(txtContent).then(() => {
            showToast('已复制到剪贴板', 'success');
        }).catch(err => {
            console.error('Failed to copy to clipboard:', err);
            showToast('复制失败，请检查浏览器权限', 'error');
        });
    };


    const isAllSelected = filteredItems.length > 0 && filteredItems.every(item => selectedItems.has(`${item.ip}:${item.port}#${item.sceneName}`));

    return (
        <div className="bg-white dark:bg-gray-800 shadow-md rounded-lg p-6 mb-8">
            <div className="flex flex-col gap-4 mb-4">
                <div className="flex items-center justify-between flex-wrap gap-4">
                    <div className="flex items-center gap-3">
                        <ListChecks className="w-7 h-7 text-green-500" />
                        <h2 className="text-2xl font-semibold text-gray-700 dark:text-gray-200">已保存的 IP/域名 列表</h2>
                        <span className="px-2.5 py-0.5 bg-green-100 text-green-800 text-sm font-semibold rounded-full dark:bg-green-900 dark:text-green-300">{items.length} 个IP/域名</span>
                    </div>
                    <div className="flex items-center gap-4">
                        {selectedItems.size > 0 && (
                            <button
                                onClick={handleDeleteSelected}
                                className="px-4 py-1.5 text-sm font-medium text-red-800 bg-red-100 rounded-full hover:bg-red-200 dark:bg-red-900 dark:text-red-300 dark:hover:bg-red-800 transition-colors"
                            >
                                <Trash2 className="w-4 h-4 mr-1 inline-block" />
                                删除选中 ({selectedItems.size})
                            </button>
                        )}
                        <button
                            onClick={loadData}
                            className="px-4 py-1.5 text-sm font-medium text-blue-800 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800 transition-colors"
                        >
                            <RotateCw className="w-4 h-4 mr-1 inline-block" />
                            刷新
                        </button>
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap">场景过滤:</span>
                    <div className="flex flex-wrap items-center gap-2">
                        {uniqueScenes.map(scene => {
                            const isSelected = selectedScenes.has(scene);
                            return (
                                <button
                                    key={scene}
                                    type="button"
                                    onClick={() => {
                                        const newSet = new Set(selectedScenes);
                                        if (newSet.has(scene)) newSet.delete(scene);
                                        else newSet.add(scene);
                                        setSelectedScenes(newSet);
                                    }}
                                    className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                                        isSelected
                                            ? 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100 dark:bg-indigo-900/40 dark:text-indigo-200 dark:border-indigo-700/60 dark:hover:bg-indigo-800/60'
                                            : 'bg-gray-100 text-gray-500 border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600'
                                    }`}
                                >
                                        {scene}
                                    </button>
                                );
                            })}
                        </div>
                        <div className="flex items-center gap-3 ml-auto">
                            <button
                                type="button"
                                onClick={() => setSelectedScenes(new Set(uniqueScenes))}
                                className="px-3 py-1 text-xs font-medium text-blue-800 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800 transition-colors"
                            >
                                全选
                            </button>
                            <button
                                type="button"
                                onClick={() => setSelectedScenes(new Set())}
                                className="px-3 py-1 text-xs font-medium text-gray-800 bg-gray-100 rounded-full hover:bg-gray-200 dark:bg-gray-600 dark:text-gray-300 dark:hover:bg-gray-500 transition-colors"
                            >
                                清空
                            </button>
                        </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                    <label className="flex items-center gap-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        排序
                        <select
                            value={sortKey}
                            onChange={(e) => setSortKey(e.target.value as SortKey)}
                            className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-xs text-gray-800 dark:text-gray-100"
                        >
                            <option value="latency">延迟（低→高）</option>
                            <option value="speed">下载速度（高→低）</option>
                            <option value="purity">纯净度（高→低）</option>
                            <option value="score">综合评分（高→低）</option>
                            <option value="recent">最近测试</option>
                        </select>
                    </label>

                    <label className="flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300 cursor-pointer select-none" title="根据保存时的纯净度数据判断：排除机房、VPN、代理、Tor、中继和移动网络，只保留上游明确标注为家庭宽带的；没有纯净度数据的不显示">
                        <input type="checkbox" checked={homeOnly} onChange={(e) => setHomeOnly(e.target.checked)} className="h-3.5 w-3.5 rounded border-gray-300 text-emerald-600" />
                        仅家宽
                    </label>
                    <button type="button" onClick={() => setShowWeights(v => !v)} className="px-3 py-1 text-xs font-medium rounded-full transition-colors disabled:opacity-50 bg-purple-100 text-purple-800 hover:bg-purple-200 dark:bg-purple-900/40 dark:text-purple-300">
                        {showWeights ? '收起评分权重' : '评分权重'}
                    </button>

                    <span className="hidden sm:block w-px h-5 bg-gray-300 dark:bg-gray-500" />

                    <button
                        type="button"
                        onClick={() => void handleRetest()}
                        disabled={retesting || loading || filteredItems.length === 0}
                        title="对勾选的 IP 重新测延迟；没有勾选时复测当前列表里的全部"
                        className="px-3 py-1 text-xs font-medium rounded-full transition-colors disabled:opacity-50 bg-teal-100 text-teal-800 hover:bg-teal-200 dark:bg-teal-900/40 dark:text-teal-300"
                    >
                        <Activity className="w-3.5 h-3.5 mr-1 inline-block" />
                        {retesting ? `复测中 ${retestDone}/${retestTotal}` : `复测${selectedItems.size > 0 ? `勾选项 (${selectedItems.size})` : '当前列表'}`}
                    </button>
                    <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300 cursor-pointer select-none" title="仅复测原来测过速度的 IPv4，每个约消耗 25MB 流量">
                        <input type="checkbox" checked={includeSpeedRetest} onChange={(e) => setIncludeSpeedRetest(e.target.checked)} disabled={retesting} className="h-3.5 w-3.5 rounded border-gray-300 text-teal-600" />
                        同时复测下载速度
                    </label>
                    {retesting && (
                        <button type="button" onClick={handleAbortRetest} className="px-3 py-1 text-xs font-medium rounded-full transition-colors disabled:opacity-50 bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300">
                            <Square className="w-3 h-3 mr-1 inline-block" />
                            中断复测
                        </button>
                    )}
                    {dirtyScenes.size > 0 && !retesting && (
                        <button type="button" onClick={() => void handleSaveRetest()} disabled={loading} className="px-3 py-1 text-xs font-medium rounded-full transition-colors disabled:opacity-50 bg-blue-100 text-blue-800 hover:bg-blue-200 dark:bg-blue-900/40 dark:text-blue-300">
                            <Save className="w-3.5 h-3.5 mr-1 inline-block" />
                            保存复测结果
                        </button>
                    )}
                    {flaggedCount > 0 && !retesting && (
                        <button type="button" onClick={() => void handleDeleteFlagged()} disabled={loading} className="px-3 py-1 text-xs font-medium rounded-full transition-colors disabled:opacity-50 bg-red-100 text-red-800 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300">
                            <Trash2 className="w-3.5 h-3.5 mr-1 inline-block" />
                            删除失效项 ({flaggedCount})
                        </button>
                    )}

                    <div className="flex items-center gap-2 ml-auto">
                        <button type="button" onClick={() => setShowManage(v => !v)} className="px-3 py-1 text-xs font-medium rounded-full transition-colors disabled:opacity-50 bg-indigo-100 text-indigo-800 hover:bg-indigo-200 dark:bg-indigo-900/40 dark:text-indigo-300">
                            <Settings2 className="w-3.5 h-3.5 mr-1 inline-block" />
                            {showManage ? '收起分组管理' : '管理分组'}
                        </button>
                        <button type="button" onClick={handleExportBackup} className="px-3 py-1 text-xs font-medium rounded-full transition-colors disabled:opacity-50 bg-gray-200 text-gray-800 hover:bg-gray-300 dark:bg-gray-600 dark:text-gray-200">
                            <Download className="w-3.5 h-3.5 mr-1 inline-block" />
                            导出备份
                        </button>
                        <button type="button" onClick={() => importInputRef.current?.click()} disabled={loading} className="px-3 py-1 text-xs font-medium rounded-full transition-colors disabled:opacity-50 bg-gray-200 text-gray-800 hover:bg-gray-300 dark:bg-gray-600 dark:text-gray-200">
                            <Upload className="w-3.5 h-3.5 mr-1 inline-block" />
                            导入备份
                        </button>
                        <input ref={importInputRef} type="file" accept="application/json,.json" onChange={(e) => void handleImportFile(e)} className="hidden" />
                    </div>
                </div>

                {showWeights && (
                    <div className="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                        <div className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">综合评分权重（任意非负数，会自动换算成百分比；保存在本浏览器）</div>
                        <div className="flex flex-wrap items-center gap-3">
                            {([
                                ['latency', '延迟'],
                                ['speed', '下载速度'],
                                ['purity', '纯净度'],
                            ] as const).map(([key, label]) => (
                                <label key={key} className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
                                    {label}
                                    <input
                                        type="text"
                                        inputMode="decimal"
                                        value={weightInputs[key]}
                                        onChange={(e) => setWeightInputs(prev => ({ ...prev, [key]: e.target.value.replace(/[^0-9.]/g, '').slice(0, 6) }))}
                                        className="p-1 border rounded-md w-16 text-sm dark:bg-gray-600 dark:border-gray-500 dark:text-white"
                                    />
                                </label>
                            ))}
                            <button type="button" onClick={() => setWeightInputs(DEFAULT_WEIGHT_INPUTS)} className="px-3 py-1 text-xs font-medium rounded-full bg-gray-200 text-gray-800 hover:bg-gray-300 dark:bg-gray-600 dark:text-gray-200">恢复默认</button>
                        </div>
                        <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                            实际占比：延迟 {weightPct(scoreWeights.latency)}% · 下载速度 {weightPct(scoreWeights.speed)}% · 纯净度 {weightPct(scoreWeights.purity)}%
                            {Number(weightInputs.latency) + Number(weightInputs.speed) + Number(weightInputs.purity) <= 0 && <span className="text-amber-600 dark:text-amber-400">（三项都为 0，已按默认权重计算）</span>}
                        </div>
                        <div className="mt-2 text-xs text-gray-500 dark:text-gray-400 break-all">
                            订阅接口使用同样的权重：<code className="break-all">sort=score&amp;{apiWeightParams}</code>
                            <button
                                type="button"
                                onClick={() => {
                                    const text = `sort=score&${apiWeightParams}`;
                                    navigator.clipboard?.writeText(text)
                                        .then(() => showToast('已复制权重参数', 'success'))
                                        .catch(() => showToast(`复制失败，请手动复制：${text}`, 'warning'));
                                }}
                                className="ml-2 px-2 py-0.5 text-xs rounded bg-blue-100 text-blue-800 hover:bg-blue-200 dark:bg-blue-900/40 dark:text-blue-300"
                            >
                                复制
                            </button>
                        </div>
                    </div>
                )}

                {showManage && (
                    <div className="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                        <div className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">分组管理（重命名或删除；删除分组会同时删除其中所有 IP）</div>
                        {manageNames.length === 0 ? (
                            <div className="text-xs text-gray-400">暂无分组</div>
                        ) : (
                            <ul className="divide-y divide-gray-200 dark:divide-gray-600">
                                {manageNames.map(name => {
                                    const count = items.filter(i => i.sceneName === name).length;
                                    const isEditing = editingScene === name;
                                    return (
                                        <li key={name} className="flex flex-wrap items-center gap-2 py-2">
                                            {isEditing ? (
                                                <>
                                                    <input
                                                        autoFocus
                                                        value={editValue}
                                                        onChange={(e) => setEditValue(e.target.value)}
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter') void submitRename(name);
                                                            if (e.key === 'Escape') setEditingScene(null);
                                                        }}
                                                        maxLength={64}
                                                        className="p-1 border rounded-md w-48 text-sm dark:bg-gray-600 dark:border-gray-500 dark:text-white"
                                                    />
                                                    <button type="button" onClick={() => void submitRename(name)} className="px-3 py-1 text-xs font-medium rounded-full transition-colors disabled:opacity-50 bg-blue-100 text-blue-800 hover:bg-blue-200 dark:bg-blue-900/40 dark:text-blue-300">保存</button>
                                                    <button type="button" onClick={() => setEditingScene(null)} className="px-3 py-1 text-xs font-medium rounded-full transition-colors disabled:opacity-50 bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-600 dark:text-gray-200">取消</button>
                                                </>
                                            ) : (
                                                <>
                                                    <span className="text-sm text-gray-800 dark:text-gray-100">{name}</span>
                                                    <span className="text-xs text-gray-400">{count} 个</span>
                                                    <div className="flex items-center gap-2 ml-auto">
                                                        <button type="button" onClick={() => { setEditingScene(name); setEditValue(name); }} className="px-3 py-1 text-xs font-medium rounded-full transition-colors disabled:opacity-50 bg-gray-200 text-gray-800 hover:bg-gray-300 dark:bg-gray-600 dark:text-gray-200">
                                                            <Pencil className="w-3 h-3 mr-1 inline-block" />
                                                            重命名
                                                        </button>
                                                        <button type="button" onClick={() => void handleDeleteScene(name)} className="px-3 py-1 text-xs font-medium rounded-full transition-colors disabled:opacity-50 bg-red-100 text-red-800 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300">
                                                            <Trash2 className="w-3 h-3 mr-1 inline-block" />
                                                            删除
                                                        </button>
                                                    </div>
                                                </>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                )}
            </div>

            <div className="overflow-auto" style={{ maxHeight: '600px' }}>
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                    <thead className="bg-gray-50 dark:bg-gray-700 sticky top-0 z-10">
                        <tr>
                            <th className="px-4 py-3 text-left">
                                <input 
                                    type="checkbox" 
                                    checked={isAllSelected}
                                    onChange={(e) => handleSelectAll(e.target.checked)}
                                    className="rounded text-purple-600 focus:ring-purple-500 h-4 w-4"
                                />
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">IP/域名</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">端口</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">延迟</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">地区代码</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">地区</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">场景</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">下载速度</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">纯净度</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider" title={`综合评分 = 延迟 ${weightPct(scoreWeights.latency)}% + 下载速度 ${weightPct(scoreWeights.speed)}% + 纯净度 ${weightPct(scoreWeights.purity)}%（延迟 300ms、速度 100Mbps 封顶；未测项按 0 计）`}>评分</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">测于</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                        {loading ? (
                            <tr><td colSpan={11} className="px-4 py-4 text-center text-gray-500">加载中...</td></tr>
                        ) : filteredItems.length === 0 ? (
                            <tr><td colSpan={11} className="px-4 py-4 text-center text-gray-500">暂无数据</td></tr>
                        ) : (
                            filteredItemsSorted.map((item) => (
                                <tr key={`${item.ip}-${item.port}-${item.sceneName}`} className={`hover:bg-gray-50 dark:hover:bg-gray-700 ${retestFlags[itemId(item)] ? 'bg-red-50 dark:bg-red-900/20' : ''}`}>
                                    <td className="px-4 py-2">
                                        <input 
                                            type="checkbox"
                                            checked={selectedItems.has(`${item.ip}:${item.port}#${item.sceneName}`)}
                                            onChange={(e) => handleCheckboxChange(`${item.ip}:${item.port}#${item.sceneName}`, e.target.checked)}
                                            className="rounded text-purple-600 focus:ring-purple-500 h-4 w-4"
                                        />
                                    </td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm font-mono text-gray-900 dark:text-white">
                                        {item.ip}
                                        {item.domain && <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">域名</span>}
                                        {retestFlags[itemId(item)] && <div className="text-[11px] font-sans font-normal text-red-600 dark:text-red-400">失效：{retestFlags[itemId(item)]}</div>}
                                    </td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{item.port}</td>
                                    <td className={`px-4 py-2 whitespace-nowrap text-sm font-semibold ${getLatencyColor(item.latency)}`}>
                                        {item.latency > -1 ? `${item.latency}ms` : 'N/A'}
                                    </td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{item.colo || '-'}</td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{item.colo ? <RegionDisplay colo={item.colo} flagSize="sm" /> : '-'}</td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{item.sceneName}</td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm font-semibold text-blue-600 dark:text-blue-400">{typeof item.downloadMbps === 'number' && item.downloadMbps > 0 ? `${item.downloadMbps.toFixed(2)} Mbps` : '-'}</td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm font-semibold text-emerald-600 dark:text-emerald-400">{typeof item.purity?.purityScore === 'number' ? `${item.purity.purityScore}/100` : '-'}
                                        {item.purity && classifyHome(item.purity) === 'residential' && (
                                            <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">家宽</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-700 dark:text-gray-200">{compositeScore(item, scoreWeights).toFixed(1)}</td>
                                    <td className={`px-4 py-2 whitespace-nowrap text-sm ${item.testedAt && Date.now() - item.testedAt > STALE_MS ? 'text-amber-600 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400'}`} title={item.testedAt ? new Date(item.testedAt).toLocaleString() : '旧数据没有测试时间，重新保存或复测后会补上'}>{formatAge(item.testedAt)}</td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>

            </div>
            <div className="mt-8 flex justify-center gap-4">
                    <button onClick={handleExportCsv} className="flex items-center px-4 py-2 font-bold text-white bg-green-600 rounded hover:bg-green-700 transition-colors">
                        <File className="w-4 h-4 mr-2" />
                        导出 CSV
                    </button>
                    <button onClick={handleExportTxt} className="flex items-center px-4 py-2 font-bold text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors">
                         <FileText className="w-4 h-4 mr-2" />
                        导出 TXT
                    </button>
                    <button onClick={handleCopyToClipboard} className="flex items-center px-4 py-2 font-bold text-white bg-purple-600 rounded hover:bg-purple-700 transition-colors">
                        <Copy className="w-4 h-4 mr-2" />
                        复制
                    </button>
            </div>
        </div>
    );
}