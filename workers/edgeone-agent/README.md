# 腾讯 EdgeOne Makers Agent 隧道

这是 cloudproxy 的 EdgeOne 原生上游，使用 Makers **Agents 会话模式**，不是普通 Edge Functions、SCF 或无状态 Cloud Functions。同一 `conversation_id` 的请求由官方运行时路由到同一实例，目标 TCP socket 始终保留在该会话中，不重放应用数据、不迁移连接。

## 能力与限制

- 免费 Agents 配额：每月 200,000 次执行、100,000 GB-s；当前配置单会话最长 300 秒、空闲 300 秒，最多 40 个并发会话。套餐以控制台为准。
- 使用 `node:net` 建立原始 TCP，目标仅限公网 IPv4；拒绝私网、回环、保留及文档地址。不会调用模型或创建沙箱。
- `POST open` 打开 SSE 下行流并后台建连；`event: ready` 才表示目标 TCP 已连接。`POST write/eof` 通过同一会话上传或半关闭，二进制以 Base64 事件承载，不会终止目标 TLS。
- 默认预览域名需要有效期约 3 小时的访问 Cookie。生产使用应绑定自定义 HTTPS 域名，避免刷新预览凭据。

## 测试与部署

```bash
npm ci
npm test
npm install -g edgeone@1.7.7
edgeone login
```

在 Makers 控制台确认免费版并生成 API Token。不要把 Token 或节点令牌提交到仓库。回到仓库根目录执行：

```bash
python3 ops/edgeone_check.py --deploy --cli edgeone
```

工具会创建/关联项目、在仓库外生成随机节点令牌、部署函数，然后执行真实 TLS/HTTPS 验证。私有文件默认位于 `~/Library/Application Support/cloudproxy/`：`edgeone-node-token` 和 `edgeone-agent-access.json`，权限为 0600。只验证已有部署时省略 `--deploy`。

在 cloudproxy 设置中选择「腾讯 EdgeOne」，填写：

- 节点地址：`wss://项目域名/tunnel`；客户端会将其映射到 HTTPS POST/SSE。
- 节点令牌：部署工具生成的随机值。
- 预览访问 Cookie：仅默认预览域名需要，自定义域名留空。
- 费率：确认免费套餐后三项填 0；其他套餐按实际单价填写。

设置不回显节点令牌或访问 Cookie，日志会对两者脱敏。
