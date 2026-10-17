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
    purity?: import('../api').PurityResult;
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
    const candidates = isIPv6(ip)
        ? [null]
        : TEST_DOMAIN_CANDIDATES.map(domain => hexIp ? `${hexIp}.${domain}` : `${ip}.${domain}`);
    let lastError = 'Error';

    for (const candidate of candidates) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        const headers: Record<string, string> = { 'User-Agent': 'Cloudflare-IP-Scanner/1.0' };
        let testUrl: string;
        if (isIPv6(ip)) {
            // 浏览器不能可靠地自定义 Host/SNI；保留旧路径，失败时返回明确错误。
            headers['Host'] = 'ns.psb.kdns.fr';
            testUrl = `https://[${ip}]:${port}/ip.json?_t=${Date.now()}`;
        } else {
            testUrl = `https://${candidate}:${port}/ip.json?_t=${Date.now()}`;
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

            const secondRequestStart = Date.now();
            const second = await fetch(testUrl, { signal: controller.signal, headers, cache: 'no-store' });
            if (!second.ok) {
                lastError = `HTTP ${second.status}`;
                continue;
            }
            await second.arrayBuffer().catch(() => undefined);
            return { latency: Date.now() - secondRequestStart, colo };
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
    options: { bytes?: number; timeoutMs?: number; urlTemplate?: string; signal?: AbortSignal } = {}
): Promise<{ downloadMbps: number; downloadBytes: number; downloadMs: number; error?: string; aborted?: boolean }> {
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

    const bytes = Math.max(1024 * 1024, Math.min(options.bytes ?? 25 * 1024 * 1024, 100 * 1024 * 1024));
    const timeoutMs = Math.max(5000, options.timeoutMs ?? 30000);
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

            const elapsedMs = Math.max(1, performance.now() - startedAt);
            if (receivedBytes <= 0) {
                lastError = '测速端点未返回可读取的数据；请换一个支持 CORS 的测速地址';
                continue;
            }
            const mbps = (receivedBytes * 8) / (elapsedMs / 1000) / 1_000_000;
            const hostDomain = TEST_DOMAIN_CANDIDATES.find(domain => url.hostname.endsWith(`.${domain}`));
            if (hostDomain) cacheTestDomain(hostDomain);
            return {
                downloadMbps: Number(mbps.toFixed(2)),
                downloadBytes: receivedBytes,
                downloadMs: Math.round(elapsedMs),
            };
        } catch (error: any) {
            if (options.signal?.aborted) return abortedResult;
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
    options: { attempts?: number; timeoutMs?: number; urlTemplate?: string; signal?: AbortSignal } = {},
): Promise<{ packetLoss: number; sent: number; received: number; error?: string; aborted?: boolean }> {
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
    const template = (options.urlTemplate || 'https://{hexip}.ns.psb.kdns.fr:{port}/ip.json').trim();
    const urlBase = template.replace(/\{ip\}/g, ip).replace(/\{hexip\}/g, hexIp).replace(/\{port\}/g, String(port));
    let parsedUrl: URL;
    try { parsedUrl = new URL(urlBase); } catch {
        return { packetLoss: 100, sent: 0, received: 0, error: '探测地址无效；请使用 HTTPS URL' };
    }
    if (parsedUrl.protocol !== 'https:') {
        return { packetLoss: 100, sent: 0, received: 0, error: '浏览器丢包检测地址必须使用 HTTPS' };
    }
    // 被用户中断时探测不完整，得出的丢包率不可信，所以返回 aborted，由调用方丢弃该结果
    const abortedResult = (sent: number, got: number) => ({ packetLoss: 100, sent, received: got, error: '已中断', aborted: true });
    let received = 0;
    for (let i = 0; i < attempts; i++) {
        if (options.signal?.aborted) return abortedResult(i, received);
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), timeoutMs);
        const onExternalAbort = () => controller.abort();
        options.signal?.addEventListener('abort', onExternalAbort, { once: true });
        try {
            const response = await fetch(`${urlBase}?packet_probe=${Date.now()}_${i}_${Math.random().toString(36).slice(2)}`, {
                method: 'GET', mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: controller.signal,
            });
            // no-cors 响应会是 opaque；fetch 能完成即计为一次 HTTPS 探测成功。
            if (response.type === 'opaque' || response.ok) received++;
        } catch {
            // DNS、TLS、连接失败或超时，均计为探测丢失。
        } finally {
            options.signal?.removeEventListener('abort', onExternalAbort);
            window.clearTimeout(timer);
        }
    }
    if (options.signal?.aborted) return abortedResult(attempts, received);
    return { packetLoss: Number((((attempts - received) / attempts) * 100).toFixed(1)), sent: attempts, received };
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
        resolvedMap?: Record<string, string | null>
    ) {
        this.ips = ips;
        this.port = port;
        this.threads = Math.min(ips.length, threads);
        this.latencyLimit = latencyLimit;
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

                const { latency, colo } = await testIpLatency(testHost, port, this.latencyLimit);

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
