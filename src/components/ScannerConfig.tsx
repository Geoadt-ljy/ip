import { useState, useRef, useEffect, useCallback, ChangeEvent } from 'react';
import { CloudflareIps, getThirdPartySourceList, getThirdPartySourceIps } from '../api';

type SourceRowStatus = 'pending' | 'loading' | 'done' | 'error';
interface SourceRow {
    url: string;
    status: SourceRowStatus;
    ipCount?: number;
    domainCount?: number;
    error?: string;
    ips?: { ip: string; port: number }[];
}
import {
    generateRandomIps,
    BatchScanner,
    ScanResult,
    CF_CIDR_LIST,
    isDomainName,
    isIpv4Cidr,
    expandAllCidrs,
    splitCidrBlocks,
    sampleBlockIps,
    findCidrBlock,
    type CidrBlock,
    cidrHostCount,
    resolveDomainToIp,
    probeBrowserAvailable,
} from '../utils/scanner';
import {
    probeLocalAgent, startAgentScan, fetchAgentProgress, stopAgentScan,
    DEFAULT_AGENT_PORT,
    type AgentResult, type AgentProbeResult,
} from '../utils/localAgent';
import { useToast } from './Toast';
import { Gauge, Play, StopCircle, Loader2, Pause, Square, Cpu, RefreshCw, AlertTriangle, CheckCircle2, Upload } from 'lucide-react';
import { parseIpFileText, MAX_IMPORT_TARGETS } from '../utils/ipFile';
import { useConfirm } from './ConfirmDialog';
import { PipelineSettings } from './PipelineSettings';
import { usePipelineConfig, getPipelineConfig, applyScanFilter } from '../utils/pipelineConfig';

interface IpScannerConfigAndControlProps {
    cfIps: CloudflareIps | null;
    onScanComplete: (results: ScanResult[]) => void;
}

const PORTS_TO_TEST = [80, 443, 8080, 8880, 2052, 2053, 2082, 2083, 2086, 2087, 2095, 2096, 8443];

