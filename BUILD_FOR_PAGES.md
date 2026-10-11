# kgcfip 1.2.3 Pages 构建版

这是基于原 kgcfip 项目的增强版，保留原 KV 数据结构。

## Cloudflare Pages

- Build command: `npm run build`
- Build output directory: `dist`
- Node.js: 18+
- `wrangler.toml` 已包含 `pages_build_output_dir = "dist"`

## KV

继续绑定原来的 `IP_KV`，不要新建 KV，也不要修改原 KV ID。

## 新增功能

- 自定义 IP / IP:端口直接测速
- 本地 Agent 下载速度测速
- 下载测速地址可配置
- 下载测速时长可配置
- 复用现有并发线程
- FFraud 纯净度参考检测（通过 Pages Function）

默认下载测速地址：
`https://speed.cloudflare.com/__down?bytes=200000000`

下载测速依赖本地 Agent，因为浏览器无法可靠地对任意 IP 指定 TLS SNI/Host。
