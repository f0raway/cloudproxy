package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	_ "embed"
	"encoding/hex"
	"html/template"
	"net/http"
	"sync"
	"time"
)

//go:embed login.html
var loginHTML string

var loginPage = template.Must(template.New("login").Parse(loginHTML))

const sessionCookie = "cloudproxy_session"
const sessionTTL = 12 * time.Hour
const maxDashboardSessions = 128

type dashboardSession struct {
	credentials [32]byte
	expires     time.Time
}

type dashboardSessions struct {
	mu    sync.Mutex
	items map[string]dashboardSession
}

func credentialsHash(user, password string) [32]byte {
	return sha256.Sum256([]byte(user + ":" + password))
}

func validCredentials(c agentConfig, user, pass string) bool {
	expected, actual := credentialsHash(c.User, c.Password), credentialsHash(user, pass)
	return c.User != "" && c.Password != "" && subtle.ConstantTimeCompare(expected[:], actual[:]) == 1
}

func (s *dashboardSessions) valid(r *http.Request, c agentConfig) bool {
	cookie, err := r.Cookie(sessionCookie)
	if err != nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.items[cookie.Value]
	if !ok {
		return false
	}
	if !time.Now().Before(item.expires) || item.credentials != credentialsHash(c.User, c.Password) {
		delete(s.items, cookie.Value)
		return false
	}
	return true
}

func setDashboardCookie(w http.ResponseWriter, r *http.Request, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: value, Path: "/", MaxAge: maxAge, HttpOnly: true, Secure: r.TLS != nil, SameSite: http.SameSiteStrictMode})
}

func (s *dashboardSessions) remove(r *http.Request) {
	if cookie, err := r.Cookie(sessionCookie); err == nil {
		s.mu.Lock()
		delete(s.items, cookie.Value)
		s.mu.Unlock()
	}
}

func (s *dashboardSessions) login(w http.ResponseWriter, r *http.Request, c agentConfig) {
	failed := false
	switch r.Method {
	case http.MethodPost:
		r.Body = http.MaxBytesReader(w, r.Body, 8192)
		if err := r.ParseForm(); err == nil && validCredentials(c, r.PostForm.Get("username"), r.PostForm.Get("password")) {
			var token [32]byte
			_, _ = rand.Read(token[:])
			key := hex.EncodeToString(token[:])
			now := time.Now()
			s.remove(r)
			s.mu.Lock()
			oldest := ""
			for id, item := range s.items {
				if !now.Before(item.expires) || item.credentials != credentialsHash(c.User, c.Password) {
					delete(s.items, id)
				} else if oldest == "" || item.expires.Before(s.items[oldest].expires) {
					oldest = id
				}
			}
			if len(s.items) >= maxDashboardSessions {
				delete(s.items, oldest)
			}
			s.items[key] = dashboardSession{credentialsHash(c.User, c.Password), now.Add(sessionTTL)}
			s.mu.Unlock()
			setDashboardCookie(w, r, key, int(sessionTTL.Seconds()))
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		failed = true
	case http.MethodGet:
		if s.valid(r, c) {
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
	default:
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if failed {
		w.WriteHeader(http.StatusUnauthorized)
	}
	_ = loginPage.Execute(w, failed)
}
