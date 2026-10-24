/**
 * 扫描结果的数据结构
 */
export interface ScanResult {
    ip: string;
    port: number;
    isAvailable: boolean;
    latency: number;
    colo?: string; // Cloudflare 数据中心代码
    domain?: boolean; // 是否为域名源（保存域名而非解析出的IP）

    // 以下为本地 Agent 测速的扩展字段，浏览器端测速不会产生这些值。
    // 全部可选，保证与原有「保存为场景 / 导出 / 筛选」等逻辑完全兼容。
    tcpMs?: number;        // TCP 三次握手耗时
    tlsMs?: number;        // 累计到 TLS 握手完成的耗时
    error?: string;        // 不可用时的原因
    downloadMbps?: number; // 本地 Agent 下载测速结果（Mbps）
    downloadBytes?: number;
    downloadError?: string;
    testedAt?: number;     // 该条记录最近一次测试/保存的时间戳（毫秒），供订阅接口按新鲜度过滤
}

/**
 * 判断一个 host 是否为域名（非 IPv4 / IPv6）
 */
export function isDomainName(host: string): boolean {
    // IPv6（含方括号或包含多个冒号）一律视为IP
    if (host.includes(':')) return false;
    // IPv4 地址
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return false;
    // 形如 example.com
    return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(host);
}

/**
 * 通过阿里云公共 DNS (DoH) 将域名解析为 IP（优先 A 记录，其次 AAAA）
 * 使用 dns.alidns.com，在大陆网络环境下可正常访问
 */
export async function resolveDomainToIp(host: string): Promise<string | null> {
    const query = (type: 'A' | 'AAAA') =>
        fetch(`https://dns.alidns.com/resolve?name=${encodeURIComponent(host)}&type=${type}`);

    try {
        const resA = await query('A');
        if (resA.ok) {
            const json = await resA.json() as { Status?: number; Answer?: { type: number; data: string }[] };
            if (json.Status === 0) {
                const a = json.Answer?.find(r => r.type === 1);
                if (a) return a.data;
            }
        }
        const resAAAA = await query('AAAA');
        if (resAAAA.ok) {
            const json = await resAAAA.json() as { Status?: number; Answer?: { type: number; data: string }[] };
            if (json.Status === 0) {
                const aaaa = json.Answer?.find(r => r.type === 28);
                if (aaaa) return aaaa.data;
            }
        }
    } catch {
        // 解析失败
    }
    return null;
}

// =================================================================
// 1. 地区分组逻辑 (源于参考代码)
// =================================================================

export { coloMap, getColoName } from './colo';

// =================================================================
// 2. IP 测速逻辑 (源于参考代码)
// =================================================================

/**
 * 将 IPv4 地址转换为十六进制，用于 nip.cmliussss.hidns.vip 技巧
 */
function ipToHex(ip: string): string | null {
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    if (!ipv4Regex.test(ip)) {
        return null;
    }
    return ip.split('.').map(part => parseInt(part, 10).toString(16).padStart(2, '0')).join('');
}

/**
 * 判断是否为 IPv6 地址
 */
function isIPv6(ip: string): boolean {
    return ip.includes(':');
}

// 浏览器端测速可用性自检使用的备用 Cloudflare IPv4 地址。
const PROBE_FALLBACK_IPS = ['104.16.0.1', '172.67.0.1', '162.159.0.1', '162.158.0.1', '188.114.96.1', '108.162.192.1'];

// 浏览器下载测速候选域名：优先使用 kgcfip 原域名，失败后回退到备用泛解析域名。
const TEST_DOMAIN_CANDIDATES = [
    'ns.psb.kdns.fr',
    'bestcf.cmliussss.hidns.vip',
] as const;
const TEST_DOMAIN_CACHE_KEY = 'kgcfip_test_domain_v1';
let memoryTestDomain: string | null = null;

function getCachedTestDomain(): string | null {
    if (memoryTestDomain && TEST_DOMAIN_CANDIDATES.includes(memoryTestDomain as any)) {
        return memoryTestDomain;
    }
    try {
        const cached = window.localStorage.getItem(TEST_DOMAIN_CACHE_KEY);
        if (cached && TEST_DOMAIN_CANDIDATES.includes(cached as any)) {
            memoryTestDomain = cached;
            return cached;
        }
    } catch {
        // 隐私模式或浏览器禁用 localStorage 时使用内存缓存。
    }
    return null;
}

function cacheTestDomain(domain: string): void {
    memoryTestDomain = domain;
    try {
        window.localStorage.setItem(TEST_DOMAIN_CACHE_KEY, domain);
    } catch {
        // 内存缓存仍然有效。
    }
}

