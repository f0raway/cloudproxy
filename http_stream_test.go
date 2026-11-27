package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func newStreamTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	var mu sync.Mutex
	sessions := make(map[string]chan []byte)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Tunnel-Token") != "test-token" || r.Header.Get("Cookie") != "eo_token=private" || r.Header.Get("X-Tunnel-Protocol") != "5" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		id := r.Header.Get("X-Tunnel-Session")
		var payload struct {
			Action string `json:"action"`
			Data   string `json:"data"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		switch payload.Action {
		case "open":
			writes := make(chan []byte, 16)
			mu.Lock()
			sessions[id] = writes
			mu.Unlock()
			defer func() {
				mu.Lock()
				delete(sessions, id)
				mu.Unlock()
			}()
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("X-Tunnel-Ready", "pending")
			w.WriteHeader(http.StatusOK)
			controller := http.NewResponseController(w)
			_ = controller.EnableFullDuplex()
			if err := controller.Flush(); err != nil {
				return
			}
			_, _ = fmt.Fprint(w, "event: ready\n\n")
			_ = controller.Flush()
			for {
				select {
				case data, ok := <-writes:
					if !ok {
						return
					}
					if _, err := fmt.Fprintf(w, "data:%s\n\n", base64.StdEncoding.EncodeToString(data)); err != nil {
						return
					}
					_ = controller.Flush()
				case <-r.Context().Done():
					return
				}
			}
		case "write":
			mu.Lock()
			writes := sessions[id]
			mu.Unlock()
			if writes == nil {
				http.Error(w, "tunnel session unavailable", http.StatusConflict)
				return
			}
			data, _ := base64.StdEncoding.DecodeString(payload.Data)
			writes <- data
			w.Header().Set("X-Tunnel-Ready", "true")
			w.WriteHeader(http.StatusNoContent)
		case "eof":
			mu.Lock()
			writes := sessions[id]
			mu.Unlock()
			close(writes)
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func testStreamNode(server *httptest.Server) nodeConfig {
	return nodeConfig{Provider: "edgeone", URL: "ws" + strings.TrimPrefix(server.URL, "http"), AccessCookie: "eo_token=private"}
}

func TestHTTPStreamOutlivesDialContext(t *testing.T) {
	server := newStreamTestServer(t)
	node := testStreamNode(server)
	ctx, cancel := context.WithCancel(context.Background())
	stream, err := openHTTPStream(ctx, agentConfig{}, node, "example.com:80", "test-token")
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	cancel()
	if _, err = stream.Write([]byte("alive")); err != nil {
		t.Fatal("dial context canceled the live stream:", err)
	}
	got := make([]byte, 5)
	if _, err = io.ReadFull(stream, got); err != nil || string(got) != "alive" {
		t.Fatalf("stream did not outlive dial context: %q %v", got, err)
	}
}

func TestHTTPStreamSupportsFullDuplex(t *testing.T) {
	server := newStreamTestServer(t)
	node := testStreamNode(server)
	stream, err := openHTTPStream(context.Background(), agentConfig{}, node, "example.com:80", "test-token")
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	if _, ok := stream.RemoteAddr().(*net.TCPAddr); !ok {
		t.Fatalf("SOCKS5 requires a TCP remote address, got %T", stream.RemoteAddr())
	}
	if local := stream.LocalAddr().(*net.TCPAddr); local.IP == nil {
		t.Fatal("SOCKS5 requires a formattable local IP")
	}
	for _, payload := range []string{"first", "second"} {
		if _, err = stream.Write([]byte(payload)); err != nil {
			t.Fatal(err)
		}
		got := make([]byte, len(payload))
		if _, err = io.ReadFull(stream, got); err != nil || string(got) != payload {
			t.Fatalf("full duplex read = %q, %v", got, err)
		}
	}
	if stream.transferred.Load() != int64(2*(len("first")+len("second"))) {
		t.Fatal("traffic accounting was not applied")
	}
	if err = stream.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	if _, err = stream.Write([]byte("closed")); err == nil {
		t.Fatal("half-closed upload accepted more bytes")
	}
}

func TestHTTPStreamSecretsStayPrivate(t *testing.T) {
	c, p := setupTest(t)
	s := editableSettings(p)
	s.Nodes[0].AccessCookie = "eo_token=private-preview"
	if err := p.saveSettings(s); err != nil {
		t.Fatal(err)
	}
	if got := p.connections.clean("cookie: eo_token=private-preview"); got != "cookie: [redacted]" {
		t.Fatal("preview cookie was not redacted:", got)
	}
	r := httptest.NewRequest(http.MethodGet, "http://monitor.example/api/settings", nil)
	r.SetBasicAuth(c.User, c.Password)
	w := httptest.NewRecorder()
	dashboardHandler(c, p).ServeHTTP(w, r)
	if w.Code != 200 || strings.Contains(w.Body.String(), "private-preview") {
		t.Fatal("settings exposed the preview cookie")
	}
	next := editableSettings(p)
	next.Nodes[0].AccessCookie = ""
	if err := p.saveSettings(next); err != nil {
		t.Fatal(err)
	}
	if got := p.config().Nodes[0].AccessCookie; got != "eo_token=private-preview" {
		t.Fatalf("blank preview cookie did not retain the private value: %q", got)
	}
}

func TestHTTPStreamTargetError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "target connection failed", http.StatusBadGateway)
	}))
	defer server.Close()
	node := nodeConfig{Provider: "edgeone", URL: "ws" + strings.TrimPrefix(server.URL, "http")}
	stream, err := openHTTPStream(context.Background(), agentConfig{}, node, "127.0.0.1:1", "test-token")
	if stream != nil {
		defer stream.Close()
	}
	var target *targetDialError
	if !errors.As(err, &target) {
		t.Fatalf("target failure was misclassified: %v", err)
	}
}

func TestHTTPStreamWriteDeadline(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct{ Action string }
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if payload.Action == "open" {
			w.Header().Set("X-Tunnel-Ready", "true")
			w.WriteHeader(http.StatusOK)
			http.NewResponseController(w).Flush()
			<-r.Context().Done()
			return
		}
		time.Sleep(time.Second)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	node := nodeConfig{Provider: "edgeone", URL: "ws" + strings.TrimPrefix(server.URL, "http")}
	stream, err := openHTTPStream(context.Background(), agentConfig{}, node, "example.com:80", "test-token")
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	if err = stream.SetWriteDeadline(time.Now().Add(20 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	if _, err = stream.Write([]byte("late")); !errors.Is(err, os.ErrDeadlineExceeded) && !errors.Is(err, io.ErrClosedPipe) && !errors.Is(err, context.Canceled) {
		t.Fatalf("write deadline error = %v", err)
	}
}
