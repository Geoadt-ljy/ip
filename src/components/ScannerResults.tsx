import { Fragment, useState, useEffect, useRef } from 'react';
import { saveResults, getScenes, checkPurity, deleteScene } from '../api';
import {
  ScanResult,
  getLatencyColor,
  testBrowserDownloadSpeed,
  testBrowserPacketLoss,
  testIpLatency,
} from '../utils/scanner';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmDialog';
import { classifyHome } from '../../functions/_lib/residential';
import { ListFilter, Save, ChevronDown, ChevronUp, X } from 'lucide-react';
import { RegionDisplay } from './RegionDisplay';

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
    const [isPurityFilterEnabled, setIsPurityFilterEnabled] = useState(false);
    const [isHomeFilterEnabled, setIsHomeFilterEnabled] = useState(false); // 仅保留家宽，需要先检测纯净度
    const [purityFilterValue, setPurityFilterValue] = useState<string>('90');
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
    const [purityMap, setPurityMap] = useState<Record<string, import('../api').PurityResult>>({});
    const [isCheckingPurity, setIsCheckingPurity] = useState(false);
    const [expandedPurityIp, setExpandedPurityIp] = useState<string | null>(null);
    const [selectedSpeedTargets, setSelectedSpeedTargets] = useState<Set<string>>(new Set());
    const [browserSpeedMap, setBrowserSpeedMap] = useState<Record<string, number>>({});
    const [browserSpeedErrors, setBrowserSpeedErrors] = useState<Record<string, string>>({});
    const [isBrowserSpeedTesting, setIsBrowserSpeedTesting] = useState(false);
    const [browserSpeedDone, setBrowserSpeedDone] = useState(0);
    const [browserSpeedTotal, setBrowserSpeedTotal] = useState(0);
    const [speedPending, setSpeedPending] = useState<Record<string, true>>({});
    const [purityDone, setPurityDone] = useState(0);
    const [purityTotal, setPurityTotal] = useState(0);
    const [purityPending, setPurityPending] = useState<Record<string, true>>({});
    const [purityFailed, setPurityFailed] = useState<Record<string, true>>({});
    // 用于“强行中断”：持有当前运行中的测速 / 纯净度检测的 AbortController
    const speedAbortRef = useRef<AbortController | null>(null);
    const packetLossAbortRef = useRef<AbortController | null>(null);
    const avgAbortRef = useRef<AbortController | null>(null);
    const [avgEnabled, setAvgEnabled] = useState(false); // 多轮平均测试开关
    const [avgMetrics, setAvgMetrics] = useState({ latency: true, download: true, loss: true });
    const [avgRounds, setAvgRounds] = useState('3');
    const [avgLatencyMap, setAvgLatencyMap] = useState<Record<string, number>>({});
    const [isAvgTesting, setIsAvgTesting] = useState(false);
    const [avgDone, setAvgDone] = useState(0);
    const [avgTotal, setAvgTotal] = useState(0);
    const purityAbortRef = useRef<AbortController | null>(null);
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
    // 纯净度检测、丢包率检测或保存到 KV，避免延迟扫描阶段并行启动下载测速。
    useEffect(() => {
        // 结果集变化时，先中断仍在运行的测速 / 纯净度检测，避免旧任务写入新结果
        speedAbortRef.current?.abort();
        purityAbortRef.current?.abort();
        packetLossAbortRef.current?.abort();
        avgAbortRef.current?.abort();
        setSelectedSpeedTargets(new Set());
        setBrowserSpeedMap({});
        setBrowserSpeedErrors({});
        setPacketLossMap({});
        setPurityMap({});
        setPurityFailed({});
        setPurityPending({});
        setSpeedPending({});
    }, [scanResults]);

    // 组件卸载时中断所有进行中的请求
    useEffect(() => () => {
        speedAbortRef.current?.abort();
        purityAbortRef.current?.abort();
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

    const purityTrim = purityFilterValue.trim();
    const isPurityFormatValid = /^\d+$/.test(purityTrim) && Number(purityTrim) >= 0 && Number(purityTrim) <= 100;
    const effectivePurityValue = isPurityFormatValid ? Number(purityTrim) : 0;

    const packetLossTrim = packetLossFilterValue.trim();
    const isPacketLossFormatValid = /^(?:\d+(?:\.\d+)?)$/.test(packetLossTrim) && Number(packetLossTrim) >= 0 && Number(packetLossTrim) <= 100;
    const effectivePacketLossValue = isPacketLossFormatValid ? Number(packetLossTrim) : 0;

    const ipsPerRegionTrim = ipsPerRegion.trim();
    const isIpsPerRegionFormatValid = /^\d+$/.test(ipsPerRegionTrim) && parseInt(ipsPerRegionTrim, 10) >= 1;
    const effectiveIpsPerRegion = isIpsPerRegionFormatValid ? parseInt(ipsPerRegionTrim, 10) : DEFAULT_IPS_PER_REGION;

    // 勾选且数值合法才生效；数值不合法时不做筛选，仅在输入框旁提示，避免误把结果全部过滤掉
    const latencyFilterActive = isLatencyFilterEnabled && isLatencyFormatValid;
    const downloadFilterActive = isDownloadFilterEnabled && isDownloadFormatValid;
    const purityFilterActive = isPurityFilterEnabled && isPurityFormatValid;
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

    const purityFilteredResults = downloadFilteredResults.filter(r =>
        purityFilterActive ? (purityMap[r.ip] && purityMap[r.ip].purityScore >= effectivePurityValue) : true
    ).filter(r =>
        // 家宽筛选：没做过纯净度检测的 IP 无法判断，视为不满足
        isHomeFilterEnabled ? (!!purityMap[r.ip] && classifyHome(purityMap[r.ip]) !== 'other') : true
    );

    const packetLossFilteredResults = purityFilteredResults.filter(r => {
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
    const abortPurityCheck = () => purityAbortRef.current?.abort();
    const abortAllTests = () => {
        speedAbortRef.current?.abort();
        purityAbortRef.current?.abort();
        packetLossAbortRef.current?.abort();
        avgAbortRef.current?.abort();
    };

    const handleCombinedSpeedPurityTest = async () => {
        if (selectedVisibleSpeedKeys.length === 0) {
            showToast('请先勾选一个或多个 IPv4 IP', 'warning');
            return;
        }
        try {
            await Promise.all([handleBrowserSpeedTest(), handlePurity()]);
        } catch (error) {
            showToast(`联合测试发生错误：${error instanceof Error ? error.message : '未知错误'}`, 'error');
        }
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

    // 多轮平均测试：对勾选 IP 重复 N 轮，按所选指标（延迟/下载速度/丢包率）取平均
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
        const rounds = Math.max(1, Math.min(10, Math.floor(Number(avgRounds)) || 3));
        const controller = new AbortController();
        avgAbortRef.current = controller;
        const signal = controller.signal;
        setIsAvgTesting(true);
        setAvgDone(0);
        setAvgTotal(targets.length);
        if (avgMetrics.download) setSpeedPending(Object.fromEntries(targets.map(t => [speedKey(t), true as const])));
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
                        if (avgMetrics.latency) {
                            const r = await testIpLatency(target.ip, target.port, 3000);
                            if (r.latency > 0) lats.push(r.latency);
                        }
                        if (avgMetrics.download && !signal.aborted) {
                            const r = await testBrowserDownloadSpeed(target.ip, target.port, {
                                bytes: downloadBytes,
                                timeoutMs: 20000,
                                signal,
                                ...(template ? { urlTemplate: template } : {}),
                            });
                            if (r.aborted) { interrupted = true; break; }
                            if (r.downloadMbps > 0) dls.push(r.downloadMbps);
                        }
                        if (avgMetrics.loss && !signal.aborted) {
                            const r = await testBrowserPacketLoss(target.ip, target.port, { attempts: 10, timeoutMs: 3000, urlTemplate: packetLossUrlTemplate, signal });
                            if (r.aborted) { interrupted = true; break; }
                            if (!r.error) { sent += r.sent; received += r.received; }
                        }
                    }
                    // 被中断的目标数据不完整，不记录
                    if (interrupted || signal.aborted) return;
                    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
                    if (lats.length > 0) setAvgLatencyMap(prev => ({ ...prev, [key]: Math.round(mean(lats)) }));
                    if (avgMetrics.download) {
                        if (dls.length > 0) setBrowserSpeedMap(prev => ({ ...prev, [key]: Number(mean(dls).toFixed(2)) }));
                        else setBrowserSpeedErrors(prev => ({ ...prev, [key]: '平均测速失败' }));
                        setSpeedPending(prev => { const next = { ...prev }; delete next[key]; return next; });
                    }
                    if (sent > 0) {
                        setPacketLossMap(prev => ({ ...prev, [key]: { packetLoss: Number((((sent - received) / sent) * 100).toFixed(1)), sent, received } }));
                    }
                    done++;
                    setAvgDone(done);
                }
            };
            await Promise.all(Array.from({ length: Math.min(3, targets.length) }, () => worker()));
            if (signal.aborted) {
                showToast(`已中断平均值测试：完成 ${done}/${targets.length} 个 IP`, 'warning');
            } else {
                showToast(`平均值测试完成：${done} 个 IP，每个 ${rounds} 轮`, 'success');
            }
        } finally {
            setIsAvgTesting(false);
            setSpeedPending({});
            if (avgAbortRef.current === controller) avgAbortRef.current = null;
        }
    };
    const abortAvgTest = () => avgAbortRef.current?.abort();

    const handlePurity = async () => {
        const ips = Array.from(new Set(filteredResults.filter(r => !r.domain && selectedSpeedTargets.has(speedKey(r))).map(r => r.ip)));
        if (ips.length === 0) {
            showToast('请先勾选一个或多个可检测的 IPv4 IP', 'warning');
            return;
        }
        const controller = new AbortController();
        purityAbortRef.current = controller;
        const signal = controller.signal;
        setIsCheckingPurity(true);
        setPurityDone(0);
        setPurityTotal(ips.length);
        setPurityFailed({});
        setPurityPending(Object.fromEntries(ips.map(ip => [ip, true as const])));

        // 小批量 + 少量并发：每批返回后立即写入 purityMap，表格里的纯净度即时显示。
        // （后端单次上限 20 个，这里取 5 个一批，让结果更快出现。）
        const BATCH_SIZE = 5;
        const CONCURRENCY = 2;
        const batches: string[][] = [];
        for (let i = 0; i < ips.length; i += BATCH_SIZE) batches.push(ips.slice(i, i + BATCH_SIZE));

        let done = 0;
        let okCount = 0;
        let firstError = '';
        let authFailed = false;
        try {
            const worker = async () => {
                while (batches.length && !signal.aborted) {
                    const batch = batches.shift();
                    if (!batch) return;
                    try {
                        const data = await checkPurity(batch, signal);
                        okCount += Object.keys(data).length;
                        setPurityMap(prev => ({ ...prev, ...data }));
                        const missing = batch.filter(ip => !data[ip]);
                        if (missing.length > 0) {
                            setPurityFailed(prev => ({ ...prev, ...Object.fromEntries(missing.map(ip => [ip, true as const])) }));
                        }
                    } catch (e) {
                        if (signal.aborted) return;
                        const msg = e instanceof Error ? e.message : '未知错误';
                        if (!firstError) firstError = msg;
                        setPurityFailed(prev => ({ ...prev, ...Object.fromEntries(batch.map(ip => [ip, true as const])) }));
                        // 登录失效时继续请求没有意义，直接中止剩余批次
                        if (msg.includes('登录已过期')) {
                            authFailed = true;
                            controller.abort();
                            return;
                        }
                    }
                    setPurityPending(prev => {
                        const next = { ...prev };
                        batch.forEach(ip => delete next[ip]);
                        return next;
                    });
                    done += batch.length;
                    setPurityDone(done);
                }
            };
            await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker()));

            if (authFailed) {
                showToast(`纯净度检测失败：${firstError}`, 'error');
            } else if (signal.aborted) {
                showToast(`已中断纯净度检测：已完成 ${done}/${ips.length}，成功 ${okCount} 个`, 'warning');
            } else if (okCount === 0 && firstError) {
                showToast(`纯净度检测失败：${firstError}`, 'error');
            } else {
                showToast(`纯净度检测完成：${okCount}/${ips.length}`, 'success');
            }
        } finally {
            setIsCheckingPurity(false);
            setPurityPending({});
            if (purityAbortRef.current === controller) purityAbortRef.current = null;
        }
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
                const measuredPurity = purityMap[result.ip] || result.purity;
                const avgLatency = avgLatencyMap[speedKey(result)];
                return {
                    ...rest,
                    testedAt: Date.now(), // 记录本次测试/保存时间，订阅接口可用 max_age 过滤过旧数据
                    ...(typeof measuredSpeed === 'number' && measuredSpeed > 0 ? { downloadMbps: measuredSpeed } : {}),
                    ...(typeof avgLatency === 'number' && avgLatency > 0 ? { latency: avgLatency } : {}),
                    ...(measuredPurity ? { purity: measuredPurity } : {}),
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
                                <h3 className="text-sm font-bold text-gray-700 dark:text-gray-200">筛选与操作（勾选项共用于测速、纯净度检测和 KV 保存）:</h3>
                                <button onClick={() => void handlePurity()} disabled={isCheckingPurity || selectedVisibleSpeedKeys.length === 0} className="px-3 py-1 text-xs font-medium rounded-full bg-emerald-100 text-emerald-700 hover:bg-emerald-200 disabled:opacity-50 dark:bg-emerald-900/40 dark:text-emerald-300">{isCheckingPurity ? `检测中 ${purityDone}/${purityTotal}` : `检测勾选项纯净度 (${selectedVisibleSpeedKeys.length})`}</button>
                                <button onClick={() => void handleBrowserSpeedTest()} disabled={isBrowserSpeedTesting || selectedVisibleSpeedKeys.length === 0} className="px-3 py-1 text-xs font-medium rounded-full bg-blue-100 text-blue-700 hover:bg-blue-200 disabled:opacity-50 dark:bg-blue-900/40 dark:text-blue-300">{isBrowserSpeedTesting ? `测速中 ${browserSpeedDone}/${browserSpeedTotal}` : `浏览器测速 (${selectedVisibleSpeedKeys.length})`}</button>
                                <button onClick={() => void handleCombinedSpeedPurityTest()} disabled={isBrowserSpeedTesting || isCheckingPurity || selectedVisibleSpeedKeys.length === 0} className="px-3 py-1 text-xs font-medium rounded-full bg-violet-100 text-violet-700 hover:bg-violet-200 disabled:opacity-50 dark:bg-violet-900/40 dark:text-violet-300">一键测速 + 纯净度</button>
                                {isBrowserSpeedTesting && (
                                    <button onClick={abortSpeedTest} title="立即中止所有下载测速请求" className="px-3 py-1 text-xs font-medium rounded-full bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300">■ 中断测速</button>
                                )}
                                {isCheckingPurity && (
                                    <button onClick={abortPurityCheck} title="立即中止纯净度检测请求" className="px-3 py-1 text-xs font-medium rounded-full bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300">■ 中断纯净度</button>
                                )}
                                {[isBrowserSpeedTesting, isCheckingPurity, isPacketLossTesting].filter(Boolean).length >= 2 && (
                                    <button onClick={abortAllTests} title="同时中止正在运行的下载测速、纯净度检测和丢包测试" className="px-3 py-1 text-xs font-bold rounded-full bg-red-600 text-white hover:bg-red-700">■ 强行中断全部</button>
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
                                        id="purity-filter-enable"
                                        type="checkbox"
                                        checked={isPurityFilterEnabled}
                                        onChange={(e) => setIsPurityFilterEnabled(e.target.checked)}
                                        className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                                    />
                                    <label htmlFor="purity-filter-enable" className="text-sm text-gray-600 dark:text-gray-300 cursor-pointer select-none">纯净度 ≥</label>
                                    <input
                                        id="purity-filter-value"
                                        type="text"
                                        inputMode="numeric"
                                        value={purityFilterValue}
                                        onChange={(e) => setPurityFilterValue(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
                                        className={`p-1 border rounded-md w-16 text-sm dark:bg-gray-600 dark:border-gray-500 dark:text-white ${isPurityFilterEnabled ? '' : 'opacity-60'}`}
                                    />
                                    <span className="text-sm text-gray-600 dark:text-gray-300">/100</span>
                                    {isPurityFilterEnabled && !isPurityFormatValid && <span className="text-red-500 text-xs">请输入 0-100 的纯净度</span>}
                                </div>
                                <div className="flex items-center gap-2">
                                    <input
                                        id="home-filter-enable"
                                        type="checkbox"
                                        checked={isHomeFilterEnabled}
                                        onChange={(e) => setIsHomeFilterEnabled(e.target.checked)}
                                        className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                                    />
                                    <label htmlFor="home-filter-enable" className="text-sm text-gray-600 dark:text-gray-300 cursor-pointer select-none" title="根据纯净度检测结果判断：排除机房、VPN、代理、Tor、中继和移动网络；只有上游明确标注为家庭宽带的才算">仅家宽</label>
                                    {isHomeFilterEnabled && Object.keys(purityMap).length === 0 && <span className="text-amber-600 dark:text-amber-400 text-xs">请先检测纯净度</span>}
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

                        {(isDownloadFilterEnabled || isPurityFilterEnabled) && (
                            <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                                当前速度/纯净度/丢包率筛选后：<span className="font-semibold text-gray-700 dark:text-gray-200">{packetLossFilteredResults.length}</span> 个结果
                                {isPurityFilterEnabled && Object.keys(purityMap).length === 0 && <span className="ml-2 text-amber-600 dark:text-amber-400">请先点击“检测纯净度”</span>}
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
                                        <input type="checkbox" checked={allVisibleSpeedSelected} onChange={toggleAllVisibleSpeedTargets} disabled={isBrowserSpeedTesting || isCheckingPurity || isSaving} title="全选可用于测速、纯净度检测和 KV 保存的 IPv4" className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                                        <span>IP/域名</span>
                                    </div>
                                </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">端口</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">延迟 (ms)</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">地区</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">下载速度</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">丢包率*</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">纯净度</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                            {limitedResults.map(({ ip, port, latency, colo, domain, downloadMbps }) => {
                                const purity = purityMap[ip];
                                const expanded = expandedPurityIp === `${ip}:${port}`;
                                return (
                                    <Fragment key={`${ip}:${port}`}>
                                        <tr key={`${ip}:${port}`} className="hover:bg-gray-100 dark:hover:bg-gray-700">
                                            <td className="px-3 py-4 whitespace-nowrap text-sm font-mono text-gray-900 dark:text-white">
                                                <div className="flex items-center gap-2">
                                                    <input type="checkbox" checked={selectedSpeedTargets.has(`${ip}:${port}`)} onChange={() => toggleSpeedTarget(`${ip}:${port}`)} disabled={domain || isBrowserSpeedTesting || isCheckingPurity || isSaving} title="选择此 IP 用于下载测速、纯净度检测及保存到 KV" className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                                                    <span>{ip}</span>
                                                {domain && <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">域名</span>}
                                                </div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{port}</td>
                                            <td className={`px-6 py-4 whitespace-nowrap text-sm font-bold ${getLatencyColor(avgLatencyMap[`${ip}:${port}`] ?? latency)}`}>{avgLatencyMap[`${ip}:${port}`] !== undefined ? <>{avgLatencyMap[`${ip}:${port}`]}ms<span className="ml-1 text-[10px] font-normal text-gray-400">均值</span></> : (latency > -1 ? `${latency}ms` : 'N/A')}</td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{colo ? <RegionDisplay colo={colo} flagSize="sm" /> : '-'}</td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-blue-600 dark:text-blue-400">{displayDownloadMbps({ ip, port, latency, colo, domain, downloadMbps, isAvailable: true }) > 0 ? `${displayDownloadMbps({ ip, port, latency, colo, domain, downloadMbps, isAvailable: true }).toFixed(2)} Mbps` : (browserSpeedErrors[`${ip}:${port}`] ? '失败' : speedPending[`${ip}:${port}`] ? <span className="text-gray-400 animate-pulse">测速中…</span> : '-')}</td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold">{packetLossMap[`${ip}:${port}`] ? (packetLossMap[`${ip}:${port}`].error ? <span className="text-red-500" title={packetLossMap[`${ip}:${port}`].error}>不可测</span> : <span className={packetLossMap[`${ip}:${port}`].packetLoss === 0 ? 'text-green-600 dark:text-green-400' : packetLossMap[`${ip}:${port}`].packetLoss < 20 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}>{packetLossMap[`${ip}:${port}`].packetLoss}% <span className="font-normal text-xs text-gray-500">({packetLossMap[`${ip}:${port}`].received}/{packetLossMap[`${ip}:${port}`].sent})</span></span>) : '-'}</td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm">
                                                <div className="flex items-center gap-2">
                                                    {purity ? <span className={purity.purityScore >= 90 ? 'text-green-600 dark:text-green-400' : purity.purityScore >= 70 ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-600 dark:text-red-400'}>{purity.purityScore} / 100</span> : (purityFailed[ip] ? <span className="text-red-500" title="检测失败或上游无结果">失败</span> : purityPending[ip] ? <span className="text-gray-400 animate-pulse">检测中…</span> : '-')}
                                                    {purity && classifyHome(purity) === 'residential' && (
                                                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" title="上游标注为家庭宽带">家宽</span>
                                                    )}
                                                    {purity && (
                                                        <button type="button" title="查看纯净度详情" onClick={() => setExpandedPurityIp(expanded ? null : `${ip}:${port}`)} className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-500 dark:text-gray-300">
                                                            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                                                        </button>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                        {expanded && purity && (
                                            <tr key={`${ip}:${port}:purity`} className="bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-100">
                                                <td colSpan={7} className="px-6 pb-5 pt-2">
                                                    <div className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 p-4">
                                                        <div className="flex flex-wrap items-center gap-2 mb-4">
                                                            <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">纯净度详情</span>
                                                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${purity.purityScore >= 90 ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' : purity.purityScore >= 70 ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300' : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'}`}>{purity.purityLabel || (purity.purityScore >= 90 ? '高' : purity.purityScore >= 70 ? '中' : '低')}</span>
                                                        </div>
                                                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                                                            <div><span className="text-gray-500 dark:text-gray-400">Fraud Score：</span><b className="font-semibold text-gray-800 dark:text-gray-100">{purity.fraudScore}</b></div>
                                                            <div><span className="text-gray-500 dark:text-gray-400">风险：</span><b className="font-semibold text-gray-800 dark:text-gray-100">{purity.risk || '-'}</b></div>
                                                            <div><span className="text-gray-500 dark:text-gray-400">VPN：</span><b className="font-semibold text-gray-800 dark:text-gray-100">{purity.vpn ? '是' : '否'}</b></div>
                                                            <div><span className="text-gray-500 dark:text-gray-400">Proxy：</span><b className="font-semibold text-gray-800 dark:text-gray-100">{purity.proxy ? '是' : '否'}</b></div>
                                                            <div><span className="text-gray-500 dark:text-gray-400">Tor：</span><b className="font-semibold text-gray-800 dark:text-gray-100">{purity.tor ? '是' : '否'}</b></div>
                                                            <div><span className="text-gray-500 dark:text-gray-400">连接类型：</span><b className="font-semibold text-gray-800 dark:text-gray-100">{purity.connectionType || '-'}</b></div>
                                                            <div><span className="text-gray-500 dark:text-gray-400">家宽判定：</span><b className="font-semibold text-gray-800 dark:text-gray-100">{classifyHome(purity) === 'residential' ? '家宽' : '非家宽'}</b></div>
                                                            <div><span className="text-gray-500 dark:text-gray-400">Relay：</span><b className="font-semibold text-gray-800 dark:text-gray-100">{purity.relay ? '是' : '否'}</b></div>
                                                            <div><span className="text-gray-500 dark:text-gray-400">数据中心：</span><b className="font-semibold text-gray-800 dark:text-gray-100">{purity.isDatacenter ? '是' : '否'}</b></div>
                                                            <div><span className="text-gray-500 dark:text-gray-400">移动网络：</span><b className="font-semibold text-gray-800 dark:text-gray-100">{purity.mobile ? '是' : '否'}</b></div>
                                                            <div><span className="text-gray-500 dark:text-gray-400">滥用者：</span><b className="font-semibold text-gray-800 dark:text-gray-100">{purity.isAbuser ? '是' : '否'}</b></div>
                                                            <div><span className="text-gray-500 dark:text-gray-400">近期滥用：</span><b className="font-semibold text-gray-800 dark:text-gray-100">{purity.recentAbuse ? '是' : '否'}</b></div>
                                                            <div><span className="text-gray-500 dark:text-gray-400">住宅代理：</span><b className="font-semibold text-gray-800 dark:text-gray-100">{purity.residentialProxy ? '是' : '否'}</b></div>
                                                            <div><span className="text-gray-500 dark:text-gray-400">连接类型：</span><b className="font-semibold text-gray-800 dark:text-gray-100">{purity.connectionType || '-'}</b></div>
                                                            <div><span className="text-gray-500 dark:text-gray-400">国家：</span><b className="font-semibold text-gray-800 dark:text-gray-100">{purity.country || '-'}</b></div>
                                                            <div><span className="text-gray-500 dark:text-gray-400">地区：</span><b className="font-semibold text-gray-800 dark:text-gray-100">{purity.region || '-'}</b></div>
                                                            <div><span className="text-gray-500 dark:text-gray-400">城市：</span><b className="font-semibold text-gray-800 dark:text-gray-100">{purity.city || '-'}</b></div>
                                                            <div><span className="text-gray-500 dark:text-gray-400">ASN：</span><b className="font-semibold text-gray-800 dark:text-gray-100">{purity.asn || '-'}</b></div>
                                                            <div><span className="text-gray-500 dark:text-gray-400">ISP：</span><b className="font-semibold text-gray-800 dark:text-gray-100">{purity.isp || '-'}</b></div>
                                                            <div className="md:col-span-2"><span className="text-gray-500 dark:text-gray-400">组织：</span><b className="font-semibold text-gray-800 dark:text-gray-100">{purity.organization || purity.company || '-'}</b></div>
                                                            <div><span className="text-gray-500 dark:text-gray-400">置信度：</span><b className="font-semibold text-gray-800 dark:text-gray-100">{purity.confidence || '-'}</b></div>
                                                            <div className="md:col-span-3"><span className="text-gray-500 dark:text-gray-400">威胁标签：</span><b className="font-semibold text-gray-800 dark:text-gray-100">{purity.threatTags.length ? purity.threatTags.join(', ') : '无'}</b></div>
                                                            <div className="md:col-span-4"><span className="text-gray-500 dark:text-gray-400">原因：</span><b className="font-semibold text-gray-800 dark:text-gray-100">{purity.reason || '无'}</b></div>
                                                        </div>
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
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
