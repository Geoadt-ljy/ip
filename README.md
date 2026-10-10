# 私人优选IP管理


## API 兼容说明

订阅接口保持 kgcfip 原版格式：

`/api/getips?token=你的APITOKEN`

支持原版筛选参数：

- `scene=场景名称`
- `latency=最大延迟`
- `region=Cloudflare Colo`
- `count=数量`

返回仍为纯文本，每行格式：

`IP:端口#地区|场景|延迟ms`

为兼容历史链接，当前版本同时接受 `api_token`、`apitoken`、`key` 作为 Token 参数别名；推荐仍使用原版的 `token`。

## 新增功能（测速与纯净度）

- **下载测速**：切换到「本地测速」后，可启用下载测速，默认使用 Cloudflare Speed 的 HTTPS 下载测试地址，并可设置测速时长。
- **纯净度检测**：可批量检测 IP 的纯净度，并按照纯净度阈值筛选。
- **联合筛选**：支持同时设置「下载速度 ≥」和「纯净度 ≥」，只保留同时满足条件的 IP。
- **纯净度详情**：点击结果中的纯净度分数旁边的展开按钮，可以查看 Fraud Score、风险、VPN、Proxy、Tor、Relay、数据中心、移动网络、滥用、住宅代理、连接类型、国家/地区/城市、ASN、ISP、组织、置信度、威胁标签和风险原因等信息。
- **浏览器测速提示**：浏览器支持直接对单个或多个 IPv4 IP 进行下载测速；仅支持 HTTPS 端口，本地 Agent 测速作为备用方式。
- **丢包率测试**：延迟扫描结果就绪后自动勾选全部 IPv4 地址，但不会自动发起测试；用户点击丢包率测试按钮后才开始。没有 IP 数量上限，可自定义 HTTPS 探测地址模板，支持 `{ip}`、`{hexip}`、`{port}` 占位符。浏览器无法发送原始 ICMP ping，因此结果是 HTTPS 探测失败率，并非 ICMP ping 丢包率。

## 简介 (Introduction)
一个帮你自建 Cloudflare 优选 IP/域名 库的小工具，

-   **网页+本地**: 不用下载和安装任何客户端软件。只要有浏览器就能测出优选IP。（鉴于网页测速不稳定，加入本地程序兜底）。
-   **私人IP库**: 用这个工具，测出来的都是你自己的，干净、高速，不怕 IP 被滥用导致连不上或被封。
-   **多场景管理**: 家里、公司、手机流量，网络环境不一样，好用的 IP 也不一样。你可以给不同场景建个分组，比如“公司摸鱼专用”、“回家看片专用”。
-   **订阅API**: 生成一个订阅链接。带参数筛选，配合其他工具使用，以后就不用手动换 IP 了。这边测速更新了，那边自动就用上最新。


## 部署教程 (Deployment Guide)
可以克隆到本地后安装相关依赖，本地启动服务测试正常后，执行deploy命名部署。
推荐使用 GitHub + Cloudflare Pages 的方式进行全自动部署。


### 步骤 1: Fork 本项目到你的 GitHub

### 步骤 2: 在 Cloudflare 创建所需服务

在部署之前，我们需要在 Cloudflare 上创建一个用于存储数据的 KV 存储空间。

-   登录 Cloudflare Dashboard。
-   在右侧菜单中选择 `Workers & Pages` -> `KV`。
-   点击 `Create a namespace`，输入一个名称（例如 `IP_KV`），然后创建。
### 步骤 3: 连接 GitHub 并部署
-   在 Cloudflare Dashboard，进入 `Workers & Pages`。
    -   点击 `Create application(创建应用程序)`  -> `想要部署 Pages？开始使用` -> `Connect to Git(导入现有 Git 存储库)` 。
-   选择你刚刚 Fork 的仓库，点击 `Begin setup`（开始设置）。
-   **配置构建设置 (非常重要):**
    -   **Project name (项目名称)**: 随便起个你喜欢的名字。
    -   **Production branch (生产分支)**: 保持 `main` 或 `master` 不变。
    -   **Framework preset(框架预设)**: 选择 `无`。
    -   **Build command(构建命令)**: 确保这里是 `npm run build`。
    -   **Build output directory(构建输出目录)** : 确保是 `dist`。
-   点击 `Save and Deploy（保存并部署）`。Cloudflare 会开始第一次构建，这次构建**可能会失败或者不完整**，因为我们还没配置环境变量和 KV，别急，继续下一步。

### 步骤 4: 配置项目

等待第一次部署结束后（无论成功失败），进入你新创建的 Pages 项目，点击 `Settings（设置）`。

#### a. 添加环境变量
-   进入 `Settings（设置）` -> `Environment variables（变量和机密）`。
    -   点击 `Add (添加)`，添加以下三个 **Production** (生产环境) 环境变量，值要换成你自己的，越复杂越好：
    -   `LOGINPW`: 你的后台登录密码。
    -   `JWT_SECRET`: 随便一长串随机字符，用于会话安全。
    -   `APITOKEN`: 订阅链接用的，也随便一长串。

#### b. 绑定 KV 存储
-   进入 `Settings` -> `Functions`。
-   向下滚动到 `KV Namespace Bindings`，点击 `Add binding`。
    -   **Variable name** (变量名): **必须**填写 `IP_KV`。
    -   **KV namespace** (KV 命名空间): 选择你在 **步骤 2** 创建的那个 KV 命名空间。
-   点击 `Save`。

### 步骤 5: 重新部署，大功告成！

所有配置都完成后，我们需要让配置生效。 ✅

-   回到项目的 `Deployments` 标签页。
    -   找到最新的那条部署记录，点击右边的 `查看详细信息`，选择管理部署-> `Retry deployment` (重试部署)。
-   等待部署流程走完，你的私人优选 IP 管理系统就上线了！

---
# 私人优选IP管理展示
<img width="1807" height="5115" alt="PixPin_2026-08-30_19-36-10" src="https://github.com/user-attachments/assets/46f71523-703e-41e1-b446-734c52d9bf7b" />


&copy; 本系统仅用于个人学习和研究目的，禁止用于任何商业用途。请勿将优选IP用于任何违反Cloudflare服务条款和违反法律法规的活动。 ⚖️


### 勾选、测速、纯净度和 KV 保存
- 延迟扫描完成后自动勾选 IPv4；勾选只做选择，不会自动发起测速或纯净度检测。
- 同一组选中项可用于浏览器下载测速、纯净度检测，以及“仅保存勾选 IPv4 到 KV”。也可一键执行下载测速和纯净度检测。
- 测速/纯净度结果会作为可选字段保存。TXT 注释保留原有 `IP:端口#地区|场景|延迟` 结构，并在后面追加下载速度和纯净度字段。
- Pages 使用 `_headers` 禁止 HTML 使用过期缓存，降低普通浏览器继续读取旧入口文件而白屏的概率。
