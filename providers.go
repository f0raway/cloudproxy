package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type costRates struct {
	Compute float64 `json:"compute_yuan_per_second"`
	Traffic float64 `json:"traffic_yuan_per_gb"`
	Request float64 `json:"request_yuan"`
}

func (r costRates) valid() bool {
	for _, v := range []float64{r.Compute, r.Traffic, r.Request} {
		if v < 0 || math.IsNaN(v) || math.IsInf(v, 0) {
			return false
		}
	}
	return true
}
func (r costRates) estimate(d time.Duration, n int64) float64 {
	return math.Max(0, d.Seconds())*r.Compute + float64(n)*2*r.Traffic/(1024*1024*1024) + r.Request
}
func (r costRates) window() float64 { return 30*r.Compute + 2*256*1024*r.Traffic/(1024*1024*1024) }
func defaultRates() costRates {
	return costRates{Compute: computeRate, Traffic: .8, Request: requestRate}
}
func (n nodeConfig) provider() string {
	if n.Provider == "" {
		return "tencent"
	}
	return n.Provider
}
func (n nodeConfig) rates() costRates {
	if n.provider() == "cloudflare" {
		return costRates{}
	}
	if n.Rates != nil {
		return *n.Rates
	}
	return defaultRates()
}
func (n nodeConfig) quotaGroup() string {
	if n.QuotaGroup != "" {
		return n.QuotaGroup
	}
	return "cloudflare"
}

type providerTargetError struct{ detail string }

func (e *providerTargetError) Error() string { return "provider cannot reach target: " + e.detail }

type dailyUsage struct {
	Day  string `json:"utc_day"`
	Used int    `json:"used"`
}
type dailyQuota struct {
	mu     sync.Mutex
	path   string
	groups map[string]dailyUsage
	now    func() time.Time
}

func openDailyQuota(path string) (*dailyQuota, error) {
	q := &dailyQuota{path: path, groups: make(map[string]dailyUsage), now: time.Now}
	raw, e := os.ReadFile(path)
	if e != nil && !os.IsNotExist(e) {
		return nil, e
	}
	if e == nil && json.Unmarshal(raw, &q.groups) != nil {
		return nil, fmt.Errorf("invalid provider daily quota ledger")
	}
	if q.groups == nil {
		q.groups = make(map[string]dailyUsage)
	}
	return q, nil
}
func (q *dailyQuota) available(group string, limit int) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	s := q.groups[group]
	return limit > 0 && (s.Day != q.now().UTC().Format("2006-01-02") || s.Used < limit)
}
func (q *dailyQuota) reserve(group string, limit int) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	day := q.now().UTC().Format("2006-01-02")
	old := q.groups[group]
	s := old
	if s.Day != day {
		s = dailyUsage{Day: day}
	}
	if limit <= 0 || s.Used >= limit {
		return fmt.Errorf("Cloudflare local daily request limit reached; no new free-node attempts")
	}
	s.Used++
	q.groups[group] = s
	raw, e := json.Marshal(q.groups)
	if e != nil {
		return e
	}
	if e = os.WriteFile(q.path+".tmp", raw, 0600); e == nil {
		e = os.Rename(q.path+".tmp", q.path)
	}
	if e != nil {
		q.groups[group] = old
		return fmt.Errorf("cannot persist provider quota; cloud request not started")
	}
	return nil
}
func (q *dailyQuota) snapshot() map[string]dailyUsage {
	q.mu.Lock()
	defer q.mu.Unlock()
	out := make(map[string]dailyUsage)
	day := q.now().UTC().Format("2006-01-02")
	for group, s := range q.groups {
		if s.Day != day {
			s = dailyUsage{Day: day}
		}
		out[group] = s
	}
	return out
}
func quotaPath(c agentConfig) string {
	return filepath.Join(filepath.Dir(c.Ledger), "provider-daily-usage.json")
}
