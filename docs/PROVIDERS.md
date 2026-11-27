# 接入任何兼容的上游

cloudproxy 提供统一的 HTTP CONNECT、HTTP 和 SOCKS5 入口。接入依据是协议能力，不是厂商名称。普通 HTTP 函数只有请求/响应能力时，不能只填一个 URL 就变成 TCP 代理。

## 选择接入方式

| 上游 | 页面选择 | 部署方式 | 费用模型 |
| --- | --- | --- | --- |
| 腾讯云 SCF Web 函数 | 腾讯云 SCF | `deploy/deploy.py` + Go 节点 | 内置参考单价，可覆盖 |
| Cloudflare Workers | Cloudflare Workers Free | `deploy/cloudflare.py` + Worker 代码 | 本地零单价模型，另有限额保护 |
| 其他云函数、容器或自建服务 | 通用 WSS/TCP | 自行部署 Go `-node` 或实现协议 2 | 必须明确填写三项单价 |

这里的“支持其他平台”表示可以接入兼容节点，不表示仓库已有每家厂商的自动部署器。云平台还可能限制 TCP 目标、WebSocket、连接寿命、并发或出口地址；请先验证平台能力。官方文档入口：Cloudflare 的 TCP sockets 文档、腾讯云 SCF Web 函数文档。

### 腾讯云 EdgeOne（EO）与阿里云 ESA

两家都有免费额度，但尚未验证它们的免费边缘函数能作为本项目的原生 TCP 出口，不提供内置适配或自动部署。

| 平台 | 接入前需要确认 |
| --- | --- |
| 腾讯云 EdgeOne | [Edge Functions](https://cloud.tencent.com/document/product/1552/127416) 列出的 `fetch` 是 HTTP 请求能力，不是 TCP socket。Makers 的 Node.js Cloud Functions 是[另一种运行时](https://cloud.tencent.com/document/product/1552/127415)，不能据此判断免费 Edge Functions 兼容。检查[实际套餐](https://cloud.tencent.com/document/product/1552/94165)。 |
| 阿里云 ESA | [函数 RuntimeAPI 手册](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/runtimeapi-manual) 未列出原始 TCP 出站 API。站点的 WebSocket 回源也不等于函数能拨号到任意目标；[站点网络优化文档](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/network-optimization)说明免费站点不能开启该功能。函数的免费额度见[计费说明](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/functions-and-pages-billing)。 |

若目标运行时实测满足下文的全部协议要求，选“通用 WSS/TCP”接入，并按实际套餐填写费率。若使用厂商回源转发到自建节点，TCP 出口是自建节点，而非边缘函数；仍需核对回源套餐与自建成本。

## 上游必须具备的能力

1. 提供有效证书保护的 `wss://主机/tunnel`，允许升级为 WebSocket。
2. 校验 `X-Tunnel-Token`，读取 `X-Tunnel-Target: host:port` 和 `X-Tunnel-Protocol: 2`。
3. 能自行解析目标域名、拒绝非公网地址，然后建立出站 TCP。不能只支持 HTTP fetch。
4. 升级后先发送 JSON 文本确认：成功 `{"ok":true}`；目标失败 `{"ok":false,"error":"target","detail":"原始错误"}`；平台明确不支持目标时用 `error:"unsupported"`。
5. 确认成功后通过二进制 WebSocket 帧转发 TCP 字节，支持文本 `EOF` 的单向半关闭；不要把业务数据转成 JSON 或 Base64。
6. 关闭连接时释放目标 socket；对令牌、消息大小、连接时长、空闲和流量设置边界。

完整流程及现有帧限制见 [架构与协议](ARCHITECTURE.md)。可复用 `node.go`、`stream.go` 或 `workers/cloudflare` 的实现及测试；入口只接受协议 2 的建连确认。

## 配置示例

以下仅为字段说明。请在私有配置或控制台填写真实值，不提交到仓库。

```json
{
  "provider": "custom",
  "region": "my-provider-primary",
  "url": "wss://node.example.org/tunnel",
  "token": "REPLACE_WITH_NODE_TOKEN",
  "rates": {
    "compute_yuan_per_second": 0.00001,
    "traffic_yuan_per_gb": 0.8,
    "request_yuan": 0.000001
  }
}
```

每个节点可以使用独立令牌；全部节点都有独立令牌时，无需顶层共享 `token`。旧共享令牌仍作为空节点令牌的回退。

单价单位分别为元/连接秒、元/GB、元/调用。只有确认上游免费时才把三项全部填为 0；这将使它参与免费优先调度，在禁用付费节点时仍可选择。Cloudflare 的每日计数只适用于 Cloudflare，不会扣到通用上游。

通用节点按端点主机隔离目标故障；一个厂商不支持某个目标，不会把其他主机上的通用节点一起停用。同一主机的多个路径共享该目标的退避。目标或节点失败最多尝试两个节点，不无限重试。已有连接始终固定在最初的上游。

## 上线验收

- 用 `-check` 检查配置，确认账户、地址、端口、单价与节点令牌正确。
- 使用真实客户端分别验证 HTTP、HTTPS CONNECT、SOCKS5，以及目标域名解析。
- HTTPS 应看到目标站点的真实证书，无需安装本系统 CA。
- 测试一个不可达目标，确认错误可见且其他目标仍能工作。
- 配置两个不同上游，临时停用其中一个，确认新连接可选择另一个；已有连接不会迁移。
- 验证预算、配额和目标范围后再放量，并检查平台账单。零本地估算不等于平台必然不收费。
