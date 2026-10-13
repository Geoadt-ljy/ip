# 1.2.3 修改说明

基于原 kgcfip-main：

1. 恢复并保留原 `src/` 全部前端源码。
2. 新增自定义 IP / IP:端口测速入口。
3. 本地 Agent 增加 CloudflareSpeedTest 风格的下载测速：先做延迟/可用性，再对成功目标进行固定时间下载测速。
4. 下载测速复用页面的线程数。
5. 下载测速地址、时间可配置。
6. 新增 FFraud 纯净度 Pages Function 和结果页检测按钮。
7. `wrangler.toml` 不再包含 `pages_build_output_dir` 和 KV id，改为在 Cloudflare Dashboard 中绑定 `IP_KV`（否则 Wrangler 配置文件会覆盖 Dashboard 设置）。
8. 更新 `public/local-agent.zip` 为增强后的 Agent。
### 2026-10-09：下载测速与 IP 筛选增强
- 修复本地 Agent 下载测速：测速计时从实际 HTTP 下载请求开始，取消下载阶段的错误空闲超时，并正确统计 HTTP body 字节。
- 下载测速保留 Cloudflare `speed.cloudflare.com` 的 SNI/Host，可直接对目标 CF IP 测速。
- 结果页新增“下载速度 ≥ X Mbps”筛选。
- 结果页新增“纯净度 ≥ X/100”筛选；启用前可点击“检测纯净度”，未检测到纯净度的 IP 不会通过该筛选。
- 纯净度检测前端自动按每批 20 个 IP 分批，避免超过后端单次上限。
- `public/local-agent.zip` 已同步更新，网页下载的 Agent 与源码一致。


## 丢包检测行为调整
- 删除自动丢包探测队列和 100 个 IP 上限。
- 延迟扫描结果就绪后自动勾选所有 IPv4 地址，但不自动发送探测请求。
- 用户点击“丢包率测试”后，才对所选 IP 开始测试；可手动取消/补选。


## 2026-10-09 follow-up
- Added shared IPv4 checkbox selection for browser download testing, purity checks, and optional selected-only KV saving.
- Added a combined “一键测速 + 纯净度” action.
- Browser-measured download speed and purity results are saved as optional fields without changing the existing `IP:port#region|scene|latency` line format. TXT exports and /api/getips append `|xx.xxMbps|xx/100`（无“下载:”“纯净度:”标签） after the original comment fields; CSV adds two optional columns.
- Added Pages `_headers` rules to prevent stale HTML/cache from making the normal browser show a blank page after deployments.

## 2026-10-11：纯净度即时显示与强行中断
- 纯净度检测改为每 5 个 IP 一批、2 路并发，每批返回后立即写入结果表，不再等全部完成；检测中的行显示“检测中…”，失败的行显示“失败”，按钮显示 `检测中 已完成/总数`。
- 重复检测时合并到已有纯净度结果，不再整体覆盖。
- 新增“■ 中断测速”“■ 中断纯净度”按钮，一键测速 + 纯净度同时运行时还会出现“■ 强行中断全部”。
- 中断通过 AbortController 立即取消进行中的 fetch 和下载流；被中断的 IP 保持“未测”状态，不记为失败，已完成的结果全部保留。
- 登录失效（401）时自动中止剩余纯净度批次；扫描结果变化或离开页面时也会自动中断旧任务。

## 2026-10-13：安全加固（无需新增任何配置，推送代码即生效）
- 登录令牌改为 HMAC-SHA256 签名令牌，有效期 7 天；`/api/login` 不再返回 `JWT_SECRET` 原文，中间件校验签名与过期时间（密钥仍用已有的 `JWT_SECRET`）。上线后旧的登录状态会失效，需要重新登录一次。
- `LOGINPW`、`APITOKEN` 改为恒定时间比较（`functions/_lib/auth.ts`）。
- 登录失败限速：同一来源 IP 连续失败 5 次后锁定 15 分钟（计数存在已有的 `IP_KV`，key 前缀 `rl:login:`，KV 最终一致，属软限速）。
- `/api/third_party_ips?url=` 只接受 http/https 链接，源内容超过 5MB 视为失败；`/api/sources` 保存时校验为 http/https 链接（最多 50 个）。Pages Functions 运行在 Cloudflare 边缘，访问不到内网，因此不再限制只能抓取已保存的地址。
- `/api/results` 校验场景名（≤64 字符、无控制字符）和条目（≤20000 条，每条必须有 `ip` 字段）。
- `/api/purity` 的 IP 校验改严格（IPv4 每段 ≤255，IPv6 需可解析）。
- 未改动：`getips` 仍兼容 `api_token`/`apitoken`/`key` 参数别名；本地 Agent 的 CORS 限制待确定站点域名后再加。

## 2026-10-14：修复筛选框的两个交互问题
- 未勾选时，延迟 / 下载速度 / 纯净度 / 丢包率 / 每地区保留 的输入框原先是禁用的，必须先勾选才能输入；现在始终可以输入，未勾选时仅显示为半透明。
- 原先数值不合法时勾选框会拒绝勾选，而输入框又被禁用，导致“填了不规范的值后取消勾选，就再也无法勾选”；现在勾选框始终可勾选。
- 勾选后数值不合法时，输入框旁实时提示，且该筛选暂不生效（不再把结果全部过滤掉）；改成合法值后立即生效。
