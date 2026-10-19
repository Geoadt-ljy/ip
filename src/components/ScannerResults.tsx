import { Fragment, useState, useEffect, useRef } from 'react';
import { saveResults, getScenes, deleteScene } from '../api';
import {
  ScanResult,
  getLatencyColor,
  testBrowserDownloadSpeed,
  testBrowserPacketLoss,
  testIpLatency,
} from '../utils/scanner';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmDialog';
import { ListFilter, Save, X } from 'lucide-react';
import { RegionDisplay } from './RegionDisplay';
import { usePipelineConfig, parseRegionRules, regionLimits, regionDlMins, capByRegion as capByRegionShared, type PipelineSortKey } from '../utils/pipelineConfig';

interface IpScannerResultsAndSaveProps {
    scanResults: ScanResult[];
    onSaveSuccess?: () => void;
    onScenesChanged?: () => void; // 删除分组后通知上层刷新已保存列表
}

const DEFAULT_IPS_PER_REGION = 20;

export function ScannerResults({ scanResults, onSaveSuccess, onScenesChanged }: IpScannerResultsAndSaveProps) {
    const [ipsPerRegion, setIpsPerRegion] = useState<string>(String(DEFAULT_IPS_PER_REGION));
    const [isLatencyFilterEnabled, setIsLatencyFilterEnabled] = useState(false);
    const [isDownloadFilterEnabled, setIsDownloadFilterEnabled] = useState(false);
    const [downloadFilterValue, setDownloadFilterValue] = useState<string>('10');
    const [isPacketLossFilterEnabled, setIsPacketLossFilterEnabled] = useState(false);
    const [packetLossFilterValue, setPacketLossFilterValue] = useState<string>('10');
    const [isRegionLimitEnabled, setIsRegionLimitEnabled] = useState(false);
    const [latencyFilterValue, setLatencyFilterValue] = useState<string>('300');
    const [isSaving, setIsSaving] = useState(false);
    const [sceneName, setSceneName] = useState('');
    const [scenes, setScenes] = useState<string[]>([]);
    const [sceneDropdownOpen, setSceneDropdownOpen] = useState(false);
    const sceneInputRef = useRef<HTMLDivElement>(null);
    const [saveMode, setSaveMode] = useState<'overwrite' | 'append'>('overwrite');
    const [selectedRegions, setSelectedRegions] = useState<Set<string>>(new Set());
    const [selectedPorts, setSelectedPorts] = useState<Set<string>>(new Set());
    const [selectedSpeedTargets, setSelectedSpeedTargets] = useState<Set<string>>(new Set());
    const [browserSpeedMap, setBrowserSpeedMap] = useState<Record<string, number>>({});
    const [browserSpeedErrors, setBrowserSpeedErrors] = useState<Record<string, string>>({});
    const [isBrowserSpeedTesting, setIsBrowserSpeedTesting] = useState(false);
    const [browserSpeedDone, setBrowserSpeedDone] = useState(0);
    const [browserSpeedTotal, setBrowserSpeedTotal] = useState(0);
    const [speedPending, setSpeedPending] = useState<Record<string, true>>({});
    // 用于“强行中断”：持有当前运行中的测速 / 丢包测试的 AbortController
    const speedAbortRef = useRef<AbortController | null>(null);
    const packetLossAbortRef = useRef<AbortController | null>(null);
    const avgAbortRef = useRef<AbortController | null>(null);
    const [avgEnabled, setAvgEnabled] = useState(false); // 多轮平均测试开关
    const [avgMetrics, setAvgMetrics] = useState({ latency: true, download: true, loss: true });
    // 自动优选配置
    const [autoRunning, setAutoRunning] = useState(false);
    const [pipe, setPipe] = usePipelineConfig(); // 流水线统一配置（与“扫描配置”共用）
    const autoEnabled = pipe.enabled;
    const autoAfterScan = pipe.afterScan;
    const autoCandidates = pipe.candidates;
    const autoLatencyOn = pipe.latencyOn;
    const autoLatencyMax = pipe.latencyMax;
    const autoPerRegion = pipe.perRegion;
    const autoDlOn = pipe.dlOn;
    const autoDlMin = pipe.dlMin;
    const autoLossOn = pipe.lossOn;
    const autoLossMax = pipe.lossMax;
    const autoKeep = pipe.keep;
    const avgRounds = pipe.rounds;
    const sortKey = pipe.sortKey;
    const setAvgRounds = (v: string) => setPipe({ rounds: v });
    const setSortKey = (k: PipelineSortKey) => setPipe({ sortKey: k });
    const autoRanRef = useRef<ScanResult[] | null>(null);
    // 导出配置
    const [exportScope, setExportScope] = useState<'selected' | 'all'>('selected');
    const [exportFormat, setExportFormat] = useState<'ipport' | 'ip' | 'csv'>('ipport');
    const [avgLatencyMap, setAvgLatencyMap] = useState<Record<string, number>>({});
    const [isAvgTesting, setIsAvgTesting] = useState(false);
    const [avgDone, setAvgDone] = useState(0);
    const [avgTotal, setAvgTotal] = useState(0);
    const [packetLossMap, setPacketLossMap] = useState<Record<string, { packetLoss: number; sent: number; received: number; error?: string }>>({});
    const [isPacketLossTesting, setIsPacketLossTesting] = useState(false);
    const [packetLossDone, setPacketLossDone] = useState(0);
    const [packetLossUrlTemplate, setPacketLossUrlTemplate] = useState('https://{hexip}.ns.psb.kdns.fr:{port}/ip.json');
    const [downloadTestAddress, setDownloadTestAddress] = useState<'auto' | 'ns' | 'bestcf' | 'custom'>('auto');
    const [downloadSizeMB, setDownloadSizeMB] = useState('25'); // 单次下载测速的文件大小（MB）
    const downloadBytes = Math.max(1, Math.min(100, Math.floor(Number(downloadSizeMB)) || 25)) * 1024 * 1024;
    const [customDownloadUrlTemplate, setCustomDownloadUrlTemplate] = useState('https://{hexip}.ns.psb.kdns.fr:{port}/__down?bytes={bytes}');
    const [saveSelectedOnly, setSaveSelectedOnly] = useState(true);
    const filterInitialized = useRef(false);

    const uniqueRegions: string[] = Array.from(new Set(scanResults.map(r => r.colo))).filter((r): r is string => !!r).sort();
    const uniquePorts: number[] = Array.from(new Set(scanResults.map(r => r.port))).sort((a, b) => a - b);

    // 结果首次就绪时，默认将全部地区/端口选入集合（真正全选，而非空集代表全选）
    useEffect(() => {
        if (!filterInitialized.current && uniqueRegions.length > 0) {
            setSelectedRegions(new Set(uniqueRegions));
            setSelectedPorts(new Set(uniquePorts.map(String)));
            filterInitialized.current = true;
        }
    }, [uniqueRegions, uniquePorts]);

    // 加载已保存场景名列表，供场景录入框快速选择
    useEffect(() => {
        const load = async () => {
            try {
                const data = await getScenes();
                setScenes(data.map((s) => s.name));
            } catch {
                // 加载失败不影响录入
            }
        };
        load();
    }, []);

    // 延迟扫描结束后不自动选择任何 IP；用户在结果列表中手动勾选后再运行下载测速、
    // 丢包率检测或保存到 KV，避免延迟扫描阶段并行启动下载测速。
    useEffect(() => {
        // 结果集变化时，先中断仍在运行的测速 / 丢包测试，避免旧任务写入新结果
        speedAbortRef.current?.abort();
        packetLossAbortRef.current?.abort();
        avgAbortRef.current?.abort();
        setSelectedSpeedTargets(new Set());
        setBrowserSpeedMap({});
        setBrowserSpeedErrors({});
        setPacketLossMap({});
        setSpeedPending({});
    }, [scanResults]);

    // 组件卸载时中断所有进行中的请求
    useEffect(() => () => {
        speedAbortRef.current?.abort();
        packetLossAbortRef.current?.abort();
        avgAbortRef.current?.abort();
    }, []);

    // 点击下拉外部时关闭场景选择浮层
    useEffect(() => {
        if (!sceneDropdownOpen) return;
        const handler = (e: MouseEvent) => {
            if (sceneInputRef.current && !sceneInputRef.current.contains(e.target as Node)) {
                setSceneDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [sceneDropdownOpen]);

    // 每次展开下拉都重新读取分组列表，这样在“已保存列表”里重命名/删除分组后这里也是最新的
    useEffect(() => {
        if (!sceneDropdownOpen) return;
        let cancelled = false;
        getScenes()
            .then((data) => { if (!cancelled) setScenes(data.map((s) => s.name)); })
            .catch(() => { /* 加载失败不影响录入 */ });
        return () => { cancelled = true; };
    }, [sceneDropdownOpen]);

    const handleDeleteScene = async (name: string) => {
        const ok = await confirm(`确定要删除分组「${name}」及其中所有 IP/域名吗？此操作不可恢复。`, { confirmText: '确定删除' });
        if (!ok) return;
        try {
            await deleteScene(name);
            setScenes((prev) => prev.filter((n) => n !== name));
            if (sceneName === name) setSceneName('');
            showToast(`已删除分组「${name}」`, 'success');
            if (onScenesChanged) onScenesChanged();
        } catch (error) {
            showToast(`删除失败: ${error instanceof Error ? error.message : '未知错误'}`, 'error');
        }
    };

    // 已保存场景列表，不进行过滤，全部展示为标签
    const sceneOptions = scenes;

    const latencyTrim = latencyFilterValue.trim();
    const isLatencyFormatValid = /^\d+$/.test(latencyTrim);
    const effectiveLatencyValue = isLatencyFormatValid ? parseInt(latencyTrim, 10) : 0;

    const downloadTrim = downloadFilterValue.trim();
    const isDownloadFormatValid = /^(?:\d+(?:\.\d+)?)$/.test(downloadTrim) && Number(downloadTrim) >= 0;
    const effectiveDownloadValue = isDownloadFormatValid ? Number(downloadTrim) : 0;


    const packetLossTrim = packetLossFilterValue.trim();
    const isPacketLossFormatValid = /^(?:\d+(?:\.\d+)?)$/.test(packetLossTrim) && Number(packetLossTrim) >= 0 && Number(packetLossTrim) <= 100;
    const effectivePacketLossValue = isPacketLossFormatValid ? Number(packetLossTrim) : 0;

    const ipsPerRegionTrim = ipsPerRegion.trim();
    const isIpsPerRegionFormatValid = /^\d+$/.test(ipsPerRegionTrim) && parseInt(ipsPerRegionTrim, 10) >= 1;
    const effectiveIpsPerRegion = isIpsPerRegionFormatValid ? parseInt(ipsPerRegionTrim, 10) : DEFAULT_IPS_PER_REGION;

    // 勾选且数值合法才生效；数值不合法时不做筛选，仅在输入框旁提示，避免误把结果全部过滤掉
    const latencyFilterActive = isLatencyFilterEnabled && isLatencyFormatValid;
    const downloadFilterActive = isDownloadFilterEnabled && isDownloadFormatValid;
    const regionLimitActive = isRegionLimitEnabled && isIpsPerRegionFormatValid;

    const baseFilteredResults = scanResults.filter(r => latencyFilterActive
        ? (r.latency > -1 && r.latency <= effectiveLatencyValue)
        : true
    );

    const portCounts = baseFilteredResults.reduce((acc, r) => {
        const key = String(r.port);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {} as Record<string, number>);

    // 按端口筛选：仅保留 selectedPorts 中的端口
    const portFilteredResults = baseFilteredResults.filter(r =>
        selectedPorts.has(String(r.port))
    );

  const regionCounts = portFilteredResults.reduce((acc, r) => {
        if (r.colo) {
            acc[r.colo] = (acc[r.colo] || 0) + 1;
        }
        return acc;
    }, {} as Record<string, number>);

    const regionFilteredResults = portFilteredResults.filter(r =>
        r.colo ? selectedRegions.has(r.colo) : true
    );

    const speedKey = (r: ScanResult) => `${r.ip}:${r.port}`;

    // 统一读取测速结果：浏览器测速结果优先，本地 Agent 结果作为回退。
    // speedKey 必须先于此函数声明，避免 const 的 TDZ 问题。
    const displayDownloadMbps = (r: ScanResult) => {
        const browserValue = browserSpeedMap[speedKey(r)];
        return typeof browserValue === 'number' ? browserValue : Number(r.downloadMbps || 0);
    };

    const downloadFilteredResults = regionFilteredResults.filter(r =>
        downloadFilterActive ? (displayDownloadMbps(r) > 0 && displayDownloadMbps(r) >= effectiveDownloadValue) : true
    );

    const packetLossFilteredResults = downloadFilteredResults.filter(r => {
        if (!isPacketLossFilterEnabled || !isPacketLossFormatValid) return true;
        const result = packetLossMap[speedKey(r)];
        // 启用丢包筛选时，仅保留已完成测试、结果有效且丢包率不高于阈值的 IP。
        return !!result && !result.error && result.packetLoss <= effectivePacketLossValue;
    });

    let limitedResults = [...packetLossFilteredResults];
    if (regionLimitActive) {
        const regionCountsForLimit: { [key: string]: number } = {};
        limitedResults = packetLossFilteredResults.filter(r => {
            const colo = r.colo || 'Unknown';
            regionCountsForLimit[colo] = (regionCountsForLimit[colo] || 0) + 1;
            return regionCountsForLimit[colo] <= effectiveIpsPerRegion;
        });
    }

    // 排序：已有平均/测速数据的行排在前面，再按所选指标排序（延迟、丢包升序；下载降序）
    if (sortKey !== 'default') {
        const hasData = (r: ScanResult) => (speedKey(r) in avgLatencyMap) || (speedKey(r) in browserSpeedMap) || (speedKey(r) in packetLossMap);
        const latOf = (r: ScanResult) => avgLatencyMap[speedKey(r)] ?? r.latency;
        const lossOf = (r: ScanResult) => { const x = packetLossMap[speedKey(r)]; return x && !x.error ? x.packetLoss : 101; };
        limitedResults = [...limitedResults].sort((a, b) => {
            const d = Number(hasData(b)) - Number(hasData(a));
            if (d !== 0) return d;
            if (sortKey === 'latency') return latOf(a) - latOf(b);
            if (sortKey === 'download') return displayDownloadMbps(b) - displayDownloadMbps(a);
            return lossOf(a) - lossOf(b);
        });
    }
    const filteredResults = limitedResults;

    const visibleSpeedKeys = new Set(filteredResults.filter(r => !r.domain).map(speedKey));
    const selectedVisibleSpeedKeys = Array.from(selectedSpeedTargets).filter(k => visibleSpeedKeys.has(k));
    const allVisibleSpeedSelected = filteredResults.filter(r => !r.domain).length > 0 && selectedVisibleSpeedKeys.length === filteredResults.filter(r => !r.domain).length;

    const { showToast } = useToast();
    const { confirm } = useConfirm();

    const toggleSpeedTarget = (key: string) => {
        setSelectedSpeedTargets(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
        });
    };

    const toggleAllVisibleSpeedTargets = () => {
        const keys = filteredResults.filter(r => !r.domain).map(speedKey);
        setSelectedSpeedTargets(prev => {
            const next = new Set(prev);
            const shouldSelect = !keys.every(k => next.has(k));
            keys.forEach(k => shouldSelect ? next.add(k) : next.delete(k));
            return next;
        });
    };

    const handleBrowserSpeedTest = async () => {
        const targets = filteredResults.filter(r => !r.domain && selectedSpeedTargets.has(speedKey(r)));
        if (targets.length === 0) {
            showToast('请先勾选一个或多个 IPv4 IP', 'warning');
            return;
        }
        const controller = new AbortController();
        speedAbortRef.current = controller;
        const signal = controller.signal;
        setIsBrowserSpeedTesting(true);
        setBrowserSpeedDone(0);
        setBrowserSpeedTotal(targets.length);
        setBrowserSpeedErrors({});
        setSpeedPending(Object.fromEntries(targets.map(t => [speedKey(t), true as const])));
        let done = 0;
        try {
            // 控制并发，避免同时建立过多连接；支持单个或多个 IP。
            const queue = [...targets];
            const worker = async () => {
                while (queue.length && !signal.aborted) {
                    const target = queue.shift();
                    if (!target) return;
                    const key = speedKey(target);
                    const selectedTemplate = downloadTestAddress === 'ns'
                        ? 'https://{hexip}.ns.psb.kdns.fr:{port}/__down?bytes={bytes}'
                        : downloadTestAddress === 'bestcf'
                            ? 'https://{hexip}.bestcf.cmliussss.hidns.vip:{port}/__down?bytes={bytes}'
                            : downloadTestAddress === 'custom' ? customDownloadUrlTemplate.trim() : undefined;
                    const result = await testBrowserDownloadSpeed(target.ip, target.port, {
                        bytes: downloadBytes,
                        timeoutMs: 30000,
                        signal,
                        ...(selectedTemplate ? { urlTemplate: selectedTemplate } : {}),
                    });
                    // 被用户中断的目标不记为失败，保持“未测”状态
                    if (result.aborted) return;
                    if (result.downloadMbps > 0) {
                        setBrowserSpeedMap(prev => ({ ...prev, [key]: result.downloadMbps }));
                    } else {
                        setBrowserSpeedErrors(prev => ({ ...prev, [key]: result.error || '测速失败' }));
                    }
                    setSpeedPending(prev => { const next = { ...prev }; delete next[key]; return next; });
                    done++;
                    setBrowserSpeedDone(done);
                }
            };
            await Promise.all(Array.from({ length: Math.min(3, targets.length) }, () => worker()));
            if (signal.aborted) {
                showToast(`已中断下载测速：完成 ${done}/${targets.length} 个 IP`, 'warning');
            } else {
                showToast(`浏览器下载测速完成：${done} 个 IP`, 'success');
            }
        } finally {
            setIsBrowserSpeedTesting(false);
            setSpeedPending({});
            if (speedAbortRef.current === controller) speedAbortRef.current = null;
        }
    };

    const abortSpeedTest = () => speedAbortRef.current?.abort();
    const abortAllTests = () => {
        speedAbortRef.current?.abort();
        packetLossAbortRef.current?.abort();
        avgAbortRef.current?.abort();
    };

    const handlePacketLossTest = async () => {
        const targets = filteredResults.filter(r => !r.domain && selectedSpeedTargets.has(speedKey(r)));
        if (targets.length === 0) {
            showToast('请先勾选一个或多个 IPv4 IP', 'warning');
            return;
        }
        const controller = new AbortController();
        packetLossAbortRef.current = controller;
        const signal = controller.signal;
        setIsPacketLossTesting(true);
        setPacketLossDone(0);
        let done = 0;
        try {
            const queue = [...targets];
            const worker = async () => {
                while (queue.length > 0 && !signal.aborted) {
                    const target = queue.shift();
                    if (!target) return;
                    const key = speedKey(target);
                    const result = await testBrowserPacketLoss(target.ip, target.port, { attempts: 10, timeoutMs: 3000, urlTemplate: packetLossUrlTemplate, signal });
                    // 被中断的目标探测不完整，丢包率不可信，不记录结果
                    if (result.aborted) return;
                    setPacketLossMap(prev => ({ ...prev, [key]: result }));
                    done++;
                    setPacketLossDone(done);
                }
            };
            await Promise.all(Array.from({ length: Math.min(3, targets.length) }, () => worker()));
            if (signal.aborted) {
                showToast(`已中断丢包测试：已完成 ${done}/${targets.length} 个 IP`, 'warning');
            } else {
                showToast(`HTTPS 探测丢包测试完成：${done} 个 IP`, 'success');
            }
        } finally {
            setIsPacketLossTesting(false);
            if (packetLossAbortRef.current === controller) packetLossAbortRef.current = null;
        }
    };

    const abortPacketLoss = () => packetLossAbortRef.current?.abort();

    type Measured = { lat?: number; dl?: number; loss?: number };
    type MeasureMetrics = { latency: boolean; download: boolean; loss: boolean };
    const num = (v: string, def: number, min: number, max: number) => {
        const n = Number(v);
        return Number.isFinite(n) && v.trim() !== '' ? Math.max(min, Math.min(max, n)) : def;
    };
    const capByRegion = (list: ScanResult[], k: number, limits: Record<string, number> = {}) => capByRegionShared(list, k, limits);

    // 多轮测量核心：对给定 IP 重复 N 轮，按所选指标（延迟/下载速度/丢包率）取平均，并写入各结果表
    const runMeasure = async (targets: ScanResult[], metrics: MeasureMetrics, rounds: number): Promise<{ data: Record<string, Measured>; aborted: boolean }> => {
        const controller = new AbortController();
        avgAbortRef.current = controller;
        const signal = controller.signal;
        const data: Record<string, Measured> = {};
        setIsAvgTesting(true);
        setAvgDone(0);
        setAvgTotal(targets.length);
        if (metrics.download) setSpeedPending(Object.fromEntries(targets.map(t => [speedKey(t), true as const])));
        const template = downloadTestAddress === 'ns'
            ? 'https://{hexip}.ns.psb.kdns.fr:{port}/__down?bytes={bytes}'
            : downloadTestAddress === 'bestcf'
                ? 'https://{hexip}.bestcf.cmliussss.hidns.vip:{port}/__down?bytes={bytes}'
                : downloadTestAddress === 'custom' ? customDownloadUrlTemplate.trim() : undefined;
        let done = 0;
        try {
            const queue = [...targets];
            const worker = async () => {
                while (queue.length > 0 && !signal.aborted) {
                    const target = queue.shift();
                    if (!target) return;
                    const key = speedKey(target);
                    const lats: number[] = [];
                    const dls: number[] = [];
                    let sent = 0;
                    let received = 0;
                    let interrupted = false;
                    for (let i = 0; i < rounds && !signal.aborted; i++) {
                        if (metrics.latency) {
                            const r = await testIpLatency(target.ip, target.port, 3000);
                            if (r.latency > 0) lats.push(r.latency);
                        }
                        if (metrics.download && !signal.aborted) {
                            const r = await testBrowserDownloadSpeed(target.ip, target.port, {
                                bytes: downloadBytes,
                                timeoutMs: 20000,
                                signal,
                                ...(template ? { urlTemplate: template } : {}),
                            });
                            if (r.aborted) { interrupted = true; break; }
                            if (r.downloadMbps > 0) dls.push(r.downloadMbps);
                        }
                        if (metrics.loss && !signal.aborted) {
                            const r = await testBrowserPacketLoss(target.ip, target.port, { attempts: 10, timeoutMs: 3000, urlTemplate: packetLossUrlTemplate, signal });
                            if (r.aborted) { interrupted = true; break; }
                            if (!r.error) { sent += r.sent; received += r.received; }
                        }
                    }
                    // 被中断的目标数据不完整，不记录
                    if (interrupted || signal.aborted) return;
                    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
                    const m: Measured = {};
                    if (lats.length > 0) { m.lat = Math.round(mean(lats)); setAvgLatencyMap(prev => ({ ...prev, [key]: m.lat as number })); }
                    if (metrics.download) {
                        if (dls.length > 0) { m.dl = Number(mean(dls).toFixed(2)); setBrowserSpeedMap(prev => ({ ...prev, [key]: m.dl as number })); }
                        else setBrowserSpeedErrors(prev => ({ ...prev, [key]: '平均测速失败' }));
                        setSpeedPending(prev => { const next = { ...prev }; delete next[key]; return next; });
                    }
                    if (sent > 0) {
                        m.loss = Number((((sent - received) / sent) * 100).toFixed(1));
                        setPacketLossMap(prev => ({ ...prev, [key]: { packetLoss: m.loss as number, sent, received } }));
                    }
                    data[key] = m;
                    done++;
                    setAvgDone(done);
                }
            };
            await Promise.all(Array.from({ length: Math.min(3, targets.length) }, () => worker()));
        } finally {
            setIsAvgTesting(false);
            setSpeedPending({});
            if (avgAbortRef.current === controller) avgAbortRef.current = null;
        }
        return { data, aborted: signal.aborted };
    };

    // 手动：对勾选的 IP 做多轮平均测试
    const handleAvgTest = async () => {
        const targets = filteredResults.filter(r => !r.domain && selectedSpeedTargets.has(speedKey(r)));
        if (targets.length === 0) {
            showToast('请先勾选一个或多个 IPv4 IP', 'warning');
            return;
        }
        if (!avgMetrics.latency && !avgMetrics.download && !avgMetrics.loss) {
            showToast('请至少选择一项要取平均的指标', 'warning');
            return;
        }
        const rounds = Math.floor(num(avgRounds, 3, 1, 10));
        const { data, aborted } = await runMeasure(targets, avgMetrics, rounds);
        const n = Object.keys(data).length;
        showToast(aborted ? `已中断平均值测试：完成 ${n}/${targets.length} 个 IP` : `平均值测试完成：${n} 个 IP，每个 ${rounds} 轮`, aborted ? 'warning' : 'success');
    };
    const abortAvgTest = () => avgAbortRef.current?.abort();

    // 自动优选：初筛候选 → 多轮平均测试 → 按条件筛选 → 排序 → 勾选前 N 个
    // mode: full=从全部扫描结果开始；selected=对已勾选的重新测试并筛选；refilter=按已有测速数据重新筛选（不测试）
    const runAutoPipeline = async (mode: 'full' | 'selected' | 'refilter' = 'full') => {
        if (isAvgTesting || isBrowserSpeedTesting || isPacketLossTesting || autoRunning) return;
        const latMax = autoLatencyOn ? num(autoLatencyMax, 300, 1, 100000) : Infinity;
        const perRegion = Math.floor(num(autoPerRegion, 0, 0, 1000));
        const candN = Math.floor(num(autoCandidates, 30, 1, 500));
        const keepN = Math.floor(num(autoKeep, 20, 1, 500));
        const dlMin = num(autoDlMin, 10, 0, 100000);
        const lossMax = num(autoLossMax, 10, 0, 100);
        const rounds = Math.floor(num(avgRounds, 3, 1, 10));
        const dlTopN = Math.floor(num(pipe.dlTopN, 0, 0, 500));
        const regionRules = parseRegionRules(pipe.regions);
        const regionList = regionRules.map(r => r.code);
        const limits = regionLimits(regionRules);
        const dlMins = regionDlMins(regionRules);
        // 下载速度下限：地区单独设置优先，其次是全局“下载 ≥”
        const dlThresholdOf = (c: ScanResult): number | undefined => dlMins[(c.colo || '').toUpperCase()] ?? (autoDlOn ? dlMin : undefined);
        const needDl = autoDlOn || Object.keys(dlMins).length > 0 || sortKey === 'download';

        let candidates: ScanResult[];
        if (mode === 'full') {
            const pool = scanResults
                .filter(r => !r.domain && r.latency > 0 && r.latency <= latMax
                    && (selectedPorts.size === 0 || selectedPorts.has(String(r.port)))
                    && (selectedRegions.size === 0 || !r.colo || selectedRegions.has(r.colo))
                    && (regionList.length === 0 || !r.colo || regionList.includes(r.colo.toUpperCase())))
                .sort((a, b) => a.latency - b.latency);
            candidates = capByRegion(pool, perRegion, limits).slice(0, candN);
            if (candidates.length === 0) {
                showToast('没有符合初筛条件的 IP，请放宽延迟上限或地区/端口选择', 'warning');
                return;
            }
        } else {
            candidates = filteredResults.filter(r => !r.domain && selectedSpeedTargets.has(speedKey(r)));
            if (candidates.length === 0) {
                showToast('请先在列表里勾选要继续筛选的 IP', 'warning');
                return;
            }
        }

        const data: Record<string, Measured> = {};
        setAutoRunning(true);
        try {
            if (mode === 'refilter') {
                // 不重新测试：直接用列表里已有的平均/测速数据
                for (const c of candidates) {
                    const k = speedKey(c);
                    const dl = displayDownloadMbps(c);
                    const pl = packetLossMap[k];
                    data[k] = {
                        lat: avgLatencyMap[k] ?? (c.latency > 0 ? c.latency : undefined),
                        dl: dl > 0 ? dl : undefined,
                        loss: pl && !pl.error ? pl.packetLoss : undefined,
                    };
                }
            } else {
                if (mode === 'full') setSelectedSpeedTargets(new Set(candidates.map(speedKey)));
                // 阶段 A：延迟（和丢包）。设置了“下载只测延迟前 N 个”时，下载放到阶段 B
                const splitDl = needDl && dlTopN > 0;
                let metricsA: MeasureMetrics = {
                    latency: autoLatencyOn || sortKey === 'latency' || splitDl,
                    download: needDl && !splitDl,
                    loss: autoLossOn || sortKey === 'loss',
                };
                if (!metricsA.latency && !metricsA.download && !metricsA.loss) metricsA = { ...metricsA, latency: true };
                const resA = await runMeasure(candidates, metricsA, rounds);
                if (resA.aborted) {
                    showToast('自动优选已中断', 'warning');
                    return;
                }
                Object.assign(data, resA.data);
                if (splitDl) {
                    const ranked = candidates
                        .filter(c => {
                            const m = data[speedKey(c)];
                            return !!m && !(autoLatencyOn && !(m.lat !== undefined && m.lat <= latMax));
                        })
                        .sort((a, b) => (data[speedKey(a)]?.lat ?? a.latency) - (data[speedKey(b)]?.lat ?? b.latency))
                        .slice(0, dlTopN);
                    if (ranked.length > 0) {
                        const resB = await runMeasure(ranked, { latency: false, download: true, loss: false }, rounds);
                        if (resB.aborted) {
                            showToast('自动优选已中断', 'warning');
                            return;
                        }
                        for (const [k, m] of Object.entries(resB.data)) data[k] = { ...(data[k] || {}), ...m };
                    }
                }
            }

            const passed = candidates.filter(c => {
                const m = data[speedKey(c)];
                if (!m) return false;
                if (autoLatencyOn && !(m.lat !== undefined && m.lat <= latMax)) return false;
                const th = dlThresholdOf(c);
                if (th !== undefined && !(m.dl !== undefined && m.dl >= th)) return false;
                if (autoLossOn && !(m.loss !== undefined && m.loss <= lossMax)) return false;
                return true;
            });
            const rankKey = sortKey === 'default' ? 'latency' : sortKey;
            const latOf = (c: ScanResult) => data[speedKey(c)]?.lat ?? c.latency;
            passed.sort((a, b) => {
                const ma = data[speedKey(a)] || {};
                const mb = data[speedKey(b)] || {};
                if (rankKey === 'download') return (mb.dl ?? 0) - (ma.dl ?? 0);
                if (rankKey === 'loss') return (ma.loss ?? 101) - (mb.loss ?? 101);
                return latOf(a) - latOf(b);
            });
            const finalList = capByRegion(passed, perRegion, limits).slice(0, keepN);
            setSelectedSpeedTargets(new Set(finalList.map(speedKey)));
            if (sortKey === 'default') setSortKey('latency');
            const label = mode === 'refilter' ? '重新筛选完成' : mode === 'selected' ? '再优选完成' : '自动优选完成';
            showToast(
                finalList.length > 0
                    ? `${label}：${mode === 'full' ? '候选' : '参与'} ${candidates.length} 个，达标 ${passed.length} 个，已勾选前 ${finalList.length} 个`
                    : `${label}：${mode === 'full' ? '候选' : '参与'} ${candidates.length} 个，但没有 IP 满足全部达标条件，可放宽条件后重试`,
                finalList.length > 0 ? 'success' : 'warning',
            );
        } finally {
            setAutoRunning(false);
        }
    };


    // 扫描完成（结果更新）后自动执行优选
    useEffect(() => {
        if (!autoEnabled || !autoAfterScan || scanResults.length === 0) return;
        if (autoRanRef.current === scanResults) return;
        autoRanRef.current = scanResults;
        void runAutoPipeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scanResults, autoEnabled, autoAfterScan]);

    // 导出：复制到剪贴板 / 下载文件
    const buildExportText = (): { text: string; count: number; ext: string } => {
        const rows = exportScope === 'selected'
            ? limitedResults.filter(r => !r.domain && selectedSpeedTargets.has(speedKey(r)))
            : limitedResults;
        const hostPort = (r: ScanResult) => `${r.ip.includes(':') ? `[${r.ip}]` : r.ip}:${r.port}`;
        if (exportFormat === 'csv') {
            const lossOf = (r: ScanResult) => { const x = packetLossMap[speedKey(r)]; return x && !x.error ? x.packetLoss : ''; };
            const lines = ['ip,port,colo,latency_ms,avg_latency_ms,download_mbps,packet_loss_pct'];
            rows.forEach(r => lines.push([
                r.ip, r.port, r.colo || '', r.latency > -1 ? r.latency : '',
                avgLatencyMap[speedKey(r)] ?? '', displayDownloadMbps(r) > 0 ? displayDownloadMbps(r).toFixed(2) : '', lossOf(r),
            ].join(',')));
            return { text: lines.join('\n'), count: rows.length, ext: 'csv' };
        }
        const lines = rows.map(r => exportFormat === 'ip' ? r.ip : `${hostPort(r)}#${r.colo || '-'}`);
        return { text: lines.join('\n'), count: rows.length, ext: 'txt' };
    };
    const handleExportCopy = async () => {
        const { text, count } = buildExportText();
        if (count === 0) { showToast(exportScope === 'selected' ? '请先勾选要导出的 IP，或改为“当前列表全部”' : '没有可导出的结果', 'warning'); return; }
        try {
            await navigator.clipboard.writeText(text);
            showToast(`已复制 ${count} 条到剪贴板`, 'success');
        } catch {
            showToast('复制失败：浏览器未授权剪贴板，请改用下载', 'error');
        }
    };
    const handleExportDownload = () => {
        const { text, count, ext } = buildExportText();
        if (count === 0) { showToast(exportScope === 'selected' ? '请先勾选要导出的 IP，或改为“当前列表全部”' : '没有可导出的结果', 'warning'); return; }
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const name = `优选IP-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
        const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showToast(`已导出 ${count} 条：${name}`, 'success');
    };

    const handleSave = async () => {
        const resultsForSave = saveSelectedOnly
            ? limitedResults.filter(r => !r.domain && selectedSpeedTargets.has(speedKey(r)))
            : limitedResults;
        if (resultsForSave.length === 0) {
            showToast(saveSelectedOnly ? '请先勾选要保存到 KV 的 IPv4 IP，或取消“仅保存勾选 IP”。' : '没有可保存的结果。', 'warning');
            return;
        }

        if (!sceneName.trim()) {
            showToast('请输入场景名称', 'warning');
            return;
        }

        setIsSaving(true);
        try{
            const dataToSave = resultsForSave.map((result) => {
                const { isAvailable, ...rest } = result;
                const measuredSpeed = browserSpeedMap[speedKey(result)];
                const avgLatency = avgLatencyMap[speedKey(result)];
                return {
                    ...rest,
                    testedAt: Date.now(), // 记录本次测试/保存时间，订阅接口可用 max_age 过滤过旧数据
                    ...(typeof measuredSpeed === 'number' && measuredSpeed > 0 ? { downloadMbps: measuredSpeed } : {}),
                    ...(typeof avgLatency === 'number' && avgLatency > 0 ? { latency: avgLatency } : {}),
                };
            });
            await saveResults(sceneName.trim(), dataToSave as ScanResult[], saveMode);
            showToast(`场景 "${sceneName.trim()}" 保存成功！\n共 ${resultsForSave.length} 个IP/域名\n模式: ${saveMode === 'overwrite' ? '覆盖' : '追加'}`, 'success');
            if (onSaveSuccess) onSaveSuccess();
        } catch (error) {
            console.error('Failed to save results:', error);
            showToast(`保存失败: ${error instanceof Error ? error.message : '未知错误'}`, 'error');
        } finally {
            setIsSaving(false);
        }
    };

    return (

        <div className="bg-white dark:bg-gray-800 shadow-md rounded-lg p-6 mb-8">
            <div className="flex items-center gap-3 mb-4">
                <ListFilter className="w-7 h-7 text-purple-500" />
                <h2 className="text-2xl font-semibold text-gray-700 dark:text-gray-200">IP/域名优选测速结果</h2>
            </div>
            {scanResults.length > 0 ? (
                <>
                    <div className="p-3 mb-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
                        <div className="flex items-center gap-4 mb-4 pb-3 border-b border-gray-200 dark:border-gray-600">
                            <div className="flex items-center gap-4 flex-wrap">
                                <h3 className="text-sm font-bold text-gray-700 dark:text-gray-200">筛选与操作（勾选项共用于测速、丢包测试和 KV 保存）:</h3>
                                <button onClick={() => void handleBrowserSpeedTest()} disabled={isBrowserSpeedTesting || selectedVisibleSpeedKeys.length === 0} className="px-3 py-1 text-xs font-medium rounded-full bg-blue-100 text-blue-700 hover:bg-blue-200 disabled:opacity-50 dark:bg-blue-900/40 dark:text-blue-300">{isBrowserSpeedTesting ? `测速中 ${browserSpeedDone}/${browserSpeedTotal}` : `浏览器测速 (${selectedVisibleSpeedKeys.length})`}</button>
                                {isBrowserSpeedTesting && (
                                    <button onClick={abortSpeedTest} title="立即中止所有下载测速请求" className="px-3 py-1 text-xs font-medium rounded-full bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300">■ 中断测速</button>
                                )}
                                {[isBrowserSpeedTesting, isPacketLossTesting].filter(Boolean).length >= 2 && (
                                    <button onClick={abortAllTests} title="同时中止正在运行的下载测速和丢包测试" className="px-3 py-1 text-xs font-bold rounded-full bg-red-600 text-white hover:bg-red-700">■ 强行中断全部</button>
                                )}
                                <button onClick={() => void handlePacketLossTest()} disabled={isPacketLossTesting || selectedVisibleSpeedKeys.length === 0} title="每个 IP 发送 10 次 HTTPS 探测；这不是 ICMP ping" className="px-3 py-1 text-xs font-medium rounded-full bg-amber-100 text-amber-800 hover:bg-amber-200 disabled:opacity-50 dark:bg-amber-900/40 dark:text-amber-300">{isPacketLossTesting ? `丢包测试 ${packetLossDone}/${selectedVisibleSpeedKeys.length}` : `丢包率测试 (${selectedVisibleSpeedKeys.length})`}</button>
                                {isPacketLossTesting && (
                                    <button onClick={abortPacketLoss} title="立即中止丢包测试" className="px-3 py-1 text-xs font-medium rounded-full bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300">■ 中断丢包测试</button>
                                )}
                                <button onClick={() => { setBrowserSpeedMap({}); setBrowserSpeedErrors({}); setPacketLossMap({}); setAvgLatencyMap({}); setSelectedSpeedTargets(new Set()); }} disabled={isBrowserSpeedTesting || (Object.keys(browserSpeedMap).length === 0 && Object.keys(browserSpeedErrors).length === 0 && Object.keys(packetLossMap).length === 0)} className="px-3 py-1 text-xs font-medium rounded-full bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-600 dark:text-gray-200 dark:hover:bg-gray-500">清除测速结果</button>
                                <div className="flex items-center gap-3 flex-wrap w-full">
                                    <label className="flex items-center gap-1.5 text-xs font-medium text-gray-700 dark:text-gray-200 cursor-pointer">
                                        <input type="checkbox" checked={avgEnabled} onChange={(e) => setAvgEnabled(e.target.checked)} disabled={isAvgTesting} />
                                        多轮平均测试
                                    </label>
                                    {avgEnabled && (
                                        <>
                                            <span className="text-xs text-gray-500 dark:text-gray-400">取平均的指标:</span>
                                            {([['latency', '延迟'], ['download', '下载速度'], ['loss', '丢包率']] as const).map(([k, label]) => (
                                                <label key={k} className="flex items-center gap-1 text-xs text-gray-700 dark:text-gray-200">
                                                    <input type="checkbox" checked={avgMetrics[k]} onChange={(e) => setAvgMetrics(prev => ({ ...prev, [k]: e.target.checked }))} disabled={isAvgTesting} />
                                                    {label}
                                                </label>
                                            ))}
                                            <label className="flex items-center gap-1 text-xs text-gray-700 dark:text-gray-200">
                                                轮数
                                                <input type="number" min={1} max={10} value={avgRounds} onChange={(e) => setAvgRounds(e.target.value)} disabled={isAvgTesting} className="w-14 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-0.5 text-xs" />
                                            </label>
                                            <button onClick={() => void handleAvgTest()} disabled={isAvgTesting || isBrowserSpeedTesting || isPacketLossTesting || selectedVisibleSpeedKeys.length === 0} title="只测试已勾选的 IP，重复多轮后取平均；下载测速每轮使用所选文件大小" className="px-3 py-1 text-xs font-medium rounded-full bg-teal-100 text-teal-800 hover:bg-teal-200 disabled:opacity-50 dark:bg-teal-900/40 dark:text-teal-300">{isAvgTesting ? `平均测试 ${avgDone}/${avgTotal}` : `平均值测试 (${selectedVisibleSpeedKeys.length})`}</button>
                                            {isAvgTesting && (
                                                <button onClick={abortAvgTest} className="px-3 py-1 text-xs font-medium rounded-full bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300">■ 中断平均测试</button>
                                            )}
                                        </>
                                    )}
                                </div>
                                <div className="flex items-center gap-3 flex-wrap w-full text-xs text-gray-700 dark:text-gray-200">
                                    {autoEnabled ? (
                                        <>
                                            <span className="font-bold">流水线:</span>
                                            <button onClick={() => void runAutoPipeline()} disabled={autoRunning || isAvgTesting || isBrowserSpeedTesting || isPacketLossTesting} title="按“扫描配置”里的流水线设置，对当前结果做初筛、多轮平均测试、筛选并勾选" className="px-3 py-1 text-xs font-medium rounded-full bg-indigo-100 text-indigo-800 hover:bg-indigo-200 disabled:opacity-50 dark:bg-indigo-900/40 dark:text-indigo-300">{autoRunning ? `优选中 ${avgDone}/${avgTotal}` : '开始自动优选'}</button>
                                            <button onClick={() => void runAutoPipeline('selected')} disabled={autoRunning || isAvgTesting || isBrowserSpeedTesting || isPacketLossTesting || selectedVisibleSpeedKeys.length === 0} title="只对已勾选的 IP 重新测试，再按流水线条件筛选，没达标的会被取消勾选" className="px-3 py-1 text-xs font-medium rounded-full bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 dark:bg-indigo-900/30 dark:text-indigo-300">对已勾选再优选 ({selectedVisibleSpeedKeys.length})</button>
                                            <button onClick={() => void runAutoPipeline('refilter')} disabled={autoRunning || isAvgTesting || isBrowserSpeedTesting || isPacketLossTesting || selectedVisibleSpeedKeys.length === 0} title="不重新测试，按列表里已有的延迟/下载/丢包数据，用当前流水线条件重新筛选已勾选的 IP" className="px-3 py-1 text-xs font-medium rounded-full bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-200">按现有数据重新筛选</button>
                                            {autoRunning && (
                                                <button onClick={abortAvgTest} className="px-3 py-1 text-xs font-medium rounded-full bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300">■ 中断优选</button>
                                            )}
                                            <span className="text-gray-500 dark:text-gray-400">{autoAfterScan ? '扫描完成后自动执行' : '手动触发'}；参数在“扫描配置”的流水线里修改</span>
                                        </>
                                    ) : (
                                        <span className="text-gray-500 dark:text-gray-400">流水线未启用（可在“扫描配置”里打开）</span>
                                    )}
                                    <label className="flex items-center gap-1">排序
                                        <select value={sortKey} onChange={(e) => setSortKey(e.target.value as PipelineSortKey)} disabled={autoRunning} className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-0.5">
                                            <option value="default">默认（扫描顺序）</option>
                                            <option value="latency">平均延迟（低→高）</option>
                                            <option value="download">下载速度（高→低）</option>
                                            <option value="loss">丢包率（低→高）</option>
                                        </select>
                                    </label>
                                </div>
                                <div className="flex items-center gap-2 flex-wrap w-full text-xs text-gray-700 dark:text-gray-200">
                                    <span className="font-medium">导出:</span>
                                    <select value={exportScope} onChange={(e) => setExportScope(e.target.value as 'selected' | 'all')} className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1">
                                        <option value="selected">仅勾选项</option>
                                        <option value="all">当前列表全部</option>
                                    </select>
                                    <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value as 'ipport' | 'ip' | 'csv')} className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1">
                                        <option value="ipport">IP:端口#地区</option>
                                        <option value="ip">仅 IP</option>
                                        <option value="csv">CSV（含全部指标）</option>
                                    </select>
                                    <button onClick={() => void handleExportCopy()} className="px-3 py-1 rounded-full bg-sky-100 text-sky-800 hover:bg-sky-200 dark:bg-sky-900/40 dark:text-sky-300">复制</button>
                                    <button onClick={handleExportDownload} className="px-3 py-1 rounded-full bg-sky-100 text-sky-800 hover:bg-sky-200 dark:bg-sky-900/40 dark:text-sky-300">下载文件</button>
                                </div>
                                <div className="flex items-center gap-2 flex-wrap">
                                    <label htmlFor="download-test-address" className="text-xs text-gray-600 dark:text-gray-300">下载测速地址</label>
                                    <select id="download-test-address" value={downloadTestAddress} onChange={(e) => setDownloadTestAddress(e.target.value as 'auto' | 'ns' | 'bestcf' | 'custom')} disabled={isBrowserSpeedTesting} className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-xs text-gray-800 dark:text-gray-100">
                                        <option value="auto">自动选择（推荐）</option>
                                        <option value="ns">ns.psb.kdns.fr</option>
                                        <option value="bestcf">bestcf.cmliussss.hidns.vip</option>
                                        <option value="custom">自定义地址模板</option>
                                    </select>
                                    <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
                                        文件大小
                                        <input type="number" min={1} max={100} list="download-size-options" value={downloadSizeMB} onChange={(e) => setDownloadSizeMB(e.target.value)} disabled={isBrowserSpeedTesting || isAvgTesting} title="单次下载测速请求的数据量，1-100 MB；越大越准但越慢、越耗流量" className="w-16 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-xs text-gray-800 dark:text-gray-100" />
                                        MB
                                        <datalist id="download-size-options">
                                            {[5, 10, 25, 50, 100].map(n => <option key={n} value={n} />)}
                                        </datalist>
                                    </label>
                                    {downloadTestAddress === 'custom' && (
                                        <input aria-label="自定义下载测速地址模板" value={customDownloadUrlTemplate} onChange={(e) => setCustomDownloadUrlTemplate(e.target.value)} disabled={isBrowserSpeedTesting} placeholder={'https://{hexip}.example.com:{port}/__down?bytes={bytes}'} className="min-w-[260px] flex-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-xs text-gray-800 dark:text-gray-100" />
                                    )}
                                </div>
                                <div className="flex items-center gap-2">
                                    <input
                                        id="latency-filter-enable"
                                        type="checkbox"
                                        checked={isLatencyFilterEnabled}
                                        onChange={(e) => setIsLatencyFilterEnabled(e.target.checked)}
                                        className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                                    />
                                    <label htmlFor="latency-filter-enable" className="text-sm text-gray-600 dark:text-gray-300 cursor-pointer select-none">延迟 ≤</label>
                                </div>
                                 <div className="flex items-center gap-2">
                                    <input
                                        id="latency-filter-value"
                                        type="text"
                                        value={latencyFilterValue}
                                        onChange={(e) => setLatencyFilterValue(e.target.value)}
                                        className={`p-1 border rounded-md w-20 text-sm dark:bg-gray-600 dark:border-gray-500 dark:text-white ${isLatencyFilterEnabled ? '' : 'opacity-60'}`}
                                    />
                                    <span className="text-sm text-gray-600 dark:text-gray-300">ms</span>
                                    {isLatencyFilterEnabled && !isLatencyFormatValid && <span className="text-red-500 text-xs">请输入有效的正整数</span>}
                                </div>
                                <div className="flex items-center gap-2">
                                    <input
                                        id="download-filter-enable"
                                        type="checkbox"
                                        checked={isDownloadFilterEnabled}
                                        onChange={(e) => setIsDownloadFilterEnabled(e.target.checked)}
                                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                    />
                                    <label htmlFor="download-filter-enable" className="text-sm text-gray-600 dark:text-gray-300 cursor-pointer select-none">下载速度 ≥</label>
                                    <input
                                        id="download-filter-value"
                                        type="text"
                                        inputMode="decimal"
                                        value={downloadFilterValue}
                                        onChange={(e) => setDownloadFilterValue(e.target.value.replace(/[^0-9.]/g, ''))}
                                        className={`p-1 border rounded-md w-20 text-sm dark:bg-gray-600 dark:border-gray-500 dark:text-white ${isDownloadFilterEnabled ? '' : 'opacity-60'}`}
                                    />
                                    <span className="text-sm text-gray-600 dark:text-gray-300">Mbps</span>
                                    {isDownloadFilterEnabled && !isDownloadFormatValid && <span className="text-red-500 text-xs">请输入有效的速度值</span>}
                                </div>
                                <div className="flex items-center gap-2">
                                    <input
                                        id="packet-loss-filter-enable"
                                        type="checkbox"
                                        checked={isPacketLossFilterEnabled}
                                        onChange={(e) => setIsPacketLossFilterEnabled(e.target.checked)}
                                        className="h-4 w-4 rounded border-gray-300 text-amber-600 focus:ring-amber-500"
                                    />
                                    <label htmlFor="packet-loss-filter-enable" className="text-sm text-gray-600 dark:text-gray-300 cursor-pointer select-none">丢包率 ≤</label>
                                    <input
                                        id="packet-loss-filter-value"
                                        type="text"
                                        inputMode="decimal"
                                        value={packetLossFilterValue}
                                        onChange={(e) => setPacketLossFilterValue(e.target.value.replace(/[^0-9.]/g, '').slice(0, 5))}
                                        className={`p-1 border rounded-md w-16 text-sm dark:bg-gray-600 dark:border-gray-500 dark:text-white ${isPacketLossFilterEnabled ? '' : 'opacity-60'}`}
                                    />
                                    <span className="text-sm text-gray-600 dark:text-gray-300">%</span>
                                    {isPacketLossFilterEnabled && !isPacketLossFormatValid && <span className="text-red-500 text-xs">请输入 0-100</span>}
                                </div>
                                <div className="flex items-center gap-2">
                                    <input
                                        id="region-limit-enable"
                                        type="checkbox"
                                        checked={isRegionLimitEnabled}
                                        onChange={(e) => setIsRegionLimitEnabled(e.target.checked)}
                                        className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                                    />
                                    <label htmlFor="region-limit-enable" className="text-sm text-gray-600 dark:text-gray-300 cursor-pointer select-none">每个地区保留</label>
                                </div>
                                <div className="flex items-center gap-2">
                                    <input
                                        id="ips-per-region"
                                        type="text"
                                        value={ipsPerRegion}
                                        onChange={(e) => setIpsPerRegion(e.target.value)}
                                        className={`p-1 border rounded-md w-20 text-sm dark:bg-gray-600 dark:border-gray-500 dark:text-white ${isRegionLimitEnabled ? '' : 'opacity-60'}`}
                                    />
                                    <span className="text-sm text-gray-600 dark:text-gray-300">个</span>
                                    {isRegionLimitEnabled && !isIpsPerRegionFormatValid && <span className="text-red-500 text-xs">请输入大于等于1的整数</span>}
                                </div>
                            </div>
                        </div>

                        {isDownloadFilterEnabled && (
                            <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                                当前速度/丢包率筛选后：<span className="font-semibold text-gray-700 dark:text-gray-200">{packetLossFilteredResults.length}</span> 个结果
                            </div>
                        )}

                        <div className="flex items-center justify-between mb-2">
                            <h3 className="text-sm font-bold text-gray-700 dark:text-gray-200">按地区筛选</h3>
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={() => setSelectedRegions(new Set(uniqueRegions))}
                                    className="px-3 py-1 text-xs font-medium text-blue-800 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800 transition-colors"
                                >
                                    全选
                                </button>
                                <button
                                    onClick={() => setSelectedRegions(new Set())}
                                    className="px-3 py-1 text-xs font-medium text-gray-800 bg-gray-100 rounded-full hover:bg-gray-200 dark:bg-gray-600 dark:text-gray-300 dark:hover:bg-gray-500 transition-colors"
                                >
                                    清空
                                </button>
                            </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {uniqueRegions.map(region => {
                                const countForRegion = regionCounts[region] || 0;
                                const displayCount = regionLimitActive ? Math.min(countForRegion, effectiveIpsPerRegion) : countForRegion;
                                const isSelected = selectedRegions.has(region);
                                return (
                                    <button
                                        key={region}
                                        type="button"
                                        onClick={() => {
                                            const newSet = new Set(selectedRegions);
                                            if (newSet.has(region)) {
                                                newSet.delete(region);
                                            } else {
                                                newSet.add(region);
                                            }
                                            setSelectedRegions(newSet);
                                        }}
                                        className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                                            isSelected
                                                ? 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100 dark:bg-indigo-900/40 dark:text-indigo-200 dark:border-indigo-700/60 dark:hover:bg-indigo-800/60'
                                                : 'bg-gray-100 text-gray-500 border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600'
                                        }`}
                                    >
                                        <RegionDisplay colo={region} flagSize="xs" /> <span>({displayCount})</span>
                                    </button>
                                );
                            })}
                        </div>

                        <div className="flex items-center justify-between mb-2 mt-4">
                            <h3 className="text-sm font-bold text-gray-700 dark:text-gray-200">按端口筛选</h3>
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={() => setSelectedPorts(new Set(uniquePorts.map(String)))}
                                    className="px-3 py-1 text-xs font-medium text-blue-800 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800 transition-colors"
                                >
                                    全选
                                </button>
                                <button
                                    onClick={() => setSelectedPorts(new Set())}
                                    className="px-3 py-1 text-xs font-medium text-gray-800 bg-gray-100 rounded-full hover:bg-gray-200 dark:bg-gray-600 dark:text-gray-300 dark:hover:bg-gray-500 transition-colors"
                                >
                                    清空
                                </button>
                            </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {uniquePorts.map((port) => {
                                const portStr = String(port);
                                const isSelected = selectedPorts.has(portStr);
                                return (
                                    <button
                                        key={port}
                                        type="button"
                                        onClick={() => {
                                            const newSet = new Set(selectedPorts);
                                            if (newSet.has(portStr)) {
                                                newSet.delete(portStr);
                                            } else {
                                                newSet.add(portStr);
                                            }
                                            setSelectedPorts(newSet);
                                        }}
                                        className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                                            isSelected
                                                ? 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100 dark:bg-indigo-900/40 dark:text-indigo-200 dark:border-indigo-700/60 dark:hover:bg-indigo-800/60'
                                                : 'bg-gray-100 text-gray-500 border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600'
                                        }`}
                                    >
                                        {port} <span className="opacity-60">({portCounts[portStr] || 0})</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    <div className="mb-3 rounded-lg border border-gray-200 dark:border-gray-600 p-3 space-y-2">
                        <div className="text-sm text-gray-700 dark:text-gray-200">
                            <span className="font-medium">丢包率测试地址</span>
                            <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">测试前需手动勾选 IP；结果可用于下方丢包率筛选</span>
                        </div>
                        <label className="block text-xs text-gray-600 dark:text-gray-300" htmlFor="packet-loss-url-template">自选探测地址模板（必须 HTTPS；支持 {'{ip}'}、{'{hexip}'}、{'{port}'}）</label>
                        <div className="flex flex-col sm:flex-row gap-2">
                            <input id="packet-loss-url-template" value={packetLossUrlTemplate} onChange={(e) => setPacketLossUrlTemplate(e.target.value)} disabled={isPacketLossTesting} placeholder="https://{hexip}.ns.psb.kdns.fr:{port}/ip.json" className="min-w-0 flex-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-xs text-gray-800 dark:text-gray-100" />
                            <button onClick={() => setPacketLossMap({})} disabled={isPacketLossTesting} className="rounded-md bg-gray-100 dark:bg-gray-600 px-3 py-2 text-xs text-gray-700 dark:text-gray-100 disabled:opacity-50">清除丢包结果</button>
                        </div>
                    </div>
                    <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">* 丢包率是 HTTPS 探测失败比例，不是 ICMP Ping。EDT 项目没有通用丢包测试专用地址，因此默认沿用本项目按候选 IP 生成的 HTTPS 探测模板；自定义地址需支持对应的 IP/端口访问。DNS、TLS、CORS 或目标服务限制都可能影响结果。</p>
                    <div className="max-h-96 overflow-y-auto">
                    <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                        <thead className="bg-gray-50 dark:bg-gray-700 sticky top-0">
                            <tr>
                                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                                    <div className="flex items-center gap-2">
                                        <input type="checkbox" checked={allVisibleSpeedSelected} onChange={toggleAllVisibleSpeedTargets} disabled={isBrowserSpeedTesting || isSaving} title="全选可用于测速、丢包测试和 KV 保存的 IPv4" className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                                        <span>IP/域名</span>
                                    </div>
                                </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">端口</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">延迟 (ms)</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">地区</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">下载速度</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">丢包率*</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                            {limitedResults.map(({ ip, port, latency, colo, domain, downloadMbps }) => {
                                return (
                                    <Fragment key={`${ip}:${port}`}>
                                        <tr key={`${ip}:${port}`} className="hover:bg-gray-100 dark:hover:bg-gray-700">
                                            <td className="px-3 py-4 whitespace-nowrap text-sm font-mono text-gray-900 dark:text-white">
                                                <div className="flex items-center gap-2">
                                                    <input type="checkbox" checked={selectedSpeedTargets.has(`${ip}:${port}`)} onChange={() => toggleSpeedTarget(`${ip}:${port}`)} disabled={domain || isBrowserSpeedTesting || isSaving} title="选择此 IP 用于下载测速、丢包测试及保存到 KV" className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                                                    <span>{ip}</span>
                                                {domain && <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">域名</span>}
                                                </div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{port}</td>
                                            <td className={`px-6 py-4 whitespace-nowrap text-sm font-bold ${getLatencyColor(avgLatencyMap[`${ip}:${port}`] ?? latency)}`}>{avgLatencyMap[`${ip}:${port}`] !== undefined ? <>{avgLatencyMap[`${ip}:${port}`]}ms<span className="ml-1 text-[10px] font-normal text-gray-400">均值</span></> : (latency > -1 ? `${latency}ms` : 'N/A')}</td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{colo ? <RegionDisplay colo={colo} flagSize="sm" /> : '-'}</td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-blue-600 dark:text-blue-400">{displayDownloadMbps({ ip, port, latency, colo, domain, downloadMbps, isAvailable: true }) > 0 ? `${displayDownloadMbps({ ip, port, latency, colo, domain, downloadMbps, isAvailable: true }).toFixed(2)} Mbps` : (browserSpeedErrors[`${ip}:${port}`] ? '失败' : speedPending[`${ip}:${port}`] ? <span className="text-gray-400 animate-pulse">测速中…</span> : '-')}</td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold">{packetLossMap[`${ip}:${port}`] ? (packetLossMap[`${ip}:${port}`].error ? <span className="text-red-500" title={packetLossMap[`${ip}:${port}`].error}>不可测</span> : <span className={packetLossMap[`${ip}:${port}`].packetLoss === 0 ? 'text-green-600 dark:text-green-400' : packetLossMap[`${ip}:${port}`].packetLoss < 20 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}>{packetLossMap[`${ip}:${port}`].packetLoss}% <span className="font-normal text-xs text-gray-500">({packetLossMap[`${ip}:${port}`].received}/{packetLossMap[`${ip}:${port}`].sent})</span></span>) : '-'}</td>
                                        </tr>
                                    </Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                </div>

                <div className="mt-6 p-4 bg-gray-50 dark:bg-gray-700 rounded-lg border border-gray-200 dark:border-gray-600">
                    <div className="flex items-center gap-3 mb-4">
                        <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-200">保存结果</h3>
                        <span className="px-2.5 py-0.5 bg-green-100 text-green-800 text-sm font-semibold rounded-full dark:bg-green-900 dark:text-green-300">IP {limitedResults.filter(r => !r.domain).length} 个</span>
                        <span className="px-2.5 py-0.5 bg-indigo-100 text-indigo-800 text-sm font-semibold rounded-full dark:bg-indigo-900 dark:text-indigo-300">域名 {limitedResults.filter(r => r.domain).length} 个</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-4">
                        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer select-none">
                            <input type="checkbox" checked={saveSelectedOnly} onChange={(e) => setSaveSelectedOnly(e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                            仅保存勾选 IPv4 到 KV（取消则保存全部筛选结果）
                        </label>
                        <div className="relative" ref={sceneInputRef}>
                            <input
                                id="scene-name"
                                type="text"
                                value={sceneName}
                                onChange={(e) => {
                                    const v = e.target.value;
                                    setSceneName(v);
                                    // 自行输入内容后隐藏下拉，清空则重新展开
                                    setSceneDropdownOpen(v.trim() === '');
                                }}
                                onFocus={() => setSceneDropdownOpen(true)}
                                placeholder="场景名称，例如: 家庭电信"
                                className="p-2 border rounded-md w-64 dark:bg-gray-600 dark:border-gray-500 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                            />
                            {sceneDropdownOpen && (
                                <div className="absolute z-30 mt-1 w-64 max-h-56 overflow-auto rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-lg p-2">
                                    {sceneOptions.length > 0 ? (
                                        <div className="flex flex-wrap gap-1.5">
                                            {sceneOptions.map((name) => (
                                                <span
                                                    key={name}
                                                    className="inline-flex items-center rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 dark:bg-indigo-900/40 dark:text-indigo-200 dark:border-indigo-700/60 overflow-hidden"
                                                >
                                                    <button
                                                        type="button"
                                                        onClick={() => { setSceneName(name); setSceneDropdownOpen(false); }}
                                                        className="pl-2.5 pr-1.5 py-1 text-xs font-medium hover:bg-indigo-100 dark:hover:bg-indigo-800/60 transition-colors"
                                                    >
                                                        {name}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        title={`删除分组「${name}」`}
                                                        aria-label={`删除分组 ${name}`}
                                                        onClick={() => void handleDeleteScene(name)}
                                                        className="px-1.5 py-1 text-indigo-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/40 transition-colors"
                                                    >
                                                        <X className="w-3 h-3" />
                                                    </button>
                                                </span>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="px-1 py-2 text-xs text-gray-400 dark:text-gray-500">
                                            暂无已保存场景
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        <div className="relative flex w-fit items-center rounded-lg bg-gray-100 p-1 dark:bg-gray-700 border border-gray-200 dark:border-gray-600">
                            <button
                                onClick={() => setSaveMode('overwrite')}
                                className={`relative z-10 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                                    saveMode === 'overwrite'
                                        ? 'bg-white text-gray-800 shadow-sm dark:bg-gray-900 dark:text-white'
                                        : 'text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white'
                                }`}
                            >
                                覆盖同场景数据
                            </button>
                            <button
                                onClick={() => setSaveMode('append')}
                                className={`relative z-10 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                                    saveMode === 'append'
                                        ? 'bg-white text-gray-800 shadow-sm dark:bg-gray-900 dark:text-white'
                                        : 'text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white'
                                }`}
                            >
                                追加到旧数据
                            </button>
                        </div>

                        <button
                            onClick={handleSave}
                            disabled={isSaving || (saveSelectedOnly ? selectedVisibleSpeedKeys.length === 0 : filteredResults.length === 0) || !sceneName.trim()}
                            className="flex items-center bg-blue-600 text-white font-bold py-2 px-6 rounded-md hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
                        >
                            <Save className="w-4 h-4 mr-2" />
                            {isSaving ? '保存中...' : '保存'}
                        </button>
                    </div>
                </div>
                </>
            ) : (
                <p className="text-gray-500 dark:text-gray-400 text-center">暂无测试结果数据</p>
            )}
        </div>
    );
}
