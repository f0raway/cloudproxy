package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Special-use destinations must never start a billable cloud invocation.
var nonPublicPrefixes = func() []netip.Prefix {
	values := []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "100::/64", "2001:db8::/32", "2001:2::/48", "2001:10::/28", "2001:20::/28"}
	prefixes := make([]netip.Prefix, 0, len(values))
	for _, value := range values {
		prefixes = append(prefixes, netip.MustParsePrefix(value))
	}
	return prefixes
}()

func publicTargetIP(ip net.IP) bool {
	address, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	address = address.Unmap()
	if !address.IsGlobalUnicast() || address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast() {
		return false
	}
	// Globally reachable exceptions inside IANA's protocol-assignment range.
	if address == netip.MustParseAddr("192.0.0.9") || address == netip.MustParseAddr("192.0.0.10") {
		return true
	}
	for _, prefix := range nonPublicPrefixes {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}
func normalizeTarget(address string) (string, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return "", fmt.Errorf("target requires host:port")
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 || host == "" {
		return "", fmt.Errorf("invalid target host or port")
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		if ip.Zone() != "" {
			return "", fmt.Errorf("scoped/local IPv6 target cannot be reached through SCF")
		}
		host = ip.Unmap().String()
	} else {
		host = strings.TrimSuffix(strings.ToLower(host), ".")
	}
	return net.JoinHostPort(host, strconv.Itoa(number)), nil
}

type targetState struct {
	providerFailures                   map[string]int
	providerFailedAt                   map[string]time.Time
	providerRetry                      map[string]time.Time
	failures                           int
	retryUntil, healthyUntil, lastUsed time.Time
	probe                              chan struct{}
}
type targetPolicy struct {
	mu     sync.Mutex
	states map[string]*targetState
	now    func() time.Time
}

func newTargetPolicy() *targetPolicy {
	return &targetPolicy{states: make(map[string]*targetState), now: time.Now}
}

type targetGateError struct{ message string }

func (e *targetGateError) Error() string { return e.message }

// Unknown/unhealthy targets get one initial probe. Successful sockets are never
// shared: waiters open their own tunnels after the first probe succeeds.
func (t *targetPolicy) acquire(ctx context.Context, address string) (func(error), error) {
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		t.mu.Lock()
		now := t.now()
		s := t.states[address]
		if s == nil {
			if len(t.states) >= 2048 {
				var oldest string
				var oldestAt time.Time
				for key, value := range t.states {
					if value.probe == nil && (oldest == "" || value.lastUsed.Before(oldestAt)) {
						oldest = key
						oldestAt = value.lastUsed
					}
				}
				if oldest == "" {
					t.mu.Unlock()
					return nil, &targetGateError{"target probe capacity reached; retry later"}
				}
				delete(t.states, oldest)
			}
			s = &targetState{}
			t.states[address] = s
		}
		if now.Sub(s.lastUsed) > 30*time.Minute && s.probe == nil {
			s.failures = 0
		}
		s.lastUsed = now
		if now.Before(s.retryUntil) {
			wait := s.retryUntil.Sub(now).Round(time.Second)
			t.mu.Unlock()
			return nil, &targetGateError{fmt.Sprintf("target connection recently failed; local backoff, retry after %s", wait)}
		}
		if now.Before(s.healthyUntil) {
			t.mu.Unlock()
			return func(err error) { t.complete(address, s, nil, err) }, nil
		}
		if s.probe == nil {
			probe := make(chan struct{})
			s.probe = probe
			t.mu.Unlock()
			return func(err error) { t.complete(address, s, probe, err) }, nil
		}
		probe := s.probe
		t.mu.Unlock()
		select {
		case <-probe:
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timer.C:
			return nil, &targetGateError{"target connection probe in progress; retry later"}
		}
	}
}
func (t *targetPolicy) complete(address string, s *targetState, probe chan struct{}, err error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	// A healthy entry may have been evicted while its tunnels were opening.
	if t.states[address] != s {
		return
	}
	now := t.now()
	s.lastUsed = now
	var targetErr *targetDialError
	if err == nil {
		s.failures = 0
		s.retryUntil = time.Time{}
		s.healthyUntil = now.Add(5 * time.Minute)
	} else if errors.As(err, &targetErr) {
		s.healthyUntil = time.Time{}
		s.failures++
		delay := 30 * time.Second
		for n := 1; n < s.failures && delay < 10*time.Minute; n++ {
			delay *= 2
		}
		if delay > 10*time.Minute {
			delay = 10 * time.Minute
		}
		s.retryUntil = now.Add(delay)
	}
	if probe != nil && s.probe == probe {
		s.probe = nil
		close(probe)
	}
}
func (t *targetPolicy) cooling() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	n := 0
	now := t.now()
	for _, s := range t.states {
		if now.Before(s.retryUntil) {
			n++
		}
	}
	return n
}

func (t *targetPolicy) skipProvider(address, provider string) {
	t.skipProviderFor(address, provider, 10*time.Minute)
}
func (t *targetPolicy) skipProviderFor(address, provider string, delay time.Duration) {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := t.states[address]
	if s == nil {
		return
	}
	if s.providerRetry == nil {
		s.providerRetry = make(map[string]time.Time)
	}
	s.providerRetry[provider] = t.now().Add(delay)
}
func (t *targetPolicy) providerBlocked(address, provider string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := t.states[address]
	return s != nil && t.now().Before(s.providerRetry[provider])
}

func (t *targetPolicy) providerFailed(address, provider string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := t.states[address]
	if s == nil {
		return
	}
	now := t.now()
	if s.providerRetry == nil {
		s.providerRetry = make(map[string]time.Time)
	}
	if s.providerFailures == nil {
		s.providerFailures = make(map[string]int)
		s.providerFailedAt = make(map[string]time.Time)
	}
	if now.Sub(s.providerFailedAt[provider]) > 30*time.Minute {
		s.providerFailures[provider] = 0
	}
	s.providerFailures[provider]++
	s.providerFailedAt[provider] = now
	delay := 30 * time.Second
	for i := 1; i < s.providerFailures[provider] && delay < 10*time.Minute; i++ {
		delay *= 2
	}
	if delay > 10*time.Minute {
		delay = 10 * time.Minute
	}
	s.providerRetry[provider] = now.Add(delay)
}
func (t *targetPolicy) providerSucceeded(address, provider string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := t.states[address]
	if s == nil {
		return
	}
	delete(s.providerRetry, provider)
	delete(s.providerFailures, provider)
	delete(s.providerFailedAt, provider)
}
