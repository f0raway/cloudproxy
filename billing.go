package main

import (
	"encoding/json"
	"io"
	"math"
	"os"
	"time"
)

type cloudBill struct {
	Month    string    `json:"month"`
	SCFTotal float64   `json:"scf_total_yuan"`
	Updated  time.Time `json:"updated_at"`
	Scope    string    `json:"scope"`
}

// Optional hourly cache. Billing API/credential access stays outside the proxy
// process; a missing/stale bill must never disable proxying or imply zero cost.
func readCloudBill(path string) map[string]any {
	unavailable := map[string]any{"available": false, "scope": "account_scf"}
	if path == "" {
		return unavailable
	}
	f, err := os.Open(path)
	if err != nil {
		return unavailable
	}
	defer f.Close()
	var bill cloudBill
	if err = json.NewDecoder(io.LimitReader(f, 8192)).Decode(&bill); err != nil {
		return unavailable
	}
	now := time.Now()
	month := now.In(time.FixedZone("CST", 28800)).Format("2006-01")
	if bill.Month != month || bill.Scope != "account_scf" || bill.Updated.IsZero() || bill.Updated.After(now.Add(5*time.Minute)) || bill.SCFTotal < 0 || math.IsNaN(bill.SCFTotal) || math.IsInf(bill.SCFTotal, 0) {
		return unavailable
	}
	return map[string]any{"available": true, "month": bill.Month, "scf_total_yuan": bill.SCFTotal, "updated_at": bill.Updated, "scope": bill.Scope, "stale": now.Sub(bill.Updated) > 2*time.Hour}
}