function clearCachedTestDomain(domain?: string): void {
    if (!domain || memoryTestDomain === domain) memoryTestDomain = null;
    try {
        if (!domain || window.localStorage.getItem(TEST_DOMAIN_CACHE_KEY) === domain) {
            window.localStorage.removeItem(TEST_DOMAIN_CACHE_KEY);
        }
    } catch {
        // 忽略缓存清理错误。
    }
}

// 体检后确定的可用测试域名（按优劣排序）；为空表示未体检或都不可用，此时使用全部候选
let activeTestDomains: string[] | null = null;
let domainCheckAt = 0;
let lastDomainCheck: DomainCheckResult | null = null;

export interface DomainCheckResult { usable: string[]; unusable: string[]; }

/** 当前应使用的测试域名：优先体检结果，其次上次成功的域名，最后是全部候选 */
function currentTestDomains(): string[] {
    return activeTestDomains && activeTestDomains.length > 0 ? activeTestDomains : orderedTestDomains();
}

/**
 * 测试域名体检：用几个已知可用的 Cloudflare IP 分别探测每个测试域名，
 * 只保留能连通的域名（连得最快的排第一）。之后每个 IP 只走可用域名，
 * 死 IP 不会再多试一个不可用的域名，白白多等一次超时。结果缓存 5 分钟。
 */
export async function ensureTestDomainsChecked(force = false): Promise<DomainCheckResult> {
    if (!force && lastDomainCheck && Date.now() - domainCheckAt < 5 * 60 * 1000) return lastDomainCheck;
    const samples = PROBE_FALLBACK_IPS.slice(0, 3);
    const stats = await Promise.all(TEST_DOMAIN_CANDIDATES.map(async (domain) => {
        let ok = 0;
        let best = Infinity;
        await Promise.all(samples.map(async (sampleIp) => {
            const hex = ipToHex(sampleIp);
            if (!hex) return;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 4000);
            const startedAt = performance.now();
            try {
                const response = await fetch(`https://${hex}.${domain}:443/ip.json?_t=${Date.now()}`, { signal: controller.signal, cache: 'no-store' });
                if (response.ok) {
                    ok++;
                    best = Math.min(best, performance.now() - startedAt);
                }
            } catch { /* 该域名对这个 IP 不通 */ } finally {
                clearTimeout(timer);
            }
        }));
        return { domain, ok, best };
    }));
    const usableStats = stats.filter(s => s.ok > 0).sort((a, b) => b.ok - a.ok || a.best - b.best);
    const usable = usableStats.map(s => s.domain);
    const unusable = stats.filter(s => s.ok === 0).map(s => s.domain);
    // 全部不通多半是网络/VPN 问题，不收窄域名，仍用全部候选，避免误伤
    activeTestDomains = usable.length > 0 ? usable : null;
    if (usable.length > 0) cacheTestDomain(usable[0]);
    domainCheckAt = Date.now();
    lastDomainCheck = { usable, unusable };
    return lastDomainCheck;
}

function orderedTestDomains(): string[] {
    const cached = getCachedTestDomain();
    return cached
        ? [cached, ...TEST_DOMAIN_CANDIDATES.filter(domain => domain !== cached)]
        : [...TEST_DOMAIN_CANDIDATES];
}

/**
 * 测试单个 IP 的延迟并获取其 Cloudflare colo
 *
 * 浏览器无法直接为任意 IP 设置自定义 TLS SNI，故采用「hex 域名技巧」：
 * 将 IPv4 编码进子域名 <hexIp>.ns.psb.kdns.fr，由 Cloudflare 边缘按
 * ip.json 端点返回 colo；IPv6 则直接连地址并指定 Host 头。
 * 该路径依赖浏览器对测速域名的 DNS 解析，解析不通即自然返回失败，
 * 从而引导用户改用更可靠的「本地 Agent 测速」。
 */
export async function testIpLatency(ip: string, port: number, timeout: number): Promise<Omit<ScanResult, 'isAvailable' | 'ip' | 'port'>> {
    const hexIp = ipToHex(ip);
    const candidates: Array<{ host: string | null; domain: string | null }> = isIPv6(ip)
        ? [{ host: null, domain: null }]
        : currentTestDomains().map(domain => ({ host: hexIp ? `${hexIp}.${domain}` : `${ip}.${domain}`, domain }));
    let lastError = 'Error';

    for (const cand of candidates) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        const headers: Record<string, string> = { 'User-Agent': 'Cloudflare-IP-Scanner/1.0' };
        let testUrl: string;
        if (isIPv6(ip)) {
            // 浏览器不能可靠地自定义 Host/SNI；保留旧路径，失败时返回明确错误。
            headers['Host'] = 'ns.psb.kdns.fr';
            testUrl = `https://[${ip}]:${port}/ip.json?_t=${Date.now()}`;
        } else {
            testUrl = `https://${cand.host}:${port}/ip.json?_t=${Date.now()}`;
        }

        try {
            const response1 = await fetch(testUrl, { signal: controller.signal, headers, cache: 'no-store' });
            if (!response1.ok) {
                lastError = `HTTP ${response1.status}`;
                continue;
            }
            let colo = '-';
            try {
                const data = await response1.json() as { colo?: string };
                if (data?.colo) colo = data.colo;
            } catch { /* 某些候选域名可能返回非 JSON */ }

            const secondRequestStart = performance.now();
            const second = await fetch(testUrl, { signal: controller.signal, headers, cache: 'no-store' });
            if (!second.ok) {
                lastError = `HTTP ${second.status}`;
                continue;
            }
            await second.arrayBuffer().catch(() => undefined);
            if (cand.domain && cand.domain !== memoryTestDomain) cacheTestDomain(cand.domain);
            return { latency: Math.max(1, Math.round(performance.now() - secondRequestStart)), colo };
        } catch (error: any) {
            lastError = error?.name === 'AbortError' ? '超时' : '错误';
        } finally {
            clearTimeout(timeoutId);
        }
    }
    return { latency: -1, colo: lastError };
}

