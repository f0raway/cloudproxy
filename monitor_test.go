package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	xproxy "golang.org/x/net/proxy"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

func connectionRows(p *provider) []connectionEvent {
	return p.connections.snapshot()["connections"].([]connectionEvent)
}
func waitRows(t *testing.T, p *provider, match func([]connectionEvent) bool) []connectionEvent {
	t.Helper()
	for end := time.Now().Add(3 * time.Second); time.Now().Before(end); {
		rows := connectionRows(p)
		if match(rows) {
			return rows
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("connection state did not settle")
	return nil
}
func TestConnectionHistoryBoundedConcurrentAndRedacted(t *testing.T) {
	l := newConnectionLog(agentConfig{Password: "private-password", Token: "private-token", Nodes: []nodeConfig{{URL: "wss://secret-endpoint/tunnel"}}})
	active := l.begin("client:1", "SOCKS5")
	var wg sync.WaitGroup
	for n := 0; n < 8; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 160; j++ {
				r := l.begin("client:2", "CONNECT")
				r.target("example.com:443", "queued")
				r.attempt("region-a")
				r.attemptError(fmt.Errorf("private-token private-password wss://secret-endpoint/tunnel"))
				r.connected("region-b")
				r.traffic(3, 7)
				r.finish(nil)
				l.snapshot()
			}
		}()
	}
	wg.Wait()
	snapshot := l.snapshot()
	rows := snapshot["connections"].([]connectionEvent)
	if len(rows) != historyLimit+1 || rows[0].ID != active.event.ID {
		t.Fatal("history evicted active connection or grew unbounded")
	}
	raw, _ := json.Marshal(snapshot)
	for _, s := range []string{"private-token", "private-password", "secret-endpoint"} {
		if strings.Contains(string(raw), s) {
			t.Fatal("secret leaked")
		}
	}
	rows[1].Attempts[0].Region = "mutated"
	if l.snapshot()["connections"].([]connectionEvent)[1].Attempts[0].Region == "mutated" {
		t.Fatal("snapshot aliased live state")
	}
	active.finish(nil)
	for j := 0; j < 256; j++ {
		if l.begin("pending:1", "SOCKS5") == nil {
			t.Fatal("early admission limit")
		}
	}
	if l.begin("extra:1", "SOCKS5") != nil || l.snapshot()["omitted"].(uint64) != 1 {
		t.Fatal("unbounded pending handshakes")
	}
}
func TestDashboardAuthenticationAndSafeJSON(t *testing.T) {
	c, p := setupTest(t)
	p.connections.begin("<script>alert(1)</script>", "SOCKS5").finish(fmt.Errorf("%s %s %s", c.Password, c.Token, c.Nodes[0].URL))
	h := dashboardHandler(c, p)
	for _, path := range []string{"/api/connections", "/api/stats"} {
		r := httptest.NewRequest("GET", path, nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 401 {
			t.Fatal("dashboard exposed without authentication")
		}
		r.SetBasicAuth(c.User, c.Password)
		w = httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("authenticated page unavailable")
		}
		if path == "/api/connections" {
			b := w.Body.String()
			if strings.Contains(b, "<script>") || strings.Contains(b, c.Nodes[0].URL) || strings.Contains(b, c.Password) {
				t.Fatal("unsafe JSON or secret leak")
			}
		}
	}
	r := httptest.NewRequest("POST", "/api/connections", nil)
	r.SetBasicAuth(c.User, c.Password)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 405 {
		t.Fatal("unexpected mutation endpoint")
	}
}
func TestObservedSOCKSSourceTrafficFailureAndAuthentication(t *testing.T) {
	c, p := setupTest(t)
	defer p.shutdown()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go serveObservedSOCKS(listener, c, p)
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	go func() {
		conn, e := target.Accept()
		if e == nil {
			defer conn.Close()
			io.Copy(conn, conn)
		}
	}()
	d, _ := xproxy.SOCKS5("tcp", listener.Addr().String(), &xproxy.Auth{User: c.User, Password: c.Password}, xproxy.Direct)
	conn, err := d.Dial("tcp", target.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	source := conn.LocalAddr().String()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	conn.Write([]byte("hello"))
	b := make([]byte, 5)
	if _, err = io.ReadFull(conn, b); err != nil {
		t.Fatal(err)
	}
	rows := waitRows(t, p, func(rows []connectionEvent) bool { return len(rows) == 1 && rows[0].Downloaded == 5 })
	if rows[0].Uploaded != 5 || rows[0].Source != source || rows[0].Target != target.Addr().String() || rows[0].State != "connected" || rows[0].Region != "test" {
		t.Fatalf("incorrect live row: %+v", rows)
	}
	conn.(*net.TCPConn).CloseWrite()
	io.Copy(io.Discard, conn)
	conn.Close()
	waitRows(t, p, func(rows []connectionEvent) bool { return rows[0].Ended != nil && rows[0].State == "closed" })
	bad, _ := xproxy.SOCKS5("tcp", listener.Addr().String(), &xproxy.Auth{User: c.User, Password: "wrong"}, xproxy.Direct)
	if c, e := bad.Dial("tcp", "example.com:80"); e == nil {
		c.Close()
		t.Fatal("authentication accepted")
	}
	waitRows(t, p, func(rows []connectionEvent) bool {
		return len(rows) == 2 && rows[1].State == "closed" && rows[0].State == "failed" && rows[0].Error != ""
	})
	p.allowPrivate = false
	if c, e := d.Dial("tcp", "127.0.0.1:80"); e == nil {
		c.Close()
		t.Fatal("private target accepted")
	}
	rows = waitRows(t, p, func(rows []connectionEvent) bool { return len(rows) == 3 && rows[0].State == "failed" })
	if !strings.Contains(rows[0].Error, "private/local") || len(rows[0].Attempts) != 0 {
		t.Fatalf("private reject missing: %+v", rows[0])
	}
}
func TestHTTPRequestsKeepOwnSourceWhenTunnelReused(t *testing.T) {
	c, p := setupTest(t)
	defer p.shutdown()
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.WriteHeader(503)
		io.WriteString(w, "reply")
	}))
	defer target.Close()
	h := httpProxy(c, p)
	auth := "Basic " + base64.StdEncoding.EncodeToString([]byte(c.User+":"+c.Password))
	for i := 0; i < 2; i++ {
		r := httptest.NewRequest("POST", target.URL+"/secret-path?token=do-not-store", strings.NewReader("data"))
		r.RemoteAddr = fmt.Sprintf("client-%d:1000", i)
		r.Header.Set("Proxy-Authorization", auth)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 503 || w.Body.String() != "reply" {
			t.Fatal("proxy request failed")
		}
	}
	rows := connectionRows(p)
	u, _ := url.Parse(target.URL)
	if len(rows) != 2 || rows[0].Source == rows[1].Source {
		t.Fatal("requests lost source identity")
	}
	for _, r := range rows {
		if r.Target != u.Host || r.Uploaded != 4 || r.Downloaded != 5 || r.HTTPStatus != 503 || r.Connected == nil || r.Ended == nil || r.State != "closed" || r.Region != "test" {
			t.Fatalf("incorrect HTTP row %+v", r)
		}
	}
	if p.success.Load() != 1 {
		t.Fatal("HTTP tunnel reuse regressed")
	}
	raw, _ := json.Marshal(p.connections.snapshot())
	if strings.Contains(string(raw), "do-not-store") || strings.Contains(string(raw), "secret-path") {
		t.Fatal("recorded complete URL")
	}
}
func TestObservedDialFailureRetainsAttempts(t *testing.T) {
	c, p := setupTest(t)
	defer p.shutdown()
	r := p.connections.begin("client:1", "SOCKS5")
	ctx := context.WithValue(context.Background(), connectionContextKey{}, r)
	_, err := p.dial(ctx, "tcp", "127.0.0.1:1")
	if err == nil {
		t.Fatal("unexpected connection")
	}
	rows := connectionRows(p)
	if len(rows) != 1 || rows[0].State != "failed" || len(rows[0].Attempts) != 1 || rows[0].Attempts[0].Error == "" || rows[0].Connected != nil {
		t.Fatalf("missing failure details %+v", rows)
	}
	if strings.Contains(rows[0].Error, c.Nodes[0].URL) {
		t.Fatal("endpoint leaked")
	}
}

func TestRetrySuccessKeepsEarlierAttemptError(t *testing.T) {
	c, p := setupTest(t)
	defer p.shutdown()
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "node unavailable", 503) }))
	defer bad.Close()
	p.nodes = append([]*nodeState{{nodeConfig: nodeConfig{Region: "unavailable", URL: "ws" + bad.URL[4:]}}}, p.nodes...)
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	r := p.connections.begin("client:9", "CONNECT")
	conn, err := p.dial(context.WithValue(context.Background(), connectionContextKey{}, r), "tcp", target.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	rows := connectionRows(p)
	if rows[0].State != "connected" || rows[0].Region != c.Nodes[0].Region || len(rows[0].Attempts) != 2 || rows[0].Attempts[0].Error == "" || rows[0].Error != "" {
		t.Fatalf("retry attribution incorrect %+v", rows[0])
	}
	conn.Close()
	rows = connectionRows(p)
	if rows[0].State != "closed" {
		t.Fatal("previous attempt incorrectly failed successful connection")
	}
}
