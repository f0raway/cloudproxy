package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSpecialUseTargetsNeverInvokeCloud(t *testing.T) {
	_, p := setupTest(t)
	p.allowPrivate = false
	for _, host := range []string{"198.18.2.150", "198.19.255.255", "100.64.1.2", "192.0.2.1", "198.51.100.1", "203.0.113.1", "240.0.0.1", "0.1.2.3", "127.0.0.1", "10.1.2.3", "::ffff:198.18.2.150", "2001:db8::1", "2001:2::1", "100::1", "fe80::1", "fc00::1"} {
		if publicTargetIP(net.ParseIP(host)) {
			t.Errorf("special-use target accepted: %s", host)
		}
		if c, err := p.dial(context.Background(), "tcp", net.JoinHostPort(host, "443")); err == nil {
			c.Close()
			t.Errorf("target invoked cloud: %s", host)
		}
	}
	for _, host := range []string{"1.1.1.1", "223.5.5.5", "8.8.8.8", "2606:4700:4700::1111", "192.0.0.9"} {
		if !publicTargetIP(net.ParseIP(host)) {
			t.Errorf("public target rejected: %s", host)
		}
	}
	for _, target := range []string{"example.com:0", "example.com:65536", ":443", "[fe80::1%lo0]:443"} {
		if c, e := p.dial(context.Background(), "tcp", target); e == nil {
			c.Close()
			t.Error("malformed target admitted")
		}
	}
	if p.meter.snapshot().Calls != 0 || len(p.slots) != 0 {
		t.Fatal("invalid targets consumed budget or slots")
	}
	normalized, err := normalizeTarget("EXAMPLE.COM.:0443")
	if err != nil || normalized != "example.com:443" {
		t.Fatal("backoff identity not normalized")
	}
}
func TestExponentialTargetBackoffRecoversAndCaps(t *testing.T) {
	policy := newTargetPolicy()
	now := time.Now()
	policy.now = func() time.Time { return now }
	for _, delay := range []time.Duration{30 * time.Second, time.Minute, 2 * time.Minute, 4 * time.Minute, 8 * time.Minute, 10 * time.Minute, 10 * time.Minute} {
		release, err := policy.acquire(context.Background(), "example.com:443")
		if err != nil {
			t.Fatal(err)
		}
		release(&targetDialError{detail: "timeout"})
		if policy.states["example.com:443"].retryUntil.Sub(now) != delay {
			t.Fatal("wrong backoff interval")
		}
		if _, err = policy.acquire(context.Background(), "example.com:443"); err == nil {
			t.Fatal("cooldown bypassed")
		}
		now = now.Add(delay)
	}
	release, err := policy.acquire(context.Background(), "example.com:443")
	if err != nil {
		t.Fatal(err)
	}
	release(nil)
	if policy.cooling() != 0 || policy.states["example.com:443"].failures != 0 {
		t.Fatal("successful recovery did not clear backoff")
	}
	release, err = policy.acquire(context.Background(), "example.com:443")
	if err != nil {
		t.Fatal(err)
	}
	release(fmt.Errorf("cloud node handshake failed"))
	if policy.cooling() != 0 {
		t.Fatal("node failure poisoned target")
	}
}
func TestConcurrentFailedTargetUsesOneCloudProbe(t *testing.T) {
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		time.Sleep(60 * time.Millisecond)
		w.Header().Set("X-Tunnel-Error", "target")
		http.Error(w, "Target connection failed", 502)
	}))
	defer server.Close()
	c, p := setupTest(t)
	_ = c
	p.nodes = []*nodeState{{nodeConfig: nodeConfig{Region: "a", URL: "ws" + server.URL[4:]}}, {nodeConfig: nodeConfig{Region: "b", URL: "ws" + server.URL[4:]}}}
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if conn, err := p.dial(context.Background(), "tcp", "offline.example.org:443"); err == nil {
				conn.Close()
				t.Error("unexpected connection")
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 || p.meter.snapshot().Calls != 1 || p.cachedTargetFailures.Load() != 31 || p.targets.cooling() != 1 {
		t.Fatalf("duplicate paid probes: calls=%d suppressed=%d", calls.Load(), p.cachedTargetFailures.Load())
	}
	if p.nodes[0].Failures != 0 || p.nodes[0].TargetFailures != 1 || len(p.slots) != 0 {
		t.Fatal("target failure poisoned regional node or leaked slots")
	}
}
func TestConcurrentHealthyTargetKeepsDistinctConnections(t *testing.T) {
	_, p := setupTest(t)
	defer p.shutdown()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, e := listener.Accept()
			if e != nil {
				return
			}
			go func() { defer conn.Close(); var b [1]byte; conn.Read(b[:]) }()
		}
	}()
	var wg sync.WaitGroup
	connections := make(chan net.Conn, 32)
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			conn, e := p.dial(context.Background(), "tcp", listener.Addr().String())
			if e != nil {
				t.Error(e)
				return
			}
			connections <- conn
		}()
	}
	wg.Wait()
	close(connections)
	if p.success.Load() != 32 || p.active.Load() != 32 {
		t.Fatal("healthy connections were shared or serialized out")
	}
	for conn := range connections {
		conn.Close()
	}
}
func TestLegacyMeterAllowanceMigrationIsAuditedAndIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.json")
	month := time.Now().In(time.FixedZone("CST", 28800)).Format("2006-01")
	old := usage{Month: month, Estimated: 6.25, Calls: 4000, Bytes: 2 * 1024 * 1024}
	raw, _ := json.Marshal(old)
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	m, err := openMeter(path, 8)
	if err != nil {
		t.Fatal(err)
	}
	s := m.snapshot()
	expected := old.Estimated - float64(old.Calls)*3*computeRate
	if s.ModelVersion != 2 || s.Estimated != expected || s.LegacyEstimated != old.Estimated || s.LegacyAllowanceRemoved != float64(old.Calls)*3*computeRate || s.Calls != old.Calls || s.Bytes != old.Bytes || m.limit != 8 {
		t.Fatalf("unsafe migration: %+v", s)
	}
	reopened, e := openMeter(path, 8)
	if e != nil || reopened.snapshot() != s {
		t.Fatal("migration applied twice")
	}
	lease, e := reopened.begin()
	if e != nil {
		t.Fatal(e)
	}
	lease.finish(time.Second, 0)
	after := reopened.snapshot()
	if delta := after.Estimated - s.Estimated; delta < computeRate+requestRate-1e-10 || delta > computeRate+requestRate+1e-10 {
		t.Fatal("fixed three seconds still charged")
	}
}
func TestOldMonthAllowanceNotCreditedToNewMonth(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.json")
	os.WriteFile(path, []byte(`{"month":"2000-01","estimated_yuan":8,"invocations":4000,"wire_bytes":12}`), 0600)
	m, e := openMeter(path, 8)
	if e != nil {
		t.Fatal(e)
	}
	s := m.snapshot()
	if s.Estimated != 0 || s.LegacyAllowanceRemoved != 0 || s.ModelVersion != 2 {
		t.Fatal("past-month allowance affected new month")
	}
}

