package main

import (
	"context"
	"encoding/json"
	"github.com/gorilla/websocket"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func editableSettings(p *provider) runtimeSettings {
	s := settingsFrom(p.config())
	s.Nodes = append([]nodeConfig{}, s.Nodes...)
	for i := range s.Nodes {
		s.Nodes[i].URL = "wss://node.example/tunnel"
	}
	return s
}
func settingsRequest(t *testing.T, h http.Handler, c agentConfig, s runtimeSettings, csrf, origin string) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(s)
	r := httptest.NewRequest("POST", "http://monitor.example/api/settings", strings.NewReader(string(body)))
	r.SetBasicAuth(c.User, c.Password)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-CSRF-Token", csrf)
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func TestSettingsPrivateAuthenticatedAndCSRFSafe(t *testing.T) {
	c, p := setupTest(t)
	h := dashboardHandler(c, p)
	s := editableSettings(p)
	if w := settingsRequest(t, h, c, s, "", "http://monitor.example"); w.Code != 403 {
		t.Fatal("missing CSRF accepted")
	}
	if w := settingsRequest(t, h, c, s, p.csrf, "https://evil.example"); w.Code != 403 {
		t.Fatal("cross-origin settings accepted")
	}
	r := httptest.NewRequest("GET", "http://monitor.example/api/settings", nil)
	r.SetBasicAuth(c.User, c.Password)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || strings.Contains(w.Body.String(), `"password"`) || strings.Contains(w.Body.String(), `"token"`) {
		t.Fatal("settings leaked stored secrets")
	}
	if p.config().Password != c.Password {
		t.Fatal("masking changed saved password")
	}
	s.Password = "new-test-password"
	s.User = "new-user"
	s.Budget = 6
	s.Allow = []string{"api.example.com", "*.example.org"}
	s.Ports = []int{443}
	w = settingsRequest(t, h, c, s, p.csrf, "http://monitor.example")
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	info, err := os.Stat(c.settingsPath())
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("settings not private")
	}
	updated, err := readSettings(c)
	if err != nil || updated.User != s.User || updated.Password != s.Password || updated.Budget != 6 {
		t.Fatal("settings not restored on restart")
	}
	r = httptest.NewRequest("GET", "http://monitor.example/api/stats", nil)
	r.SetBasicAuth(c.User, c.Password)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("old dashboard credentials still accepted")
	}
	r.SetBasicAuth(s.User, s.Password)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal("new dashboard credentials rejected")
	}
	if targetAllowed(p.config(), "not-allowed.example:443") || targetAllowed(p.config(), "api.example.com:80") || !targetAllowed(p.config(), "api.example.com:443") || !targetAllowed(p.config(), "child.example.org:443") || targetAllowed(p.config(), "example.org:443") {
		t.Fatal("target scope incorrect")
	}
	_, err = p.dial(context.Background(), "tcp", "not-allowed.example:443")
	if err == nil || p.meter.snapshot().Calls != 0 {
		t.Fatal("out-of-scope target invoked cloud")
	}
	s.Password = ""
	if w = settingsRequest(t, h, p.config(), s, p.csrf, "http://monitor.example"); w.Code != 200 || p.config().Password != "new-test-password" {
		t.Fatal("blank password did not preserve")
	}
}
func TestInvalidSettingsCannotChangeConfigOrLedger(t *testing.T) {
	_, p := setupTest(t)
	s := editableSettings(p)
	s.Budget = -1
	before := p.meter.snapshot()
	if p.saveSettings(s) == nil || p.config().Budget != 8 || p.meter.snapshot() != before {
		t.Fatal("invalid budget mutated configuration")
	}
	if _, err := os.Stat(p.config().settingsPath()); !os.IsNotExist(err) {
		t.Fatal("invalid settings persisted")
	}
	s = editableSettings(p)
	s.Nodes[0].URL = "wss://user:password@node.example/tunnel"
	if p.saveSettings(s) == nil {
		t.Fatal("credentials in endpoint accepted")
	}
	s = editableSettings(p)
	s.Nodes[0].Provider = "custom"
	if p.saveSettings(s) == nil {
		t.Fatal("custom billing defaulted to free")
	}
	s = editableSettings(p)
	s.CFDaily = 100001
	if p.saveSettings(s) == nil {
		t.Fatal("free quota exceeded")
	}
}
func TestConfigChangesDoNotRaceLiveStatsAndAuth(t *testing.T) {
	_, p := setupTest(t)
	s := editableSettings(p)
	var wg sync.WaitGroup
	for j := 0; j < 4; j++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 20; i++ {
				p.stats()
				p.connections.snapshot()
				p.config()
			}
		}()
	}
	for i := 0; i < 10; i++ {
		s.Budget = 6 + float64(i)/10
		if err := p.saveSettings(s); err != nil {
			t.Fatal(err)
		}
	}
	wg.Wait()
}
func TestFreeProviderUsesDailyQuotaNotTencentCompute(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.json")
	m, e := openMeter(path, .0001)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = m.begin(); e == nil {
		t.Fatal("paid lease should exceed tiny budget")
	}
	lease, e := m.beginWithRates(costRates{})
	if e != nil {
		t.Fatal("free provider blocked by paid budget", e)
	}
	lease.progress(time.Hour, 1<<20)
	lease.finish(time.Hour, 1<<20)
	if m.snapshot().Estimated != 0 {
		t.Fatal("Tencent compute applied to Cloudflare")
	}
	q, e := openDailyQuota(filepath.Join(t.TempDir(), "daily.json"))
	if e != nil {
		t.Fatal(e)
	}
	now := time.Date(2026, 11, 16, 23, 59, 0, 0, time.UTC)
	q.now = func() time.Time { return now }
	for i := 0; i < 2; i++ {
		if e = q.reserve("account-a", 2); e != nil {
			t.Fatal(e)
		}
	}
	if q.available("account-a", 2) || q.reserve("account-a", 2) == nil {
		t.Fatal("daily cap bypassed")
	}
	saved, e := openDailyQuota(q.path)
	if e != nil {
		t.Fatal(e)
	}
	saved.now = q.now
	if saved.available("account-a", 2) {
		t.Fatal("restart reset quota")
	}
	if !q.available("account-b", 2) {
		t.Fatal("separate accounts shared quota")
	}
	now = now.Add(2 * time.Minute)
	if e = q.reserve("account-a", 2); e != nil || q.snapshot()["account-a"].Used != 1 {
		t.Fatal("UTC day did not roll")
	}
}
func TestPaidFallbackSwitchAndFreeFirstSelection(t *testing.T) {
	_, p := setupTest(t)
	p.nodes = append(p.nodes, &nodeState{nodeConfig: nodeConfig{Provider: "cloudflare", Region: "cf", URL: "wss://worker.example/tunnel"}})
	free := p.next(map[*nodeState]bool{})
	if free == nil || free.provider() != "cloudflare" {
		t.Fatal("free not preferred")
	}
	cfg := p.config()
	cfg.PaidDisabled = true
	p.configValue.Store(&cfg)
	if p.next(map[*nodeState]bool{free: true}) != nil {
		t.Fatal("paid fallback bypassed disabled switch")
	}
	cfg.PaidDisabled = false
	p.configValue.Store(&cfg)
	if n := p.next(map[*nodeState]bool{free: true}); n == nil || n.provider() != "tencent" {
		t.Fatal("paid fallback unavailable")
	}
	// No response bodies or secret values are included in snapshots.
	r := httptest.NewRequest("GET", "/settings.js", nil)
	r.SetBasicAuth(cfg.User, cfg.Password)
	w := httptest.NewRecorder()
	dashboardHandler(cfg, p).ServeHTTP(w, r)
	b, _ := io.ReadAll(w.Result().Body)
	if w.Code != 200 || !strings.Contains(string(b), "settingsForm") {
		t.Fatal("configuration UI asset unavailable")
	}
}

