# 成本优化与账单接入

## 省掉哪些无效开销

1. 入口校验主机/端口，并拒绝私网、回环、链路本地、CGNAT、文档与基准测试等非公网 IP，包括 `198.18.0.0/15`。拒绝发生在云调用和费用预留之前，IPv4-mapped IPv6 同样检查。云节点解析域名后使用相同规则，避免 DNS 指向不可公网访问的地址。
2. 对同一未知或失败目标（规范化后的 host:port）只允许一个在途探测。并发等待者在探测失败后本地返回；成功后分别建立自己的 TCP 隧道，不共享连接，不影响各连接的独立区域调度。
3. 付费节点目标 DNS/TCP 错误不立即换区重试，间隔依次为 30 秒、1/2/4/8/10 分钟。成功恢复后清除失败计数；长时间没有请求也会重置失败级别。云节点本身的握手等故障仍最多换区重试一次，不把目标失败当成区域故障。
4. 目标状态最多 2,048 项，优先淘汰非在途探测的旧记录。等待初始探测最长 5 秒，取消或服务停止可打断等待，不占用云调用。冷却状态为内存状态，重启后重新探测。
5. 重复预算/并发/无节点拒绝的磁盘日志每分钟采样并汇总；页面连接记录与计数照常更新。

不改变客户端代理范围、预算上限、正常 TCP 会话、空闲时限或最大连接时长。代理服务器不能代替客户端还原 Fake-IP 对应域名；若出现 `198.18.x.x`，需让客户端通过 SOCKS5 提交域名，或修正其 DNS/Fake-IP 配置。

## 本地费用模型 v2

按入口观察的连接尝试持续时长、隧道字节保守估算，并保留滚动预留。取消旧算法每次无条件追加的 3 秒；入口观察的握手/等待时间已计入尝试时长，重复追加会在大量短连接时积累明显偏差。

- `cost_estimate.estimated_yuan`：本地预算占用，含待用预留，不是云账单。
- `cost_breakdown.usage_estimated_yuan`：扣除当前活跃连接待用预留后的本地运行估算。
- `cost_breakdown.pending_reserve_yuan`：当前活跃连接尚未使用的预留。
- `legacy_estimated_yuan` / `legacy_fixed_allowance_removed_yuan`：首次迁移时的旧估算与移除的固定余量。

旧账本同月且尚无 `model_version` 时，一次性扣除不超过原估算的 `invocations × 3 秒 × 128MB 计算参考单价`，记录审计字段，设置 `model_version=2`。以后启动不会再次扣减；调用次数与流量不清零，预算不提高。跨月按原机制切换新月，不把上月校正转成本月额度。异常退出遗留的其他预留仍保守保留。

**校正只是估算变化，不是云账单退款，也不保证精确封顶。** 升级应备份原账本。云端真实使用、外部直接调用、日志等可能与本地模型不同。

## 可选：每小时读取腾讯云账单

此采集器只调用 `DescribeBillSummaryByProduct`，不调用 SCF 函数、不创建资源。与代理进程分离，使用独立 Python 环境（3.11+，安装 `tencentcloud-sdk-python-common`），凭据来自私有 TOML 的 `[tencent] secret_id/secret_key`。代理进程只读取缓存，无需获得腾讯云密钥。

```bash
/path/to/private/venv/bin/python ops/billing_sync.py \
  --credentials /path/to/private/deploy.toml \
  --output /var/lib/scf-tunnel-proxy/billing.json \
  --group scftunnel
```

使用现有 systemd/cron 每小时运行同一命令，再在入口配置中添加：

```json
{"billing_cache_path": "/var/lib/scf-tunnel-proxy/billing.json"}
```

这是现有完整配置的**新增字段**，不要用此单行替换完整配置。采集器使用 `billing.tencentcloudapi.com`，凭据至少需允许只读账单汇总；不要把凭据放入仓库、命令行或代理配置。缓存原子写入，权限 640，指定代理服务用户所属组。

`cloud_bill` 返回 `available`、`scope=account_scf`、`month`、`scf_total_yuan`、`updated_at` 和 `stale`。超过两小时标记旧缓存；当前月无数据或格式错误显示“不可用”，不冒充零元。查询失败保留旧缓存，不影响代理和健康检查。

**账单金额为账号下全部 SCF 的已出账合计，可能延迟，不一定完全属于这个代理池。** 页面与本地预算分别展示，不自动用账单覆盖费用账本，也不因账单暂时未更新而放开预算。

多平台调度和免费节点回退规则见 [页面配置](SETTINGS.md)，免费节点不使用腾讯云计算费模型。
