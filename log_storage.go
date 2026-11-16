package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type logConfig struct {
	Enabled bool `json:"enabled"`
	MaxMB   int  `json:"max_file_mb"`
	Backups int  `json:"backups"`
}

func (c agentConfig) logOptions() logConfig {
	if c.Logging == nil {
		return logConfig{Enabled: true, MaxMB: 5, Backups: 2}
	}
	return *c.Logging
}
func validLogConfig(c logConfig) bool {
	return c.MaxMB >= 1 && c.MaxMB <= 100 && c.Backups >= 0 && c.Backups <= 5
}

type rotatingFile struct {
	mu       sync.Mutex
	path     string
	maxBytes int64
	backups  int
	file     *os.File
	size     int64
	errors   atomic.Uint64
}

func openRotatingFile(path string, maxBytes int64, backups int) (*rotatingFile, error) {
	r := &rotatingFile{path: path, maxBytes: maxBytes, backups: backups}
	if e := r.prepare(); e != nil {
		return nil, e
	}
	return r, nil
}
func trimLogTail(path string, max int64) error {
	info, e := os.Lstat(path)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("log must be a regular file")
	}
	if info.Size() <= max {
		return nil
	}
	source, e := os.Open(path)
	if e != nil {
		return e
	}
	defer source.Close()
	if _, e = source.Seek(info.Size()-max, io.SeekStart); e != nil {
		return e
	}
	reader := bufio.NewReader(source)
	if _, e = reader.ReadString('\n'); e != nil && e != io.EOF {
		return e
	}
	target, e := os.CreateTemp(filepath.Dir(path), ".log-tail-")
	if e != nil {
		return e
	}
	name := target.Name()
	defer os.Remove(name)
	_, e = io.Copy(target, io.LimitReader(reader, max))
	ce := target.Close()
	if e != nil {
		return e
	}
	if ce != nil {
		return ce
	}
	return os.Rename(name, path)
}
func (r *rotatingFile) prepare() error {
	for i := r.backups + 1; i <= 5; i++ {
		if e := os.Remove(fmt.Sprintf("%s.%d", r.path, i)); e != nil && !os.IsNotExist(e) {
			return e
		}
	}
	for i := r.backups; i >= 0; i-- {
		path := r.path
		if i > 0 {
			path = fmt.Sprintf("%s.%d", path, i)
		}
		if e := trimLogTail(path, r.maxBytes); e != nil {
			return e
		}
		if e := os.Chmod(path, 0600); e != nil && !os.IsNotExist(e) {
			return e
		}
	}
	f, e := os.OpenFile(r.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	if e = f.Chmod(0600); e != nil {
		f.Close()
		return e
	}
	info, e := f.Stat()
	if e != nil {
		f.Close()
		return e
	}
	r.file = f
	r.size = info.Size()
	return nil
}
func (r *rotatingFile) rotate() error {
	if r.file != nil {
		if e := r.file.Close(); e != nil {
			return e
		}
		r.file = nil
	}
	if r.backups == 0 {
		if e := os.Remove(r.path); e != nil && !os.IsNotExist(e) {
			return e
		}
	} else {
		if e := os.Remove(fmt.Sprintf("%s.%d", r.path, r.backups)); e != nil && !os.IsNotExist(e) {
			return e
		}
		for i := r.backups - 1; i >= 1; i-- {
			e := os.Rename(fmt.Sprintf("%s.%d", r.path, i), fmt.Sprintf("%s.%d", r.path, i+1))
			if e != nil && !os.IsNotExist(e) {
				return e
			}
		}
		if e := os.Rename(r.path, r.path+".1"); e != nil && !os.IsNotExist(e) {
			return e
		}
	}
	return r.prepare()
}
func (r *rotatingFile) Write(data []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	fail := func(e error) (int, error) { r.errors.Add(1); return 0, e }
	if int64(len(data)) > r.maxBytes {
		return fail(fmt.Errorf("single log entry exceeds size limit"))
	}
	if r.file == nil {
		return fail(os.ErrClosed)
	}
	if r.size+int64(len(data)) > r.maxBytes {
		if e := r.rotate(); e != nil {
			return fail(e)
		}
	}
	n, e := r.file.Write(data)
	r.size += int64(n)
	if e == nil && n != len(data) {
		e = io.ErrShortWrite
	}
	if e != nil {
		r.errors.Add(1)
	}
	return n, e
}
func (r *rotatingFile) setLimits(maxBytes int64, backups int) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.maxBytes == maxBytes && r.backups == backups {
		return nil
	}
	if r.file != nil {
		r.file.Close()
		r.file = nil
	}
	r.maxBytes = maxBytes
	r.backups = backups
	return r.prepare()
}
func (r *rotatingFile) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.file == nil {
		return nil
	}
	e := r.file.Close()
	r.file = nil
	return e
}
func (r *rotatingFile) files() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []string{}
	for i := r.backups; i >= 0; i-- {
		p := r.path
		if i > 0 {
			p = fmt.Sprintf("%s.%d", p, i)
		}
		out = append(out, p)
	}
	return out
}

