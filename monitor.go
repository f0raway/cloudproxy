package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptrace"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/armon/go-socks5"
)

const historyLimit = 1000

type connectionEvent struct {
	ErrorCategory string              `json:"error_category,omitempty"`
	Diagnosis     string              `json:"diagnosis,omitempty"`
	ID            uint64              `json:"id"`
	Source        string              `json:"source"`
	Target        string              `json:"target"`
	Protocol      string              `json:"protocol"`
	State         string              `json:"state"`
	Region        string              `json:"region"`
	Started       time.Time           `json:"started"`
	Connected     *time.Time          `json:"connected,omitempty"`
	Ended         *time.Time          `json:"ended,omitempty"`
	Uploaded      int64               `json:"uploaded"`
	Downloaded    int64               `json:"downloaded"`
	Error         string              `json:"error,omitempty"`
	HTTPStatus    int                 `json:"http_status,omitempty"`
	Attempts      []connectionAttempt `json:"attempts"`
}
type connectionAttempt struct {
	Region  string    `json:"region"`
	Started time.Time `json:"started"`
	Error   string    `json:"error,omitempty"`
}
type connectionLog struct {
	sink      *eventSink
	secretsMu sync.RWMutex
	mu        sync.Mutex
	next      uint64
	active    map[uint64]*connectionEvent
	recent    []connectionEvent
	secrets   []string
	omitted   uint64
}
type connectionRecord struct {
	log   *connectionLog
	event *connectionEvent
}
type connectionContextKey struct{}

func newConnectionLog(c agentConfig) *connectionLog {
	secrets := []string{c.Password, c.Token}
	for _, n := range c.Nodes {
		secrets = append(secrets, n.URL, n.Token)
	}
	return &connectionLog{active: make(map[uint64]*connectionEvent), secrets: secrets}
}
func (l *connectionLog) redact(s string) string {
	l.secretsMu.RLock()
	defer l.secretsMu.RUnlock()
	for _, secret := range l.secrets {
		if secret != "" {
			s = strings.ReplaceAll(s, secret, "[redacted]")
		}
	}
	return s
}
func (l *connectionLog) clean(s string) string {
	s = l.redact(s)
	if len(s) > 1024 {
		s = s[:1024] + "…"
	}
	return strings.Map(func(r rune) rune {
		if r < 32 && r != '\t' {
			return ' '
		}
		return r
	}, s)
}
func (l *connectionLog) begin(source, protocol string) *connectionRecord {
	l.mu.Lock()
	defer l.mu.Unlock()
	// Handshakes are also bounded so an unauthenticated peer cannot exhaust memory.
	if len(l.active) >= 256 {
		l.omitted++
		return nil
	}
	l.next++
	e := &connectionEvent{ID: l.next, Source: l.clean(source), Protocol: protocol, State: "negotiating", Started: time.Now(), Attempts: []connectionAttempt{}}
	l.active[e.ID] = e
	return &connectionRecord{l, e}
}
func (r *connectionRecord) update(fn func(*connectionEvent)) {
	if r == nil {
		return
	}
	r.log.mu.Lock()
	defer r.log.mu.Unlock()
	if r.event.Ended == nil {
		fn(r.event)
	}
}
func (r *connectionRecord) target(target, state string) {
	r.update(func(e *connectionEvent) { e.Target = r.log.clean(target); e.State = state })
}
func (r *connectionRecord) attempt(region string) {
	r.update(func(e *connectionEvent) {
		e.Region = r.log.clean(region)
		e.State = "connecting"
		e.Attempts = append(e.Attempts, connectionAttempt{Region: e.Region, Started: time.Now()})
	})
}
func (r *connectionRecord) attemptError(err error) {
	if err != nil {
		r.update(func(e *connectionEvent) {
			if len(e.Attempts) > 0 {
				e.Attempts[len(e.Attempts)-1].Error = r.log.clean(err.Error())
			}
		})
	}
}
func (r *connectionRecord) connected(region string) {
	r.update(func(e *connectionEvent) {
		t := time.Now()
		already := e.Connected != nil
		e.Connected = &t
		e.Region = r.log.clean(region)
		e.State = "connected"
		if !already {
			r.log.sink.record("connection.connected", *e)
		}
	})
}
func (r *connectionRecord) traffic(up, down int) {
	r.update(func(e *connectionEvent) { e.Uploaded += int64(up); e.Downloaded += int64(down) })
}
func (r *connectionRecord) finish(err error) {
	if r == nil {
		return
	}
	l := r.log
	l.mu.Lock()
	defer l.mu.Unlock()
	e := r.event
	if e.Ended != nil {
		return
	}
	now := time.Now()
	e.Ended = &now
	e.State = "closed"
	if e.Error != "" {
		e.State = "failed"
	} else if err != nil {
		e.State = "failed"
		e.Error = l.clean(err.Error())
	}
	classifyConnection(e)
	l.sink.record("connection.end", *e)
	delete(l.active, e.ID)
	if len(l.recent) == historyLimit {
		copy(l.recent, l.recent[1:])
		l.recent = l.recent[:historyLimit-1]
	}
	l.recent = append(l.recent, *e)
}
func (l *connectionLog) snapshot() map[string]any {
	l.mu.Lock()
	defer l.mu.Unlock()
	rows := make([]connectionEvent, 0, len(l.active)+len(l.recent))
	copyEvent := func(e connectionEvent) connectionEvent {
		e.Attempts = append([]connectionAttempt{}, e.Attempts...)
		return e
	}
	for _, e := range l.active {
		rows = append(rows, copyEvent(*e))
	}
	for _, e := range l.recent {
		rows = append(rows, copyEvent(e))
	}
	sort.Slice(rows, func(i, j int) bool {
		if (rows[i].Ended == nil) != (rows[j].Ended == nil) {
			return rows[i].Ended == nil
		}
		return rows[i].ID > rows[j].ID
	})
	return map[string]any{"connections": rows, "active": len(l.active), "history_limit": historyLimit, "omitted": l.omitted, "server_time": time.Now()}
}
func recordFrom(ctx context.Context) *connectionRecord {
	r, _ := ctx.Value(connectionContextKey{}).(*connectionRecord)
	return r
}

