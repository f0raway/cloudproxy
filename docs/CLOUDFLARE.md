# Cloudflare Workers 节点

## 原理与免费额度

Worker 通过 WebSocket 协议 2 接收入口的 TCP 字节流，用 `cloudflare:sockets` 建立目标 TCP 连接，转发二进制消息，支持 `EOF` 半关闭。客户端与目标网站的 TLS 仍端到端透传，无需安装 CA。不使用 Durable Objects、KV、R2 或付费套餐切换接口。

Workers Free 的每日 100,000 次是**账号级入站请求限额**；WebSocket 初始 Upgrade 计一次请求，普通 WebSocket 消息不按额外请求计数。免费计划仍有 CPU 等资源限制，连接可能被平台关闭，不能承诺所有目标或长期会话始终可用。参考 [官方价格](https://developers.cloudflare.com/workers/platform/pricing/)、[限制](https://developers.cloudflare.com/workers/platform/limits/)。

Workers TCP 出站不能连接 Cloudflare 自身 IP、私网或 SMTP 25 端口，部分网站因此无法通过该节点访问。Worker 会将平台特有限制报告为 `unsupported`，入口可按配置回退到其他平台并缓存该目标的平台限制。参考 [官方 TCP 接口](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)。

免费 Cloudflare 节点报告目标 DNS/TCP 错误且允许付费回退时，会再尝试一次付费节点，并将该目标的免费路径短暂冷却 30 秒；付费节点本身的目标错误不继续跨区域重试。平台明确不支持目标时，免费路径缓存 10 分钟。关闭付费回退后不会执行这些付费尝试。

## 准备凭据

到 [API Tokens](https://dash.cloudflare.com/profile/api-tokens) 创建自定义 Token，只给目标账号的 **Account / Workers Scripts / Edit** 权限。使用 workers.dev 不需要 DNS/Zone 权限。Account ID 是账号标识，不是 Token ID；在控制台按 Ctrl/Cmd+K 搜索 `Copy account ID`，或到 Workers & Pages 的 Account Details 复制。[官方查找方法](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/)

将凭据放在仓库外，权限 600：

```toml
[cloudflare]
account_id = "YOUR_ACCOUNT_ID"
api_token = "YOUR_API_TOKEN"
worker_name = "cloud-tunnel-proxy"
```

## 部署

Python 3.11+；无需安装第三方部署库。先离线检查：

```bash
python3 deploy/cloudflare.py --dry-run
```

部署 Worker，但先不加入入口池：

```bash
python3 deploy/cloudflare.py --credentials /path/to/private/cloudflare.toml --no-register
```

脚本使用 Cloudflare 官方 API 上传 ES modules、Secret binding，启用脚本 workers.dev 地址；若账号尚无子域名则创建随机的账号 workers.dev 子域名。不会覆盖非本工具标记的同名 Worker。项目节点令牌单独生成，600 保存在凭据文件旁，另存私有节点状态 `cloudflare-node.json`。

确认节点 DNS、TLS 和 TCP 转发可用，再部署并注册到入口（使用实际基础配置路径）：

```bash
python3 deploy/cloudflare.py --credentials /path/to/private/cloudflare.toml \
  --agent-config /etc/scf-tunnel-proxy/agent.json
```

入口需运行带 `/api/settings` 的新版本。部署工具通过已认证、CSRF 保护的管理接口注册节点并保留已有设置；不会把 Cloudflare API Token 交给代理进程或写进网页。用户也可在配置页手工添加已部署节点、选择 Cloudflare、填写其私有节点令牌和配额组。

## 网络验证与其他平台

部署 API 成功只说明代码上传成功，不能证明入口能访问 workers.dev。有些网络中，该域名会解析失败或 TLS 被重置；不要关闭证书校验来处理。可使用账号已有的自有域名，并在 Cloudflare 绑定至该 Worker，随后将入口节点 URL 改为对应的 `wss://子域名/tunnel`。绑定域名需要对应 Zone 的路由权限；它不同于账号的 `某名称.workers.dev` 子域名。验证前保持节点停用，腾讯云节点继续提供转发。

其他平台尚未确定时不要自动购买资源。仓库另提供通用 `workers/Dockerfile`：支持 WebSocket 透传、长连接与公网 TCP 出站的容器平台可运行 Go 节点；环境变量 `CLOUD_PROXY_TOKEN` 必须设置，`PORT` 默认 9000。不同平台的请求超时、并发、出网、费用与协议支持需单独核验，不能把普通函数 URL 直接视为兼容代理节点。


## 保留自有域名

域名在 Cloudflare 绑定到本工具管理的 Worker 并启用后，可在私有凭据 TOML 的 `[cloudflare]` 中添加：

```toml
custom_domain = "proxy.example.com"
```

部署工具会核对该域名是否已启用并归属于同一账号、同一 Worker。此时重新部署和注册继续使用 `wss://proxy.example.com/tunnel`，不会改回 workers.dev，也不会创建或覆盖其他域名绑定。这个字段不能代替 Cloudflare 上的域名绑定步骤；新绑定需要相应域名的 Workers 路由权限。绑定前应确认子域名未被其他网站或 DNS 记录占用，绑定后仍需验证 DNS、证书、WebSocket 及目标 TCP。