type connectionLogEvent struct {
	Event      string          `json:"event"`
	Session    string          `json:"session"`
	Recorded   time.Time       `json:"recorded_at"`
	Connection connectionEvent `json:"connection"`
}
type eventSink struct {
	mu          sync.Mutex
	queue       chan connectionLogEvent
	done        chan struct{}
	closing     bool
	enabled     atomic.Bool
	dropped     atomic.Uint64
	written     atomic.Uint64
	writeErrors atomic.Uint64
	file        *rotatingFile
	session     string
}

func newEventSink(file *rotatingFile, enabled bool) *eventSink {
	s := &eventSink{file: file, queue: make(chan connectionLogEvent, 512), done: make(chan struct{}), session: fmt.Sprintf("%d", time.Now().UnixNano())}
	s.enabled.Store(enabled)
	go func() {
		defer close(s.done)
		for event := range s.queue {
			if !s.enabled.Load() {
				continue
			}
			raw, e := json.Marshal(event)
			if e == nil {
				_, e = s.file.Write(append(raw, '\n'))
			}
			if e != nil {
				s.writeErrors.Add(1)
			} else {
				s.written.Add(1)
			}
		}
	}()
	return s
}
func (s *eventSink) record(kind string, e connectionEvent) {
	if s == nil || !s.enabled.Load() {
		return
	}
	e.Attempts = append([]connectionAttempt{}, e.Attempts...)
	event := connectionLogEvent{Event: kind, Session: s.session, Recorded: time.Now(), Connection: e}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return
	}
	select {
	case s.queue <- event:
	default:
		s.dropped.Add(1)
	}
}
func (s *eventSink) Close() {
	if s == nil {
		return
	}
	s.mu.Lock()
	if !s.closing {
		s.closing = true
		close(s.queue)
	}
	s.mu.Unlock()
	<-s.done
	s.file.Close()
}

type redactingLogWriter struct {
	output  io.Writer
	records *connectionLog
}

func (w redactingLogWriter) Write(p []byte) (int, error) {
	_, e := w.output.Write([]byte(w.records.redact(string(p))))
	if e != nil {
		return 0, e
	}
	return len(p), nil
}

type runtimeLogs struct {
	operations *rotatingFile
	events     *eventSink
	previous   io.Writer
}

func startRuntimeLogs(c agentConfig, p *provider) (*runtimeLogs, error) {
	options := c.logOptions()
	if !validLogConfig(options) {
		return nil, fmt.Errorf("invalid log retention")
	}
	dir := filepath.Dir(c.Ledger)
	max := int64(options.MaxMB) * 1024 * 1024
	operations, e := openRotatingFile(filepath.Join(dir, "service.log"), max, options.Backups)
	if e != nil {
		return nil, e
	}
	events, e := openRotatingFile(filepath.Join(dir, "connections.jsonl"), max, options.Backups)
	if e != nil {
		operations.Close()
		return nil, e
	}
	p.connections.restore(events.files())
	sink := newEventSink(events, options.Enabled)
	p.connections.mu.Lock()
	p.connections.sink = sink
	p.connections.mu.Unlock()
	logs := &runtimeLogs{operations: operations, events: sink, previous: log.Writer()}
	p.logs = logs
	log.SetOutput(redactingLogWriter{operations, p.connections})
	return logs, nil
}
func (l *runtimeLogs) Close() {
	if l == nil {
		return
	}
	l.events.Close()
	log.SetOutput(l.previous)
	l.operations.Close()
}
func (l *runtimeLogs) configure(c logConfig) error {
	max := int64(c.MaxMB) * 1024 * 1024
	if e := l.operations.setLimits(max, c.Backups); e != nil {
		return e
	}
	if e := l.events.file.setLimits(max, c.Backups); e != nil {
		return e
	}
	l.events.enabled.Store(c.Enabled)
	return nil
}
func (p *provider) loggingStatus() map[string]any {
	options := p.config().logOptions()
	out := map[string]any{"enabled": options.Enabled, "max_file_mb": options.MaxMB, "backups": options.Backups, "memory_history_limit": historyLimit, "ready": p.logs != nil}
	if p.logs != nil {
		out["events_written"] = p.logs.events.written.Load()
		out["events_dropped"] = p.logs.events.dropped.Load()
		out["event_write_errors"] = p.logs.events.writeErrors.Load()
		out["operation_write_errors"] = p.logs.operations.errors.Load()
		out["queue_capacity"] = cap(p.logs.events.queue)
	}
	return out
}
func (l *connectionLog) restore(paths []string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	latest := make(map[uint64]connectionEvent)
	for _, path := range paths {
		f, e := os.Open(path)
		if e != nil {
			continue
		}
		scanner := bufio.NewScanner(f)
		scanner.Buffer(make([]byte, 4096), 32768)
		for scanner.Scan() {
			var row connectionLogEvent
			if json.Unmarshal(scanner.Bytes(), &row) != nil || row.Event != "connection.end" || row.Connection.Ended == nil {
				continue
			}
			event := row.Connection
			event.Source = l.clean(event.Source)
			event.Target = l.clean(event.Target)
			event.Region = l.clean(event.Region)
			event.Error = l.clean(event.Error)
			for i := range event.Attempts {
				event.Attempts[i].Error = l.clean(event.Attempts[i].Error)
				event.Attempts[i].Region = l.clean(event.Attempts[i].Region)
			}
			classifyConnection(&event)
			latest[event.ID] = event
			if event.ID > l.next {
				l.next = event.ID
			}
			if len(latest) > historyLimit {
				var oldest uint64 = ^uint64(0)
				for id := range latest {
					if id < oldest {
						oldest = id
					}
				}
				delete(latest, oldest)
			}
		}
		f.Close()
	}
	l.recent = l.recent[:0]
	for _, e := range latest {
		l.recent = append(l.recent, e)
	}
	sortConnectionEvents(l.recent)
}
func (l *connectionLog) finishActive(err error) {
	l.mu.Lock()
	records := make([]*connectionRecord, 0, len(l.active))
	for _, e := range l.active {
		records = append(records, &connectionRecord{log: l, event: e})
	}
	l.mu.Unlock()
	for _, r := range records {
		r.finish(err)
	}
}

