// 家宽判定：根据纯净度检测返回的连接类型和各类标志位，判断一个 IP 是否像家庭宽带。
//
// 结果：
//   residential  上游明确标注为家庭 / 住宅宽带，且没有机房、VPN、代理、Tor、中继、移动网络等标志
//   likely       上游没有给出可识别的连接类型，但各类标志位都不是机房 / 代理 / 移动，推断为“疑似家宽”
//   other        机房、VPN、代理、Tor、中继、移动网络，或连接类型为商业 / 教育 / 政府 / 机房等
//
// 注意：连接类型的具体取值取决于上游接口，这里按关键词识别；识别不了时只能按标志位推断为“疑似家宽”。
// Cloudflare 自己的 IP 都是机房 IP，不会被判为家宽，这个功能主要用于自定义 IP / 反代 IP 等场景。

export type HomeType = 'residential' | 'likely' | 'other';

export interface HomeInfo {
    connectionType?: string;
    isDatacenter?: boolean;
    vpn?: boolean;
    proxy?: boolean;
    tor?: boolean;
    relay?: boolean;
    mobile?: boolean;
}

const NOT_HOME_TYPE = /data\s*-?\s*center|hosting|server|cdn|business|corporate|commercial|education|government|mobile|cellular|机房|数据中心|商业|企业|教育|政府|移动/i;
const HOME_TYPE = /residential|home|broadband|家庭|住宅|家宽/i;

export function classifyHome(p: HomeInfo | null | undefined): HomeType {
    if (!p) return 'other';
    if (p.isDatacenter || p.vpn || p.proxy || p.tor || p.relay || p.mobile) return 'other';
    const type = String(p.connectionType || '');
    if (NOT_HOME_TYPE.test(type)) return 'other';
    if (HOME_TYPE.test(type)) return 'residential';
    return 'likely';
}

/** strict=true 时只接受“确认家宽”，否则连“疑似家宽”也算 */
export function isHome(p: HomeInfo | null | undefined, strict = false): boolean {
    const t = classifyHome(p);
    return strict ? t === 'residential' : t !== 'other';
}
