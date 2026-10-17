// 家宽判定：根据纯净度检测返回的连接类型和各类标志位，判断一个 IP 是否为家庭宽带。
//
// 判为家宽需要同时满足：
//   1. 不是机房 / VPN / 代理 / Tor / 中继 / 移动网络（标志位都为否）
//   2. 上游返回的连接类型明确是家庭 / 住宅宽带
// 其余情况（包括上游没有给出连接类型）一律视为非家宽，不做“疑似”推断。
//
// 注意：连接类型的具体取值取决于上游接口，这里按关键词识别；
// 如果发现明明是家宽却没被识别，可以在结果页展开纯净度详情查看“连接类型”的实际取值，再调整下面的关键词。
// Cloudflare 自己的 IP 都是机房 IP，不会被判为家宽，这个功能主要用于自定义 IP / 反代 IP 等场景。

export type HomeType = 'residential' | 'other';

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
    return HOME_TYPE.test(type) ? 'residential' : 'other';
}

export function isHome(p: HomeInfo | null | undefined): boolean {
    return classifyHome(p) === 'residential';
}
