# 三大免费上游：额度、限制与部署

文档核对日期：2026-11-27。免费额度、功能与套餐会变化，实际以部署时控制台为准。**腾讯 EdgeOne 与阿里云 ESA 是系统的核心上游方向，但目前只有 Cloudflare 具备已验证的原生 Worker TCP 实现。**

| 上游 | 免费额度 | 与代理相关的限制 | cloudproxy 当前状态 |
| --- | --- | --- | --- |
| Cloudflare Workers Free | 每账号每天 100,000 次请求；本系统默认本地限制为 90,000 次 | 单次 CPU 10 ms；`connect()` 不允许 Cloudflare 网络、私网目标及 25 端口；同账号节点共享额度 | 已有 Worker 和部署器；使用真实连接结果判断节点可用性 |
| 腾讯 EdgeOne Makers 免费版 | Cloud Functions 每月 100 万次、50 万 GB-s；Edge Functions 每月 300 万次、300 万 ms CPU；40 个项目、500 次构建/月 | Cloud Functions 默认 30 秒，最多配置 120 秒；代码含依赖 128 MB；请求/响应 6 MB；免费版不能改 Cloud Functions 地域 | 有实验性 Cloud Functions 实现和部署工具。**2026-11-27 的 HTTP 函数部署成功，但 WebSocket 帧及 TCP 验证未通过，不启用为可用上游** |
| 阿里云 ESA 计算 AI 免费版 | 0 元/月、每月 100 Credits；Credits 在构建、函数、KV 等共享 | CPU 100 ms、墙钟 120 秒、10 次 Fetch；免费版 Credits 用尽停止，不自动按量付费 | 可在设置登记协议 2 兼容端点；官方函数 API 尚无原始 TCP 出站依据，不提供未经证实的 TCP 适配 |

ESA 的旧免费函数模式是每账号每天 100,000 次、单函数全网 1,000 并发；新版计算 AI 使用 Credits，不应混为一项固定额度。ESA 站点流量/请求和函数执行又是不同计费范围。参考[新版计费说明](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/functions-and-pages-billing)和[套餐选型](https://help.aliyun.com/zh/edge-security-acceleration/esa/product-overview/package-function-comparison)。

腾讯 EdgeOne Makers 与普通 EdgeOne 站点、腾讯云 SCF 是不同产品。新专业版资源按 MU 等计量，不能因为产品名里有 EdgeOne 就默认免费。参考[Makers 配额](https://cloud.tencent.com/document/product/1552/132789)、[资源计费](https://cloud.tencent.com/document/product/1552/140891)。Cloudflare 参考[官方 Workers 价格](https://developers.cloudflare.com/workers/platform/pricing/)和[TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)。

## 腾讯云部署

使用 `workers/edgeone/` 下的 Node.js Cloud Functions 实现。先安装固定版本的官方 CLI（`npm install -g edgeone@1.7.7`）和 `npm --prefix workers/edgeone ci`。在控制台开通免费版，从 **API Token** 页面生成 Makers Token，不是腾讯云 SecretId/SecretKey。通过官方 CLI 的浏览器登录或安全输入方式认证，不要把 Token 提交到仓库。

工具会自动创建/关联项目，并在仓库外生成随机节点令牌；不需要把节点令牌手写在命令中。部署与实际 TCP 验证分离：

```bash
# 返回仓库根目录；已登录的官方 CLI 无需把 Token 放进命令行。
python3 ops/edgeone_check.py --deploy --cli edgeone
```

该工具把临时预览访问参数保存在私有目录（默认 `~/Library/Application Support/cloudproxy/edgeone-access.json`），不会将部署 URL 或节点令牌写进仓库。长期使用建议绑定自己的 HTTPS 域名，避免依赖临时预览访问参数。

### 当前实测结果

2026-11-27 在 `global` 和 `overseas` 项目都部署了本实现：

- HTTP 函数正常返回，`node:net` 和 DNS API 存在。
- WebSocket 握手返回 HTTP 101，但没有收到函数回调发送的文本帧，随后以 `1006` 关闭。
- 部署腾讯官方 [`TencentEdgeOne/pages-websocket`](https://github.com/TencentEdgeOne/pages-websocket) 后，其浏览器示例同样反复 `1006`，没有收到 `ready` 消息。因此当前故障并非只由 cloudproxy 的 TCP 代码导致。
- 上述结果不代表腾讯未来版本或其他域名/区域也不可用。修复平台链路后运行 `ops/edgeone_check.py`，只有真实 TCP 返回目标 HTTP 响应才能启用节点。

`edgeone_live_test.go` 默认跳过，只有显式提供授权节点凭据时才访问云端。不要因为编译通过或部署成功而填写假的健康状态。

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
