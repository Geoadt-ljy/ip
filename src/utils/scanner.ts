// e:\CODE\kgcfip\src\utils\scanner.ts
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
}

/**
 * 判断一个 host 是否为域名（非 IPv4 / IPv6）
 */
export function isDomainName(host: string): boolean {
    // IPv6（含方括号或包含多个冒号）一律视为IP
    if (host.includes(':')) return false;
    // IPv4
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

// 浏览器端候选探测域名。优先沿用 kgcfip 原域名，失败后尝试 EDT/BestCF 常见候选。
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
 * 浏览器无法自定义 Host/SNI 直连任意 IP。通过候选泛解析域名进行 HTTPS 探测，
 * no-cors 模式避免测速域名未开放 CORS 时把成功连接误判为失败。
 * 成功域名会缓存；缓存域名失效时会自动清除并切换候选。
 */
async function testIpLatency(ip: string, port: number, timeout: number): Promise<Omit<ScanResult, 'isAvailable' | 'ip' | 'port'>> {
    if (isIPv6(ip)) {
        return { latency: -1, colo: '浏览器暂不支持 IPv6 直连探测，请使用本地 Agent' };
    }

    const hexIp = ipToHex(ip);
    if (!hexIp) return { latency: -1, colo: 'Invalid IPv4' };

    const timeoutMs = Math.max(1000, timeout);
    const cached = getCachedTestDomain();
    for (const domain of orderedTestDomains()) {
        const host = `${hexIp}.${domain}`;
        const url = `https://${host}:${port}/cdn-cgi/trace?_kgcfip=${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
        const started = performance.now();
        try {
            const response = await fetch(url, {
                method: 'GET',
                mode: 'no-cors',
                cache: 'no-store',
                credentials: 'omit',
                redirect: 'follow',
                signal: controller.signal,
            });
            // no-cors 返回 opaque 是预期行为：浏览器不暴露响应状态，但网络请求确实完成。
            if (response.type === 'opaque' || response.ok) {
                const latency = Math.max(1, Math.round(performance.now() - started));
                cacheTestDomain(domain);
                return { latency, colo: '-' };
            }
            clearCachedTestDomain(domain);
        } catch (error: any) {
            clearCachedTestDomain(domain);
            if (error?.name === 'AbortError') {
                // 当前域名超时，继续尝试候选池中的下一个域名。
            }
        } finally {
            window.clearTimeout(timeoutId);
        }
        // 只有当前缓存域名失败时才清掉；继续尝试剩余候选。
        if (cached === domain) clearCachedTestDomain(domain);
    }
    return { latency: -1, colo: '候选测速域名均不可用' };
}

const PROBE_FALLBACK_IPS = ['104.16.0.1', '172.67.0.1', '162.159.0.1', '162.158.0.1', '188.114.96.1', '108.162.192.1'];


/**
 * 浏览器端对指定 IPv4/端口执行下载测速。
 * 使用与浏览器延迟测速相同的 hex 泛解析域名，因此无需本地 Agent。
 * 使用 no-cors 计时；测试端点返回固定 bytes，因此无需读取跨域响应体即可计算 Mbps。
 */
export async function testBrowserDownloadSpeed(
    ip: string,
    port: number,
    options: { bytes?: number; timeoutMs?: number } = {}
): Promise<{ downloadMbps: number; downloadBytes: number; downloadMs: number; error?: string }> {
    if (isIPv6(ip) || isDomainName(ip)) {
        return { downloadMbps: 0, downloadBytes: 0, downloadMs: 0, error: '浏览器测速目前仅支持 IPv4 IP' };
    }

    const hexIp = ipToHex(ip);
    if (!hexIp) {
        return { downloadMbps: 0, downloadBytes: 0, downloadMs: 0, error: 'IPv4 地址格式无效' };
    }

    // Cloudflare Pages 本身是 HTTPS 页面，因此浏览器直接测速时只允许 HTTPS 端口。
    // 与 EDT / Cloudflare IP 优选思路一致：用 hex-ip 泛解析域名把请求路由到指定 IP，
    // 再请求 Cloudflare 的 __down 测试端点。
    const httpsPorts = new Set([443, 2053, 2083, 2087, 2096, 8443]);
    if (!httpsPorts.has(port)) {
        return {
            downloadMbps: 0,
            downloadBytes: 0,
            downloadMs: 0,
            error: `浏览器测速不支持 HTTP 端口 ${port}（HTTPS 页面会拦截混合内容），请使用 HTTPS 端口`,
        };
    }

    const bytes = Math.max(512 * 1024, Math.min(options.bytes ?? 10 * 1024 * 1024, 100 * 1024 * 1024));
    const timeoutMs = Math.max(3000, options.timeoutMs ?? 15000);
    const candidateDomains = orderedTestDomains();
    let lastError = '浏览器无法连接该 IP 的 HTTPS 测速端点';
    for (const domain of candidateDomains) {
        const host = `${hexIp}.${domain}`;
        const url = `https://${host}:${port}/__down?bytes=${bytes}&_t=${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), timeoutMs);
        const start = performance.now();
        try {
            const response = await fetch(url, {
                method: 'GET',
                mode: 'no-cors',
                cache: 'no-store',
                signal: controller.signal,
                credentials: 'omit',
            });
            const elapsedMs = Math.max(1, performance.now() - start);
            if (response.type !== 'opaque' && !response.ok) {
                lastError = `HTTP ${response.status}`;
                clearCachedTestDomain(domain);
                continue;
            }
            cacheTestDomain(domain);
            // no-cors 无法读取 body，因此吞吐是按请求完成时间与目标字节数估算。
            const mbps = (bytes * 8) / (elapsedMs / 1000) / 1_000_000;
            return { downloadMbps: Number(mbps.toFixed(2)), downloadBytes: bytes, downloadMs: Math.round(elapsedMs) };
        } catch (error: any) {
            lastError = error?.name === 'AbortError'
                ? `测速超时（>${Math.round(timeoutMs / 1000)}秒）`
                : '浏览器无法连接该 IP 的 HTTPS 测速端点';
            clearCachedTestDomain(domain);
        } finally {
            window.clearTimeout(timer);
        }
    }
    return { downloadMbps: 0, downloadBytes: 0, downloadMs: 0, error: lastError };
}


/**
 * 浏览器端近似丢包率测试：连续发送多次 HTTPS 探测请求，按请求失败/超时比例计算。
 * 注意这不是 ICMP ping；浏览器权限限制下，结果代表 HTTPS 探测请求失败率。
 */
export async function testBrowserPacketLoss(
    ip: string,
    port: number,
    options: { attempts?: number; timeoutMs?: number; urlTemplate?: string } = {},
): Promise<{ packetLoss: number; sent: number; received: number; error?: string }> {
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
    const customTemplate = options.urlTemplate?.trim();
    const templates = customTemplate
        ? [customTemplate]
        : orderedTestDomains().map(domain => `https://{hexip}.${domain}:{port}/cdn-cgi/trace`);
    const parsedTemplates: Array<{ template: string; domain?: string }> = [];
    try {
        for (const template of templates) {
            const urlBase = template.replace(/\{ip\}/g, ip).replace(/\{hexip\}/g, hexIp).replace(/\{port\}/g, String(port));
            const parsed = new URL(urlBase);
            if (parsed.protocol !== 'https:') {
                return { packetLoss: 100, sent: 0, received: 0, error: '浏览器丢包检测地址必须使用 HTTPS' };
            }
            const domain = TEST_DOMAIN_CANDIDATES.find(item => parsed.hostname === `${hexIp}.${item}`);
            parsedTemplates.push({ template: urlBase, domain });
        }
    } catch {
        return { packetLoss: 100, sent: 0, received: 0, error: '探测地址无效；请使用 HTTPS URL' };
    }
    let received = 0;
    for (let i = 0; i < attempts; i++) {
        let attemptSucceeded = false;
        for (const candidate of parsedTemplates) {
            const controller = new AbortController();
            const timer = window.setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await fetch(`${candidate.template}${candidate.template.includes('?') ? '&' : '?'}packet_probe=${Date.now()}_${i}_${Math.random().toString(36).slice(2)}`, {
                    method: 'GET', mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: controller.signal,
                });
                if (response.type === 'opaque' || response.ok) {
                    attemptSucceeded = true;
                    if (candidate.domain) cacheTestDomain(candidate.domain);
                    break;
                }
            } catch {
                // 当前候选失败时尝试下一个域名。
            } finally {
                window.clearTimeout(timer);
            }
        }
        if (attemptSucceeded) received++;
    }
    return { packetLoss: Number((((attempts - received) / attempts) * 100).toFixed(1)), sent: attempts, received };
}

export async function probeBrowserAvailable(sampleIps?: string[], attempts = 10): Promise<boolean> {
    const ips = Array.from({ length: Math.max(1, attempts) }, (_, i) =>
        sampleIps?.[i] ?? PROBE_FALLBACK_IPS[Math.floor(Math.random() * PROBE_FALLBACK_IPS.length)]
    );
    const domains = orderedTestDomains();
    const tasks = ips.map(async (ip) => {
        const hexIp = ipToHex(ip);
        if (!hexIp) return false;
        for (const domain of domains) {
            const controller = new AbortController();
            const timer = window.setTimeout(() => controller.abort(), 2500);
            try {
                const url = `https://${hexIp}.${domain}:443/cdn-cgi/trace?_probe=${Date.now()}_${Math.random().toString(36).slice(2)}`;
                const response = await fetch(url, {
                    method: 'GET',
                    mode: 'no-cors',
                    cache: 'no-store',
                    credentials: 'omit',
                    signal: controller.signal,
                });
                if (response.type === 'opaque' || response.ok) {
                    cacheTestDomain(domain);
                    return true;
                }
            } catch {
                // 当前候选失败时继续检查下一个。
            } finally {
                window.clearTimeout(timer);
            }
        }
        return false;
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
