package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type runtimeSettings struct {
	Logging      *logConfig   `json:"logging,omitempty"`
	NodeNetwork  string       `json:"node_network,omitempty"`
	User         string       `json:"user"`
	Password     string       `json:"password,omitempty"`
	Budget       float64      `json:"monthly_limit_yuan"`
	Allow        []string     `json:"target_allow"`
	Deny         []string     `json:"target_deny"`
	Ports        []int        `json:"target_ports"`
	Strategy     string       `json:"routing_strategy"`
	PaidDisabled bool         `json:"paid_fallback_disabled"`
	CFDaily      int          `json:"cloudflare_daily_limit"`
	Nodes        []nodeConfig `json:"nodes"`
}

func (c agentConfig) settingsPath() string {
	if c.SettingsPath != "" {
		return c.SettingsPath
	}
	return filepath.Join(filepath.Dir(c.Ledger), "settings.json")
}
func (c agentConfig) dailyLimit() int {
	if c.CFDaily == nil {
		return 90000
	}
	return *c.CFDaily
}
func settingsFrom(c agentConfig) runtimeSettings {
	options := c.logOptions()
	network := c.NodeNetwork
	if network == "" {
		network = "auto"
	}
	return runtimeSettings{Logging: &options, NodeNetwork: network, User: c.User, Password: c.Password, Budget: c.Budget, Allow: c.TargetAllow, Deny: c.TargetDeny, Ports: c.TargetPorts, Strategy: c.Strategy, PaidDisabled: c.PaidDisabled, CFDaily: c.dailyLimit(), Nodes: c.Nodes}
}
func applySettings(c agentConfig, s runtimeSettings) agentConfig {
	if s.Logging != nil {
		c.Logging = s.Logging
	}
	if s.NodeNetwork != "" {
		c.NodeNetwork = s.NodeNetwork
	}
	c.User = s.User
	c.Password = s.Password
	c.Budget = s.Budget
	c.TargetAllow = s.Allow
	c.TargetDeny = s.Deny
	c.TargetPorts = s.Ports
	c.Strategy = s.Strategy
	c.PaidDisabled = s.PaidDisabled
	c.CFDaily = &s.CFDaily
	c.Nodes = s.Nodes
	return c
}
func readSettings(c agentConfig) (agentConfig, error) {
	raw, err := os.ReadFile(c.settingsPath())
	if os.IsNotExist(err) {
		return c, nil
	}
	if err != nil {
		return c, fmt.Errorf("cannot read private runtime settings")
	}
	var s runtimeSettings
	if json.Unmarshal(raw, &s) != nil {
		return c, fmt.Errorf("invalid runtime settings JSON")
	}
	if err = validateSettings(s); err != nil {
		return c, err
	}
	return applySettings(c, s), nil
}
func validateSettings(s runtimeSettings) error {
	if s.Logging != nil && !validLogConfig(*s.Logging) {
		return fmt.Errorf("日志单文件上限需为 1–100 MB，保留旧文件数需为 0–5")
	}
	if s.NodeNetwork != "" && s.NodeNetwork != "auto" && s.NodeNetwork != "ipv4" && s.NodeNetwork != "ipv6" {
		return fmt.Errorf("节点网络应为自动、IPv4 或 IPv6")
	}
	if strings.TrimSpace(s.User) == "" || len(s.User) > 128 || strings.ContainsAny(s.User, ":\r\n") || len(s.Password) < 8 || len(s.Password) > 255 {
		return fmt.Errorf("账号不能为空且不能含冒号；密码需为 8–255 字节")
	}
	if s.Budget <= 0 || s.Budget > 100000 || math.IsNaN(s.Budget) || math.IsInf(s.Budget, 0) {
		return fmt.Errorf("月预算需大于 0，且不超过 100000 元")
	}
	if s.Strategy != "free_first" && s.Strategy != "round_robin" {
		return fmt.Errorf("请选择免费优先或轮换调度")
	}
	if s.CFDaily < 0 || s.CFDaily > 100000 {
		return fmt.Errorf("Cloudflare 本地每日限额需为 0–100000")
	}
	if len(s.Nodes) < 1 || len(s.Nodes) > 64 {
		return fmt.Errorf("需保留 1–64 个节点，可停用节点以暂停使用")
	}
	seenURLs := map[string]bool{}
	for _, n := range s.Nodes {
		if seenURLs[n.URL] {
			return fmt.Errorf("节点地址重复，请合并重复节点")
		}
		seenURLs[n.URL] = true
		u, e := url.Parse(n.URL)
		if e != nil || u.Scheme != "wss" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || len(n.URL) > 2048 {
			return fmt.Errorf("节点地址必须是无账号、查询参数的 wss:// 地址")
		}
		if len(n.Region) > 128 || n.Region == "" || len(n.Token) > 256 || len(n.QuotaGroup) > 128 || strings.ContainsAny(n.Region+n.QuotaGroup+n.Token, "\r\n\x00") {
			return fmt.Errorf("节点名称不能为空，令牌最长 256 字节")
		}
		if n.provider() != "tencent" && n.provider() != "cloudflare" && n.provider() != "custom" {
			return fmt.Errorf("不支持的节点平台")
		}
		if n.provider() == "custom" && n.Rates == nil {
			return fmt.Errorf("其他平台节点必须填写自己的费用模型，不能默认为免费")
		}
		if n.Rates != nil && !n.Rates.valid() {
			return fmt.Errorf("节点计费单价必须为有限的非负数")
		}
	}
	if len(s.Allow)+len(s.Deny) > 400 || len(s.Ports) > 128 {
		return fmt.Errorf("目标规则或端口数量过多")
	}
	for _, rule := range append(append([]string{}, s.Allow...), s.Deny...) {
		if len(rule) > 253 || strings.TrimSpace(rule) != rule || rule == "" || strings.ContainsAny(rule, " /\\@?#\r\n\t") && !strings.Contains(rule, "/") {
			return fmt.Errorf("目标规则格式无效")
		}
		if strings.Contains(rule, "/") {
			if _, e := netip.ParsePrefix(rule); e != nil {
				return fmt.Errorf("CIDR 格式无效")
			}
			continue
		}
		if net.ParseIP(rule) != nil {
			continue
		}
		name := strings.TrimPrefix(rule, "*.")
		if name == "" || strings.ContainsAny(name, "*: ") {
			return fmt.Errorf("请输入域名、*.域名、IP 或 CIDR")
		}
	}
	for _, port := range s.Ports {
		if port < 1 || port > 65535 {
			return fmt.Errorf("目标端口需为 1–65535")
		}
	}
	return nil
}
func targetMatches(host, rule string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	rule = strings.ToLower(strings.TrimSuffix(rule, "."))
	if prefix, e := netip.ParsePrefix(rule); e == nil {
		ip, e := netip.ParseAddr(host)
		return e == nil && prefix.Contains(ip.Unmap())
	}
	if ip, e := netip.ParseAddr(rule); e == nil {
		target, e := netip.ParseAddr(host)
		return e == nil && ip.Unmap() == target.Unmap()
	}
	if strings.HasPrefix(rule, "*.") {
		suffix := rule[1:]
		return strings.HasSuffix(host, suffix) && len(host) > len(suffix)
	}
	return host == rule
}
func targetAllowed(c agentConfig, address string) bool {
	host, port, e := net.SplitHostPort(address)
	if e != nil {
		return false
	}
	for _, rule := range c.TargetDeny {
		if targetMatches(host, rule) {
			return false
		}
	}
	if len(c.TargetAllow) > 0 {
		matched := false
		for _, rule := range c.TargetAllow {
			if targetMatches(host, rule) {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	if len(c.TargetPorts) > 0 {
		for _, value := range c.TargetPorts {
			if port == fmt.Sprint(value) {
				return true
			}
		}
		return false
	}
	return true
}
func (p *provider) config() agentConfig { return *p.configValue.Load() }

// Compare effective defaults, since the UI may make implicit provider/rates explicit.
func sameNodeConfig(a, b nodeConfig) bool {
	return a.provider() == b.provider() && a.URL == b.URL && a.Token == b.Token && a.Region == b.Region && a.Disabled == b.Disabled && a.quotaGroup() == b.quotaGroup() && a.rates() == b.rates()
}
func (p *provider) saveSettings(s runtimeSettings) error {
	p.settingsMu.Lock()
	defer p.settingsMu.Unlock()
	current := p.config()
	if s.Password == "" {
		s.Password = current.Password
	}
	for i := range s.Nodes {
		if s.Nodes[i].Token == "" {
			for _, old := range current.Nodes {
				if old.URL == s.Nodes[i].URL {
					s.Nodes[i].Token = old.Token
					break
				}
			}
		}
	}
	if err := validateSettings(s); err != nil {
		return err
	}
	if err := validateNodeTokens(applySettings(current, s)); err != nil {
		return err
	}
	path := current.settingsPath()
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".settings-")
	if err != nil {
		return fmt.Errorf("无法保存配置，请检查服务配置目录权限")
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(raw)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("配置写入失败，原配置保持有效")
	}
	next := applySettings(current, s)
	p.mu.Lock()
	defer p.mu.Unlock()
	if err = os.Rename(file.Name(), path); err != nil {
		return fmt.Errorf("配置保存失败，原配置保持有效")
	}
	nodes := make([]*nodeState, 0, len(s.Nodes))
	for _, n := range s.Nodes {
		var retained *nodeState
		for _, old := range p.nodes {
			if sameNodeConfig(old.nodeConfig, n) {
				retained = old
				break
			}
		}
		if retained == nil {
			retained = &nodeState{nodeConfig: n}
		}
		nodes = append(nodes, retained)
	}
	p.nodes = nodes
	p.meter.mu.Lock()
	p.meter.limit = s.Budget
	p.meter.mu.Unlock()
	p.connections.addSecrets(next)
	p.configValue.Store(&next)
	if p.logs != nil {
		if err := p.logs.configure(next.logOptions()); err != nil {
			return fmt.Errorf("配置已保存，但日志参数应用失败：%v", err)
		}
	}
	return nil
}
func (p *provider) settingsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		c := p.config()
		s := settingsFrom(c)
		s.Password = ""
		s.Nodes = append([]nodeConfig{}, s.Nodes...)
		for i := range s.Nodes {
			s.Nodes[i].Token = ""
		}
		json.NewEncoder(w).Encode(map[string]any{"settings": s, "csrf_token": p.csrf, "password_set": true, "note": "保存即时生效；已有 TCP 连接保持不变。Cloudflare 限额仅统计本入口，不代表账号剩余额度。"})
		return
	}
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", 405)
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-CSRF-Token")), []byte(p.csrf)) != 1 || p.csrf == "" {
		http.Error(w, "请刷新配置页后重试", 403)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, e := url.Parse(origin)
		if e != nil || u.Host != r.Host {
			http.Error(w, "跨站配置请求已拒绝", 403)
			return
		}
	}
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "JSON required", 415)
		return
	}
	var s runtimeSettings
	decoder := json.NewDecoder(io.LimitReader(r.Body, 128*1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&s) != nil {
		http.Error(w, "配置 JSON 无效", 400)
		return
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		http.Error(w, "配置 JSON 无效", 400)
		return
	}
	previous := p.config()
	if err := p.saveSettings(s); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	current := p.config()
	json.NewEncoder(w).Encode(map[string]any{"saved": true, "reauthenticate": previous.User != current.User || previous.Password != current.Password})
}
func newCSRF() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("cannot initialize secure settings token")
	}
	return hex.EncodeToString(b[:])
}