func TestUnsupportedFreeProviderFallsBackAndCachesCapability(t *testing.T) {
	_, p := setupTest(t)
	defer p.shutdown()
	var freeCalls atomic.Int64
	free := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		freeCalls.Add(1)
		if r.Header.Get("X-Tunnel-Token") != "per-node-token" {
			http.Error(w, "bad node token", 403)
			return
		}
		ws, e := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if e != nil {
			return
		}
		defer ws.Close()
		ws.WriteJSON(dialAck{Error: "unsupported", Detail: "provider IP range blocked"})
	}))
	defer free.Close()
	cf := &nodeState{nodeConfig: nodeConfig{Provider: "cloudflare", Region: "cf", URL: "ws" + free.URL[4:], Token: "per-node-token", QuotaGroup: "account-a"}}
	p.nodes = append([]*nodeState{cf}, p.nodes...)
	target, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer target.Close()
	go func() {
		for {
			c, e := target.Accept()
			if e != nil {
				return
			}
			go func() { defer c.Close(); io.Copy(io.Discard, c) }()
		}
	}()
	for i := 0; i < 2; i++ {
		connection, e := p.dial(context.Background(), "tcp", target.Addr().String())
		if e != nil {
			t.Fatal(e)
		}
		connection.Close()
	}
	if freeCalls.Load() != 1 || p.success.Load() != 2 || cf.Failures != 0 || p.daily.snapshot()["account-a"].Used != 1 {
		t.Fatal("provider capability cache, fallback or per-node token failed")
	}
}

