package main

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/gorilla/websocket"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type targetDialError struct{ detail string }

func (e *targetDialError) Error() string { return "target connection failed: " + e.detail }

type nodeConfig struct {
	Provider   string     `json:"provider,omitempty"`
	Disabled   bool       `json:"disabled,omitempty"`
	Token      string     `json:"token,omitempty"`
	QuotaGroup string     `json:"quota_group,omitempty"`
	Rates      *costRates `json:"rates,omitempty"`
	Region     string     `json:"region"`
	URL        string     `json:"url"`
}
type agentConfig struct {
	Logging        *logConfig   `json:"logging,omitempty"`
	NodeNetwork    string       `json:"node_network,omitempty"`
	SettingsPath   string       `json:"settings_path,omitempty"`
	TargetAllow    []string     `json:"target_allow,omitempty"`
	TargetDeny     []string     `json:"target_deny,omitempty"`
	TargetPorts    []int        `json:"target_ports,omitempty"`
	Strategy       string       `json:"routing_strategy,omitempty"`
	PaidDisabled   bool         `json:"paid_fallback_disabled,omitempty"`
	CFDaily        *int         `json:"cloudflare_daily_limit,omitempty"`
	HTTP           string       `json:"http_addr"`
	SOCKS          string       `json:"socks_addr"`
	BillingCache   string       `json:"billing_cache_path,omitempty"`
	Dashboard      string       `json:"dashboard_addr"`
	User           string       `json:"user"`
	Password       string       `json:"password"`
	Token          string       `json:"token"`
	Nodes          []nodeConfig `json:"nodes"`
	Ledger         string       `json:"ledger_path"`
	Budget         float64      `json:"monthly_limit_yuan"`
	MaxConnections int          `json:"max_connections"`
}
type nodeState struct {
	nodeConfig
	Failures       int
	RetryAfter     time.Time
	Opens          uint64
	LastError      string
	TargetFailures uint64
}
type provider struct {
	logs                 *runtimeLogs
	configValue          atomic.Pointer[agentConfig]
	settingsMu           sync.Mutex
	csrf                 string
	daily                *dailyQuota
	billingCache         string
	rejectionLog         *log.Logger
	connections          *connectionLog
	targets              *targetPolicy
	cachedTargetFailures atomic.Uint64
	allowPrivate         bool // Only enabled by local tests; never populated from configuration.
	lifeMu               sync.Mutex
	stopping             bool
	opening              sync.WaitGroup
	live                 map[*wsStream]struct{}
	stopCtx              context.Context
	cancel               context.CancelFunc
	mu                   sync.Mutex
	nodes                []*nodeState
	index                int
	token                string
	meter                *meter
	slots                chan struct{}
	active               atomic.Int64
	success              atomic.Uint64
	failed               atomic.Uint64
	rejectedPrivate      atomic.Uint64
	rejectedLimit        atomic.Uint64
	rejectedBudget       atomic.Uint64
	noNodes              atomic.Uint64
}

func newProvider(c agentConfig) (*provider, error) {
	if len(c.Nodes) == 0 || c.Token == "" {
		return nil, fmt.Errorf("missing authenticated nodes")
	}
	m, e := openMeter(c.Ledger, c.Budget)
	if e != nil {
		return nil, e
	}
	stopCtx, cancel := context.WithCancel(context.Background())
	limit := c.MaxConnections
	if limit == 0 {
		limit = 32
	}
	if limit < 1 || limit > 64 {
		cancel()
		return nil, fmt.Errorf("max_connections must be between 1 and 64")
	}
	quota, quotaErr := openDailyQuota(quotaPath(c))
	if quotaErr != nil {
		cancel()
		return nil, quotaErr
	}
	if c.Strategy == "" {
		c.Strategy = "free_first"
	}
	p := &provider{daily: quota, csrf: newCSRF(), billingCache: c.BillingCache, rejectionLog: log.New(&limitedSOCKSLog{}, "proxy_reject ", log.LstdFlags), connections: newConnectionLog(c), token: c.Token, meter: m, slots: make(chan struct{}, limit), live: make(map[*wsStream]struct{}), targets: newTargetPolicy(), stopCtx: stopCtx, cancel: cancel}
	p.configValue.Store(&c)
	for _, n := range c.Nodes {
		if !n.rates().valid() || (n.provider() == "custom" && n.Rates == nil) {
			cancel()
			return nil, fmt.Errorf("invalid or missing provider cost model")
		}
		if n.provider() != "tencent" && n.provider() != "cloudflare" && n.provider() != "custom" {
			cancel()
			return nil, fmt.Errorf("unknown node provider")
		}
		p.nodes = append(p.nodes, &nodeState{nodeConfig: n})
	}
	return p, nil
}
func (p *provider) next(exclude map[*nodeState]bool) *nodeState { return p.nextFor(exclude, "") }
func (p *provider) nextFor(exclude map[*nodeState]bool, address string) *nodeState {
	p.mu.Lock()
	defer p.mu.Unlock()
	cfg := p.config()
	phases := 1
	if cfg.Strategy == "free_first" {
		phases = 2
	}
	for phase := 0; phase < phases; phase++ {
		for i := 0; i < len(p.nodes); i++ {
			index := (p.index + i) % len(p.nodes)
			n := p.nodes[index]
			free := n.provider() == "cloudflare"
			if p.targets.providerBlocked(address, n.provider()) || n.Disabled || exclude[n] || time.Now().Before(n.RetryAfter) || (!free && cfg.PaidDisabled) {
				continue
			}
			if free && !p.daily.available(n.quotaGroup(), cfg.dailyLimit()) {
				continue
			}
			if phases == 2 && ((phase == 0 && !free) || (phase == 1 && free)) {
				continue
			}
			p.index = (index + 1) % len(p.nodes)
			return n
		}
	}
	return nil
}

