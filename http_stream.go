package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type httpStream struct {
	ctx      context.Context
	cancel   context.CancelFunc
	response *http.Response
	events   *bufio.Reader
	pending  []byte
	upload   *http.Client
	url      string
	token    string
	cookie   string
	session  string
	remote   *net.TCPAddr

	ready     chan struct{}
	readyErr  error
	onReady   func()
	readyOnce sync.Once
	confirmed atomic.Bool

	closeOnce  sync.Once
	readMu     sync.Mutex
	writeMu    sync.Mutex
	readTimer  *time.Timer
	writeTimer *time.Timer
}

func (s *httpStream) waitReady() error {
	<-s.ready
	return s.readyErr
}

func (s *httpStream) notifyReady() {
	if !s.confirmed.Load() {
		return
	}
	s.readyOnce.Do(func() {
		s.readMu.Lock()
		callback := s.onReady
		s.readMu.Unlock()
		if callback != nil {
			callback()
		}
	})
}

func (s *httpStream) setReadyCallback(callback func()) {
	s.readMu.Lock()
	s.onReady = callback
	ready := s.response != nil && s.confirmed.Load()
	s.readMu.Unlock()
	if ready {
		s.notifyReady()
	}
}

func (s *httpStream) Read(p []byte) (int, error) {
	if err := s.waitReady(); err != nil {
		return 0, err
	}
	if len(s.pending) > 0 {
		n := copy(p, s.pending)
		s.pending = s.pending[n:]
		return n, nil
	}
	for {
		event, data, err := s.nextEvent()
		if err != nil {
			return 0, err
		}
		switch event {
		case "ready":
			s.confirmed.Store(true)
			s.notifyReady()
			continue
		case "eof":
			return 0, io.EOF
		case "error":
			return 0, fmt.Errorf("upstream target stream failed")
		}
		if len(data) > 0 {
			s.pending = data
			n := copy(p, s.pending)
			s.pending = s.pending[n:]
			return n, nil
		}
	}
}

func (s *httpStream) nextEvent() (string, []byte, error) {
	var event, encoded string
	for {
		line, err := s.events.ReadString('\n')
		if len(line) > 128*1024 {
			return "", nil, fmt.Errorf("SSE event exceeds 128 KiB")
		}
		if err != nil && line == "" {
			return "", nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			if event == "eof" || event == "error" {
				return event, nil, nil
			}
			if event != "" {
				return event, nil, nil
			}
			if encoded == "" {
				return "", nil, nil
			}
			data, decodeErr := base64.StdEncoding.DecodeString(encoded)
			return "", data, decodeErr
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		if strings.HasPrefix(line, "event:") {
			event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		}
		if strings.HasPrefix(line, "data:") {
			encoded = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		}
		if err != nil {
			return "", nil, err
		}
	}
}
func (s *httpStream) Write(p []byte) (int, error) { return s.send(p, false) }
func (s *httpStream) CloseWrite() error {
	_, err := s.send(nil, true)
	return err
}
func (s *httpStream) LocalAddr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4zero, Port: 0}
}
func (s *httpStream) RemoteAddr() net.Addr { return s.remote }

