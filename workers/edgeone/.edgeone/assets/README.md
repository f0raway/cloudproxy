# 腾讯 EdgeOne Makers Cloud Functions（实验）

本目录是 cloudproxy 隧道协议 2 的 Node.js Cloud Functions 实现，依据腾讯公开的 WebSocket handler 模型，使用 `node:net` 建立目标 TCP。它不是普通 Edge Functions 或 SCF 的实现。

```bash
npm ci
npm test
```

免费版 Cloud Functions 每月 100 万次、50 万 GB-s，单次最多配置 120 秒。完整额度、部署凭据和当前实测限制见 [`docs/EDGE_UPSTREAMS.md`](../../docs/EDGE_UPSTREAMS.md)。

**当前云端验证未通过**：HTTP 函数部署成功、WebSocket 握手返回 101，但官方示例和本实现均没有收到帧并出现 `1006`。本地单元测试不证明腾讯云端 TCP 可用。

通过官方 CLI 登录，不要把 Makers API Token 写进仓库：

```bash
npm install -g edgeone@1.7.7
edgeone login
```

部署并进行独立的真实 TCP 验证：

```bash
python3 ops/edgeone_check.py --deploy --cli edgeone
```

`ops/edgeone_check.py` 将临时访问参数和节点令牌保存在仓库外的私有目录。长期部署请绑定自己的 HTTPS 域名。