// Report the same exclusions used by nextFor without exposing endpoint URLs.
func (p *provider) noEligibleReason(address string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	counts := make([]int, 5)
	cfg := p.config()
	for _, n := range p.nodes {
		switch {
		case n.Disabled:
			counts[0]++
		case n.provider() != "cloudflare" && cfg.PaidDisabled:
			counts[1]++
		case p.targets.providerBlocked(address, n.provider()):
			counts[2]++
		case time.Now().Before(n.RetryAfter):
			counts[3]++
		case n.provider() == "cloudflare" && !p.daily.available(n.quotaGroup(), cfg.dailyLimit()):
			counts[4]++
		}
	}
	labels := []string{"已停用节点", "付费回退被关闭的节点", "对此目标退避的平台节点", "故障冷却节点", "今日额度已用尽的节点"}
	var reasons []string
	for i, count := range counts {
		if count > 0 {
			reasons = append(reasons, fmt.Sprintf("%s %d 个", labels[i], count))
		}
	}
	if len(reasons) == 0 {
		return "当前节点选择状态已变化，请重试并查看节点状态"
	}
	return strings.Join(reasons, "；")
}

func (p *provider) mark(n *nodeState, ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if ok {
		n.Failures = 0
		n.RetryAfter = time.Time{}
		n.Opens++
	} else {
		n.Failures++
		if n.Failures >= 3 {
			n.RetryAfter = time.Now().Add(30 * time.Second)
		}
	}
}
func (p *provider) dial(ctx context.Context, network, address string) (net.Conn, error) {
	r := recordFrom(ctx)
	r.target(address, "queued")
	conn, err := p.dialTunnel(ctx, network, address)
	if err != nil {
		r.finish(err)
	}
	return conn, err
}
func (p *provider) dialTunnel(ctx context.Context, network, address string) (connection net.Conn, result error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var normalizeErr error
	address, normalizeErr = normalizeTarget(address)
	if normalizeErr != nil {
		return nil, normalizeErr
	}
	record := recordFrom(ctx)
	if !targetAllowed(p.config(), address) {
		return nil, fmt.Errorf("target rejected by configured allow/deny/port scope")
	}
	host, _, splitErr := net.SplitHostPort(address)
	if splitErr != nil {
		return nil, splitErr
	}
	if ip := net.ParseIP(host); !p.allowPrivate && ip != nil && !publicTargetIP(ip) {
		p.rejectedPrivate.Add(1)
		return nil, fmt.Errorf("private/local or reserved target %s cannot be reached through SCF; fake-IP targets require proxy-side DNS, LAN targets require Direct in Proxifier", address)
	}

	p.lifeMu.Lock()
	if p.stopping {
		p.lifeMu.Unlock()
		return nil, fmt.Errorf("proxy is stopping")
	}
	p.opening.Add(1)
	p.lifeMu.Unlock()
	defer p.opening.Done()
	ctx, cancel := context.WithCancel(ctx)
	stopCancel := context.AfterFunc(p.stopCtx, cancel)
	defer func() { stopCancel(); cancel() }()

	releaseProbe, gateErr := p.targets.acquire(ctx, address)
	if gateErr != nil {
		var gated *targetGateError
		if errors.As(gateErr, &gated) {
			p.cachedTargetFailures.Add(1)
		}
		return nil, gateErr
	}
	defer func() { releaseProbe(result) }()

	queueTimer := time.NewTimer(5 * time.Second)
	defer queueTimer.Stop()
	select {
	case p.slots <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-queueTimer.C:
		p.rejectedLimit.Add(1)
		p.rejectionLog.Printf("tunnel_reject reason=connection_limit active=%d target=%q", p.active.Load(), address)
		return nil, fmt.Errorf("maximum active connections reached")
	}
	release := true
	defer func() {
		if release {
			<-p.slots
		}
	}()
	tried := map[*nodeState]bool{}
	var last error
	for i := 0; i < 2; i++ {
		n := p.nextFor(tried, address)
		if n == nil {
			break
		}
		tried[n] = true
		if n.provider() == "cloudflare" {
			if e := p.daily.reserve(n.quotaGroup(), p.config().dailyLimit()); e != nil {
				return nil, e
			}
		}
		charge, e := p.meter.beginWithRates(n.rates())
		if e != nil {
			p.rejectedBudget.Add(1)
			p.rejectionLog.Printf("tunnel_reject reason=budget target=%q", address)
			last = e
			p.mu.Lock()
			for _, candidate := range p.nodes {
				if !p.meter.canBegin(candidate.rates()) {
					tried[candidate] = true
				}
			}
			p.mu.Unlock()
			continue
		}
		record.attempt(n.Region)
		finish := charge.finish
		start := time.Now()
		nodeToken := n.Token
		if nodeToken == "" {
			nodeToken = p.token
		}
		headers := http.Header{"X-Tunnel-Token": []string{nodeToken}, "X-Tunnel-Target": []string{address}, "X-Tunnel-Protocol": []string{"2"}}
		dialer := websocket.Dialer{HandshakeTimeout: 25 * time.Second, ReadBufferSize: chunkSize, WriteBufferSize: chunkSize, Proxy: nil, NetDialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			switch p.config().NodeNetwork {
			case "ipv4":
				network = "tcp4"
			case "ipv6":
				network = "tcp6"
			}
			return (&net.Dialer{Timeout: 8 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, network, address)
		}}
		ws, response, e := dialer.DialContext(ctx, n.URL, headers)
		if e == nil {
			ws.SetReadLimit(2048)
			ws.SetReadDeadline(time.Now().Add(15 * time.Second))
			var ack dialAck
			e = ws.ReadJSON(&ack)
			ws.SetReadDeadline(time.Time{})
			if e == nil && !ack.OK {
				if ack.Error == "unsupported" {
					e = &providerTargetError{detail: ack.Detail}
				} else if ack.Error == "target" {
					e = &targetDialError{detail: ack.Detail}
				} else {
					e = fmt.Errorf("invalid tunnel connection acknowledgement")
				}
			}
			if e != nil {
				ws.Close()
			}
		}
		if e != nil {
			status := 0
			detail := ""
			var targetErr *targetDialError
			targetFailure := errors.As(e, &targetErr)
			var capabilityErr *providerTargetError
			unsupported := errors.As(e, &capabilityErr)
			if targetFailure {
				detail = targetErr.detail
			}
			if response != nil {
				status = response.StatusCode
				if response.Body != nil && status != http.StatusSwitchingProtocols {
					raw, _ := io.ReadAll(io.LimitReader(response.Body, 512))
					detail = strings.TrimSpace(string(raw))
					response.Body.Close()
				}
				targetFailure = targetFailure || status == 502 && (strings.Contains(detail, "Target connection failed") || response.Header.Get("X-Tunnel-Error") == "target")
			}
			if err := finish(time.Since(start), 0); err != nil {
				log.Printf("budget ledger: %v", err)
			}
			summary := p.connections.clean(fmt.Sprintf("status=%d error=%v detail=%s", status, e, detail))
			record.attemptError(fmt.Errorf("%s", summary))
			p.mu.Lock()
			n.LastError = summary
			if targetFailure {
				n.TargetFailures++
				n.Failures = 0
				n.RetryAfter = time.Time{}
			}
			p.mu.Unlock()
			log.Printf("tunnel_open_failed region=%s target=%q status=%d target_failure=%t duration=%s error=%q detail=%q", n.Region, address, status, targetFailure, time.Since(start).Round(time.Millisecond), e.Error(), detail)
			if !targetFailure && !unsupported && ctx.Err() == nil {
				p.mark(n, false)
			}
			if targetFailure {
				last = fmt.Errorf("%s: %w", n.Region, &targetDialError{detail: detail})
			} else {
				last = fmt.Errorf("%s: HTTP %d: %w", n.Region, status, e)
			}
			p.failed.Add(1)
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if n.provider() == "cloudflare" && !unsupported {
				p.targets.providerFailed(address, n.provider())
			}
			if unsupported {
				p.targets.skipProvider(address, n.provider())
				p.mu.Lock()
				for _, candidate := range p.nodes {
					if candidate.provider() == n.provider() {
						tried[candidate] = true
					}
				}
				p.mu.Unlock()
			}
			// The cloud node is healthy but the destination failed. Do not pay for a
			// second regional attempt; subsequent probes recover via exponential backoff.
			if targetFailure {
				if n.provider() == "cloudflare" && !p.config().PaidDisabled {
					p.mu.Lock()
					for _, candidate := range p.nodes {
						if candidate.provider() == "cloudflare" {
							tried[candidate] = true
						}
					}
					p.mu.Unlock()
					continue
				}
				break
			}
			continue
		}
		p.lifeMu.Lock()
		if p.stopping {
			p.lifeMu.Unlock()
			ws.Close()
			finish(time.Since(start), 0)
			return nil, fmt.Errorf("proxy is stopping")
		}
		p.targets.providerSucceeded(address, n.provider())
		p.mark(n, true)
		p.success.Add(1)
		p.active.Add(1)
		stream := newStream(ws)
		stream.region = n.Region
		if n.provider() == "cloudflare" {
			stream.writeInterval = 0
		}
		record.connected(n.Region)
		if record != nil && record.event.Protocol != "HTTP" {
			stream.onTraffic = record.traffic
		}
		stream.onProgress = func(n int64) error { return charge.progress(time.Since(start), n) }
		stop := make(chan struct{})
		stream.onClose = func() {
			if record != nil && record.event.Protocol == "CONNECT" {
				record.finish(stream.failure())
			}
			if record != nil && record.event.Protocol == "SOCKS5" && stream.failure() != nil {
				record.update(func(e *connectionEvent) { e.Error = p.connections.clean(stream.failure().Error()) })
			}
			p.lifeMu.Lock()
			delete(p.live, stream)
			p.lifeMu.Unlock()
			close(stop)
			<-p.slots
			p.active.Add(-1)
			if err := finish(time.Since(start), stream.transferred.Load()); err != nil {
				log.Printf("budget ledger: %v", err)
			}
		}
		p.live[stream] = struct{}{}
		p.lifeMu.Unlock()
		release = false
		go func() {
			timer := time.NewTimer(maxTunnelSeconds * time.Second)
			defer timer.Stop()
			tick := time.NewTicker(5 * time.Second)
			defer tick.Stop()
			for {
				select {
				case <-stop:
					return
				case <-timer.C:
					stream.setFailure(fmt.Errorf("maximum connection lifetime reached"))
					stream.Close()
					return
				case <-tick.C:
					if err := charge.progress(time.Since(start), stream.transferred.Load()); err != nil {
						stream.setFailure(err)
						log.Printf("tunnel_closed reason=budget region=%s target=%q error=%q", n.Region, address, err)
						stream.Close()
						return
					}
					if time.Since(time.Unix(0, stream.lastActivity.Load())) > idleSeconds*time.Second {
						stream.setFailure(fmt.Errorf("connection idle timeout"))
						stream.Close()
						return
					}
				}
			}
		}()
		return stream, nil
	}
	if last == nil {
		p.noNodes.Add(1)
		p.rejectionLog.Printf("tunnel_reject reason=no_healthy_nodes target=%q", address)
		last = fmt.Errorf("no eligible tunnel nodes: %s", p.noEligibleReason(address))
	}
	return nil, last
}
func (p *provider) shutdown() {
	p.lifeMu.Lock()
	p.stopping = true
	p.cancel()
	connections := make([]*wsStream, 0, len(p.live))
	for s := range p.live {
		connections = append(connections, s)
	}
	p.lifeMu.Unlock()
	for _, s := range connections {
		s.setFailure(fmt.Errorf("proxy shutting down"))
		s.Close()
	}
	p.opening.Wait()
	p.connections.finishActive(fmt.Errorf("proxy shutting down"))
	log.Printf("proxy_shutdown active=%d ledger_settled=true", p.active.Load())
}