// Keep dependency error text intact while separating failures from local policy
// and ordinary client cancellations in the diagnostic view.
func classifyConnection(e *connectionEvent) {
	if e.Error == "" {
		e.ErrorCategory = ""
		e.Diagnosis = ""
		return
	}
	s := e.Error
	switch {
	case containsAny(s, "private/local", "reserved target", "scoped/local IPv6"):
		e.ErrorCategory = "local_policy"
		e.Diagnosis = "非公网目标已在本地拒绝；198.18.x.x 通常为客户端 Fake-IP，需提交原始域名"
	case containsAny(s, "configured allow/deny", "invalid target", "requires host:port", "invalid proxy request", "SOCKS command unsupported"):
		e.ErrorCategory = "local_policy"
		e.Diagnosis = "目标范围、端口或请求格式被本地规则拒绝"
	case e.Target == "" && e.Connected == nil && len(e.Attempts) == 0 && (s == "EOF" || strings.HasSuffix(s, ": EOF") || strings.HasSuffix(s, ": unexpected EOF")):
		e.ErrorCategory = "client_disconnect"
		e.Diagnosis = "客户端在提交目标地址前结束握手；未调用云节点"
	case containsAny(s, "connection reset by peer", "broken pipe", "context canceled") && ((e.Connected == nil && len(e.Attempts) == 0) || strings.Contains(s, "->"+e.Source)):
		e.ErrorCategory = "client_disconnect"
		e.Diagnosis = "客户端在目标建连前断开"
		if e.Connected != nil {
			e.Diagnosis = "客户端在连接建立后断开"
		}
	case containsAny(s, "authentication failed", "Failed to authenticate", "no supported authentication"):
		e.ErrorCategory = "authentication"
		e.Diagnosis = "认证失败或认证握手未完成，请检查客户端设置"
	case containsAny(s, "本月", "budget", "额度"):
		e.ErrorCategory = "budget"
		e.Diagnosis = "本地费用保护拒绝或停止转发"
	case containsAny(s, "recently failed", "probe in progress", "maximum active", "daily request limit", "no eligible", "capacity reached"):
		e.ErrorCategory = "local_limit"
		e.Diagnosis = "本地退避、排队、额度或节点策略限制，并非新的云端连接失败"
	case containsAny(s, "provider cannot reach target"):
		e.ErrorCategory = "provider_target"
		e.Diagnosis = "当前平台无法连接该目标；可能为平台限制或该路径不可达，请查看节点尝试，不能据此判断节点整体故障"
	case strings.HasPrefix(e.Target, "[") && strings.Contains(s, "network is unreachable") && strings.Contains(s, "target connection failed"):
		e.ErrorCategory = "target_network"
		e.Diagnosis = "云节点到此 IPv6 目标没有可用路由；入口节点网络设为 IPv4 不会将目标 IPv6 转成 IPv4"
	case containsAny(s, "target connection failed"):
		e.ErrorCategory = "target_connect"
		e.Diagnosis = "目标 DNS/TCP 建连失败；请核对目标服务与端口"
	case containsAny(s, "idle timeout", "lifetime", "traffic limit"):
		e.ErrorCategory = "connection_limit"
		e.Diagnosis = "连接达到空闲、时长或流量保护限制"
	case containsAny(s, "proxy shutting down", "proxy is stopping"):
		e.ErrorCategory = "shutdown"
		e.Diagnosis = "入口服务正在停止或更新"
	default:
		e.ErrorCategory = "upstream"
		e.Diagnosis = "节点建连或传输异常，需结合区域尝试详情判断"
	}
}

func containsAny(value string, needles ...string) bool {
	for _, needle := range needles {
		if strings.Contains(value, needle) {
			return true
		}
	}
	return false
}
func sortConnectionEvents(rows []connectionEvent) {
	sort.Slice(rows, func(i, j int) bool { return rows[i].ID < rows[j].ID })
}