func TestFreeTargetFailureMayUseAllowedPaidFallback(t *testing.T) {
	_, p := setupTest(t)
	defer p.shutdown()
	free := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, e := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if e != nil {
			return
		}
		defer ws.Close()
		ws.WriteJSON(dialAck{Error: "target", Detail: "network path timeout"})
	}))
	defer free.Close()
	p.nodes = append([]*nodeState{{nodeConfig: nodeConfig{Provider: "cloudflare", Region: "cf", URL: "ws" + free.URL[4:]}}}, p.nodes...)
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	go func() {
		conn, e := listener.Accept()
		if e == nil {
			defer conn.Close()
			io.Copy(io.Discard, conn)
		}
	}()
	conn, e := p.dial(context.Background(), "tcp", listener.Addr().String())
	if e != nil {
		t.Fatal("free path failure prevented paid fallback", e)
	}
	conn.Close()
	if p.success.Load() != 1 || p.targets.cooling() != 0 {
		t.Fatal("working target incorrectly put in global cooldown")
	}
}

func TestExhaustedPaidBudgetStillAllowsFreeNodeInRoundRobin(t *testing.T) {
	_, p := setupTest(t)
	defer p.shutdown()
	free := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, e := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if e != nil {
			return
		}
		defer ws.Close()
		ws.WriteJSON(dialAck{OK: true})
		for {
			if _, _, e = ws.ReadMessage(); e != nil {
				return
			}
		}
	}))
	defer free.Close()
	p.nodes = append(p.nodes, &nodeState{nodeConfig: nodeConfig{Provider: "cloudflare", Region: "cf", URL: "ws" + free.URL[4:]}})
	c := p.config()
	c.Strategy = "round_robin"
	p.configValue.Store(&c)
	p.meter.mu.Lock()
	p.meter.limit = .0001
	p.meter.state.Estimated = .0001
	p.meter.mu.Unlock()
	conn, e := p.dial(context.Background(), "tcp", "public.example:443")
	if e != nil {
		t.Fatal("paid cap blocked available free node", e)
	}
	conn.Close()
	if p.success.Load() != 1 || p.rejectedBudget.Load() != 1 || p.meter.snapshot().Estimated != .0001 {
		t.Fatal("free fallback incorrectly charged Tencent budget")
	}
}