func (p *provider) stats() map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	nodes := []map[string]any{}
	for _, n := range p.nodes {
		status := "Healthy"
		if n.provider() == "cloudflare" && !p.daily.available(n.quotaGroup(), p.config().dailyLimit()) {
			status = "Quota"
		}
		if n.Disabled {
			status = "Disabled"
		}
		if time.Now().Before(n.RetryAfter) {
			status = "Cooling"
		}
		nodes = append(nodes, map[string]any{"region": n.Region, "provider": n.provider(), "disabled": n.Disabled, "status": status, "failure_count": n.Failures, "connections": n.Opens, "target_failures": n.TargetFailures, "last_error": n.LastError})
	}
	return map[string]any{"mode": "tcp-tunnel-no-mitm", "nodes": nodes, "active": p.active.Load(), "opening_or_active": len(p.slots), "max_connections": cap(p.slots), "success": p.success.Load(), "failed": p.failed.Load(), "rejected_limit": p.rejectedLimit.Load(), "rejected_private": p.rejectedPrivate.Load(), "cached_target_failures": p.cachedTargetFailures.Load(), "cooling_targets": p.targets.cooling(), "target_retry_policy": "single-probe; target failure backoff 30s to 10m; node failure retries up to 2 regions", "rejected_budget": p.rejectedBudget.Load(), "rejected_no_nodes": p.noNodes.Load(), "logging": p.loggingStatus(), "node_network": p.config().NodeNetwork, "cost_estimate": p.meter.snapshot(), "cost_breakdown": p.meter.breakdown(), "cloud_bill": readCloudBill(p.billingCache), "monthly_limit_yuan": p.config().Budget, "cloudflare_daily_limit": p.config().dailyLimit(), "provider_daily_usage": p.daily.snapshot(), "routing_strategy": p.config().Strategy, "paid_fallback_disabled": p.config().PaidDisabled, "max_connection_seconds": maxTunnelSeconds, "max_connection_bytes": maxTunnelBytes}
}
func authOK(r *http.Request, c agentConfig) bool {
	parts := strings.SplitN(r.Header.Get("Proxy-Authorization"), " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Basic") {
		return false
	}
	v, e := base64.StdEncoding.DecodeString(parts[1])
	return e == nil && subtle.ConstantTimeCompare(v, []byte(c.User+":"+c.Password)) == 1
}
func stripHop(h http.Header) {
	for _, v := range h.Values("Connection") {
		for _, k := range strings.Split(v, ",") {
			h.Del(strings.TrimSpace(k))
		}
	}
	for _, k := range []string{"Proxy-Authorization", "Proxy-Authenticate", "Proxy-Connection", "Connection", "Keep-Alive", "TE", "Trailer", "Transfer-Encoding", "Upgrade"} {
		h.Del(k)
	}
}
func httpProxy(c agentConfig, p *provider) http.Handler {
	transport := &http.Transport{DialContext: p.dial, DisableCompression: true, MaxIdleConns: 16, MaxIdleConnsPerHost: 2, IdleConnTimeout: 20 * time.Second, ResponseHeaderTimeout: 45 * time.Second}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c := p.config()
		protocol := "HTTP"
		if r.Method == "CONNECT" {
			protocol = "CONNECT"
		}
		record := p.connections.begin(r.RemoteAddr, protocol)
		if record == nil {
			http.Error(w, "Too many pending connections", 503)
			return
		}
		// Store only host:port, never URL paths, queries or credentials.
		target := r.URL.Hostname()
		port := r.URL.Port()
		if port == "" {
			port = "80"
		}
		if r.Method == "CONNECT" {
			target = r.Host
		} else if target != "" {
			target = net.JoinHostPort(target, port)
		}
		record.target(target, "negotiating")
		var result error
		defer func() { record.finish(result) }()
		if !authOK(r, c) {
			result = fmt.Errorf("proxy authentication failed")
			w.Header().Set("Proxy-Authenticate", `Basic realm="CloudTunnel"`)
			http.Error(w, "Proxy authentication required", 407)
			return
		}
		if r.Method == "CONNECT" {
			address := r.Host
			if _, _, e := net.SplitHostPort(address); e != nil {
				result = fmt.Errorf("CONNECT requires host:port")
				http.Error(w, "CONNECT requires host:port", 400)
				return
			}
			remote, e := p.dial(context.WithValue(r.Context(), connectionContextKey{}, record), "tcp", address)
			if e != nil {
				http.Error(w, "Tunnel unavailable: "+p.connections.clean(e.Error()), 503)
				return
			}
			raw, rw, e := w.(http.Hijacker).Hijack()
			if e != nil {
				result = e
				remote.(*wsStream).setFailure(e)
				remote.Close()
				return
			}
			if _, e = rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); e != nil {
				raw.Close()
				remote.(*wsStream).setFailure(e)
				remote.Close()
				return
			}
			if e = rw.Flush(); e != nil {
				raw.Close()
				remote.(*wsStream).setFailure(e)
				remote.Close()
				return
			}
			buffered := &bufferedConn{Conn: raw, reader: rw.Reader}
			relay(buffered, remote.(*wsStream))
			result = remote.(*wsStream).failure()
			return
		}
		if r.URL.Scheme != "http" || r.URL.Host == "" {
			result = fmt.Errorf("invalid proxy request: use absolute HTTP URL or CONNECT")
			http.Error(w, "Use CONNECT for HTTPS", 400)
			return
		}
		outgoing := r.Clone(observedHTTPContext(r.Context(), record))
		if outgoing.Body != nil {
			outgoing.Body = observedBody{outgoing.Body, record}
		}
		outgoing.RequestURI = ""
		outgoing.Header = r.Header.Clone()
		stripHop(outgoing.Header)
		resp, e := transport.RoundTrip(outgoing)
		if e != nil {
			result = e
			http.Error(w, "Proxy upstream unavailable", 502)
			return
		}
		defer resp.Body.Close()
		stripHop(resp.Header)
		for k, vs := range resp.Header {
			for _, v := range vs {
				w.Header().Add(k, v)
			}
		}
		record.update(func(e *connectionEvent) { e.HTTPStatus = resp.StatusCode })
		w.WriteHeader(resp.StatusCode)
		_, err := io.Copy(observedWriter{w, record}, resp.Body)
		result = err
	})
}