// Each accepted socket owns its record, including failed authentication/handshakes.
type observedRules struct {
	r    *connectionRecord
	conn net.Conn
}

func (o observedRules) Allow(ctx context.Context, req *socks5.Request) (context.Context, bool) {
	o.conn.SetDeadline(time.Time{})
	o.r.target(req.DestAddr.Address(), "queued")
	ctx = context.WithValue(ctx, connectionContextKey{}, o.r)
	if req.Command != socks5.ConnectCommand {
		o.r.finish(fmt.Errorf("SOCKS command unsupported: only TCP CONNECT is available"))
		return ctx, false
	}
	return ctx, true
}
func serveObservedSOCKS(listener net.Listener, c agentConfig, p *provider) error {
	logger := log.New(&limitedSOCKSLog{}, "SOCKS5 ", log.LstdFlags)
	for {
		conn, err := listener.Accept()
		if err != nil {
			return err
		}
		go func() {
			c := p.config()
			r := p.connections.begin(conn.RemoteAddr().String(), "SOCKS5")
			if r == nil {
				conn.Close()
				return
			}
			conn.SetDeadline(time.Now().Add(15 * time.Second))
			server, err := socks5.New(&socks5.Config{Resolver: remoteResolver{}, Credentials: socks5.StaticCredentials{c.User: c.Password}, Rules: observedRules{r, conn}, Dial: p.dial, Logger: logger})
			if err == nil {
				err = server.ServeConn(conn)
			} else {
				conn.Close()
			}
			if err == io.EOF {
				err = nil
			}
			r.finish(err)
		}()
	}
}