func (s *httpStream) send(p []byte, eof bool) (int, error) {
	payload := map[string]any{"action": "write", "data": base64.StdEncoding.EncodeToString(p)}
	if eof {
		payload = map[string]any{"action": "eof"}
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(s.ctx, http.MethodPost, s.url, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Tunnel-Protocol", "5")
	req.Header.Set("X-Tunnel-Session", s.session)
	req.Header.Set("Makers-Conversation-Id", s.session)
	req.Header.Set("X-Tunnel-Token", s.token)
	if s.cookie != "" {
		req.Header.Set("Cookie", s.cookie)
	}
	if eof {
		req.Header.Set("X-Tunnel-EOF", "true")
	}
	response, err := s.upload.Do(req)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.Header.Get("X-Tunnel-Ready") == "true" {
		s.confirmed.Store(true)
		s.notifyReady()
	}
	if response.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return 0, fmt.Errorf("upload rejected: HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	return len(p), nil
}

func (s *httpStream) Close() error {
	s.closeOnce.Do(func() {
		s.cancel()
		s.readMu.Lock()
		if s.response != nil {
			_ = s.response.Body.Close()
		}
		if s.readTimer != nil {
			s.readTimer.Stop()
		}
		s.readMu.Unlock()
		s.writeMu.Lock()
		if s.writeTimer != nil {
			s.writeTimer.Stop()
		}
		s.writeMu.Unlock()
		s.upload.CloseIdleConnections()
	})
	return nil
}
func (s *httpStream) SetDeadline(t time.Time) error {
	_ = s.SetReadDeadline(t)
	return s.SetWriteDeadline(t)
}
func (s *httpStream) SetReadDeadline(t time.Time) error {
	s.readMu.Lock()
	defer s.readMu.Unlock()
	if s.readTimer != nil {
		s.readTimer.Stop()
	}
	if t.IsZero() {
		return nil
	}
	s.readTimer = time.AfterFunc(time.Until(t), func() {
		s.cancel()
		s.readMu.Lock()
		if s.response != nil {
			_ = s.response.Body.Close()
		}
		s.readMu.Unlock()
	})
	return nil
}
func (s *httpStream) SetWriteDeadline(t time.Time) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.writeTimer != nil {
		s.writeTimer.Stop()
	}
	if t.IsZero() {
		return nil
	}
	s.writeTimer = time.AfterFunc(time.Until(t), func() {
		s.cancel()
		_ = s.response.Body.Close()
	})
	return nil
}

func tcpStreamAddress(u *url.URL) *net.TCPAddr {
	port := 443
	if u.Scheme == "http" {
		port = 80
	}
	if value := u.Port(); value != "" {
		if parsed, err := strconv.Atoi(value); err == nil {
			port = parsed
		}
	}
	ip := net.ParseIP(u.Hostname())
	if ip == nil {
		ip = net.IPv4zero
	}
	return &net.TCPAddr{IP: ip, Port: port}
}

func openHTTPStream(ctx context.Context, cfg agentConfig, n nodeConfig, address, token string) (*wsStream, error) {
	u, err := url.Parse(n.URL)
	if err != nil {
		return nil, fmt.Errorf("invalid EdgeOne node URL")
	}
	switch u.Scheme {
	case "wss":
		u.Scheme = "https"
	case "ws":
		u.Scheme = "http"
	default:
		return nil, fmt.Errorf("EdgeOne streaming node requires wss://")
	}
	var session [16]byte
	if _, err = rand.Read(session[:]); err != nil {
		return nil, err
	}
	sessionID := hex.EncodeToString(session[:])
	requestCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	body, _ := json.Marshal(map[string]string{"action": "open", "target": address})
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, u.String(), bytes.NewReader(body))
	if err != nil {
		cancel()
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Tunnel-Protocol", "5")
	req.Header.Set("X-Tunnel-Session", sessionID)
	req.Header.Set("Makers-Conversation-Id", sessionID)
	req.Header.Set("X-Tunnel-Token", token)
	if n.AccessCookie != "" {
		req.Header.Set("Cookie", n.AccessCookie)
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			switch cfg.NodeNetwork {
			case "ipv4":
				network = "tcp4"
			case "ipv6":
				network = "tcp6"
			}
			return (&net.Dialer{Timeout: 8 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, network, address)
		},
		ForceAttemptHTTP2:     false,
		DisableCompression:    true,
		DisableKeepAlives:     true,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 25 * time.Second,
	}
	response, err := (&http.Client{Transport: transport}).Do(req)
	if err != nil {
		cancel()
		return nil, err
	}
	ready := response.Header.Get("X-Tunnel-Ready")
	if response.StatusCode != http.StatusOK || ready != "true" && ready != "pending" {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		_ = response.Body.Close()
		cancel()
		if response.StatusCode == http.StatusBadGateway {
			return nil, &targetDialError{detail: strings.TrimSpace(string(body))}
		}
		return nil, fmt.Errorf("streaming tunnel rejected: %s", strings.TrimSpace(string(body)))
	}
	raw := &httpStream{ctx: requestCtx, cancel: cancel, response: response, events: bufio.NewReaderSize(response.Body, 128*1024), upload: &http.Client{Transport: transport.Clone()}, url: u.String(), token: token, cookie: n.AccessCookie, session: sessionID, remote: tcpStreamAddress(u), ready: make(chan struct{})}
	close(raw.ready)
	raw.confirmed.Store(ready == "true")
	if ready == "pending" {
		timer := time.AfterFunc(30*time.Second, cancel)
		defer timer.Stop()
		for {
			event, data, eventErr := raw.nextEvent()
			if eventErr != nil {
				_ = response.Body.Close()
				cancel()
				return nil, fmt.Errorf("EdgeOne stream was not ready: %w", eventErr)
			}
			if event == "ready" {
				raw.confirmed.Store(true)
				break
			}
			if event == "error" || event == "eof" {
				_ = response.Body.Close()
				cancel()
				return nil, &targetDialError{detail: "upstream could not establish the target connection"}
			}
			if len(data) > 0 {
				raw.pending = data
				raw.confirmed.Store(true)
				break
			}
		}
	}
	return newRawStream(raw), nil
}
