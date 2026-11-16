package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRotatingLogHardLimitAndNewestEntries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.jsonl")
	w, e := openRotatingFile(path, 128, 2)
	if e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 30; i++ {
		line := fmt.Sprintf("%03d %s\n", i, strings.Repeat("x", 20))
		if _, e = w.Write([]byte(line)); e != nil {
			t.Fatal(e)
		}
	}
	if _, e = w.Write(bytes.Repeat([]byte("x"), 129)); e == nil {
		t.Fatal("oversize write bypassed cap")
	}
	for _, p := range w.files() {
		info, e := os.Stat(p)
		if e != nil {
			t.Fatal(e)
		}
		if info.Size() > 128 || info.Mode().Perm() != 0600 {
			t.Fatal("file size or permission not bounded")
		}
	}
	current, _ := os.ReadFile(path)
	if !bytes.Contains(current, []byte("029 ")) || bytes.Contains(current, []byte("000 ")) {
		t.Fatal("rotation did not retain newest data")
	}
	if e = w.setLimits(64, 1); e != nil {
		t.Fatal(e)
	}
	for _, p := range w.files() {
		info, e := os.Stat(p)
		if e != nil || info.Size() > 64 {
			t.Fatal("shrinking limit left oversize file")
		}
	}
	if _, e = os.Stat(path + ".2"); !os.IsNotExist(e) {
		t.Fatal("extra backup retained")
	}
	w.Close()
}
func TestConcurrentLogWritesRemainCompleteAndBounded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "service.log")
	w, e := openRotatingFile(path, 1024, 2)
	if e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	for n := 0; n < 8; n++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for i := 0; i < 30; i++ {
				if _, e := w.Write([]byte(fmt.Sprintf("%02d-%03d\n", n, i))); e != nil {
					t.Error(e)
				}
			}
		}(n)
	}
	wg.Wait()
	w.Close()
	for _, p := range w.files() {
		raw, e := os.ReadFile(p)
		if os.IsNotExist(e) {
			continue
		}
		if e != nil {
			t.Fatal(e)
		}
		if len(raw) > 1024 {
			t.Fatal("concurrent write exceeded cap")
		}
		for _, line := range bytes.Split(bytes.TrimSpace(raw), []byte("\n")) {
			if len(line) != 6 {
				t.Fatal("interleaved or partial line")
			}
		}
	}
}
func TestConnectionJournalRedactsAndRestoresEndedRecords(t *testing.T) {
	c := agentConfig{Password: "private-password", Token: "private-token", Nodes: []nodeConfig{{URL: "wss://private-node.example/tunnel"}}}
	l := newConnectionLog(c)
	w, e := openRotatingFile(filepath.Join(t.TempDir(), "events.jsonl"), 8192, 2)
	if e != nil {
		t.Fatal(e)
	}
	l.sink = newEventSink(w, true)
	r := l.begin("client:100", "SOCKS5")
	r.target("example.com:443", "queued")
	r.attempt("region")
	r.connected("region")
	r.connected("region")
	r.traffic(7, 9)
	r.finish(fmt.Errorf("%s %s %s", c.Password, c.Token, c.Nodes[0].URL))
	l.sink.Close()
	raw, e := os.ReadFile(w.path)
	if e != nil {
		t.Fatal(e)
	}
	for _, s := range []string{c.Password, c.Token, c.Nodes[0].URL} {
		if bytes.Contains(raw, []byte(s)) {
			t.Fatal("secret in connection journal")
		}
	}
	lines := bytes.Split(bytes.TrimSpace(raw), []byte("\n"))
	if len(lines) != 2 {
		t.Fatal("connected event duplicated or terminal event missing")
	}
	restored := newConnectionLog(c)
	restored.restore(w.files())
	rows := restored.snapshot()["connections"].([]connectionEvent)
	if len(rows) != 1 || rows[0].Uploaded != 7 || rows[0].Downloaded != 9 || rows[0].Ended == nil {
		t.Fatalf("history restore failed %+v", rows)
	}
	if next := restored.begin("client:101", "SOCKS5"); next.event.ID <= r.event.ID {
		t.Fatal("restart reused journal IDs")
	}
}
func TestSlowJournalNeverBlocksConnectionHandlers(t *testing.T) {
	w, e := openRotatingFile(filepath.Join(t.TempDir(), "events.jsonl"), 4096, 2)
	if e != nil {
		t.Fatal(e)
	}
	w.mu.Lock()
	sink := newEventSink(w, true)
	start := time.Now()
	for i := 0; i < 1200; i++ {
		sink.record("test", connectionEvent{ID: uint64(i), Source: "client:1", Attempts: []connectionAttempt{}})
	}
	elapsed := time.Since(start)
	dropped := sink.dropped.Load()
	w.mu.Unlock()
	sink.Close()
	if dropped == 0 || elapsed > time.Second {
		t.Fatal("log backpressure blocked producer or was not reported")
	}
}
func TestOperationalLogRedactionAndSettingsRetention(t *testing.T) {
	c, p := setupTest(t)
	runtime, e := startRuntimeLogs(c, p)
	if e != nil {
		t.Fatal(e)
	}
	defer func() { p.shutdown(); runtime.Close() }()
	log.Printf("test sensitive values %s %s", c.Password, c.Token)
	raw, _ := os.ReadFile(filepath.Join(filepath.Dir(c.Ledger), "service.log"))
	if bytes.Contains(raw, []byte(c.Password)) || bytes.Contains(raw, []byte(c.Token)) || !bytes.HasSuffix(raw, []byte("\n")) {
		t.Fatal("operational logger leaked secrets or lost line boundaries")
	}
	settings := editableSettings(p)
	settings.Logging = &logConfig{Enabled: false, MaxMB: 1, Backups: 0}
	settings.NodeNetwork = "ipv4"
	if e = p.saveSettings(settings); e != nil {
		t.Fatal(e)
	}
	record := p.connections.begin("client:1", "SOCKS5")
	record.target("example.com:443", "queued")
	record.finish(nil)
	if runtime.events.enabled.Load() || p.loggingStatus()["max_file_mb"] != 1 || len(connectionRows(p)) != 1 {
		t.Fatal("logging toggle incorrectly disabled memory diagnostics")
	}
}
func TestConnectionErrorCategoriesSeparatePolicyFromService(t *testing.T) {
	now := time.Now()
	cases := []struct {
		err       string
		source    string
		connected *time.Time
		want      string
	}{
		{"private/local or reserved target 198.18.1.1:443 cannot be reached", "client:1", nil, "local_policy"},
		{"Failed to authenticate: read tcp server:10801->client:1: read: connection reset by peer", "client:1", nil, "client_disconnect"},
		{"read tcp server:10801->client:1: read: connection reset by peer", "client:1", &now, "client_disconnect"},
		{"Failed to authenticate: User authentication failed", "client:1", nil, "authentication"},
		{"region: target connection failed: connection refused", "client:1", nil, "target_connect"},
		{"target connection recently failed; local backoff", "client:1", nil, "local_limit"},
		{"websocket: close 1006 (abnormal closure)", "client:1", &now, "upstream"},
	}
	for _, c := range cases {
		e := connectionEvent{Error: c.err, Source: c.source, Connected: c.connected}
		classifyConnection(&e)
		if e.ErrorCategory != c.want || e.Diagnosis == "" {
			t.Fatalf("wrong category %s: %+v", c.want, e)
		}
	}
}
func TestProviderPathBackoffSurvivesPaidSuccess(t *testing.T) {
	policy := newTargetPolicy()
	now := time.Now()
	policy.now = func() time.Time { return now }
	release, e := policy.acquire(context.Background(), "example.com:443")
	if e != nil {
		t.Fatal(e)
	}
	release(nil)
	for _, delay := range []time.Duration{30 * time.Second, time.Minute, 2 * time.Minute, 4 * time.Minute, 8 * time.Minute, 10 * time.Minute} {
		policy.providerFailed("example.com:443", "cloudflare")
		policy.providerSucceeded("example.com:443", "tencent")
		if !policy.providerBlocked("example.com:443", "cloudflare") || policy.states["example.com:443"].providerRetry["cloudflare"].Sub(now) != delay {
			t.Fatal("paid success reset free-path history")
		}
		now = now.Add(delay)
	}
	policy.providerSucceeded("example.com:443", "cloudflare")
	if policy.providerBlocked("example.com:443", "cloudflare") || policy.states["example.com:443"].providerFailures["cloudflare"] != 0 {
		t.Fatal("free path did not recover")
	}
}
func TestIPv4EndpointPolicyAppliesWithoutChangingTargets(t *testing.T) {
	listener, e := net.Listen("tcp6", "[::1]:0")
	if e != nil {
		t.Skip("IPv6 loopback unavailable")
	}
	server := httptest.NewUnstartedServer(nodeHandler("secret", true))
	server.Listener = listener
	server.Start()
	defer server.Close()
	_, p := setupTest(t)
	defer p.shutdown()
	p.nodes = []*nodeState{{nodeConfig: nodeConfig{Region: "local", URL: "ws" + server.URL[4:] + "/tunnel"}}}
	target, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer target.Close()
	go func() {
		c, e := target.Accept()
		if e == nil {
			defer c.Close()
			io.Copy(io.Discard, c)
		}
	}()
	conn, e := p.dial(context.Background(), "tcp", target.Addr().String())
	if e != nil {
		t.Fatal("auto did not use available loopback", e)
	}
	conn.Close()
	cfg := p.config()
	cfg.NodeNetwork = "ipv4"
	p.configValue.Store(&cfg)
	if conn, e = p.dial(context.Background(), "tcp", target.Addr().String()); e == nil {
		conn.Close()
		t.Fatal("IPv4 policy connected to IPv6-only endpoint")
	}
}
func TestCancelledRequestDoesNotConsumeCloudAttempt(t *testing.T) {
	_, p := setupTest(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if c, e := p.dial(ctx, "tcp", "example.com:443"); e == nil {
		c.Close()
		t.Fatal("cancel ignored")
	}
	if p.meter.snapshot().Calls != 0 {
		t.Fatal("cancelled request billed an attempt")
	}
}
