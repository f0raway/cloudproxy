package main

import (
	"context"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func TestSOCKSDisconnectAfterAuthenticationDoesNotLookLikeNodeFailure(t *testing.T) {
	c, p := setupTest(t)
	defer p.shutdown()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go serveObservedSOCKS(listener, c, p)
	conn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(2 * time.Second))
	conn.Write([]byte{5, 1, 2})
	var reply [2]byte
	if _, err = io.ReadFull(conn, reply[:]); err != nil || reply != [2]byte{5, 2} {
		t.Fatal("method negotiation failed", err)
	}
	auth := append([]byte{1, byte(len(c.User))}, []byte(c.User)...)
	auth = append(auth, byte(len(c.Password)))
	auth = append(auth, []byte(c.Password)...)
	conn.Write(auth)
	if _, err = io.ReadFull(conn, reply[:]); err != nil || reply != [2]byte{1, 0} {
		t.Fatal("authentication failed", err)
	}
	conn.Close()
	rows := waitRows(t, p, func(rows []connectionEvent) bool { return len(rows) == 1 && rows[0].Ended != nil })
	r := rows[0]
	if r.ErrorCategory != "client_disconnect" || r.Target != "" || len(r.Attempts) != 0 || p.meter.snapshot().Calls != 0 {
		t.Fatalf("handshake EOF misreported or invoked node: %+v", r)
	}
}

func TestDiagnosticsPreserveActualUpstreamEOFFailure(t *testing.T) {
	for _, c := range []struct {
		target, error, want string
		attempted           bool
	}{
		{"", "Failed to read destination address: Failed to get command version: EOF", "client_disconnect", false},
		{"", "Failed to authenticate: unexpected EOF", "client_disconnect", false},
		{"example.org:443", "region: HTTP 101: websocket: close 1006 (abnormal closure): unexpected EOF", "upstream", true},
		{"example.org:443", "region: HTTP 101: provider cannot reach target: proxy request failed", "provider_target", true},
		{"[2606:4700::1]:443", "region: target connection failed: connect: network is unreachable", "target_network", true},
		{"example.org:443", "region: target connection failed: connect: network is unreachable", "target_connect", true},
	} {
		r := connectionEvent{Target: c.target, Error: c.error}
		if c.attempted {
			r.Attempts = []connectionAttempt{{Region: "test"}}
		}
		classifyConnection(&r)
		if r.ErrorCategory != c.want {
			t.Fatalf("wanted %s, got %+v", c.want, r)
		}
	}
}

func TestUnavailableNodesExplainExclusionsWithoutCloudCalls(t *testing.T) {
	c, p := setupTest(t)
	defer p.shutdown()
	const address = "example.org:443"
	p.nodes = []*nodeState{{nodeConfig: nodeConfig{Provider: "tencent", Disabled: true}}, {nodeConfig: nodeConfig{Provider: "cloudflare"}}}
	release, err := p.targets.acquire(context.Background(), address)
	if err != nil {
		t.Fatal(err)
	}
	release(nil)
	p.targets.skipProvider(address, "cloudflare")
	_, err = p.dial(context.Background(), "tcp", address)
	if err == nil || !strings.Contains(err.Error(), "已停用节点 1 个") || !strings.Contains(err.Error(), "对此目标退避的平台节点 1 个") {
		t.Fatal("missing eligibility explanation", err)
	}
	if p.meter.snapshot().Calls != 0 || p.failed.Load() != 0 {
		t.Fatal("eligibility check invoked or blamed node")
	}
	p.targets.providerSucceeded(address, "cloudflare")
	zero := 0
	c.CFDaily = &zero
	c.PaidDisabled = true
	p.configValue.Store(&c)
	p.nodes[0].Disabled = false
	reason := p.noEligibleReason(address)
	if !strings.Contains(reason, "付费回退被关闭的节点 1 个") || !strings.Contains(reason, "今日额度已用尽的节点 1 个") {
		t.Fatal(reason)
	}
	p.nodes[1].RetryAfter = time.Now().Add(time.Minute)
	if !strings.Contains(p.noEligibleReason(address), "故障冷却节点 1 个") {
		t.Fatal("cooldown not explained")
	}
}
