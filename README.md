# 私人优选 IP 管理（kgcfip-manager）

一个自建的 Cloudflare 优选 IP / 域名库：在浏览器里扫描延迟，用浏览器或本地 Agent 测下载速度，检测 IP 纯净度，按场景保存到 Cloudflare KV，并生成可直接订阅的接口。部署在 Cloudflare Pages 上，数据只存在你自己的 KV 里。

订阅接口格式兼容 kgcfip 原版，已有的订阅工具可以直接使用。

## 功能

- **多场景管理**：家里、公司、手机流量等网络环境各建一个分组，每个场景保存自己的优选 IP。
- **延迟扫描**：在浏览器里批量测延迟，支持 Cloudflare 官方 IP 段、第三方 IP 源，以及直接上传 txt / csv 文件导入自定义 IP。
- **下载测速**：浏览器直接对勾选的 IPv4 测速（仅 HTTPS 端口）；浏览器测速不稳定时，可用本地 Agent 兜底。测速过程中可随时点击「中断测速」。
- **纯净度检测**：批量检测 Fraud Score、风险、VPN / Proxy / Tor、数据中心、ASN、ISP 等信息。结果逐批即时显示，可点击「中断纯净度」立即停止；两项同时运行时可「强行中断全部」。
- **联合筛选**：同时设置「下载速度 ≥」和「纯净度 ≥」，只保留两项都满足的 IP。
- **丢包率测试**：浏览器无法发送 ICMP，因此结果是 HTTPS 探测失败率，不等同于 ICMP 丢包率。
- **订阅 API**：带参数筛选的纯文本接口，支持按速度、纯净度、数据新鲜度筛选和多种排序，测速结果更新后订阅端自动拿到最新数据。
- **分组管理**：保存时的分组下拉里可以直接删除分组；「已保存列表」里可以重命名、删除分组。
- **复测与清理**：对已保存的 IP 一键复测延迟（可选同时复测下载速度），超时或速度下降超过一半的会标红，可一键删除失效项。
- **多种排序**：已保存列表可按延迟、下载速度、纯净度、综合评分、最近测试时间排序，综合评分的权重可以自定义。
- **家宽筛选**：根据纯净度检测结果判断是否像家庭宽带（排除机房、VPN、代理、Tor、中继、移动网络），结果页和已保存列表都可以一键「仅家宽」。
- **备份与恢复**：把所有分组导出为一个 JSON 文件，也可以导回（与现有同名分组按 IP 合并，不会删除现有数据）。
- **纯净度缓存**：同一个 IP 的纯净度结果缓存 24 小时，重复检测更快；勾选「忽略缓存」可强制重新查询。

勾选只是选择，不会自动发起测速或纯净度检测；同一组勾选项可用于测速、纯净度检测和「仅保存勾选 IPv4 到 KV」。

## 部署（Cloudflare Pages）

### 1. Fork 本仓库

### 2. 创建 KV 命名空间

Cloudflare Dashboard → `Workers & Pages` → `KV` → `Create a namespace`，名称随意（例如 `IP_KV`）。

### 3. 连接 GitHub 并部署

`Workers & Pages` → `Create application` → `Pages` → `Connect to Git`，选择你 Fork 的仓库，构建设置如下：

| 项目 | 值 |
| --- | --- |
| Production branch | `main` |
| Framework preset | 无 |
| Build command | `npm run build` |
| Build output directory | `dist` |

第一次构建可能失败，因为环境变量和 KV 还没配置，继续下一步即可。

### 4. 配置环境变量

进入项目 `Settings` → `Environment variables`，添加以下三个 Production 变量（值请使用足够长的随机字符串）：

| 变量 | 作用 |
| --- | --- |
| `LOGINPW` | 后台登录密码 |
| `JWT_SECRET` | 登录令牌的签名密钥 |
| `APITOKEN` | 订阅接口使用的令牌 |

### 5. 绑定 KV

进入 `Settings` → `Bindings` → `Add binding` → KV namespace：

- Variable name：必须填 `IP_KV`
- KV namespace：选择第 2 步创建的命名空间
- Production 和 Preview 两个环境都要绑定

本仓库的 `wrangler.toml` 刻意不包含 KV 配置，也不含 `pages_build_output_dir`，线上绑定以 Dashboard 为准；部署日志里关于 Wrangler 配置的提示可以忽略。

### 6. 重新部署

回到 `Deployments`，对最新一次部署点击 `Retry deployment`。

## 本地开发

```bash
npm install
```

在项目根目录新建 `.dev.vars`（已被 `.gitignore` 忽略，不会提交）：

```
LOGINPW=your-password
JWT_SECRET=your-long-random-secret
APITOKEN=your-api-token
```

启动：

```bash
npm run dev      # 前端 + Pages Functions + 本地模拟 KV（IP_KV）
npm run build    # 类型检查并构建到 dist
npm run deploy   # 构建并用 wrangler 部署
```

## 本地测速 Agent（可选）

用于浏览器测速不稳定时兜底。需要 Node.js 16 或更高版本，无需安装依赖。

1. 下载 `public/local-agent.zip`（部署后也可从站点下载）并解压。
2. Windows 运行 `start.bat`，Linux / macOS 运行 `start.sh`。
3. 默认只监听 `127.0.0.1:15888`，端口可在 `config.json` 的 `listenPort` 修改。
4. 回到网页，切换到「本地测速」。

