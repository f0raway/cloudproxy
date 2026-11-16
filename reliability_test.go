package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestSettingsSaveRetainsUnchangedNodeCircuit(t *testing.T) {
	_, p := setupTest(t)
	s := editableSettings(p)
	if err := p.saveSettings(s); err != nil {
		t.Fatal(err)
	}
	old := p.nodes[0]
	p.mark(old, false)
	p.mark(old, false)
	p.mark(old, false)
	old.LastError = "connection refused"
	retry := old.RetryAfter
	s.Nodes[0].Provider = "tencent"
	rates := defaultRates()
	s.Nodes[0].Rates = &rates
	s.Budget = 7
	s.Allow = []string{"*.example.com"}
	if err := p.saveSettings(s); err != nil {
		t.Fatal(err)
	}
	if p.nodes[0] != old || old.RetryAfter != retry || old.Failures != 3 || old.LastError == "" {
		t.Fatal("ordinary settings save reset node circuit")
	}
	if p.next(map[*nodeState]bool{}) != nil {
		t.Fatal("cooling node became selectable")
	}
	s.Nodes[0].Token = "changed-node-token"
	if err := p.saveSettings(s); err != nil {
		t.Fatal(err)
	}
	if p.nodes[0] == old || p.nodes[0].Failures != 0 {
		t.Fatal("changed credentials must allow a new connection attempt")
	}
}

func TestGenericFreeNodesAndIndependentFailureScopes(t *testing.T) {
	_, p := setupTest(t)
	a := &nodeState{nodeConfig: nodeConfig{Provider: "custom", URL: "wss://vendor-a.example/tunnel", Region: "a", Rates: &costRates{}}}
	b := &nodeState{nodeConfig: nodeConfig{Provider: "custom", URL: "wss://vendor-b.example/tunnel", Region: "b", Rates: &costRates{}}}
	p.nodes = append(p.nodes, a, b)
	cfg := p.config()
	cfg.PaidDisabled = true
	p.configValue.Store(&cfg)
	if n := p.next(map[*nodeState]bool{}); n != a {
		t.Fatal("custom zero-price provider was not preferred")
	}
	release, err := p.targets.acquire(context.Background(), "example.org:443")
	if err != nil {
		t.Fatal(err)
	}
	defer release(nil)
	p.targets.skipProvider("example.org:443", a.failureScope())
	if n := p.nextFor(map[*nodeState]bool{}, "example.org:443"); n != b {
		t.Fatal("one custom vendor excluded unrelated vendor")
	}
	if p.daily.snapshot()["cloudflare"].Used != 0 {
		t.Fatal("custom node consumed Cloudflare quota")
	}
}

func TestNodeReadinessDoesNotInventSuccessfulConnections(t *testing.T) {
	_, p := setupTest(t)
	stats := p.stats()
	node := stats["nodes"].([]map[string]any)[0]
	if node["status"] != "Unverified" || stats["eligible_nodes"] != 1 {
		t.Fatal(stats)
	}
	p.mark(p.nodes[0], true)
	if p.stats()["nodes"].([]map[string]any)[0]["last_success_at"] == nil {
		t.Fatal("missing evidence of success")
	}
	for i := 0; i < 3; i++ {
		p.mark(p.nodes[0], false)
	}
	if stats = p.stats(); stats["readiness"] != "blocked" || stats["eligible_nodes"] != 0 {
		t.Fatal(stats)
	}
	p.nodes[0].Disabled = true
	if p.stats()["nodes"].([]map[string]any)[0]["status"] != "Disabled" {
		t.Fatal("disabled state hidden by cooldown")
	}
}

func TestCancellationInterruptsNodeAcknowledgement(t *testing.T) {
	opened := make(chan struct{})
	node := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		close(opened)
		// Wait for the caller to close; deliberately never acknowledge the target.
		ws.ReadMessage()
	}))
	defer node.Close()
	c := agentConfig{User: "user", Password: "password", Nodes: []nodeConfig{{Provider: "custom", Region: "silent", URL: "ws" + strings.TrimPrefix(node.URL, "http"), Token: "node-only-token", Rates: &costRates{}}}, Ledger: filepath.Join(t.TempDir(), "usage.json"), Budget: 8}
	p, err := newProvider(c)
	if err != nil {
		t.Fatal(err)
	}
	defer p.shutdown()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := p.dial(ctx, "tcp", "example.org:443"); done <- err }()
	select {
	case <-opened:
	case <-time.After(2 * time.Second):
		t.Fatal("node not opened")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled connection succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("cancel waited for 15 second acknowledgement timeout")
	}
	if len(p.slots) != 0 || p.nodes[0].Failures != 0 {
		t.Fatal("cancel leaked a slot or penalized healthy node")
	}
}

func TestEffectiveConfigCheckIsReadOnlyAndUsesOverlay(t *testing.T) {
	dir := t.TempDir()
	ledger := filepath.Join(dir, "usage.json")
	c := agentConfig{HTTP: "127.0.0.1:10800", SOCKS: "127.0.0.1:10801", Dashboard: "127.0.0.1:8081", User: "user", Password: "password", Ledger: ledger, Budget: 8, Nodes: []nodeConfig{{Region: "custom", Provider: "custom", URL: "wss://example.org/tunnel", Token: "per-node-token", Rates: &costRates{}}}, Strategy: "free_first"}
	path := filepath.Join(dir, "agent.json")
	raw, _ := json.Marshal(c)
	os.WriteFile(path, raw, 0600)
	checked, err := loadAgentConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if checked.Token != "" {
		t.Fatal("per-node auth required global token")
	}
	if _, err = os.Stat(ledger); !os.IsNotExist(err) {
		t.Fatal("validation wrote ledger")
	}
	overlay := settingsFrom(c)
	overlay.Budget = 4
	overlay.Password = "new-password"
	raw, _ = json.Marshal(overlay)
	os.WriteFile(c.settingsPath(), raw, 0600)
	checked, err = loadAgentConfig(path)
	if err != nil || checked.Budget != 4 || checked.Password != "new-password" {
		t.Fatal("effective config ignored saved UI settings", err)
	}
	for _, value := range []string{`{"unknown":"secret"}`, string(raw) + ` {}`} {
		os.WriteFile(path, []byte(value), 0600)
		if _, err = loadAgentConfig(path); err == nil {
			t.Fatal("bad config accepted")
		}
	}
	c.Nodes[0].Memory = 128
	c.Nodes[0].Timeout = 7200
	raw, _ = json.Marshal(c)
	os.WriteFile(path, raw, 0600)
	if _, err = loadAgentConfig(path); err != nil {
		t.Fatal("legacy deployment metadata rejected", err)
	}
	c.SOCKS = c.HTTP
	raw, _ = json.Marshal(c)
	os.WriteFile(path, raw, 0600)
	if _, err = loadAgentConfig(path); err == nil {
		t.Fatal("colliding listeners accepted")
	}
}

func TestDashboardAssetsRemainAuthenticated(t *testing.T) {
	c, p := setupTest(t)
	h := dashboardHandler(c, p)
	for _, path := range []string{"/dashboard.js", "/dashboard.css", "/settings.js"} {
		r := httptest.NewRequest("GET", path, nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 401 {
			t.Fatal("asset bypassed authentication", path)
		}
		r.SetBasicAuth(c.User, c.Password)
		w = httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 || w.Body.Len() < 100 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(fmt.Sprint("asset unavailable ", path))
		}
	}
}
