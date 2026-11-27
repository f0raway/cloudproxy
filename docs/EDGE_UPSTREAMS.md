# 三大免费上游：额度、限制与部署

文档核对日期：2026-11-27。套餐会变化，实际以部署时控制台为准。**Cloudflare 与腾讯 EdgeOne 已完成真实 TLS/HTTPS 验证；阿里云 ESA 仍只接受独立协议 2 兼容端点。**

| 上游 | 免费额度 | 与代理相关的限制 | cloudproxy 当前状态 |
| --- | --- | --- | --- |
| Cloudflare Workers Free | 每账号每天 100,000 次请求；本系统默认本地限制为 90,000 次 | 单次 CPU 10 ms；`connect()` 不允许 Cloudflare 网络、私网目标及 25 端口；同账号节点共享额度 | 已有 Worker 和部署器；使用真实连接结果判断节点可用性 |
| 腾讯 EdgeOne Makers Agents | 每月 200,000 次执行、100,000 GB-s；同会话最多 40 个并发运行 | 当前适配单会话 300 秒、空闲 300 秒；仅公网 IPv4 目标；需要会话粘性，不能用无状态函数替代 | `workers/edgeone-agent/` 原生实现；已完成 HTTP 代理、SOCKS5 及连续 HTTPS 请求验证 |
| 阿里云 ESA 计算 AI 免费版 | 0 元/月、每月 100 Credits；Credits 在构建、函数、KV 等共享 | CPU 100 ms、墙钟 120 秒、10 次 Fetch；免费版 Credits 用尽停止，不自动按量付费 | 可在设置登记协议 2 兼容端点；官方函数 API 尚无原始 TCP 出站依据，不提供未经证实的 TCP 适配 |

腾讯 EdgeOne 还有其他免费额度：Cloud Functions 每月 100 万次、50 万 GB-s，Edge Functions 每月 300 万次、300 万 ms CPU。cloudproxy **没有使用无状态 Cloud Functions**，因为 GET/POST 不保证路由到同一实例，无法安全保留一条 TCP socket。Agents 的会话模式才是本适配的依据。参考[Makers 配额](https://cloud.tencent.com/document/product/1552/132789)、[Agents 概览](https://cloud.tencent.com/document/product/1552/132759)。

ESA 的旧免费函数模式是每账号每天 100,000 次、单函数全网 1,000 并发；新版计算 AI 使用 Credits，不应混为一项固定额度。ESA 站点流量/请求和函数执行又是不同计费范围。参考[新版计费说明](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/functions-and-pages-billing)和[套餐选型](https://help.aliyun.com/zh/edge-security-acceleration/esa/product-overview/package-function-comparison)。Cloudflare 参考[官方 Workers 价格](https://developers.cloudflare.com/workers/platform/pricing/)和[TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)。

## 腾讯 EdgeOne 部署

实现位于 `workers/edgeone-agent/`。先安装固定版本的官方 CLI（`npm install -g edgeone@1.7.7`）和 `npm --prefix workers/edgeone-agent ci`。在控制台确认免费版并生成 Makers **API Token**，不是腾讯云 SecretId/SecretKey。通过官方 CLI 的浏览器登录或安全输入方式认证，不要把 Token 提交到仓库。

```bash
edgeone login
python3 ops/edgeone_check.py --deploy --cli edgeone
```

工具会创建/关联项目、在仓库外生成随机节点令牌、部署 Agent，然后执行真实 TLS/HTTPS 验证。私有文件默认位于 `~/Library/Application Support/cloudproxy/`：`edgeone-node-token` 与 `edgeone-agent-access.json`，权限为 0600。只验证已有部署时省略 `--deploy`。

在设置中选择「腾讯 EdgeOne」，节点地址填 `wss://项目域名/tunnel`，节点令牌填部署工具生成的值。默认预览域名还需填写预览访问 Cookie；自定义域名留空。免费套餐的三项费率才可填 0。令牌与 Cookie 均不回显、脱敏且不提交到 GitHub。

### 传输协议与实测

EdgeOne 使用独立的协议 5：POST 打开会话并返回 SSE 下行流，后台建立 TCP；`event: ready` 表示真实建连，后续 POST 通过同一会话写入或半关闭。原始 TLS 字节只在客户端与目标网站之间传输，函数不签发证书、不终止 TLS。

2026-11-27 的实际验证包括：

- 本地 HTTP CONNECT 与 SOCKS5 均完成 `https://example.com/` GET，返回 HTTP 200。
- 连续 HTTPS 请求成功，证书校验通过。
- 本地全双工、半关闭、超时、私网目标拒绝、会话缺失拒绝和秘密脱敏测试通过。

预览域名的访问 Cookie 通常约 3 小时到期。长期使用请绑定自己的 HTTPS 域名，不要通过反复部署来刷新凭据。单会话 300 秒是平台限制，客户端应在连接结束后重新建立会话，不能把已有 TCP 静默迁移到其他节点。

## 阿里云 ESA 部署

阿里云[官方 CLI 文档](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/functions-and-pages-cli-tool)使用 `esa-cli login`，通过 AK/SK 登录。请创建仅有 ESA 所需权限的 RAM 用户，不要使用主账号 AccessKey，也不要把 AK/SK 发在聊天或提交到 GitHub。

```bash
npm install -g esa-cli
esa-cli login
esa-cli init
esa-cli dev
esa-cli commit
esa-cli deploy
```

站点函数需要绑定已经接入 ESA 的域名/路由；临时 Pages 预览地址有访问 Token 与有效期限制。部署 HTTP 函数不代表实现了本系统的 WSS/TCP 协议。ESA 的四层代理是企业版能力，也不能当作免费函数的替代。

目前可在设置中选择「阿里云 ESA · 兼容节点」，用于登记已经独立实现协议 2 的端点。需要填写真实费率；确认免费套餐后才能填 0。未来如验证原生函数 API，应按 Cloudflare 的方式补齐目标地址校验、建连确认、二进制转发和 EOF，而不是用 HTTP `fetch` 模拟 TCP。