export interface BrowserDownloadOptions {
    enabled: boolean;
    url: string;
    seconds: number;
}

/**
 * 浏览器下载测速：用 IPv4 十六进制子域名和候选测速域名发起下载请求。
 * 需要候选域名允许跨域读取响应体（CORS）；若浏览器拦截，则自动尝试下一个域名。
 * 该测试仅对 IPv4 进行，浏览器无法可靠指定任意 IPv6 的 TLS SNI/Host。
 */

export async function testBrowserDownloadSpeed(
    ip: string,
    port: number,
    options: { bytes?: number; timeoutMs?: number; urlTemplate?: string; signal?: AbortSignal; mode?: 'size' | 'time'; durationMs?: number; skipMs?: number } = {}
): Promise<{ downloadMbps: number; downloadBytes: number; downloadMs: number; error?: string; aborted?: boolean; partial?: boolean }> {
    // 外部（用户点击“中断”）触发的取消：立即返回，不当作测速失败记录。
    const abortedResult = { downloadMbps: 0, downloadBytes: 0, downloadMs: 0, error: '已中断', aborted: true };
    if (options.signal?.aborted) return abortedResult;

    if (isIPv6(ip) || isDomainName(ip)) {
        return { downloadMbps: 0, downloadBytes: 0, downloadMs: 0, error: '浏览器测速目前仅支持 IPv4 IP' };
    }

    const hexIp = ipToHex(ip);
    if (!hexIp) {
        return { downloadMbps: 0, downloadBytes: 0, downloadMs: 0, error: 'IPv4 地址格式无效' };
    }

    const httpsPorts = new Set([443, 2053, 2083, 2087, 2096, 8443]);
    if (!httpsPorts.has(port)) {
        return {
            downloadMbps: 0,
            downloadBytes: 0,
            downloadMs: 0,
            error: `浏览器测速不支持 HTTPS 端口 ${port}，请使用支持 HTTPS 的端口`,
        };
    }

    // 限时模式：固定测 durationMs，请求最大文件，到时间就停；忽略开头 skipMs（TCP 慢启动）后按稳定阶段算速度
    const timeMode = options.mode === 'time';
    const durationMs = Math.max(2000, Math.min(20000, options.durationMs ?? 6000));
    const skipMs = Math.min(options.skipMs ?? 500, durationMs / 2);
    const bytes = timeMode ? 100 * 1024 * 1024 : Math.max(1024 * 1024, Math.min(options.bytes ?? 25 * 1024 * 1024, 100 * 1024 * 1024));
    const timeoutMs = Math.max(timeMode ? durationMs + 10000 : 5000, options.timeoutMs ?? 30000);
    const templates = options.urlTemplate
        ? [options.urlTemplate]
        : orderedTestDomains().map(domain => `https://{hexip}.${domain}:{port}/__down?bytes={bytes}`);

    let lastError = '没有可用的下载测速地址';

    for (const template of templates) {
        let url: URL;
        try {
            const rendered = template
                .replace(/\{hexip\}/g, hexIp)
                .replace(/\{ip\}/g, ip)
                .replace(/\{port\}/g, String(port))
                .replace(/\{bytes\}/g, String(bytes));
            url = new URL(rendered);
            if (url.protocol !== 'https:') {
                return { downloadMbps: 0, downloadBytes: 0, downloadMs: 0, error: '下载测速地址必须使用 HTTPS' };
            }
            // 避免误把普通固定测速站当成指定 IP 的测速结果。
            if (!url.hostname.toLowerCase().includes(hexIp.toLowerCase())) {
                return {
                    downloadMbps: 0,
                    downloadBytes: 0,
                    downloadMs: 0,
                    error: '测速地址必须在主机名中包含 {hexip}，否则测到的不是所选 IP',
                };
            }
            if (!template.includes('{bytes}') && !url.searchParams.has('bytes')) {
                url.searchParams.set('bytes', String(bytes));
            }
            url.searchParams.set('_t', `${Date.now()}_${Math.random().toString(36).slice(2)}`);
        } catch {
            return { downloadMbps: 0, downloadBytes: 0, downloadMs: 0, error: '下载测速地址格式无效' };
        }

        if (options.signal?.aborted) return abortedResult;
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), timeoutMs);
        // 外部中断信号 -> 立即中止 fetch 与正在读取的响应流
        const onExternalAbort = () => controller.abort();
        options.signal?.addEventListener('abort', onExternalAbort, { once: true });
        const startedAt = performance.now();
        let receivedBytes = 0;
        let firstChunkAt = 0;
        let bytesAfterFirst = 0;
        let skipMarked = false;
        let bytesAtSkip = 0;
        let tSkip = 0;
        try {
            // 必须使用可读取响应体的 CORS 请求并统计实际字节；opaque/no-cors 只能测到响应头时间，
            // 不能据此推算下载速度。若测速域不允许 CORS，则明确报错并尝试下一个候选地址。
            const response = await fetch(url.toString(), {
                method: 'GET',
                mode: 'cors',
                cache: 'no-store',
                credentials: 'omit',
                signal: controller.signal,
            });
            if (!response.ok) {
                lastError = `测速地址返回 HTTP ${response.status}`;
                clearCachedTestDomain(url.hostname.split('.').slice(1).join('.'));
                continue;
            }

            if (response.body) {
                const reader = response.body.getReader();
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        if (value) {
                            receivedBytes += value.byteLength;
                            if (!firstChunkAt) firstChunkAt = performance.now();
                            else bytesAfterFirst += value.byteLength;
                            if (timeMode && firstChunkAt) {
                                const t = performance.now();
                                if (!skipMarked && t - firstChunkAt >= skipMs) { skipMarked = true; bytesAtSkip = receivedBytes; tSkip = t; }
                                if (t - firstChunkAt >= durationMs) { await reader.cancel().catch(() => undefined); break; }
                            }
                            // 自定义地址即使忽略 bytes 参数，也限制本次最多接收约定的测速样本量。
                            if (receivedBytes >= bytes) {
                                await reader.cancel().catch(() => undefined);
                                break;
                            }
                        }
                    }
                } finally {
                    reader.releaseLock();
                }
            } else {
                receivedBytes = (await response.arrayBuffer()).byteLength;
            }

            const nowMs = performance.now();
            const elapsedMs = Math.max(1, nowMs - startedAt);
            // 从收到第一块数据开始计时，排除 DNS/TCP/TLS 握手和首字节等待，更接近真实下载带宽
            const dataMs = firstChunkAt && bytesAfterFirst > 0 ? Math.max(1, nowMs - firstChunkAt) : 0;
            if (receivedBytes <= 0) {
                lastError = '测速端点未返回可读取的数据；请换一个支持 CORS 的测速地址';
                continue;
            }
            // 限时模式且稳定阶段至少有 0.5 秒：只用稳定阶段算速度
            const windowMs = timeMode && skipMarked ? nowMs - tSkip : 0;
            const mbps = windowMs >= 500
                ? ((receivedBytes - bytesAtSkip) * 8) / (windowMs / 1000) / 1_000_000
                : dataMs > 0
                    ? (bytesAfterFirst * 8) / (dataMs / 1000) / 1_000_000
                    : (receivedBytes * 8) / (elapsedMs / 1000) / 1_000_000;
            const hostDomain = TEST_DOMAIN_CANDIDATES.find(domain => url.hostname.endsWith(`.${domain}`));
            if (hostDomain) cacheTestDomain(hostDomain);
            return {
                downloadMbps: Number(mbps.toFixed(2)),
                downloadBytes: receivedBytes,
                downloadMs: Math.round(windowMs >= 500 ? windowMs : dataMs > 0 ? dataMs : elapsedMs),
            };
        } catch (error: any) {
            if (options.signal?.aborted) return abortedResult;
            // 超时但已经收到足够数据：用已下载部分计算速度，而不是把慢速 IP 记成失败
            if (error?.name === 'AbortError' && firstChunkAt && bytesAfterFirst >= 256 * 1024) {
                const partialMs = Math.max(1, performance.now() - firstChunkAt);
                if (partialMs >= 1000) {
                    const hostDomain = TEST_DOMAIN_CANDIDATES.find(domain => url.hostname.endsWith(`.${domain}`));
                    if (hostDomain) cacheTestDomain(hostDomain);
                    return {
                        downloadMbps: Number(((bytesAfterFirst * 8) / (partialMs / 1000) / 1_000_000).toFixed(2)),
                        downloadBytes: receivedBytes,
                        downloadMs: Math.round(partialMs),
                        partial: true,
                    };
                }
            }
            lastError = error?.name === 'AbortError'
                ? `下载测速超时（>${Math.round(timeoutMs / 1000)} 秒）`
                : '测速地址连接失败或未开放 CORS；请切换测速地址';
            const hostDomain = TEST_DOMAIN_CANDIDATES.find(domain => url.hostname.endsWith(`.${domain}`));
            if (hostDomain) clearCachedTestDomain(hostDomain);
        } finally {
            options.signal?.removeEventListener('abort', onExternalAbort);
            window.clearTimeout(timer);
        }
    }

    return { downloadMbps: 0, downloadBytes: 0, downloadMs: 0, error: lastError };
}

