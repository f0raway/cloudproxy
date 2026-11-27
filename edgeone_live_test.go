package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Requires a separately authorized deployment. Credentials are supplied only
// through the caller's environment and are never saved in deployment output.
func TestEdgeOneLiveTCP(t *testing.T) {
	address, token := os.Getenv("EDGEONE_LIVE_URL"), os.Getenv("EDGEONE_LIVE_TOKEN")
	if address == "" || token == "" {
		t.Skip("set EDGEONE_LIVE_URL and EDGEONE_LIVE_TOKEN to verify an authorized deployment")
	}
	headers := http.Header{
		"X-Tunnel-Token":    []string{token},
		"X-Tunnel-Target":   []string{"example.com:80"},
		"X-Tunnel-Protocol": []string{"2"},
	}
	if cookie := os.Getenv("EDGEONE_ACCESS_COOKIE"); cookie != "" {
		headers.Set("Cookie", cookie)
	}
	ws, response, err := (&websocket.Dialer{HandshakeTimeout: 20 * time.Second}).Dial(address, headers)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	defer ws.Close()
	if err = ws.WriteMessage(websocket.BinaryMessage, []byte("GET / HTTP/1.0\r\nHost: example.com\r\nConnection: close\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	for {
		kind, data, err := ws.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if kind == websocket.TextMessage {
			if string(data) == "EOF" {
				t.Fatal("target returned EOF before an HTTP response")
			}
			var ack dialAck
			if err = json.Unmarshal(data, &ack); err != nil || !ack.OK {
				t.Fatal(fmt.Errorf("tunnel rejected: %s (%v)", data, err))
			}
			continue
		}
		if !strings.HasPrefix(string(data), "HTTP/1.") {
			t.Fatalf("unexpected TCP bytes: %q", data[:min(len(data), 80)])
		}
		t.Log("EdgeOne Makers Cloud Function established a raw TCP tunnel and returned the target HTTP response")
		return
	}
}
