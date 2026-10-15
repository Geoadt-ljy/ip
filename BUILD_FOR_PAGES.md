# kgcfip 1.2.3 Pages 构建版

这是基于原 kgcfip 项目的增强版，保留原 KV 数据结构。

## Cloudflare Pages

- 构建命令（Build command）：`npm run build`
- 构建输出目录（Build output directory）：`dist`
- Node.js 版本：18 及以上
- `wrangler.toml` 刻意不包含 `pages_build_output_dir` 和 KV 配置：线上绑定在 Cloudflare Dashboard 中配置。部署时出现“字段缺失、配置文件仅用于本地开发”的警告属正常现象，可忽略。

## KV

在 Dashboard（Settings → Bindings）里绑定原来的 KV 命名空间，变量名必须为 `IP_KV`，Production 和 Preview 都要绑定。不要新建 KV，否则原有数据不会出现。

本地开发由 `npm run dev` 的 `--kv=IP_KV` 提供模拟 KV，无需在 `wrangler.toml` 中声明。

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
