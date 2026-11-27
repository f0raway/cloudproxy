package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestDashboardSessionLifecycle(t *testing.T) {
	c, p := setupTest(t)
	h := dashboardHandler(c, p)
	request := func(method, path, form, origin string, cookie *http.Cookie) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "https://console.example"+path, strings.NewReader(form))
		if method == http.MethodPost {
			r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			r.Header.Set("Origin", origin)
		}
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if w := request("GET", "/", "", "", nil); w.Code != 303 || w.Header().Get("Location") != "/login" {
		t.Fatal("missing login redirect")
	}
	if w := request("GET", "/login", "", "", nil); w.Code != 200 || !strings.Contains(w.Body.String(), `autocomplete="current-password"`) {
		t.Fatal("missing login form")
	}
	if w := request("POST", "/login", "password=wrong", "https://console.example", nil); w.Code != 401 || len(w.Result().Cookies()) != 0 {
		t.Fatal("invalid credentials accepted")
	}
	form := url.Values{"username": {c.User}, "password": {c.Password}}.Encode()
	if w := request("POST", "/login", form, "https://other.example", nil); w.Code != 403 {
		t.Fatal("cross-site login accepted")
	}
	w := request("POST", "/login", form, "https://console.example", nil)
	cookies := w.Result().Cookies()
	if w.Code != 303 || len(cookies) != 1 || !cookies[0].HttpOnly || !cookies[0].Secure || cookies[0].SameSite != http.SameSiteStrictMode || strings.Contains(cookies[0].Value, c.Password) {
		t.Fatal("missing safe session cookie")
	}
	cookie := cookies[0]
	for _, path := range []string{"/", "/api/stats", "/api/settings", "/dashboard.js"} {
		if w := request("GET", path, "", "", cookie); w.Code != 200 {
			t.Fatalf("session could not open %s: %d", path, w.Code)
		}
	}
	if w := request("POST", "/logout", "", "https://other.example", cookie); w.Code != 403 {
		t.Fatal("cross-site logout accepted")
	}
	if w := request("POST", "/logout", "", "https://console.example", cookie); w.Code != 303 || w.Result().Cookies()[0].MaxAge != -1 {
		t.Fatal("session cookie not cleared")
	}
	if w := request("GET", "/api/stats", "", "", cookie); w.Code != 401 {
		t.Fatal("logged-out session could still access API")
	}
	cookie = request("POST", "/login", form, "https://console.example", nil).Result().Cookies()[0]
	s := editableSettings(p)
	s.Password = "replacement-password"
	if err := p.saveSettings(s); err != nil {
		t.Fatal(err)
	}
	if w := request("GET", "/api/stats", "", "", cookie); w.Code != 401 {
		t.Fatal("old session remained valid after credential change")
	}
}