type bufferedConn struct {
	net.Conn
	reader io.Reader
}

func (c *bufferedConn) Read(b []byte) (int, error) { return c.reader.Read(b) }
func (c *bufferedConn) CloseWrite() error {
	if x, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return x.CloseWrite()
	}
	return c.Conn.Close()
}

type remoteResolver struct{}

func (remoteResolver) Resolve(ctx context.Context, name string) (context.Context, net.IP, error) {
	return ctx, nil, nil
}
func runAgent(path string) error {
	raw, e := os.ReadFile(path)
	if e != nil {
		return e
	}
	var c agentConfig
	if e = json.Unmarshal(raw, &c); e != nil {
		return e
	}
	c, e = readSettings(c)
	if e != nil {
		return e
	}
	if c.User == "" || c.Password == "" {
		return fmt.Errorf("proxy authentication must be enabled")
	}
	p, e := newProvider(c)
	if e != nil {
		return e
	}
	logs, logErr := startRuntimeLogs(c, p)
	if logErr != nil {
		p.shutdown()
		return fmt.Errorf("cannot initialize bounded logs: %w", logErr)
	}
	defer func() { p.shutdown(); logs.Close() }()
	errors := make(chan error, 3)
	listener, e := net.Listen("tcp", c.SOCKS)
	if e != nil {
		return e
	}
	defer listener.Close()
	go func() { errors <- serveObservedSOCKS(listener, c, p) }()
	go func() {
		errors <- (&http.Server{Addr: c.HTTP, Handler: httpProxy(c, p), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 64 * 1024}).ListenAndServe()
	}()
	go func() {
		errors <- (&http.Server{Addr: c.Dashboard, Handler: dashboardHandler(c, p), ReadHeaderTimeout: 5 * time.Second}).ListenAndServe()
	}()
	log.Printf("TCP tunnel proxy started HTTP=%s SOCKS5=%s regions=%d CA=not-required", c.HTTP, c.SOCKS, len(c.Nodes))
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(signals)
	select {
	case e := <-errors:
		return e
	case <-signals:
		return nil
	}
}

// Keep repetitive client errors from filling the disk while retaining samples.
type limitedSOCKSLog struct {
	mu                sync.Mutex
	start             time.Time
	count, suppressed int
}

func (w *limitedSOCKSLog) Write(b []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if time.Since(w.start) > time.Minute {
		if w.suppressed > 0 {
			fmt.Fprintf(log.Writer(), "proxy repeated_errors_suppressed=%d in_previous_minute\n", w.suppressed)
		}
		w.start = time.Now()
		w.count = 0
		w.suppressed = 0
	}
	w.count++
	if w.count > 20 {
		w.suppressed++
		return len(b), nil
	}
	return log.Writer().Write(b)
}
