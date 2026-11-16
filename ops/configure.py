#!/usr/bin/env python3
"""Create a private entry configuration. Does not deploy or contact cloud services."""
import argparse
import getpass
import json
import os
from pathlib import Path
from urllib.parse import urlsplit


def create_config(output, provider, endpoint, token, user, password, budget, rates):
    parsed = urlsplit(endpoint)
    if (parsed.scheme != "wss" or not parsed.hostname or parsed.username is not None
            or parsed.query or parsed.fragment):
        raise ValueError("节点地址必须是无账号、查询参数的 wss:// 地址")
    if not token or len(token) > 256 or any(c in token for c in "\r\n\x00"):
        raise ValueError("请填写节点部署时设置的令牌，最长 256 字节")
    if not user or ":" in user or any(c in user for c in "\r\n") or len(user.encode()) > 128:
        raise ValueError("账号不能为空，不能含冒号或换行")
    if not 8 <= len(password.encode()) <= 255:
        raise ValueError("代理密码需要 8–255 字节")
    if not 0 < budget <= 100000:
        raise ValueError("月预算需大于 0 且不超过 100000 元")
    node = {"provider": provider, "region": "my-" + provider, "url": endpoint, "token": token}
    if provider == "custom":
        if rates is None or any(not 0 <= v < float("inf") for v in rates.values()):
            raise ValueError("通用节点必须提供三项非负的实际单价；免费节点明确填写 0")
        node["rates"] = rates
    config = {"http_addr": "0.0.0.0:10800", "socks_addr": "0.0.0.0:10801",
              "dashboard_addr": "127.0.0.1:8081", "user": user, "password": password,
              "nodes": [node], "ledger_path": "/var/lib/scf-tunnel-proxy/usage.json",
              "monthly_limit_yuan": budget, "max_connections": 32,
              "routing_strategy": "free_first", "paid_fallback_disabled": False,
              "cloudflare_daily_limit": 90000, "node_network": "auto",
              "logging": {"enabled": True, "max_file_mb": 5, "backups": 2}}
    # Refuse existing files, including symlinks. Never print secrets or overwrite a deployment.
    with os.fdopen(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
        json.dump(config, file, ensure_ascii=False, indent=2)
        file.write("\n")
    return config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("config/agent.json"))
    args = parser.parse_args()
    if args.output.exists():
        parser.error("输出文件已存在，不会覆盖；请选择一个新文件")
    print("CloudProxy 配置向导：请先部署兼容协议 2 的节点。此向导不创建云资源。")
    provider = input("上游类型 cloudflare / tencent / custom [custom]: ").strip() or "custom"
    if provider not in {"cloudflare", "tencent", "custom"}:
        parser.error("请选择 cloudflare、tencent 或 custom")
    endpoint = input("已部署节点的 WSS 地址: ").strip()
    token = getpass.getpass("节点令牌（不回显）: ")
    user = input("代理账号 [cloudproxy]: ").strip() or "cloudproxy"
    password = getpass.getpass("代理密码（至少 8 字节，不回显）: ")
    if password != getpass.getpass("再输入一次密码: "):
        parser.error("两次密码不一致")
    try:
        budget = float(input("每月本地费用保护上限，单位元 [8]: ").strip() or "8")
        rates = None
        if provider == "custom":
            print("以下是本地估算模型，不是平台报价；免费节点三项均填 0。")
            rates = {key: float(input(label)) for key, label in [
                ("compute_yuan_per_second", "计算费（元/连接秒）: "),
                ("traffic_yuan_per_gb", "流量费（元/GB）: "), ("request_yuan", "调用费（元/次）: ")]}
        create_config(args.output, provider, endpoint, token, user, password, budget, rates)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    print(f"已生成私有配置：{args.output}（权限 600）。可继续执行安装，或用 -check 检查。")

if __name__ == "__main__":
    main()
