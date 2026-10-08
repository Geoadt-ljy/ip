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
