// 解析用户上传的 txt / csv IP 文件，输出可直接放进“自定义 IP”文本框的目标列表。
//
// 支持的写法（可混用）：
//   104.16.1.1                 单个 IPv4
//   104.16.1.1:2053            IPv4 + 端口
//   example.com / example.com:8443   域名（扫描时会先解析）
//   104.16.1.1:443#备注        “#”及之后的备注会被忽略（本系统导出的 TXT 就是这种格式）
//   以逗号 / 分号 / Tab 分隔的 CSV：若有表头“IP/IP地址/地址/host/域名”和“端口/port”，按表头取列；
//   没有表头时取第一列为地址，第二列是 1-65535 的整数时视为端口（本系统导出的 CSV 可直接导入）
// 不支持（计入“已忽略”）：CIDR 网段（如 1.0.0.0/24）、IPv6。

import { isDomainName } from './scanner';

export const MAX_IMPORT_TARGETS = 20000;

export interface ParsedIpFile {
    targets: string[];
    ignored: number;     // 无法识别而被忽略的条目数
    truncated: boolean;  // 是否因超过上限被截断
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

function normalizeTarget(raw: string): string | null {
    const token = raw.trim().replace(/^["']+|["']+$/g, '');
    if (!token) return null;

    const colonCount = (token.match(/:/g) || []).length;
    if (colonCount > 1 || token.includes('[')) return null; // IPv6 暂不支持

    let host = token;
    let port: number | null = null;
    if (colonCount === 1) {
        const idx = token.indexOf(':');
        host = token.slice(0, idx);
        const portText = token.slice(idx + 1);
        if (!/^\d{1,5}$/.test(portText)) return null;
        port = Number(portText);
        if (port < 1 || port > 65535) return null;
    }

    if (!IPV4.test(host) && !isDomainName(host)) return null;
    return port ? `${host}:${port}` : host;
}

export function parseIpFileText(text: string): ParsedIpFile {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    const found = new Set<string>();
    let ignored = 0;
    let truncated = false;
    let ipCol = -1;
    let portCol = -1;

    const add = (target: string | null): boolean => {
        if (!target) return false;
        if (found.size >= MAX_IMPORT_TARGETS) {
            truncated = true;
            return true; // 已识别但超出上限
        }
        found.add(target);
        return true;
    };

    for (const rawLine of lines) {
        // 去掉备注（# 之后）与整行注释
        const line = rawLine.split('#')[0].trim();
        if (!line || line.startsWith('//')) continue;

        if (/[,;\t]/.test(line)) {
            const cells = line.split(/[,;\t]/).map(c => c.trim().replace(/^["']+|["']+$/g, ''));

            // 表头行：记录地址列和端口列，不计入忽略
            const headerIp = cells.findIndex(c => /^(ip|ip地址|地址|host|域名|address)$/i.test(c));
            if (headerIp >= 0) {
                ipCol = headerIp;
                portCol = cells.findIndex(c => /^(端口|port)$/i.test(c));
                continue;
            }

            // 有表头：按表头取地址列和端口列
            if (ipCol >= 0) {
                const hostCell = cells[ipCol] || '';
                const portCell = portCol >= 0 ? cells[portCol] : undefined;
                let candidate = hostCell;
                if (!hostCell.includes(':') && portCell && /^\d{1,5}$/.test(portCell)) {
                    candidate = `${hostCell}:${portCell}`;
                }
                if (!add(normalizeTarget(candidate))) ignored++;
                continue;
            }

            // 无表头：第一列是地址，第二列是 1-65535 的整数时视为端口
            const first = cells[0] || '';
            const second = cells[1];
            let candidate = first;
            if (!first.includes(':') && second && /^\d{1,5}$/.test(second)) {
                candidate = `${first}:${second}`;
            }
            if (add(normalizeTarget(candidate))) continue;

            // 第一列不是单个地址：当作逗号分隔的地址列表（如 1.1.1.1, 8.8.8.8）
            for (const token of cells.join(' ').split(/\s+/).filter(Boolean)) {
                if (!add(normalizeTarget(token))) ignored++;
            }
            continue;
        }

        // 普通文本：空白分隔，一行可以有多个
        for (const token of line.split(/\s+/)) {
            if (!add(normalizeTarget(token))) ignored++;
        }
    }

    return { targets: Array.from(found), ignored, truncated };
}