export async function testBrowserPacketLoss(
    ip: string,
    port: number,
    options: { attempts?: number; timeoutMs?: number; urlTemplate?: string; signal?: AbortSignal; countSpikes?: boolean } = {},
): Promise<{ packetLoss: number; sent: number; received: number; error?: string; aborted?: boolean; spikes?: number; jitterMs?: number }> {
    if (isIPv6(ip) || isDomainName(ip)) {
        return { packetLoss: 100, sent: 0, received: 0, error: '浏览器丢包测试目前仅支持 IPv4 IP' };
    }
    const hexIp = ipToHex(ip);
    if (!hexIp) return { packetLoss: 100, sent: 0, received: 0, error: 'IPv4 地址格式无效' };
    const httpsPorts = new Set([443, 2053, 2083, 2087, 2096, 8443]);
    if (!httpsPorts.has(port)) {
        return { packetLoss: 100, sent: 0, received: 0, error: `端口 ${port} 不属于支持的 HTTPS 端口` };
    }

    const attempts = Math.max(5, Math.min(20, Math.floor(options.attempts ?? 10)));
    const timeoutMs = Math.max(1500, Math.min(8000, options.timeoutMs ?? 3000));
    const template = (options.urlTemplate || `https://{hexip}.${currentTestDomains()[0]}:{port}/ip.json`).trim();
    const urlBase = template.replace(/\{ip\}/g, ip).replace(/\{hexip\}/g, hexIp).replace(/\{port\}/g, String(port));
    let parsedUrl: URL;
    try { parsedUrl = new URL(urlBase); } catch {
        return { packetLoss: 100, sent: 0, received: 0, error: '丢包测试地址不是有效的 HTTPS URL' };
    }
    if (parsedUrl.protocol !== 'https:') {
        return { packetLoss: 100, sent: 0, received: 0, error: '丢包测试地址必须使用 HTTPS' };
    }
    // 被用户中断时返回 aborted，调用方据此丢弃这次不完整的结果
    const abortedResult = (sent: number, got: number) => ({ packetLoss: 100, sent, received: got, error: '已中断', aborted: true });

    // 单次探测：成功返回耗时(ms)，失败/超时返回 null
    const probeOnce = async (tag: string, timeout: number): Promise<number | null> => {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), timeout);
        const onExternalAbort = () => controller.abort();
        options.signal?.addEventListener('abort', onExternalAbort, { once: true });
        const startedAt = performance.now();
        try {
            const response = await fetch(`${urlBase}?packet_probe=${Date.now()}_${tag}_${Math.random().toString(36).slice(2)}`, {
                method: 'GET', mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: controller.signal,
            });
            // no-cors 下响应为 opaque，fetch 成功即说明 HTTPS 往返完成
            return response.type === 'opaque' || response.ok ? performance.now() - startedAt : null;
        } catch {
            return null; // DNS、TLS、连接失败或超时
        } finally {
            options.signal?.removeEventListener('abort', onExternalAbort);
            window.clearTimeout(timer);
        }
    };

    // 预热：先发一次请求建立连接，不计入统计，避免握手耗时把第一次探测误判成丢包
    await probeOnce('warm', Math.max(timeoutMs, 5000));
    if (options.signal?.aborted) return abortedResult(0, 0);

    // 正式探测：间隔发送，复用已建立的连接。浏览器看不到 TCP 层丢包，丢包会表现为请求失败，
    // 或被 TCP 重传拖慢成明显的延迟尖峰，所以两种情况都计为“丢包”。
    const rtts: number[] = [];
    let failed = 0;
    for (let i = 0; i < attempts; i++) {
        if (options.signal?.aborted) return abortedResult(i, rtts.length);
        const rtt = await probeOnce(String(i), timeoutMs);
        if (rtt === null) failed++; else rtts.push(rtt);
        if (i < attempts - 1) await new Promise<void>(resolve => window.setTimeout(resolve, 100));
    }
    if (options.signal?.aborted) return abortedResult(attempts, rtts.length);

    let spikes = 0;
    let jitterMs = 0;
    if (rtts.length >= 3) {
        const sorted = [...rtts].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        // 比中位数高出 max(150ms, 1.5 倍中位数) 以上，视为被重传拖慢（略高于 TCP 最小重传超时）
        const spikeGap = Math.max(150, median * 1.5);
        spikes = rtts.filter(r => r - median > spikeGap).length;
        let diff = 0;
        for (let i = 1; i < rtts.length; i++) diff += Math.abs(rtts[i] - rtts[i - 1]);
        jitterMs = Math.round(diff / (rtts.length - 1));
    }
    // countSpikes=false（默认宽松）：只把请求失败/超时算丢包；true（严格）：延迟尖峰也算
    const received = Math.max(0, rtts.length - (options.countSpikes === false ? 0 : spikes));
    return {
        packetLoss: Number((((attempts - received) / attempts) * 100).toFixed(1)),
        sent: attempts,
        received,
        spikes,
        jitterMs,
    };
}

