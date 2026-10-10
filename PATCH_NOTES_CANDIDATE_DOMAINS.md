# 候选域名与测速回退修复说明

基于提交 `6e2e0f9a336b6032376c766a67e6ca001d6f0bc7` 修改，保留原有 API 路径、结果结构和页面界面。

## 浏览器端延迟探测

- 保留原 kgcfip 探测域名 `ns.psb.kdns.fr` 作为首选。
- 增加 `bestcf.cmliussss.hidns.vip` 作为备用候选。
- 使用 HTTPS `no-cors` 探测，避免目标域名未开放 CORS 时被浏览器直接判定为失败。
- 成功候选写入 `localStorage`（不可用时退回内存缓存）；缓存候选失败后自动清理并尝试其他候选。
- 延迟探测、浏览器下载测速和浏览器丢包探测共用候选池；丢包测试支持候选失败后切换。
- 浏览器端无法读取 opaque 响应中的 HTTP 状态和 Cloudflare colo，因此此模式返回延迟但 colo 为 `-`。IPv6 浏览器直连探测提示使用本地 Agent。

## 下载测速候选源

参考 CFData-WEB 的测速地址候选：

- `speed.cloudflare.com/__down?bytes=200000000`
- `cf.090227.xyz/__down?bytes=99999999`
- `speed.okl.abrdns.com/`

本地 Agent 仍然直连待测 IP，并使用当前候选地址的 SNI/Host；默认测速源失败或无有效数据时才尝试下一个。用户显式设置自定义测速 URL 时不启用自动候选回退。

## 验证情况

- `local-agent/agent.js` 已通过 `node --check` 语法检查。
- `src/utils/scanner.ts` 已通过 TypeScript `transpileModule` 语法转译检查。
- 完整 `npm ci` / `npm run build` 未能在当前环境完成，因此本包不宣称已经通过完整项目构建；请部署前在有依赖网络的环境执行 `npm ci` 后再运行 `npm run build`。
