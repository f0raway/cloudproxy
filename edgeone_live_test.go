package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"os"
	"testing"
	"time"
)

// Requires an explicitly authorized deployment. Credentials are supplied only
// through the caller's environment and are never saved in deployment output.
func TestEdgeOneAgentLiveHTTPS(t *testing.T) {
	address, token := os.Getenv("EDGEONE_AGENT_URL"), os.Getenv("EDGEONE_LIVE_TOKEN")
	if address == "" || token == "" {
		t.Skip("set EDGEONE_AGENT_URL and EDGEONE_LIVE_TOKEN to verify an authorized deployment")
	}
	node := nodeConfig{Provider: "edgeone", URL: address, AccessCookie: os.Getenv("EDGEONE_ACCESS_COOKIE")}
	stream, err := openHTTPStream(context.Background(), agentConfig{}, node, "example.com:443", token)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	if err = stream.SetDeadline(time.Now().Add(60 * time.Second)); err != nil {
		t.Fatal(err)
	}
	tlsConn := tls.Client(stream, &tls.Config{ServerName: "example.com", MinVersion: tls.VersionTLS12})
	if err = tlsConn.Handshake(); err != nil {
		t.Fatal(err)
	}
	if err = tlsConn.VerifyHostname("example.com"); err != nil {
		t.Fatal("upstream replaced the target certificate:", err)
	}
	if _, err = fmt.Fprint(tlsConn, "GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(tlsConn), &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("unexpected target status: %s", response.Status)
	}
	t.Log("EdgeOne Agent completed TLS with the target certificate and returned an HTTPS response")
}