export async function probeBrowserAvailable(sampleIps?: string[], attempts = 10): Promise<boolean> {
    const tasks = Array.from({ length: attempts }, async (_, i) => {
        const ip = sampleIps?.[i] ?? PROBE_FALLBACK_IPS[Math.floor(Math.random() * PROBE_FALLBACK_IPS.length)];
        const probeHex = ipToHex(ip);
        if (!probeHex) return false;
        const resolved = await resolveDomainToIp(`${probeHex}.ns.psb.kdns.fr`);
        return !!resolved;
    });
    const results = await Promise.all(tasks);
    return results.some(Boolean);
}

// =================================================================
// 3. 批量扫描器和 IP 生成器
// =================================================================

export class BatchScanner {
    private ips: string[];
    private port: number;
    private threads: number;
    private latencyLimit: number;
    // 单次探测的超时：要覆盖首次连接（DNS + TCP + TLS）和之后计时的第二次请求，不能直接用延迟上限，否则低延迟上限会误判大量 IP 失败
    private connectTimeout: number;
    private retryFailed: boolean;
    private borderRecheck: boolean;
    private onProgress: (result: ScanResult) => void;
    private onComplete: (results: ScanResult[]) => void;
    private abortController: AbortController;
    // 解析出的测速IP映射：key 为 "host:port"，value 为实际用于测速的IP（域名解析后）
    private resolvedMap?: Record<string, string | null>;
    private paused = false;
    private resumeResolvers: Array<() => void> = [];

