package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func validateNodeTokens(c agentConfig) error {
	for i, n := range c.Nodes {
		token := n.Token
		if token == "" {
			token = c.Token
		}
		if !n.Disabled && (token == "" || len(token) > 256 || strings.ContainsAny(token, "\r\n\x00")) {
			return fmt.Errorf("node %d requires a valid node token or shared fallback token", i+1)
		}
	}
	return nil
}

// Validation is read-only: no listener, ledger, cloud API or target connection.
func loadAgentConfig(path string) (agentConfig, error) {
	var c agentConfig
	raw, err := os.ReadFile(path)
	if err != nil {
		return c, fmt.Errorf("cannot read agent config: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if len(raw) > 1024*1024 || decoder.Decode(&c) != nil {
		return c, fmt.Errorf("invalid agent JSON or unknown configuration field")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return c, fmt.Errorf("agent config must contain one JSON object")
	}
	// The settings overlay is the authoritative UI-managed configuration.
	c, err = readSettings(c)
	if err != nil {
		return c, err
	}
	if c.Strategy == "" {
		c.Strategy = "free_first"
	}
	if c.MaxConnections == 0 {
		c.MaxConnections = 32
	}
	if err = validateSettings(settingsFrom(c)); err != nil {
		return c, err
	}
	if err = validateNodeTokens(c); err != nil {
		return c, err
	}
	if c.MaxConnections < 1 || c.MaxConnections > 64 {
		return c, fmt.Errorf("max_connections must be between 1 and 64")
	}
	if strings.Contains(c.Password, "CHANGE_ME") || strings.Contains(c.Token, "CHANGE_ME") {
		return c, fmt.Errorf("replace placeholder credentials before starting")
	}
	listeners := map[string]bool{}
	for _, item := range []struct{ name, address string }{{"http_addr", c.HTTP}, {"socks_addr", c.SOCKS}, {"dashboard_addr", c.Dashboard}} {
		host, port, e := net.SplitHostPort(item.address)
		number, numberErr := strconv.Atoi(port)
		if e != nil || numberErr != nil || number < 1 || number > 65535 || (host != "localhost" && host != "" && net.ParseIP(host) == nil) {
			return c, fmt.Errorf("%s must be an IP or localhost and a port between 1 and 65535", item.name)
		}
		// Avoid ambiguous wildcard collisions; one port per listener is deliberate.
		if listeners[port] {
			return c, fmt.Errorf("HTTP, SOCKS5 and dashboard listeners must use different ports")
		}
		listeners[port] = true
	}
	if !filepath.IsAbs(c.Ledger) {
		return c, fmt.Errorf("ledger_path must be an absolute path")
	}
	if !filepath.IsAbs(c.settingsPath()) || filepath.Clean(c.settingsPath()) == filepath.Clean(c.Ledger) {
		return c, fmt.Errorf("settings_path must be an absolute path different from ledger_path")
	}
	for _, n := range c.Nodes {
		if strings.Contains(n.URL, "YOUR_") || strings.Contains(n.Token, "CHANGE_ME") {
			return c, fmt.Errorf("replace placeholder node addresses and tokens")
		}
	}
	return c, nil
}
