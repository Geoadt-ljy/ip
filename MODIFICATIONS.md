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


## 2026-10-09 补充更新
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

## 2026-10-14：订阅筛选、复测、分组管理、备份等功能
- `/api/getips` 新增参数：`min_speed`、`min_purity`、`max_age`、`sort`（latency/speed/purity/score）、`format=simple`。
- 综合评分（`functions/_lib/score.ts`，前后端共用）：延迟 40% + 下载速度 35% + 纯净度 25%，延迟 300ms、速度 100Mbps 封顶，未测项按 0 计。评分权重是本项目自己的设计，业界工具（如 CloudflareSpeedTest）常见做法是分阶段筛选而不是单一评分。
- 保存结果时给每条记录写入 `testedAt`（毫秒时间戳），供 `max_age` 过滤；已保存列表新增“评分”“测于”两列，超过 7 天标黄。
- 已保存列表：新增排序选择；新增“复测”（延迟，可选同时复测下载速度，可中断），超时/不可达/速度下降超过 50% 的标红，支持“保存复测结果”和“删除失效项”。
- 分组管理：`PATCH /api/results` 重命名分组（目标已存在返回 409）；已保存列表新增“管理分组”面板（重命名/删除）；保存分组下拉里每个分组带删除按钮；展开下拉时自动刷新分组列表。
- 备份与恢复：已保存列表新增“导出备份”（JSON，含空分组）和“导入备份”（与同名分组按 IP 合并，不删除现有数据）。
- 曾加过纯净度结果缓存（`IP_KV`，key 前缀 `purity:`），后来因占用写入额度而去掉，见 2026-10-17 的说明。
- 已保存列表默认排序时，延迟为 -1（失败）的条目现在排在最后。

## 2026-10-15：家宽筛选、自定义权重、文件导入与体验修复
- 家宽筛选：`functions/_lib/residential.ts` 根据纯净度检测的连接类型和标志位判定家宽（后来去掉了“疑似家宽”，见下文）；结果页新增“仅家宽”筛选、纯净度列徽标和详情里的“连接类型 / 家宽判定”；已保存列表新增“仅家宽”和徽标；订阅接口新增 `home=1` / `home=strict`。
- 自定义评分权重：`compositeScore` 支持传入权重并自动归一化；已保存列表新增“评分权重”面板（保存在浏览器本地，可复制对应的接口参数）；订阅接口新增 `w_latency` / `w_speed` / `w_purity`。
- 自定义 IP 支持上传 txt / csv（`src/utils/ipFile.ts`）：兼容本系统导出的 TXT / CSV，识别 IPv4、IP:端口、域名，忽略 `#` 备注，CIDR 和 IPv6 暂不支持。
- 修复删除分组后图标要刷新页面才消失：KV 最终一致，列表接口短时间内会返回旧数据；现在在浏览器里记 3 分钟的“已删除 / 已新建”提示，读取分组列表时据此修正（`src/api/index.ts`）。
- 修复手机端 API 示例过长撑宽页面：示例改为可换行的代码框，参数说明里的代码也允许换行。

## 2026-10-16：家宽字样与中文化
- `/api/getips` 新增可选参数 `show_home=1`：输出家宽标记，位置紧跟在延迟之后（`...|45ms|家宽|86.20Mbps|95/100`），默认不输出；`format=simple` 时也会按该参数输出。已保存列表的复制、TXT 导出同样把家宽标记放在延迟之后，CSV 导出新增“家宽”列。
- 把代码里的英文注释、英文提示信息（登录、令牌校验、第三方源、本地 Agent 等）和文档里的英文标签改为中文；删除了 `scanner.ts` 开头泄露本机路径的注释。
- 去掉“疑似家宽”：只有上游明确标注为家庭宽带、且不是机房 / VPN / 代理 / Tor / 中继 / 移动网络的才判为家宽，上游没有给出连接类型的视为非家宽；`home=strict` 保留为 `home=1` 的别名；接口、导出和页面徽标都只剩“家宽”。

## 2026-10-17：丢包测试可中断，纯净度缓存改为可选
- 丢包率测试新增“■ 中断丢包测试”按钮：立即中止进行中的探测，被中断的 IP 不记录结果；同时有两项以上测试在运行时，“■ 强行中断全部”一并中止丢包测试；结果集变化或离开页面时也会自动中断。
- 纯净度缓存改为可选，默认关闭：界面新增“使用缓存”开关（设置保存在本浏览器），接口请求体用 `cache: true` 才会读写 KV 缓存（原来的 `refresh` 参数和“忽略缓存”选项已去掉）。
- 默认关闭的原因：开启缓存后，每个新查询的 IP 都要写一次 KV，而 Cloudflare 免费版 KV 每天只有约 1000 次写入额度，用完后保存场景、登录失败计数等同样要写 KV 的功能也会失败。开关的提示、开启后的警告文字、README 和 `functions/api/purity.ts` 的注释里都写明了这个原因。

## 2026-10-17（续）：去掉纯净度 KV 缓存
- 纯净度检测不再读写 KV：结果只放在页面内存里（和延迟一样），保存到场景时才随 IP 整体写入一次，不再查一个写一个。接口 `/api/purity` 只接收 `ips`，页面上的“使用缓存”开关和对应的 KV 缓存代码已删除。
- 原因：Cloudflare 免费版 KV 每天只有约 1000 次写入额度，逐个 IP 写缓存会很快用完，进而让保存场景、登录失败计数等也失败。