    constructor(
        ips: string[],
        port: number,
        threads: number,
        latencyLimit: number,
        onProgress: (result: ScanResult) => void,
        onComplete: (results: ScanResult[]) => void,
        resolvedMap?: Record<string, string | null>,
        retryFailed = false,
        borderRecheck = false
    ) {
        this.retryFailed = retryFailed;
        this.borderRecheck = borderRecheck;
        this.ips = ips;
        this.port = port;
        this.threads = Math.min(ips.length, threads);
        this.latencyLimit = latencyLimit;
        this.connectTimeout = Math.min(8000, Math.max(1500, latencyLimit * 2));
        this.onProgress = onProgress;
        this.onComplete = onComplete;
        this.abortController = new AbortController();
        this.resolvedMap = resolvedMap;
    }

    public stop() {
        this.abortController.abort();
    }

    public pause() {
        this.paused = true;
    }

    public resume() {
        this.paused = false;
        const resolvers = this.resumeResolvers;
        this.resumeResolvers = [];
        resolvers.forEach((r) => r());
    }

    /**
     * 解析 "host:port" / "[IPv6]:port" / "host" 字符串
     */
    private parseTarget(rawTarget: string): { host: string; port: number } {
        // 未加方括号的 IPv6 含多个冒号，整体当作主机，不能把最后一段误当成端口
        if ((rawTarget.match(/:/g) || []).length > 1 && !rawTarget.includes('[')) {
            return { host: rawTarget, port: this.port === 0 ? 443 : this.port };
        }
        let host = rawTarget;
        let port = this.port;

        const lastColonIndex = rawTarget.lastIndexOf(':');
        const closeBracketIndex = rawTarget.lastIndexOf(']');

        if (lastColonIndex > -1 && lastColonIndex > closeBracketIndex) {
            const portPart = rawTarget.substring(lastColonIndex + 1);
            const parsedPort = parseInt(portPart, 10);
            if (!isNaN(parsedPort)) {
                port = parsedPort;
                host = rawTarget.substring(0, lastColonIndex);
                if (host.startsWith('[') && host.endsWith(']')) {
                    host = host.substring(1, host.length - 1);
                }
            }
        }

        if (port === 0) port = 443;
        return { host, port };
    }

