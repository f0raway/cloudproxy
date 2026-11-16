# 部署 CloudProxy

本指南面向已有兼容上游的 Linux systemd 服务器。HTTP/SOCKS5 端口只应对可信客户端开放；控制台默认仅本机可访问。云端管理密钥留在部署工具中，入口只需要节点地址和节点令牌。

## 1. 准备一个上游

任选一种：

- [Cloudflare 部署](CLOUDFLARE.md)。
- [腾讯云部署](../README.md#腾讯云部署详解)。
- [其他厂商或自建服务](PROVIDERS.md)。

得到 `wss://…/tunnel` 和该节点实际使用的令牌。只得到普通 HTTP 函数 URL 时，请先确认协议兼容。

## 2. 构建入口

需要 Go 版本以 `go.mod` 为准、Python 3.11+，并使用支持 systemd 的 Linux 服务器。

```bash
git clone https://github.com/f0raway/scf-tunnel-proxy.git
cd scf-tunnel-proxy
bash ops/build.sh          # x86_64 / amd64
# ARM64 服务器改用：bash ops/build.sh arm64
```

可在另一台机器上交叉编译，再把二进制、`ops/` 和私有配置复制到服务器。下面的检查与安装命令必须在匹配架构的 Linux 上执行。

## 3. 交互生成私有配置

```bash
python3 ops/configure.py --output config/agent.json
```

向导询问上游类型、WSS 地址、节点令牌、代理账号密码与月度保护金额。密码和令牌不回显，文件权限为 600；已有文件不会覆盖。通用平台必须填写真实单价，免费平台明确填 0。此步骤不会联系云平台或创建资源。

## 4. 检查并安装

```bash
./dist/scf-tunnel-linux-amd64 -check -config config/agent.json
sudo bash ops/install.sh dist/scf-tunnel-linux-amd64 config/agent.json
```

ARM64 替换二进制文件名。检查会同时读取已有页面配置覆盖值，验证实际生效的配置，不监听端口、不修改账本、不调用云端。

安装器使用独立服务用户、开机自启、进程异常重启、本地健康检查和有界日志。更新失败时恢复之前的程序/配置/服务文件，保留当前费用及配额账本；备份路径会显示。已有定制部署请按 [迁移说明](EXISTING_DEPLOYMENT.md) 操作，不直接套用通用目录。

## 5. 打开控制台与连接代理

在自己的电脑上建立 SSH 转发：

```bash
ssh -L 18081:127.0.0.1:8081 your-user@your-server
```

打开 `http://127.0.0.1:18081`，输入刚设置的代理账号密码。在配置页添加更多节点，设置目标范围、费用保护和日志保留。

客户端代理地址为服务器 IP，HTTP/CONNECT 端口 `10800`、SOCKS5 端口 `10801`。启用账号密码认证。SOCKS 客户端应由代理解析目标域名，避免本地 Fake-IP 被传给服务器。

控制台显示入口运行时间、节点状态与连接记录。首次部署显示“尚未验证”，只有实际建连才会出现成功记录。请用客户端访问你有权访问的 HTTPS 站点，确认目标证书正常且控制台显示连接成功。

## 6. 长期运行

```bash
sudo systemctl status scf-tunnel-proxy --no-pager
sudo python3 /opt/scf-tunnel-proxy/local_health.py
sudo journalctl -u scf-tunnel-proxy -n 50 --no-pager
```

本地检查不会调用云函数，因此通过仅表示入口正常；节点额度耗尽或外网故障不会触发无效的反复重启。配置页保存普通设置会保留未改动节点的统计和故障冷却。持续运行仍需要主机、电源、网络、云服务与配额可用；单机故障会影响入口，升级与崩溃后客户端需要重连。详见 [运维与恢复](OPERATIONS.md)。