func TestMeterSeparatesUsageFromPendingReserve(t *testing.T) {
	m, err := openMeter(filepath.Join(t.TempDir(), "usage.json"), 8)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := m.begin()
	if err != nil {
		t.Fatal(err)
	}
	d := m.breakdown()
	if d["pending_reserve_yuan"] <= 0 || d["usage_estimated_yuan"] != 0 {
		t.Fatal("fresh reserve presented as usage")
	}
	if err = lease.progress(10*time.Second, 100); err != nil {
		t.Fatal(err)
	}
	d = m.breakdown()
	if diff := d["usage_estimated_yuan"] - estimatedCost(10*time.Second, 100); diff > 1e-10 || diff < -1e-10 {
		t.Fatal("observed estimate missing")
	}
	lease.finish(10*time.Second, 100)
	d = m.breakdown()
	if d["pending_reserve_yuan"] != 0 || d["usage_estimated_yuan"] != m.snapshot().Estimated {
		t.Fatal("reserve not released")
	}
}
func TestBillCacheScopeStalenessAndInvalidData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bill.json")
	if readCloudBill(path)["available"] != false {
		t.Fatal("missing bill shown as zero")
	}
	now := time.Now()
	month := now.In(time.FixedZone("CST", 28800)).Format("2006-01")
	b := cloudBill{Month: month, SCFTotal: 3.5, Updated: now, Scope: "account_scf"}
	write := func() { raw, _ := json.Marshal(b); os.WriteFile(path, raw, 0600) }
	write()
	if s := readCloudBill(path); s["available"] != true || s["stale"] != false || s["scope"] != "account_scf" || s["scf_total_yuan"] != 3.5 {
		t.Fatal("bill cache not displayed correctly")
	}
	b.Updated = now.Add(-3 * time.Hour)
	write()
	if readCloudBill(path)["stale"] != true {
		t.Fatal("stale bill not identified")
	}
	b.Month = "2000-01"
	write()
	if readCloudBill(path)["available"] != false {
		t.Fatal("past bill displayed as current")
	}
	b.Month = month
	b.SCFTotal = -1
	write()
	if readCloudBill(path)["available"] != false {
		t.Fatal("negative bill accepted")
	}
}