    public async run() {
        const queue = [...this.ips];
        const finalResults: ScanResult[] = [];

        const worker = async () => {
            while (queue.length > 0) {
                if (this.abortController.signal.aborted) break;
                if (this.paused) {
                    await new Promise<void>((resolve) => { this.resumeResolvers.push(resolve); });
                    if (this.abortController.signal.aborted) break;
                    continue;
                }

                const rawTarget = queue.shift();
                if (!rawTarget) continue;

                const { host, port } = this.parseTarget(rawTarget);

                // 域名源：先用阿里云 DoH 解析出 IP 再用 IP 测速，保存时仍保存域名
                let testHost = host;
                let isDomain = false;
                if (isDomainName(host)) {
                    isDomain = true;
                    const resolved = this.resolvedMap ? (this.resolvedMap[rawTarget] ?? null) : await resolveDomainToIp(host);
                    if (!resolved) {
                        const fail: ScanResult = {
                            ip: host,
                            port,
                            isAvailable: false,
                            latency: -1,
                            colo: 'ResolveFail',
                            domain: true,
                        };
                        finalResults.push(fail);
                        this.onProgress(fail);
                        continue;
                    }
                    testHost = resolved;
                }

                let probe = await testIpLatency(testHost, port, this.connectTimeout);
                // 失败或略高于上限时重试一次，取更好的结果，减少偶发超时/抖动造成的误判
                if (this.retryFailed && !this.abortController.signal.aborted
                    && (probe.latency <= 0 || (probe.latency > this.latencyLimit && probe.latency <= this.latencyLimit * 1.5))) {
                    const again = await testIpLatency(testHost, port, this.connectTimeout);
                    if (again.latency > 0 && (probe.latency <= 0 || again.latency < probe.latency)) probe = again;
                }
                // 临界值再确认：延迟落在上限 ±10% 内时，再测两次取中位数，避免单次抖动决定去留
                if (this.borderRecheck && !this.abortController.signal.aborted && probe.latency > 0
                    && probe.latency >= this.latencyLimit * 0.9 && probe.latency <= this.latencyLimit * 1.1) {
                    const samples = [probe.latency];
                    for (let k = 0; k < 2 && !this.abortController.signal.aborted; k++) {
                        const extra = await testIpLatency(testHost, port, this.connectTimeout);
                        if (extra.latency > 0) samples.push(extra.latency);
                    }
                    if (samples.length >= 2) {
                        samples.sort((a, b) => a - b);
                        const m = Math.floor(samples.length / 2);
                        const med = samples.length % 2 ? samples[m] : Math.round((samples[m - 1] + samples[m]) / 2);
                        probe = { latency: med, colo: probe.colo };
                    }
                }
                const { latency, colo } = probe;

                const result: ScanResult = {
                    ip: isDomain ? host : testHost, // 域名源保存域名，IP源保存IP
                    port,
                    isAvailable: latency > 0 && latency <= this.latencyLimit,
                    latency,
                    colo,
                    domain: isDomain || undefined,
                };

                finalResults.push(result);
                this.onProgress(result);
            }
        };

        const workers = Array(this.threads).fill(null).map(() => worker());
        await Promise.all(workers);

        // 按延迟对成功的结果进行排序
        const sortedResults = finalResults
            .filter(r => r.isAvailable)
            .sort((a, b) => a.latency - b.latency);

        this.onComplete(sortedResults);
    }
}


const CIDR_RE = /^((?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d))\/(\d{1,2})$/;

/** 是否为合法的 IPv4 CIDR 网段（前缀长度 8-32，如 104.16.0.0/20） */
export function isIpv4Cidr(text: string): boolean {
    const m = CIDR_RE.exec(text.trim());
    if (!m) return false;
    const prefix = Number(m[2]);
    return prefix >= 8 && prefix <= 32;
}

/**
 * 从 CIDR 块生成随机 IP
 */
function generateRandomIPFromCIDR(cidr: string): string {
    const [baseIP, prefixLength] = cidr.split('/');
    const prefix = parseInt(prefixLength, 10);

    if (prefix === 32) return baseIP;

    const hostBits = 32 - prefix;
    const ipParts = baseIP.split('.').map(p => parseInt(p, 10));

    const ipInt = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
    const randomOffset = Math.floor(Math.random() * (2 ** hostBits));
    const mask = (0xFFFFFFFF << hostBits) >>> 0;
    const randomIPInt = ((ipInt & mask) >>> 0) + randomOffset;

    return [
        (randomIPInt >>> 24) & 0xFF,
        (randomIPInt >>> 16) & 0xFF,
        (randomIPInt >>> 8) & 0xFF,
        randomIPInt & 0xFF
    ].join('.');
}



const ipToInt = (ip: string): number => ip.split('.').reduce((a, b) => a * 256 + Number(b), 0);
const intToIpStr = (n: number): string => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/** 分层筛选用的网段块：前缀小于 /24 的网段按 /24 切分，其余保持原样 */
export interface CidrBlock { cidr: string; start: number; end: number; }