## 订阅 API

```
GET /api/getips?token=你的APITOKEN
```

返回纯文本，每行一个 IP，按延迟从低到高排序：

```
IP:端口#地区|场景|延迟ms
```

如果该 IP 测过下载速度或纯净度，会在末尾依次追加数值（不带文字标签）：

```
104.16.1.2:443#🇭🇰香港|公司|45ms|86.20Mbps|95/100
172.67.3.4:2053#🇺🇸洛杉矶|家里|120ms
```

| 参数 | 说明 |
| --- | --- |
| `token` | 必填，对应环境变量 `APITOKEN`（兼容别名 `api_token`、`apitoken`、`key`） |
| `scene` | 只取某个场景，不填则合并所有场景 |
| `latency` | 最大延迟（毫秒） |
| `region` | Cloudflare 机房代码，如 `HKG`、`LAX` |
| `count` | 只返回前 N 条（按排序结果取） |
| `min_speed` | 下载速度下限（Mbps），未测速的 IP 不返回 |
| `min_purity` | 纯净度下限（0-100），未检测的 IP 不返回 |
| `max_age` | 只要最近测试过的 IP：数字默认是小时，支持 `h` / `d` 后缀，如 `24h`、`7d`；没有测试时间的旧数据不返回 |
| `sort` | `latency`（默认）、`speed`、`purity`、`score`，除延迟外均为从高到低，延迟低者优先作次级排序 |
| `format` | `simple` 时只输出 `IP:端口#地区|场景|延迟ms`，不追加速度和纯净度 |
| `w_latency` `w_speed` `w_purity` | 自定义综合评分权重（任意非负数，自动归一化），仅 `sort=score` 时生效；只写其中几项时，未写的按 0 计 |
| `home` | `1`：只要家宽（含疑似家宽）；`strict`：只要上游明确标注为家宽的。需要该 IP 做过纯净度检测，没检测的不返回 |

数值无效的参数会被忽略。

综合评分（`sort=score`）= 延迟 40% + 下载速度 35% + 纯净度 25%，其中延迟 300ms、速度 100Mbps 封顶，未测速或未检测的项按 0 计，所以只测了延迟的 IP 最高 40 分。权重和封顶值定义在 `functions/_lib/score.ts`，可按需修改。

示例：

```
/api/getips?token=你的APITOKEN&min_speed=30&min_purity=90&max_age=7d&sort=score&count=10
/api/getips?token=你的APITOKEN&sort=score&w_speed=60&w_latency=30&w_purity=10&home=1
```

### 家宽判定说明

家宽判定基于纯净度检测返回的连接类型和各类标志位：机房、VPN、代理、Tor、中继、移动网络一律判为非家宽；上游明确标注为家庭 / 住宅宽带的判为「家宽」；上游没有给出可识别的连接类型、但标志位都正常的判为「疑似家宽」。连接类型的具体取值取决于上游接口，这里按关键词识别。Cloudflare 自己的 IP 都是机房 IP，不会被判为家宽，该功能主要用于自定义 IP / 反代 IP 等场景。

### 自定义 IP 文件格式

在「自定义IP」里可以直接上传 txt / csv 文件（≤2MB，最多 20000 个目标），可与文本框里已有内容合并去重：

- 每行一个或多个 IPv4、`IP:端口` 或域名，`#` 之后的备注会被忽略（本系统导出的 TXT 可直接导入）。
- CSV 如果有表头 `IP` / `IP地址` / `地址` / `host` 和 `端口` / `port`，按表头取列；没有表头时第一列为地址，第二列是 1-65535 的整数时视为端口（本系统导出的 CSV 可直接导入）。
- CIDR 网段（如 `1.0.0.0/24`）和 IPv6 暂不支持，会被忽略并提示数量。

令牌错误返回 `401`；未配置 `APITOKEN` 返回 `500`。

## 安全说明

- 登录后签发 HMAC 签名令牌，有效期 7 天，不会向浏览器返回 `JWT_SECRET`。
- 密码和 API 令牌使用恒定时间比较。
- 同一来源 IP 连续登录失败 5 次后锁定 15 分钟（计数存放在 `IP_KV`，属于软限速）。
- 第三方 IP 源只接受 http/https 链接，保存时会校验格式，单个源内容超过 5MB 视为失败。
- 保存结果时会校验场景名长度和条目数量。
- 纯净度缓存会让每个新查询的 IP 写一次 KV，Cloudflare 免费版每天约有 1000 次写入额度，大批量检测时请留意。
- 请为 `LOGINPW`、`JWT_SECRET`、`APITOKEN` 使用足够长的随机值，并且不要把它们写进仓库。

## 目录结构

```
functions/api/     Pages Functions：登录、订阅、结果保存、纯净度、第三方源
functions/_lib/    令牌签发与校验、恒定时间比较
src/               React + Vite 前端
local-agent/       本地测速 Agent（Node.js，零依赖）
public/            静态资源与 local-agent.zip
```

## 说明

本项目在 kgcfip 的基础上二次开发，订阅接口格式保持兼容。更多改动记录见 [MODIFICATIONS.md](MODIFICATIONS.md)。

本系统仅用于个人学习和研究，禁止用于任何商业用途。请勿将优选 IP 用于任何违反 Cloudflare 服务条款或违反法律法规的活动。
