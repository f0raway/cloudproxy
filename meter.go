package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const computeRate = 0.125 * 0.00011108
const trafficRate = 0.80 / (1024 * 1024 * 1024)
const requestRate = 0.0133 / 10000
const budgetWindow = 30*computeRate + 2*256*1024*trafficRate

type usage struct {
	ModelVersion           int     `json:"model_version"`
	LegacyEstimated        float64 `json:"legacy_estimated_yuan,omitempty"`
	LegacyAllowanceRemoved float64 `json:"legacy_fixed_allowance_removed_yuan,omitempty"`
	Month                  string  `json:"month"`
	Estimated              float64 `json:"estimated_yuan"`
	Calls                  uint64  `json:"invocations"`
	Bytes                  uint64  `json:"wire_bytes"`
}
type budgetLease struct {
	rates costRates
	m     *meter
	held  float64
	spent float64
	done  bool
}
type meter struct {
	mu     sync.Mutex
	path   string
	limit  float64
	state  usage
	active map[*budgetLease]bool
}

func openMeter(path string, limit float64) (*meter, error) {
	if limit <= 0 || math.IsNaN(limit) || math.IsInf(limit, 0) {
		return nil, fmt.Errorf("invalid budget")
	}
	m := &meter{path: path, limit: limit, active: make(map[*budgetLease]bool)}
	b, e := os.ReadFile(path)
	if e == nil {
		if e = json.Unmarshal(b, &m.state); e != nil {
			return nil, e
		}
	} else if !os.IsNotExist(e) {
		return nil, e
	}
	m.roll()
	if m.state.ModelVersion == 0 {
		// v1 charged an unconditional 3s on every admitted attempt. Remove that
		// deterministic allowance once, preserving the old estimate for audit.
		m.state.LegacyEstimated = m.state.Estimated
		m.state.LegacyAllowanceRemoved = math.Min(m.state.Estimated, float64(m.state.Calls)*3*computeRate)
		m.state.Estimated -= m.state.LegacyAllowanceRemoved
		m.state.ModelVersion = 2
	}
	return m, m.save()
}
func (m *meter) roll() {
	month := time.Now().In(time.FixedZone("CST", 28800)).Format("2006-01")
	if m.state.Month != month {
		m.state = usage{ModelVersion: 2, Month: month}
		for charge := range m.active {
			m.state.Estimated += charge.held
			m.state.Calls++
		}
	}
}
func (m *meter) save() error {
	b, e := json.MarshalIndent(m.state, "", "  ")
	if e != nil {
		return e
	}
	if e = os.MkdirAll(filepath.Dir(m.path), 0700); e != nil {
		return e
	}
	if e = os.WriteFile(m.path+".tmp", b, 0600); e != nil {
		return e
	}
	return os.Rename(m.path+".tmp", m.path)
}
func (m *meter) snapshot() usage { m.mu.Lock(); defer m.mu.Unlock(); m.roll(); return m.state }
func estimatedCost(d time.Duration, n int64) float64 {
	return math.Max(0, d.Seconds())*computeRate + float64(n)*2*trafficRate + requestRate
}
func (m *meter) begin() (*budgetLease, error) { return m.beginWithRates(defaultRates()) }
func (m *meter) beginWithRates(rates costRates) (*budgetLease, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.roll()
	amount := rates.window() + rates.Request
	if amount > 0 && m.state.Estimated+amount > m.limit {
		return nil, fmt.Errorf("本月本地估算额度不足，新的转发暂停")
	}
	prev := m.state
	charge := &budgetLease{m: m, held: amount, rates: rates}
	m.active[charge] = true
	m.state.Estimated += amount
	m.state.Calls++
	if e := m.save(); e != nil {
		m.state = prev
		delete(m.active, charge)
		return nil, e
	}
	return charge, nil
}

// progress replenishes a small rolling reserve before the current one is spent.
// It persists only at a reserve boundary, rather than on every network packet.
func (c *budgetLease) progress(d time.Duration, n int64) error {
	m := c.m
	m.mu.Lock()
	defer m.mu.Unlock()
	if c.done {
		return net.ErrClosed
	}
	m.roll()
	spent := c.rates.estimate(d, n)
	c.spent = spent
	if c.held-spent >= c.rates.window()/2 {
		return nil
	}
	additional := spent + c.rates.window() - c.held
	if m.state.Estimated+additional > m.limit {
		return fmt.Errorf("本月费用保护达到上限，当前隧道停止转发")
	}
	m.state.Estimated += additional
	c.held += additional
	if e := m.save(); e != nil {
		m.state.Estimated -= additional
		c.held -= additional
		return e
	}
	return nil
}
func (c *budgetLease) finish(d time.Duration, n int64) error {
	m := c.m
	m.mu.Lock()
	defer m.mu.Unlock()
	if c.done {
		return nil
	}
	m.roll()
	c.done = true
	delete(m.active, c)
	m.state.Estimated += c.rates.estimate(d, n) - c.held
	if m.state.Estimated < 0 {
		m.state.Estimated = 0
	}
	if n > 0 {
		m.state.Bytes += uint64(n)
	}
	return m.save()
}
func (m *meter) reserve() (func(time.Duration, int64) error, error) {
	c, e := m.begin()
	if e != nil {
		return nil, e
	}
	return c.finish, nil
}

func (m *meter) breakdown() map[string]float64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.roll()
	reserve := 0.0
	for lease := range m.active {
		reserve += math.Max(0, lease.held-lease.spent)
	}
	return map[string]float64{"usage_estimated_yuan": math.Max(0, m.state.Estimated-reserve), "pending_reserve_yuan": reserve}
}

func (m *meter) canBegin(rates costRates) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	amount := rates.window() + rates.Request
	return amount == 0 || m.state.Estimated+amount <= m.limit
}