export function splitCidrBlocks(cidrs: string[], maxBlocks = 3000): CidrBlock[] {
    const seen = new Map<string, CidrBlock>();
    for (const c of cidrs) {
        const [base, pre] = c.split('/');
        const prefix = Number(pre);
        const size = 2 ** (32 - prefix);
        const start = Math.floor(ipToInt(base) / size) * size;
        const step = prefix < 24 ? 256 : size;
        const bPrefix = prefix < 24 ? 24 : prefix;
        for (let s = start; s < start + size; s += step) {
            const cidr = `${intToIpStr(s)}/${bPrefix}`;
            if (!seen.has(cidr)) seen.set(cidr, { cidr, start: s, end: s + step - 1 });
        }
    }
    const all = Array.from(seen.values());
    if (all.length <= maxBlocks) return all;
    for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [all[i], all[j]] = [all[j], all[i]];
    }
    return all.slice(0, maxBlocks);
}

/** 每个网段块随机抽 perBlock 个主机 IP */
export function sampleBlockIps(blocks: CidrBlock[], perBlock: number): string[] {
    const out: string[] = [];
    for (const b of blocks) {
        const size = b.end - b.start + 1;
        const lo = size > 2 ? 1 : 0;
        const hi = size > 2 ? size - 2 : size - 1;
        const n = Math.min(perBlock, hi - lo + 1);
        const picked = new Set<number>();
        while (picked.size < n) picked.add(lo + Math.floor(Math.random() * (hi - lo + 1)));
        picked.forEach(o => out.push(intToIpStr(b.start + o)));
    }
    return out;
}

/** 找到某个 IP 所属的网段块 */
export function findCidrBlock(blocks: CidrBlock[], ip: string): CidrBlock | undefined {
    const n = ipToInt(ip);
    return blocks.find(b => n >= b.start && n <= b.end);
}

/** 网段内可测试的主机数量（前缀 <=30 时去掉网络地址和广播地址） */
export function cidrHostCount(cidr: string): number {
    const prefix = Number(cidr.split('/')[1]);
    const size = 2 ** (32 - prefix);
    return size > 2 ? size - 2 : size;
}

/**
 * 展开多个网段内的全部 IP。总数超过 limit 时，从全部地址中均匀随机抽取 limit 个。
 */
export function expandAllCidrs(cidrs: string[], limit: number): { ips: string[]; total: number; truncated: boolean } {
    const items = cidrs.map(c => {
        const [base, pre] = c.split('/');
        const prefix = Number(pre);
        const size = 2 ** (32 - prefix);
        const baseInt = Math.floor(base.split('.').reduce((a, b) => a * 256 + Number(b), 0) / size) * size;
        const skip = size > 2 ? 1 : 0;
        return { baseInt: baseInt + skip, count: cidrHostCount(c) };
    });
    const total = items.reduce((a, b) => a + b.count, 0);
    const toIp = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
    const result = new Set<string>();

    if (total <= limit) {
        for (const it of items) for (let i = 0; i < it.count; i++) result.add(toIp(it.baseInt + i));
        return { ips: Array.from(result), total, truncated: false };
    }
    const starts: number[] = [];
    let acc = 0;
    for (const it of items) { starts.push(acc); acc += it.count; }
    const picked = new Set<number>();
    while (picked.size < limit) picked.add(Math.floor(Math.random() * total));
    for (const idx of picked) {
        let k = starts.length - 1;
        while (starts[k] > idx) k--;
        result.add(toIp(items[k].baseInt + (idx - starts[k])));
    }
    return { ips: Array.from(result), total, truncated: true };
}

/**
 * 从 CIDR 列表生成指定数量的随机 IP
 */
export function generateRandomIps(cidrs: string[], count: number): string[] {
    if (!cidrs || cidrs.length === 0) {
        return [];
    }
    const randomIps = new Set<string>();
    const maxAttempts = count * 5;
    let attempts = 0;

    while (randomIps.size < count && attempts < maxAttempts) {
        const randomCidr = cidrs[Math.floor(Math.random() * cidrs.length)];
        const randomIp = generateRandomIPFromCIDR(randomCidr);
        randomIps.add(randomIp);
        attempts++;
    }
    return Array.from(randomIps);
}

// =================================================================
// 4. 其他工具函数
// =================================================================

/**
 * 根据延迟值获取颜色样式
 */
export const getLatencyColor = (latency: number): string => {
    if (latency < 0) return 'text-gray-400 dark:text-gray-500';
    if (latency < 200) return 'text-green-500 dark:text-green-400';
    if (latency < 500) return 'text-yellow-500 dark:text-yellow-400';
    return 'text-red-500 dark:text-red-400';
};


/**
 * 备用的 Cloudflare CIDR 列表。
 * 此列表已废弃，CIDR数据现在应完全从API/KV中获取。
 * 保留为空数组以确保类型兼容和旧逻辑的平稳过渡。
 */
export const CF_CIDR_LIST: string[] = [];