export function ScannerConfig({ cfIps, onScanComplete }: IpScannerConfigAndControlProps) {
    const [count, setCount] = useState<string>('500');
    const [threads, setThreads] = useState<string>('8');
    const [latencyLimit, setLatencyLimit] = useState<string>('1000');
    const [countError, setCountError] = useState<string>('');
    const [threadsError, setThreadsError] = useState<string>('');
    const [latencyLimitError, setLatencyLimitError] = useState<string>('');
    const [selectedPort, setSelectedPort] = useState(443);
    const [ipSource, setIpSource] = useState<'cf' | 'cm' | 'third' | 'custom'>('cf');
    const [customIps, setCustomIps] = useState('');
    const [pipe] = usePipelineConfig(); // 流水线统一配置（总开关开启时接管延迟上限）
    const pipeLatency = pipe.enabled && pipe.latencyOn ? Math.floor(Number(pipe.latencyMax)) : 0;
    const latencyOverride = Number.isFinite(pipeLatency) && pipeLatency > 0 ? pipeLatency : 0;
    const [retryFailed, setRetryFailed] = useState(true); // 扫描时失败或略高于上限的 IP 重试一次
    const [fullCidr, setFullCidr] = useState(false); // 自定义网段：测试网段内全部 IP
    const [stratified, setStratified] = useState(false); // 分层筛选：先每个 /24 抽样，再精测最优 /24
    const [keepBlocks, setKeepBlocks] = useState('20'); // 精测阶段保留的最优 /24 数量
    const [stage, setStage] = useState<{ no: 0 | 1 | 2; text: string }>({ no: 0, text: '' });
    const stopRequestedRef = useRef(false);
    type CidrPreset = { text: string; fullCidr: boolean; stratified: boolean; keepBlocks: string };
    const PRESET_KEY = 'ip-main:cidr-presets';
    const [presets, setPresets] = useState<Record<string, CidrPreset>>(() => {
        try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '{}'); } catch { return {}; }
    });
    const [presetName, setPresetName] = useState('');
    const [presetSel, setPresetSel] = useState('');
    const persistPresets = (next: Record<string, CidrPreset>) => {
        setPresets(next);
        try { localStorage.setItem(PRESET_KEY, JSON.stringify(next)); } catch { /* 存储不可用时忽略 */ }
    };
    const mergeLines = (existing: string, extra: string[]) => {
        const have = existing.split(/[\s,，]+/).map(x => x.trim()).filter(Boolean);
        const set = new Set(have);
        const add = extra.filter(x => !set.has(x));
        return { text: [...have, ...add].join('\n'), added: add.length };
    };
    const customFileRef = useRef<HTMLInputElement | null>(null);
    const [isScanning, setIsScanning] = useState(false);
    const [progress, setProgress] = useState(0);
    const [total, setTotal] = useState(0);
    const [successCount, setSuccessCount] = useState(0);
    const [failCount, setFailCount] = useState(0);
    const [isStopping, setIsStopping] = useState(false);
    const [uniqueIpCount, setUniqueIpCount] = useState(0);
    const [grossIpCount, setGrossIpCount] = useState(0);
    const [ipCount, setIpCount] = useState(0);
    const [domainCount, setDomainCount] = useState(0);
    const [isPreparing, setIsPreparing] = useState(false);
    const [prepareDone, setPrepareDone] = useState(0);
    const [prepareTotal, setPrepareTotal] = useState(0);
    const [sourceRows, setSourceRows] = useState<SourceRow[]>([]);
    const [startTime, setStartTime] = useState<number | null>(null);
    const [now, setNow] = useState(Date.now());
    const [isPaused, setIsPaused] = useState(false);
    const [pausedAt, setPausedAt] = useState<number | null>(null);

    const scannerRef = useRef<BatchScanner | null>(null);
    const cancelPreparingRef = useRef(false);
    const { showToast } = useToast();
    const { confirm } = useConfirm();

    // ---------- 测速方式切换 ----------
    const [activeTab, setActiveTab] = useState<'browser' | 'local'>('browser');

    // ---------- 本地 Agent ----------
    const [agentProbe, setAgentProbe] = useState<AgentProbeResult | null>(null);
    const [agentChecking, setAgentChecking] = useState(false);
    // 本地服务端口：保存在浏览器本地，下次自动带出
    const [agentPort, setAgentPort] = useState<string>(
        () => localStorage.getItem('LOCAL_AGENT_PORT') || String(DEFAULT_AGENT_PORT)
    );
    const agentStopRef = useRef(false);
    const agentModeRef = useRef(false);
    // 当前这一轮是否走本地 Agent（需要触发重渲染以隐藏不支持的暂停按钮）
    const [agentActive, setAgentActive] = useState(false);

    /** 探测本机 127.0.0.1 上的 Agent 服务 */
    const checkAgent = useCallback(async (port: number, silent = false) => {
        setAgentChecking(true);
        try {
            const r = await probeLocalAgent(port);
            setAgentProbe(r);
            if (r.online && !silent) showToast('已连接到本地 Agent 服务', 'success');
        } catch {
            setAgentProbe({ online: false, reason: 'offline' });
        } finally {
            setAgentChecking(false);
        }
    }, [showToast]);

    // 启动 & 端口变更：探测本地服务
    useEffect(() => {
        void checkAgent(Number(agentPort) || DEFAULT_AGENT_PORT, true);
    }, [checkAgent, agentPort]);

    // ---------- 浏览器端测速可用性自检 ----------
    // 浏览器无法为任意 IP 设置 TLS SNI，只能依赖会失效的第三方泛解析域名；
    // 此处用一次真实浏览器测速来验证当前环境是否可用，失败则提示切换到本地测速。
    const [browserHealthy, setBrowserHealthy] = useState<boolean | null>(null);
    const [browserChecking, setBrowserChecking] = useState(false);

    const checkBrowser = useCallback(async () => {
        setBrowserChecking(true);
        setBrowserHealthy(null);
        try {
            // 从同步到的 Cloudflare IP 段中随机取样例 IP（10 个）用于自检，避免依赖写死地址
            const cidrs = cfIps?.ipv4_cidrs?.length ? cfIps.ipv4_cidrs
                : (cfIps?.cm_cidrs?.length ? cfIps.cm_cidrs : []);
            const sampleIps = cidrs.length > 0 ? generateRandomIps(cidrs, 10) : undefined;
            const ok = await probeBrowserAvailable(sampleIps);
            setBrowserHealthy(ok);
        } catch {
            setBrowserHealthy(false);
        } finally {
            setBrowserChecking(false);
        }
    }, [cfIps]);

    // 进入「浏览器测速」Tab 时做一次自检
    useEffect(() => {
        if (activeTab === 'browser') void checkBrowser();
    }, [activeTab, checkBrowser]);

    const showLocationWarning = async () => {
        const result = await confirm('检测到您目前网络处于代理或VPN环境，请处于直连状态下再开始测试，否则结果没有意义！', {
            confirmText: '坚持测试',
            confirmButtonColor: 'bg-orange-500 hover:bg-orange-600 focus:ring-orange-500',
            cancelText: '取消测试',
            cancelButtonColor: 'bg-green-500 hover:bg-green-600 focus:ring-green-500',
        });
        return result;
    };

    const validateInputs = (): { countNum: number; threadsNum: number; latencyLimitNum: number } | null => {
        const countTrim = count.trim();
        const threadsTrim = threads.trim();
        const latencyLimitTrim = latencyLimit.trim();
        let hasError = false;
        if (ipSource !== 'third' && !/^\d+$/.test(countTrim)) {
            setCountError('请输入有效的正整数');
            hasError = true;
        } else {
            setCountError('');
        }
        if (!/^\d+$/.test(threadsTrim) || parseInt(threadsTrim, 10) < 1) {
            setThreadsError('请输入大于等于1的整数');
            hasError = true;
        } else {
            setThreadsError('');
        }
        if (!latencyOverride && !/^\d+$/.test(latencyLimitTrim)) {
            setLatencyLimitError('请输入有效的正整数');
            hasError = true;
        } else {
            setLatencyLimitError('');
        }
        if (hasError) return null;

        return {
            countNum: parseInt(countTrim, 10),
            threadsNum: parseInt(threadsTrim, 10),
            latencyLimitNum: latencyOverride || parseInt(latencyLimitTrim, 10),
        };
    };

    const checkGeoLocation = async (): Promise<boolean> => {
        let isCN = true;
        try {
            const response = await fetch('https://api.ip.sb/geoip');
            const data = await response.json() as { country_code: string };
            isCN = data.country_code === 'CN';
        } catch (error) {
            console.error('Failed to determine location:', error);
            isCN = false;
        }
        if (!isCN) {
            return showLocationWarning();
        }
        return true;
    };

    // 上传 txt / csv：解析后与文本框里已有的内容合并去重
    const handleCustomFile = async (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // 允许重复选择同一个文件
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) {
            showToast('文件过大（超过 2MB）', 'error');
            return;
        }
        try {
            const parsed = parseIpFileText(await file.text());
            if (parsed.targets.length === 0) {
                showToast('文件中没有识别到有效的 IPv4 / 域名', 'warning');
                return;
            }
            const existing = customIps.split(/[\s,，]+/).map(x => x.trim()).filter(Boolean);
            const merged = Array.from(new Set([...existing, ...parsed.targets])).slice(0, MAX_IMPORT_TARGETS);
            setCustomIps(merged.join('\n'));
            const notes: string[] = [];
            if (parsed.ignored > 0) notes.push(`忽略 ${parsed.ignored} 项无法识别的内容（如 IPv6）`);
            if (parsed.truncated || merged.length >= MAX_IMPORT_TARGETS) notes.push(`数量超过 ${MAX_IMPORT_TARGETS} 个上限，多余部分已截断`);
            showToast(`已导入 ${parsed.targets.length} 个目标，当前共 ${merged.length} 个${notes.length ? '；' + notes.join('；') : ''}`, notes.length ? 'warning' : 'success');
        } catch {
            showToast('读取文件失败', 'error');
        }
    };

    const prepareTargets = async (countNum: number): Promise<{ targets: string[]; resolvedMap?: Record<string, string | null>; stratify?: { blocks: CidrBlock[]; keep: number } } | null> => {
        setSourceRows([]);
        setUniqueIpCount(0);
        setGrossIpCount(0);
        setIpCount(0);
        setDomainCount(0);

        if (cancelPreparingRef.current) return null;

        if (ipSource === 'custom') {
            const targets = customIps.split(/[\s,，]+/).map(x => x.trim()).filter(Boolean);
            if (targets.length === 0) {
                showToast('请输入至少一个 IP 或 IP:端口', 'warning');
                return null;
            }
            // IP 段（CIDR）按“随机IP数量”从所有网段中随机抽样展开，其余目标原样保留
            const cidrs = targets.filter(isIpv4Cidr);
            const plain = targets.filter(t => !t.includes('/'));
            const bad = targets.length - cidrs.length - plain.length;
            if (bad > 0) showToast(`有 ${bad} 项无法识别（网段前缀需在 8-32 之间），已忽略`, 'warning');
            let expanded: string[] = [];
            if (cidrs.length > 0) {
                const agentOn = activeTab === 'local' && agentProbe?.online === true;
                const keep = Math.max(1, Math.min(500, Math.floor(Number(keepBlocks)) || 20));
                if (fullCidr && stratified) {
                    if (agentOn) {
                        showToast('分层筛选仅支持浏览器端测速，已改为直接测试全部 IP', 'info');
                    } else {
                        const blocks = splitCidrBlocks(cidrs);
                        if (blocks.length > keep) {
                            const stage1 = Array.from(new Set([...plain, ...sampleBlockIps(blocks, 3)]));
                            return { targets: stage1, stratify: { blocks, keep } };
                        }
                        showToast(`网段只有 ${blocks.length} 个 /24，不需要分层筛选，直接测试全部 IP`, 'info');
                    }
                }
                if (fullCidr) {
                    const r = expandAllCidrs(cidrs, MAX_IMPORT_TARGETS);
                    expanded = r.ips;
                    if (r.truncated) showToast(`网段内共 ${r.total} 个 IP，超过 ${MAX_IMPORT_TARGETS} 上限，已随机抽取 ${MAX_IMPORT_TARGETS} 个`, 'warning');
                } else {
                    expanded = generateRandomIps(cidrs, countNum);
                }
            }
            const finalTargets = Array.from(new Set([...plain, ...expanded]));
            if (finalTargets.length === 0) {
                showToast('没有可测试的目标，请检查输入', 'warning');
                return null;
            }
            return { targets: finalTargets };
        }

        if (ipSource === 'third') {
            setPrepareDone(0);
            setPrepareTotal(0);

            // 先取出完整源列表，立即以"等待中"渲染全部条目
            const sources = await getThirdPartySourceList();
            if (cancelPreparingRef.current) return null;
            if (!Array.isArray(sources) || sources.length === 0) {
                showToast('未配置第三方源，请先到"第三方IP/域名源"中添加', 'warning');
                return null;
            }

            const rows: SourceRow[] = sources.map((url) => ({ url, status: 'pending' }));
            setSourceRows(rows);
            setPrepareTotal(sources.length);

            // 逐源解析，实时更新对应条目的状态与结果
            const allIps = new Map<string, { ip: string; port: number }>();
            let grossCount = 0;
            let doneCount = 0;

            for (let i = 0; i < sources.length; i++) {
                if (cancelPreparingRef.current) return null;
                // 标记当前行为"解析中"
                setSourceRows((prev) => prev.map((r, idx) => idx === i ? { ...r, status: 'loading' } : r));
                setPrepareDone(i);

                let stat;
                try {
                    stat = await getThirdPartySourceIps(sources[i]);
                } catch (e) {
                    stat = { url: sources[i], status: 'error', count: 0, ipCount: 0, domainCount: 0, ips: [], error: (e as Error).message };
                }

                // 更新当前行结果
                setSourceRows((prev) => prev.map((r, idx) => idx === i ? {
                    url: stat.url,
                    status: stat.status === 'error' ? 'error' : 'done',
                    ipCount: stat.ipCount,
                    domainCount: stat.domainCount,
                    error: stat.error,
                    ips: stat.ips
                } : r));
                doneCount++;
                setPrepareDone(doneCount);

                if (stat.status !== 'error') {
                    for (const item of stat.ips) {
                        allIps.set(`${item.ip}:${item.port}`, item);
                    }
                }
                grossCount += stat.count;
            }

            if (cancelPreparingRef.current) return null;

            const finalIps = Array.from(allIps.values());
            let dedupIp = 0;
            let dedupDomain = 0;
            for (const item of finalIps) {
                if (isDomainName(item.ip)) dedupDomain++;
                else dedupIp++;
            }

            setUniqueIpCount(finalIps.length);
            setGrossIpCount(grossCount);
            setIpCount(dedupIp);
            setDomainCount(dedupDomain);

            if (finalIps.length === 0) {
                showToast('未能获取到第三方源IP，请检查配置或后台日志', 'warning');
                return null;
            }

            const targets: string[] = [];
            const domainItems: { key: string; host: string }[] = [];
            for (const item of finalIps) {
                const key = `${item.ip}:${item.port}`;
                targets.push(key);
                // 收集域名源，前端用阿里云 DoH 解析出测速 IP
                if (isDomainName(item.ip)) domainItems.push({ key, host: item.ip });
            }

            const resolvedMap: Record<string, string | null> = {};
            if (domainItems.length > 0) {
                const entries = await Promise.all(
                    domainItems.map(async ({ key, host }) => [key, await resolveDomainToIp(host)] as const)
                );
                for (const [key, ip] of entries) resolvedMap[key] = ip;
            }

            return { targets, resolvedMap };
        }

        const cidrsToUse = ipSource === 'cf'
            ? (cfIps?.ipv4_cidrs?.length ? cfIps.ipv4_cidrs : (CF_CIDR_LIST || []))
            : (cfIps?.cm_cidrs?.length ? cfIps.cm_cidrs : (CF_CIDR_LIST || []));

        if (!cidrsToUse || cidrsToUse.length === 0) {
            showToast('未找到Cloudflare IP段数据，请先点击上方的"同步IP段"按钮进行同步。', 'error');
            return null;
        }
        return { targets: generateRandomIps(cidrsToUse, countNum) };
    };

    // ---------- 本地 Agent 测速 ----------

    /** Agent 结果 -> 页面统一的 ScanResult，从而复用原有的结果列表与保存逻辑 */
    const toScanResult = (r: AgentResult): ScanResult => ({
        ip: r.host,
        port: r.port,
        isAvailable: r.ok,
        latency: r.ok ? r.latency : -1,
        colo: r.colo || undefined,
        domain: isDomainName(r.host) || undefined,
        tcpMs: r.tcpMs >= 0 ? r.tcpMs : undefined,
        tlsMs: r.tlsMs >= 0 ? r.tlsMs : undefined,
        error: r.error || undefined,
        downloadMbps: r.downloadMbps,
        downloadBytes: r.downloadBytes,
        downloadError: r.downloadError,
    });

    /**
     * 把页面已有的靶标字符串解析成 Agent 需要的 {host, ip, port}。
     * 域名源用 DoH 已解析出的 IP 去连接，但 host 保留域名，与浏览器端行为一致。
     */
    const buildAgentTargets = (
        rawTargets: string[],
        resolvedMap?: Record<string, string | null>,
        defaultPort = 443
    ) => rawTargets.map((raw) => {
        let host = raw;
        let port = defaultPort;
        const lastColon = raw.lastIndexOf(':');
        const closeBracket = raw.lastIndexOf(']');
        if (lastColon > -1 && lastColon > closeBracket) {
            const p = parseInt(raw.substring(lastColon + 1), 10);
            if (!isNaN(p)) {
                port = p;
                host = raw.substring(0, lastColon);
                if (host.startsWith('[') && host.endsWith(']')) host = host.substring(1, host.length - 1);
            }
        }
        if (port === 0) port = 443;
        const ip = (resolvedMap && resolvedMap[raw]) || host;
        return { host, ip, port };
    });

    /** 通过本地 Agent 执行测速：下发参数 -> 轮询进度 -> 汇总回传 */
    const runAgentScan = async (
        targets: { host: string; ip: string; port: number }[],
        threadsNum: number,
        latencyLimitNum: number,
        onProgress: (r: ScanResult) => void,
        onComplete: (rs: ScanResult[]) => void,
    ) => {
        if (!agentProbe?.online) throw new Error('本地 Agent 未连接');
        const base = agentProbe.baseUrl;

        await startAgentScan(base, {
            targets,
            threads: threadsNum,
            timeoutMs: 2500,
            latencyLimit: latencyLimitNum,
            source: ipSource,
            // 延迟扫描阶段不自动下载测速；完成扫描后由结果列表手动勾选并启动浏览器测速。
            downloadTest: false,
        });

        let since = 0;
        let lastDone = -1;
        let stallTicks = 0;
        const acc: ScanResult[] = [];

        while (!agentStopRef.current) {
            const p = await fetchAgentProgress(base, since);
            since += p.count;
            for (const r of p.results) {
                const sr = toScanResult(r);
                acc.push(sr);
                onProgress(sr);
            }

            if (!p.running) break;

            // 卡死保护：连续 60 秒没有任何进展则放弃
            if (p.done === lastDone) {
                if (++stallTicks > 150) throw new Error('本地 Agent 长时间无进展，已放弃等待');
            } else {
                lastDone = p.done;
                stallTicks = 0;
            }
            await new Promise((r) => setTimeout(r, 400));
        }

        onComplete(acc.filter((r) => r.isAvailable).sort((a, b) => a.latency - b.latency));
    };

    const handleScan = async () => {
        cancelPreparingRef.current = false;

        const val = validateInputs();
        if (!val) return;

        setIsPreparing(true);
        try {
            // Step 1: 地理定位检测
            const shouldContinue = await checkGeoLocation();
            if (!shouldContinue || cancelPreparingRef.current) {
                setIsPreparing(false);
                return;
            }

            // Step 2: 准备靶标 IP
            const prepared = await prepareTargets(val.countNum);
            if (!prepared || prepared.targets.length === 0 || cancelPreparingRef.current) {
                setIsPreparing(false);
                return;
            }
            const targets = prepared.targets;

            // Step 3: 初始化扫描状态
            setProgress(0);
            setSuccessCount(0);
            setFailCount(0);
            setTotal(targets.length);
            await new Promise(resolve => setTimeout(resolve, 0));

            const currentResults: ScanResult[] = [];
            const onProgress = (result: ScanResult) => {
                setProgress(p => p + 1);
                currentResults.push(result);
                if (result.isAvailable) {
                    setSuccessCount(s => s + 1);
                } else {
                    setFailCount(f => f + 1);
                }
            };

            const onComplete = (finalResults: ScanResult[]) => {
                setIsStopping(false);
                setIsPaused(false);
                setAgentActive(false);
                agentModeRef.current = false;
                if (scannerRef.current) {
                    scannerRef.current.stop();
                }
                setIsScanning(false);
                setStartTime(null);
                const cfg = getPipelineConfig();
                if (cfg.enabled) {
                    const filtered = applyScanFilter(finalResults, cfg);
                    if (filtered.removed > 0) showToast(`流水线已按地区/每地区上限筛选，去掉 ${filtered.removed} 条`, 'info');
                    onScanComplete(filtered.results);
                } else {
                    onScanComplete(finalResults);
                }
            };

            // 分层筛选：阶段 1 每个 /24 抽样粗筛，阶段 2 只精测最优的若干 /24
            stopRequestedRef.current = false;
            if (prepared.stratify) {
                const { blocks, keep } = prepared.stratify;
                const port = ipSource === 'third' ? 0 : selectedPort;
                setIsPreparing(false);
                setIsScanning(true);
                setStartTime(Date.now());
                setNow(Date.now());
                setAgentActive(false);
                agentModeRef.current = false;

                setStage({ no: 1, text: `阶段 1/2：抽样粗筛 ${blocks.length} 个 /24` });
                const stage1: ScanResult[] = [];
                const s1 = new BatchScanner(targets, port, val.threadsNum, val.latencyLimitNum,
                    (r) => { stage1.push(r); onProgress(r); }, () => { }, prepared.resolvedMap, retryFailed);
                scannerRef.current = s1;
                await s1.run();

                if (!stopRequestedRef.current) {
                    const best = new Map<CidrBlock, number>();
                    for (const r of stage1) {
                        if (!r.isAvailable) continue;
                        const b = findCidrBlock(blocks, r.ip);
                        if (b && (!best.has(b) || r.latency < (best.get(b) as number))) best.set(b, r.latency);
                    }
                    const ranked = Array.from(best.entries()).sort((a, b) => a[1] - b[1]).slice(0, keep).map(([b]) => b.cidr);
                    if (ranked.length === 0) {
                        showToast('粗筛中没有可用的网段，请放宽延迟上限或检查网络', 'warning');
                    } else {
                        const tested = new Set(stage1.map(r => r.ip));
                        const exp = expandAllCidrs(ranked, MAX_IMPORT_TARGETS);
                        const stage2 = exp.ips.filter(ip => !tested.has(ip));
                        if (stage2.length > 0) {
                            setTotal(targets.length + stage2.length);
                            setStage({ no: 2, text: `阶段 2/2：精测最优 ${ranked.length} 个 /24（${stage2.length} 个 IP）` });
                            const s2 = new BatchScanner(stage2, port, val.threadsNum, val.latencyLimitNum, onProgress, () => { }, undefined, retryFailed);
                            scannerRef.current = s2;
                            await s2.run();
                        }
                    }
                }
                setStage({ no: 0, text: '' });
                onComplete(currentResults.filter(r => r.isAvailable).sort((a, b) => a.latency - b.latency));
                return;
            }

            // Step 4: 启动扫描（按当前 Tab 决定走本地 Agent 还是浏览器端）
            setIsPreparing(false);
            setIsScanning(true);
            setStartTime(Date.now());
            setNow(Date.now());

            const agentReady = activeTab === 'local' && agentProbe?.online === true;
            agentModeRef.current = agentReady;
            agentStopRef.current = false;
            setAgentActive(agentReady);

            if (agentReady) {
                const agentTargets = buildAgentTargets(
                    targets,
                    prepared.resolvedMap,
                    ipSource === 'third' ? 0 : selectedPort,
                );
                await runAgentScan(agentTargets, val.threadsNum, val.latencyLimitNum, onProgress, onComplete);
            } else {
                const scanner = new BatchScanner(
                    targets,
                    ipSource === 'third' ? 0 : selectedPort,
                    val.threadsNum,
                    val.latencyLimitNum,
                    onProgress,
                    onComplete,
                    prepared.resolvedMap,
                    retryFailed,
                );
                scannerRef.current = scanner;

                await scanner.run();
            }
        } catch (error) {
            console.error('Scan failed:', error);
            setIsScanning(false);
            setIsPreparing(false);
            setIsPaused(false);
            setStartTime(null);
            showToast('启动测试失败，请检查控制台错误信息', 'error');
        }
    };

    const handleStopScan = () => {
        stopRequestedRef.current = true;
        setIsStopping(true);
        setIsPaused(false);
        setStartTime(null);
        if (agentModeRef.current && agentProbe?.online) {
            // 轮询循环会自行退出并触发 onComplete 收尾
            agentStopRef.current = true;
            void stopAgentScan(agentProbe.baseUrl);
        }
        if (scannerRef.current) {
            scannerRef.current.stop();
        }
    };

    const handlePause = () => {
        if (scannerRef.current) {
            scannerRef.current.pause();
        }
        setPausedAt(Date.now());
        setIsPaused(true);
    };

    const handleResume = () => {
        if (scannerRef.current && pausedAt !== null) {
            // 将暂停时长补偿到 startTime，使已用时连续、预计剩余准确
            setStartTime((prev) => (prev !== null ? prev + (Date.now() - pausedAt) : prev));
        }
        setPausedAt(null);
        if (scannerRef.current) {
            scannerRef.current.resume();
        }
        setIsPaused(false);
    };

    // 接收“IP段”卡片里点击的网段，加入自定义 IP 输入框
    useEffect(() => {
        const handler = (e: Event) => {
            if (isScanning || isPreparing) return;
            const cidrs = (e as CustomEvent<{ cidrs: string[] }>).detail?.cidrs ?? [];
            if (cidrs.length === 0) return;
            const { text, added } = mergeLines(customIps, cidrs);
            setCustomIps(text);
            setIpSource('custom');
            showToast(added > 0 ? `已加入 ${added} 个网段到自定义 IP` : '这些网段已在自定义 IP 里', added > 0 ? 'success' : 'info');
        };
        window.addEventListener('ip-main:add-cidr', handler);
        return () => window.removeEventListener('ip-main:add-cidr', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [customIps, isScanning, isPreparing]);

    const handleSavePreset = () => {
        const name = presetName.trim();
        if (!name) { showToast('请输入预设名称', 'warning'); return; }
        if (!customIps.trim()) { showToast('自定义 IP 输入框是空的，没有内容可保存', 'warning'); return; }
        persistPresets({ ...presets, [name]: { text: customIps, fullCidr, stratified, keepBlocks } });
        setPresetSel(name);
        showToast(`预设“${name}”已保存`, 'success');
    };
    const handleLoadPreset = (append: boolean) => {
        const pr = presets[presetSel];
        if (!pr) { showToast('请先选择一个预设', 'warning'); return; }
        if (append) {
            setCustomIps(mergeLines(customIps, pr.text.split(/[\s,，]+/).map(x => x.trim()).filter(Boolean)).text);
        } else {
            setCustomIps(pr.text);
            setFullCidr(!!pr.fullCidr);
            setStratified(!!pr.stratified);
            setKeepBlocks(pr.keepBlocks || '20');
        }
        showToast(`已${append ? '追加' : '载入'}预设“${presetSel}”`, 'success');
    };
    const handleDeletePreset = () => {
        if (!presets[presetSel]) return;
        const next = { ...presets };
        delete next[presetSel];
        persistPresets(next);
        showToast(`已删除预设“${presetSel}”`, 'success');
        setPresetSel('');
    };

    // 扫描进行中且未暂停时，每 1 秒刷新 now 以更新已用时间
    useEffect(() => {
        if (!isScanning || isPaused) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [isScanning, isPaused]);

    return (
        <div className="bg-white dark:bg-gray-800 shadow-md rounded-lg p-6 mb-8">
            <div className="flex items-center gap-3 mb-4">
                <Gauge className="w-7 h-7 text-purple-500" />
                <h2 className="text-2xl font-semibold text-gray-700 dark:text-gray-200">IP优选测速</h2>
            </div>
            
            <div className="flex items-center mb-4">
                <label className="text-gray-700 dark:text-gray-300 font-semibold mr-3">IP来源:</label>
                <div className="relative flex w-fit items-center rounded-lg bg-gray-100 p-1 dark:bg-gray-700">
                    <button
                        onClick={() => setIpSource('cf')}
                        disabled={isScanning || isPreparing}
                        className={`relative z-10 rounded-md px-4 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${
                            ipSource === 'cf'
                                ? 'bg-white text-gray-800 shadow-sm dark:bg-gray-900 dark:text-white'
                                : 'text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white'
                        }`}
                    >
                        CF官方IP
                    </button >
                    <button
                        onClick={() => setIpSource('cm')}
                        disabled={isScanning || isPreparing}
                        className={`relative z-10 rounded-md px-4 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${
                            ipSource === 'cm'
                                ? 'bg-white text-gray-800 shadow-sm dark:bg-gray-900 dark:text-white'
                                : 'text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white'
                        }`}
                    >
                        CM整理IP
                    </button>
                    <button
                        onClick={() => setIpSource('third')}
                        disabled={isScanning || isPreparing}
                        className={`relative z-10 rounded-md px-4 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${
                            ipSource === 'third'
                                ? 'bg-white text-gray-800 shadow-sm dark:bg-gray-900 dark:text-white'
                                : 'text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white'
                        }`}
                    >
                        第三方IP/域名源
                    </button>
                    <button
                        onClick={() => setIpSource('custom')}
                        disabled={isScanning || isPreparing}
                        className={`relative z-10 rounded-md px-4 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${
                            ipSource === 'custom'
                                ? 'bg-white text-gray-800 shadow-sm dark:bg-gray-900 dark:text-white'
                                : 'text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white'
                        }`}
                    >
                        自定义IP
                    </button>
                </div>
            </div >

            {ipSource === 'custom' && (
                <div className="mb-4">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                        <label htmlFor="custom-ips" className="text-gray-700 dark:text-gray-300 text-sm font-bold">自定义 IP（每行一个，支持 IP、IP:端口、IP段如 104.16.0.0/20）:</label>
                        <button
                            type="button"
                            onClick={() => customFileRef.current?.click()}
                            disabled={isScanning || isPreparing}
                            title="支持 txt / csv：每行一个 IP、IP:端口、域名或 IP 段（CIDR），可带 # 备注；CSV 可带 IP 和端口列（本系统导出的文件可直接导入）"
                            className="px-3 py-1 text-xs font-medium rounded-full bg-blue-100 text-blue-800 hover:bg-blue-200 disabled:opacity-50 dark:bg-blue-900/40 dark:text-blue-300"
                        >
                            <Upload className="w-3.5 h-3.5 mr-1 inline-block" />
                            上传 txt / csv
                        </button>
                        <button
                            type="button"
                            onClick={() => setCustomIps('')}
                            disabled={isScanning || isPreparing || customIps.trim() === ''}
                            className="px-3 py-1 text-xs font-medium rounded-full bg-gray-200 text-gray-700 hover:bg-gray-300 disabled:opacity-50 dark:bg-gray-600 dark:text-gray-200"
                        >
                            清空
                        </button>
                        <span className="text-xs text-gray-400">已填 {customIps.split(/[\s,，]+/).filter(Boolean).length} 个</span>
                        <input ref={customFileRef} type="file" accept=".txt,.csv,text/plain,text/csv" onChange={(e) => void handleCustomFile(e)} className="hidden" />
                    </div>
                    <textarea id="custom-ips" value={customIps} onChange={(e) => setCustomIps(e.target.value)} disabled={isScanning || isPreparing} rows={5} className="w-full border rounded p-3 font-mono text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" placeholder="104.16.1.1\n104.17.2.2:443\n104.16.0.0/20\n172.67.64.0/20" />
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                        <span>预设:</span>
                        <select value={presetSel} onChange={(e) => setPresetSel(e.target.value)} disabled={isScanning || isPreparing} className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-xs">
                            <option value="">选择已保存的预设</option>
                            {Object.keys(presets).map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                        <button type="button" onClick={() => handleLoadPreset(false)} disabled={!presetSel || isScanning || isPreparing} className="px-2 py-1 text-xs rounded-full bg-blue-100 text-blue-700 hover:bg-blue-200 disabled:opacity-50 dark:bg-blue-900/40 dark:text-blue-300">载入</button>
                        <button type="button" onClick={() => handleLoadPreset(true)} disabled={!presetSel || isScanning || isPreparing} className="px-2 py-1 text-xs rounded-full bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-600 dark:text-gray-200">追加</button>
                        <button type="button" onClick={handleDeletePreset} disabled={!presetSel || isScanning || isPreparing} className="px-2 py-1 text-xs rounded-full bg-red-100 text-red-700 hover:bg-red-200 disabled:opacity-50 dark:bg-red-900/40 dark:text-red-300">删除</button>
                        <input type="text" value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="预设名称" disabled={isScanning || isPreparing} className="w-28 border rounded px-2 py-1 text-xs dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                        <button type="button" onClick={handleSavePreset} disabled={isScanning || isPreparing} className="px-2 py-1 text-xs rounded-full bg-emerald-100 text-emerald-700 hover:bg-emerald-200 disabled:opacity-50 dark:bg-emerald-900/40 dark:text-emerald-300">保存当前</button>
                    </div>
                    <label className="mt-2 flex flex-wrap items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                        <input type="checkbox" checked={fullCidr} onChange={(e) => setFullCidr(e.target.checked)} disabled={isScanning || isPreparing} />
                        <span>测试网段内全部 IP（不勾选则按“随机IP数量”抽样）</span>
                        {(() => {
                            const cs = customIps.split(/[\s,，]+/).map(x => x.trim()).filter(isIpv4Cidr);
                            if (!fullCidr || cs.length === 0) return null;
                            const n = cs.reduce((a, c) => a + cidrHostCount(c), 0);
                            return <span className={n > MAX_IMPORT_TARGETS ? 'text-xs text-amber-500' : 'text-xs text-gray-400'}>共 {n} 个{n > MAX_IMPORT_TARGETS ? `，超过上限将随机抽 ${MAX_IMPORT_TARGETS} 个` : ''}</span>;
                        })()}
                    </label>
                    {fullCidr && (
                        <label className="mt-2 flex flex-wrap items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                            <input type="checkbox" checked={stratified} onChange={(e) => setStratified(e.target.checked)} disabled={isScanning || isPreparing} />
                            <span>分层筛选：先每个 /24 抽 3 个粗筛，只精测最优的</span>
                            <input type="number" min={1} max={500} value={keepBlocks} onChange={(e) => setKeepBlocks(e.target.value)} disabled={isScanning || isPreparing || !stratified} className="w-16 border rounded px-2 py-0.5 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                            <span>个 /24</span>
                        </label>
                    )}
                </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                <div>
                    <label htmlFor="ip-count" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-1">随机IP数量:</label>
                    <input
                        id="ip-count"
                        type="text"
                        value={count}
                        onChange={(e) => { setCount(e.target.value); if (countError) setCountError(''); }}
                        className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 dark:text-white dark:bg-gray-700 dark:border-gray-600 leading-tight focus:outline-none focus:shadow-outline disabled:opacity-50"
                        disabled={isScanning || isPreparing || ipSource === 'third' || (ipSource === 'custom' && fullCidr)}
                    />
                    {countError && <p className="text-red-500 text-xs mt-1">{countError}</p>}
                </div>
                <div>
                    <label htmlFor="port-select" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-1">端口:</label>
                    <select id="port-select" value={selectedPort} onChange={(e) => setSelectedPort(Number(e.target.value))} className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 dark:text-white dark:bg-gray-700 dark:border-gray-600 leading-tight focus:outline-none focus:shadow-outline disabled:opacity-50" disabled={isScanning || isPreparing || ipSource === 'third'}>
                        {PORTS_TO_TEST.map(port => (
                            <option key={port} value={port}>{port}</option>
                        ))}
                    </select>
                </div>
                <div>
                    <label htmlFor="threads-count" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-1">线程数:</label>
                    <input
                        id="threads-count"
                        type="text"
                        value={threads}
                        onChange={(e) => { setThreads(e.target.value); if (threadsError) setThreadsError(''); }}
                        className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 dark:text-white dark:bg-gray-700 dark:border-gray-600 leading-tight focus:outline-none focus:shadow-outline disabled:opacity-50"
                        disabled={isScanning || isPreparing}
                    />
                    {threadsError && <p className="text-red-500 text-xs mt-1">{threadsError}</p>}
                </div>
                <div>
                    <label htmlFor="latency-limit" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-1">延迟限制(ms):</label>
                    <input
                        id="latency-limit"
                        type="text"
                        value={latencyOverride ? String(latencyOverride) : latencyLimit}
                        onChange={(e) => { setLatencyLimit(e.target.value); if (latencyLimitError) setLatencyLimitError(''); }}
                        className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 dark:text-white dark:bg-gray-700 dark:border-gray-600 leading-tight focus:outline-none focus:shadow-outline disabled:opacity-50"
                        disabled={isScanning || isPreparing || latencyOverride > 0}
                        title={latencyOverride ? '流水线已启用，延迟上限由流水线配置接管' : undefined}
                    />
                    {latencyOverride > 0 && <p className="text-[11px] text-indigo-500 mt-1">流水线接管中</p>}
                    {latencyLimitError && <p className="text-red-500 text-xs mt-1">{latencyLimitError}</p>}
                </div>

            </div>

            {/* ============ 测速方式：浏览器测速 / 本地测速 ============ */}
            <div className="mb-4">
                <div className="flex w-fit items-center rounded-lg bg-gray-100 p-1 dark:bg-gray-700 mb-3">
                    <button
                        onClick={() => setActiveTab('browser')}
                        disabled={isScanning || isPreparing}
                        className={`relative z-10 rounded-md px-4 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${
                            activeTab === 'browser'
                                ? 'bg-white text-gray-800 shadow-sm dark:bg-gray-900 dark:text-white'
                                : 'text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white'
                        }`}
                    >
                        浏览器测速
                    </button>
                    <button
                        onClick={() => setActiveTab('local')}
                        disabled={isScanning || isPreparing}
                        className={`relative z-10 rounded-md px-4 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${
                            activeTab === 'local'
                                ? 'bg-white text-gray-800 shadow-sm dark:bg-gray-900 dark:text-white'
                                : 'text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white'
                        }`}
                    >
                        本地测速
                    </button>
                </div>

                {activeTab === 'browser' ? (
                    /* ---------- 浏览器测速面板 ---------- */
                    <div className="space-y-3">
                        {browserChecking && (
                            <p className="text-sm text-gray-500 dark:text-gray-400">正在检测浏览器测速是否可用…</p>
                        )}
                        {!browserChecking && browserHealthy === true && (
                            <div className="flex items-start gap-2.5 rounded-lg border border-green-200 dark:border-green-700/50 bg-green-50 dark:bg-green-900/20 px-4 py-3">
                                <CheckCircle2 className="w-4 h-4 text-green-500 flex-none mt-0.5" />
                                <div className="text-sm text-green-800 dark:text-green-300">
                                    <p>当前环境的浏览器测速可用。</p>
                                    <p className="mt-1">可直接点击下方「开始测试（浏览器）」进行测速。</p>
                                </div>
                            </div>
                        )}
                        {!browserChecking && browserHealthy === false && (
                            <div className="flex items-start gap-2.5 rounded-lg border border-orange-200 dark:border-orange-700/50 bg-orange-50 dark:bg-orange-900/20 px-4 py-3">
                                <AlertTriangle className="w-4 h-4 text-orange-500 flex-none mt-0.5" />
                                <div className="text-sm text-orange-800 dark:text-orange-300">
                                    <p>当前环境的浏览器测速不可用（测速地址无法解析或连接失败）。</p>
                                    <p className="mt-1">
                                        建议使用「本地测速」：在本机运行 Agent 后，页面参数会原样下发到本机执行，结果更稳定。
                                        <button
                                            onClick={() => setActiveTab('local')}
                                            className="ml-1 inline-flex items-center gap-1 text-orange-700 dark:text-orange-200 font-medium underline underline-offset-2 hover:opacity-80"
                                        >
                                            切换到本地测速 →
                                        </button>
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>
                ) : (
                    /* ---------- 本地 Agent 测速面板 ---------- */
                    <div className={'rounded-lg border overflow-hidden ' + (agentProbe?.online ? 'border-green-500 dark:border-green-500' : 'border-red-500 dark:border-red-500')}>
                        <div className="flex items-center justify-between gap-3 px-4 py-3 bg-gray-50 dark:bg-gray-900/40">
                            <div className="flex items-center gap-2 min-w-0 flex-wrap">
                                <Cpu className="w-5 h-5 text-teal-500 flex-none" />
                                <span className="font-medium text-gray-700 dark:text-gray-200">本地 Agent 测速</span>
                                {agentProbe === null && (
                                    <span className="px-2 py-0.5 text-xs rounded-full bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300">未检测</span>
                                )}
                                {agentProbe && !agentProbe.online && agentProbe.reason === 'offline' && (
                                    <span className="px-2 py-0.5 text-xs rounded-full bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">未启动</span>
                                )}
                                {agentProbe?.online && (
                                    <span className="px-2 py-0.5 text-xs rounded-full bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">
                                        已连接 {agentProbe.baseUrl}
                                        {agentProbe.status.running && agentProbe.status.task
                                            ? ` · 忙（${agentProbe.status.task.done}/${agentProbe.status.task.total}）`
                                            : ''}
                                    </span>
                                )}
                            </div>

                            <button
                                onClick={() => void checkAgent(Number(agentPort) || DEFAULT_AGENT_PORT)}
                                disabled={agentChecking || isScanning}
                                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-teal-600 text-white hover:bg-teal-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-none"
                            >
                                <RefreshCw className={`w-3 h-3 ${agentChecking ? 'animate-spin' : ''}`} />
                                {agentChecking ? '检测中' : '检测服务'}
                            </button>
                        </div>

                        <div className="px-4 py-3">
                            {/* 本地服务端口设置（保存在浏览器本地） */}
                            <div className="flex items-center gap-2 mb-3">
                                <label htmlFor="agent-port" className="text-xs text-gray-600 dark:text-gray-400 flex-none">本地服务端口</label>
                                <input
                                    id="agent-port"
                                    type="text"
                                    inputMode="numeric"
                                    value={agentPort}
                                    onChange={(e) => {
                                        const v = e.target.value.replace(/[^\d]/g, '').slice(0, 5);
                                        setAgentPort(v);
                                        localStorage.setItem('LOCAL_AGENT_PORT', v);
                                    }}
                                    placeholder={String(DEFAULT_AGENT_PORT)}
                                    className="w-24 px-2.5 py-1.5 text-xs font-mono rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100 focus:ring-2 focus:ring-teal-500 focus:border-transparent outline-none disabled:opacity-50"
                                    disabled={isScanning || agentChecking}
                                />
                                <span className="text-xs text-gray-400 dark:text-gray-500">默认 {DEFAULT_AGENT_PORT}</span>
                            </div>

                            {!agentProbe?.online && (
                                <>
                                    <p className="text-sm text-gray-600 dark:text-gray-300 mb-2">
                                        本机 Agent 未运行，请按以下步骤启动：
                                    </p>
                                    <ol className="list-decimal list-inside space-y-1.5 text-sm text-gray-600 dark:text-gray-400 mb-3">
                                        <li>
                                            下载并解压 <a href="/local-agent.zip" download className="text-teal-600 dark:text-teal-400 hover:underline font-medium">local-agent.zip</a>（需先安装
                                            <a href="https://nodejs.org/" target="_blank" rel="noreferrer" className="text-teal-600 dark:text-teal-400 hover:underline"> Node.js</a>，16 及以上版本）
                                        </li>
                                        <li>
                                            进入解压后的文件夹，执行 <code className="px-1 rounded bg-gray-100 dark:bg-gray-700 text-xs">node agent.js</code>
                                            （Windows 双击 <code className="px-1 rounded bg-gray-100 dark:bg-gray-700 text-xs">start.bat</code>即可启动）
                                        </li>
                                        <li>确认端口与本地 <code className="px-1 rounded bg-gray-100 dark:bg-gray-700 text-xs">config.json</code> 的 listenPort 一致，再点「检测服务」</li>
                                    </ol>
                                </>
                            )}
                        </div>
                    </div>
                )}
            </div>

            <label className="mb-3 flex flex-wrap items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input type="checkbox" checked={retryFailed} onChange={(e) => setRetryFailed(e.target.checked)} disabled={isScanning || isPreparing} />
                <span>失败重试一次（失败或略高于延迟上限时再测一次取更好值，结果更准，但死 IP 多时更慢）</span>
            </label>

            <PipelineSettings disabled={isScanning || isPreparing} />

            <div className="mb-4 flex justify-center" >
                <button onClick={handleScan} disabled={isScanning || isPreparing || (activeTab === 'local' && !agentProbe?.online)} className="flex items-center bg-purple-600 text-white font-bold py-2 px-4 rounded-md hover:bg-purple-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed">
                    {isPreparing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
                    {isPreparing
                        ? (ipSource === 'third' && prepareTotal > 0
                            ? `解析源 ${prepareDone}/${prepareTotal}`
                            : '准备中...')
                            : isScanning
                                ? `测试中... (${progress}/${total})`
                                : (activeTab === 'local'
                                    ? (agentProbe?.online ? '开始测试（本地 Agent）' : '本地 Agent 未连接')
                                    : '开始测试（浏览器）')}
                </button>
                {isPreparing && (
                    <button onClick={() => { cancelPreparingRef.current = true; setIsPreparing(false); }} style={{ marginLeft: "8px" }}
                            className="flex items-center bg-red-600 text-white font-bold py-2 px-4 rounded-md hover:bg-red-700 transition-colors">
                        <StopCircle className="w-4 h-4 mr-2" />
                        取消准备
                    </button>
                )}
                {isScanning && (
                    <button onClick={handleStopScan} style={{ marginLeft: "8px" }} disabled={isStopping}
                            className="flex items-center bg-red-600 text-white font-bold py-2 px-4 rounded-md hover:bg-red-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed">
                        <StopCircle className="w-4 h-4 mr-2" />
                        {isStopping ? '停止中...' : '停止测试'}
                    </button>
                )}
            </div >

            {/* 第三方源逐条解析展示区 */}
            {ipSource === 'third' && sourceRows.length > 0 && (
                <div className="mb-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 border border-gray-100 dark:border-gray-700">
                    <h3 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                        第三方IP/域名获取详情 {isPreparing && `(${prepareDone}/${prepareTotal})`}
                    </h3>

                    {/* 解析完成后的总览信息 */}
                    {!isPreparing && (
                        <div className="mb-3 text-sm text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-800/50 p-2 rounded-md text-center">
                            共发现 <strong className="text-blue-500 font-semibold">{grossIpCount}</strong> 个记录，
                            去重后剩余 <strong className="text-purple-500 font-semibold">{uniqueIpCount}</strong> 个，
                            其中 IP <strong className="text-green-500 font-semibold">{ipCount}</strong> 个、
                            域名 <strong className="text-orange-500 font-semibold">{domainCount}</strong> 个。
                        </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {sourceRows.map((row, idx) => (
                            <div key={idx} className="flex items-center justify-between bg-white dark:bg-gray-800 p-2 rounded border border-gray-100 dark:border-gray-600 shadow-sm text-xs transition-colors hover:border-purple-200 dark:hover:border-purple-800">
                                <div className="truncate flex-1 mr-2 text-gray-600 dark:text-gray-300 font-mono" title={row.url}>
                                    {row.url.replace(/^https?:\/\//, '')}
                                </div>
                                <span className="flex items-center gap-1 shrink-0">
                                    {row.status === 'pending' && (
                                        <span className="px-2 py-0.5 rounded-full font-bold shadow-sm bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                                            等待中
                                        </span>
                                    )}
                                    {row.status === 'loading' && (
                                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full font-bold shadow-sm bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                                            <Loader2 className="w-3 h-3 animate-spin" />
                                            解析中
                                        </span>
                                    )}
                                    {row.status === 'done' && (
                                        <>
                                            {row.ipCount! > 0 && (
                                                <span className="px-2 py-0.5 rounded-full font-bold shadow-sm bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" title="IP 个数">
                                                    IP {row.ipCount}
                                                </span>
                                            )}
                                            {row.domainCount! > 0 && (
                                                <span className="px-2 py-0.5 rounded-full font-bold shadow-sm bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400" title="域名个数">
                                                    域名 {row.domainCount}
                                                </span>
                                            )}
                                            {row.ipCount === 0 && row.domainCount === 0 && (
                                                <span className="px-2 py-0.5 rounded-full font-bold shadow-sm bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400" title="该源未返回有效条目">
                                                    未解析出
                                                </span>
                                            )}
                                        </>
                                    )}
                                    {row.status === 'error' && (
                                        <span className="px-2 py-0.5 rounded-full font-bold shadow-sm bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" title={row.error || '请求失败'}>
                                            失败
                                        </span>
                                    )}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {isScanning && (() => {
                const endRef = isPaused && pausedAt !== null ? pausedAt : now;
                const elapsedSec = startTime ? Math.floor((endRef - startTime) / 1000) : 0;
                const percent = total > 0 ? Math.round((progress / total) * 100) : 0;
                const fmt = (s: number) => {
                    const m = Math.floor(s / 60);
                    const sec = s % 60;
                    return `${m}:${sec.toString().padStart(2, '0')}`;
                };
                return (
                    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 w-[calc(100%-2rem)] max-w-xl px-5 py-3 rounded-xl bg-white/95 dark:bg-gray-800/95 backdrop-blur border border-gray-200 dark:border-gray-700 shadow-[0_-4px_16px_rgba(0,0,0,0.12)]">
                        <div className="flex justify-between items-center mb-1">
                            <span className="text-base font-medium text-purple-700 dark:text-white">
                                进度 {percent}%
                            </span>
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-purple-700 dark:text-white mr-1">
                                    任务: {progress} / {total}
                                </span>
                                {isPaused ? (
                                    <button
                                        type="button"
                                        onClick={handleResume}
                                        aria-label="继续测试"
                                        title="继续测试"
                                        className="p-1.5 rounded-full text-green-600 bg-green-100 hover:bg-green-200 dark:bg-green-900/50 dark:text-green-300 dark:hover:bg-green-800/50 transition-colors"
                                    >
                                        <Play className="w-4 h-4" />
                                    </button>
                                ) : agentActive ? (
                                    // 本地 Agent 暂不支持暂停，用不可点状态替代，避免点击无反应
                                    <span
                                        aria-label="本地 Agent 模式不支持暂停"
                                        title="本地 Agent 模式暂不支持暂停，可使用「停止测试」"
                                        className="p-1.5 rounded-full text-gray-300 bg-gray-100 dark:bg-gray-700 dark:text-gray-500 cursor-not-allowed"
                                    >
                                        <Pause className="w-4 h-4" />
                                    </span>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={handlePause}
                                        aria-label="暂停测试"
                                        title="暂停测试"
                                        className="p-1.5 rounded-full text-yellow-600 bg-yellow-100 hover:bg-yellow-200 dark:bg-yellow-900/50 dark:text-yellow-300 dark:hover:bg-yellow-800/50 transition-colors"
                                    >
                                        <Pause className="w-4 h-4" />
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={handleStopScan}
                                    disabled={isStopping}
                                    aria-label="停止测试"
                                    title="停止测试"
                                    className="p-1.5 rounded-full text-red-600 bg-red-100 hover:bg-red-200 dark:bg-red-900/50 dark:text-red-300 dark:hover:bg-red-800/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <Square className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                        <div className="w-full flex h-2.5 rounded-full overflow-hidden bg-gray-200 dark:bg-gray-700">
                            <div className="bg-green-500 h-2.5 transition-all duration-300" style={{ width: `${total > 0 ? (successCount / total) * 100 : 0}%` }}></div>
                            <div className="bg-red-500 h-2.5 transition-all duration-300" style={{ width: `${total > 0 ? (failCount / total) * 100 : 0}%` }}></div>
                        </div>
                        <div className="flex justify-between text-sm mt-1">
                            <span className="text-green-600">成功: {successCount}</span>
                            <span className="text-gray-500 dark:text-gray-400">已用: {fmt(elapsedSec)}</span>
                            <span className="text-red-600">失败: {failCount}</span>
                        </div>
                        <div className="flex justify-between text-xs mt-1 text-gray-500 dark:text-gray-400">
                            <span>{stage.text}</span>
                            <span>{(() => {
                                if (progress < 5 || elapsedSec < 3 || progress >= total) return '预计剩余: 计算中…';
                                const remain = Math.ceil((total - progress) / (progress / elapsedSec));
                                return `${stage.no === 1 ? '粗筛剩余' : '预计剩余'}: ${fmt(remain)}`;
                            })()}</span>
                        </div>
                    </div>
                );
            })()}
        </div >
    );
}