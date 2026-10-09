# 1.2.3 修改说明

基于原 kgcfip-main：

1. 恢复并保留原 `src/` 全部前端源码。
2. 新增自定义 IP / IP:端口测速入口。
3. 本地 Agent 增加 CloudflareSpeedTest 风格的下载测速：先做延迟/可用性，再对成功目标进行固定时间下载测速。
4. 下载测速复用页面的线程数。
5. 下载测速地址、时间可配置。
6. 新增 FFraud 纯净度 Pages Function 和结果页检测按钮。
7. `wrangler.toml` 增加 `pages_build_output_dir = "dist"`，避免 Pages 的 Wrangler 配置警告。
8. 更新 `public/local-agent.zip` 为增强后的 Agent。
### 2026-10-09：下载测速与 IP 筛选增强
- 修复本地 Agent 下载测速：测速计时从实际 HTTP 下载请求开始，取消下载阶段的错误空闲超时，并正确统计 HTTP body 字节。
- 下载测速保留 Cloudflare `speed.cloudflare.com` 的 SNI/Host，可直接对目标 CF IP 测速。
- 结果页新增“下载速度 ≥ X Mbps”筛选。
- 结果页新增“纯净度 ≥ X/100”筛选；启用前可点击“检测纯净度”，未检测到纯净度的 IP 不会通过该筛选。
- 纯净度检测前端自动按每批 100 个 IP 分批，避免超过后端单次上限。
- `public/local-agent.zip` 已同步更新，网页下载的 Agent 与源码一致。


## 丢包检测行为调整
- 删除自动丢包探测队列和 100 个 IP 上限。
- 延迟扫描结果就绪后自动勾选所有 IPv4 地址，但不自动发送探测请求。
- 用户点击“丢包率测试”后，才对所选 IP 开始测试；可手动取消/补选。


## 2026-10-09 follow-up
- Added shared IPv4 checkbox selection for browser download testing, purity checks, and optional selected-only KV saving.
- Added a combined “一键测速 + 纯净度” action.
- Browser-measured download speed and purity results are saved as optional fields without changing the existing `IP:port#region|scene|latency` line format. TXT exports append `|下载:xxMbps|纯净度:xx/100` after the original comment fields; CSV adds two optional columns.
- Added Pages `_headers` rules to prevent stale HTML/cache from making the normal browser show a blank page after deployments.