//go:embed dashboard.html
var dashboardHTML string

//go:embed dashboard.js
var dashboardJS string

//go:embed dashboard.css
var dashboardCSS string

//go:embed settings.js
var settingsJS string

func dashboardHandler(c agentConfig, p *provider) http.Handler {
	sessions := dashboardSessions{items: make(map[string]dashboardSession)}
	origin := http.NewCrossOriginProtection()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/settings", p.settingsHandler)
	mux.HandleFunc("/dashboard.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		io.WriteString(w, dashboardJS)
	})
	mux.HandleFunc("/dashboard.css", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
		io.WriteString(w, dashboardCSS)
	})
	mux.HandleFunc("/settings.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		io.WriteString(w, settingsJS)
	})
	mux.HandleFunc("/api/stats", func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(p.stats()) })
	mux.HandleFunc("/api/connections", func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(p.connections.snapshot()) })
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, dashboardHTML)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		w.Header().Set("Referrer-Policy", "no-referrer")
		c := p.config()
		switch r.URL.Path {
		case "/login", "/logout":
			if err := origin.Check(r); err != nil {
				http.Error(w, "跨站请求已拒绝", http.StatusForbidden)
				return
			}
			if r.URL.Path == "/login" {
				sessions.login(w, r, c)
				return
			}
			if r.Method != http.MethodPost {
				w.Header().Set("Allow", "POST")
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				return
			}
			sessions.remove(r)
			setDashboardCookie(w, r, "", -1)
			http.Redirect(w, r, "/login", http.StatusSeeOther)
			return
		}
		hasSession := sessions.valid(r, c)
		if r.URL.Path == "/" && !hasSession && r.Method == http.MethodGet {
			http.Redirect(w, r, "/login", http.StatusSeeOther)
			return
		}
		user, pass, ok := r.BasicAuth()
		if !hasSession && !(ok && validCredentials(c, user, pass)) {
			// Explicit Basic credentials remain supported for local health and API clients.
			// Only challenge a client which already opted in to Basic authentication.
			if ok {
				w.Header().Set("WWW-Authenticate", `Basic realm="CloudProxy", charset="UTF-8"`)
			}
			http.Error(w, "Authentication required", 401)
			return
		}
		if r.Method != "GET" && !(r.URL.Path == "/api/settings" && r.Method == "POST") {
			w.Header().Set("Allow", "GET")
			http.Error(w, "Method not allowed", 405)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		mux.ServeHTTP(w, r)
	})
}

// HTTP requests have separate records even when Transport reuses a TCP tunnel.
func observedHTTPContext(ctx context.Context, r *connectionRecord) context.Context {
	ctx = context.WithValue(ctx, connectionContextKey{}, r)
	return httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{GotConn: func(info httptrace.GotConnInfo) {
		if s, ok := info.Conn.(*wsStream); ok {
			r.connected(s.region)
		}
	}})
}

type observedBody struct {
	io.ReadCloser
	r *connectionRecord
}

func (b observedBody) Read(p []byte) (int, error) {
	n, e := b.ReadCloser.Read(p)
	b.r.traffic(n, 0)
	return n, e
}

type observedWriter struct {
	io.Writer
	r *connectionRecord
}

func (w observedWriter) Write(p []byte) (int, error) {
	n, e := w.Writer.Write(p)
	w.r.traffic(0, n)
	return n, e
}

func (l *connectionLog) addSecrets(c agentConfig) {
	l.secretsMu.Lock()
	defer l.secretsMu.Unlock()
	values := []string{c.Password, c.Token}
	for _, n := range c.Nodes {
		values = append(values, n.URL, n.Token)
	}
	for _, v := range values {
		if v == "" {
			continue
		}
		found := false
		for _, old := range l.secrets {
			if old == v {
				found = true
				break
			}
		}
		if !found {
			l.secrets = append(l.secrets, v)
		}
	}
}
