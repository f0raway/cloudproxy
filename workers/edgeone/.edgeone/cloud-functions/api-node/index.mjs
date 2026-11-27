
import { createRequire as __createRequire } from 'module';
import { fileURLToPath as __fileURLToPath } from 'url';
import { dirname as __pathDirname } from 'path';

// Global variables
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __pathDirname(__filename);
const require = __createRequire(import.meta.url);

// Global require function
globalThis.require = require;
globalThis.__filename = __filename;
globalThis.__dirname = __dirname;

// Dynamic require handler
globalThis.__dynamicRequire = function(id) {
  try {
    return require(id);
  } catch (err) {
    if (err.code === 'ERR_REQUIRE_ESM') {
      // If the module is ESM, try using import()
      return import(id);
    }
    throw err;
  }
};

// Fix Buffer
if (typeof Buffer === 'undefined') {
  globalThis.Buffer = require('buffer').Buffer;
}

// Fix process
if (typeof process === 'undefined') {
  globalThis.process = require('process');
}

// Fix util.promisify
if (!Symbol.for('nodejs.util.promisify.custom')) {
  Symbol.for('nodejs.util.promisify.custom');
}



// ===== Outbound Net Hook (Production Mode Only) =====
// Injected by EdgeOne CLI. Do NOT modify.
(function() {
  if (globalThis.__edgeoneNetHooked) return;
  globalThis.__edgeoneNetHooked = true;

  // 灰度总开关：整个 hook 都不安装
  if (process.env.EDGEONE_OUTBOUND_HOOK_DISABLED === '1' ||
      process.env.EDGEONE_OUTBOUND_HOOK_DISABLED === 'true') {
    return;
  }

  const __hookMode = (process.env.EDGEONE_OUTBOUND_HOOK_MODE || 'enforce').toLowerCase();
  // observe 模式：只打日志不拦，用于灰度阶段观察误伤
  const __observeOnly = __hookMode === 'observe';

  const __async_hooks = require('async_hooks');
  const __net = require('net');
  const __tls = require('tls');

  // AsyncLocalStorage 单例：runtime 入口 als.run(store, () => handler(...))
  const __als = new __async_hooks.AsyncLocalStorage();
  globalThis.__edgeoneRestrictedALS = __als;

  // ---------- 白名单构建 ----------
  const __staticSuffixes = [
    '.edgeone.site',
    '.tencentyun.com', // OTLP / 观测 collector 常用域名后缀
  ];
  const __staticHosts = new Set([
    'localhost',
    'ip6-localhost',
    'ip6-loopback',
  ]);

  // 动态白名单：从环境变量读取（OTLP endpoint / 用户显式 bypass）
  function __hostFromEndpoint(v) {
    if (!v) return '';
    try {
      // 兼容 "host:port" 与 "http(s)://host[:port]/path" 两种形式
      const s = String(v).trim();
      if (!s) return '';
      if (s.includes('://')) return new URL(s).hostname;
      return s.split('/')[0].split(':')[0];
    } catch (_) {
      return '';
    }
  }

  const __dynamicHosts = new Set();
  const __otlpHost = __hostFromEndpoint(process.env.EDGEONE_OTLP_ENDPOINT);
  if (__otlpHost) __dynamicHosts.add(__otlpHost);

  const __bypassRaw = process.env.EDGEONE_OUTBOUND_BYPASS_HOSTS || '';
  if (__bypassRaw) {
    for (const item of __bypassRaw.split(',')) {
      const h = item.trim();
      if (h) __dynamicHosts.add(h);
    }
  }

  // IPv4 私网 / 回环判定（127.0.0.0/8, ::1）
  function __isLoopbackOrPrivate(host) {
    if (!host || typeof host !== 'string') return false;
    // IPv6 loopback
    if (host === '::1' || host === '[::1]') return true;
    // IPv4 loopback 127.x.x.x
    if (/^127\./.test(host)) return true;
    // 明确不拦 Unix socket path（host 为空、路径含斜杠场景由调用方保证）
    return false;
  }

  function __isWhitelisted(host) {
    if (!host) return true; // Unix socket / undefined host：放行，交给上层
    const h = String(host).toLowerCase();
    if (__staticHosts.has(h)) return true;
    if (__dynamicHosts.has(h)) return true;
    for (const suffix of __staticSuffixes) {
      if (h.endsWith(suffix)) return true;
    }
    if (__isLoopbackOrPrivate(h)) return true;
    return false;
  }

  function __currentRequestId() {
    try {
      const store = __als.getStore();
      return (store && store.requestId) || '';
    } catch (_) { return ''; }
  }

  function __isRestricted() {
    try {
      const store = __als.getStore();
      return !!(store && store.restricted === true);
    } catch (_) { return false; }
  }

  function __buildError(host, port) {
    const rid = __currentRequestId();
    const err = new Error('PagesLimit: egress quota may have been exceeded');
    err.code = 'OUTBOUND_RESTRICTED';
    err.host = host;
    err.port = port;
    return err;
  }

  // observe 模式下发一行结构化 stderr 日志
  function __logObserve(kind, host, port) {
    try {
      const rid = __currentRequestId();
      process.stderr.write(
        JSON.stringify({
          type: 'outbound_restricted_observe',
          kind: kind,
          host: host,
          port: port,
          requestId: rid,
          ts: Date.now(),
        }) + '\n'
      );
    } catch (_) {}
  }

  // ---------- 提取 host/port 的兼容逻辑 ----------
  // net.createConnection / net.connect 签名有多态：
  //   (options[, cb])
  //   (port[, host][, cb])
  //   (path[, cb])  // Unix socket
  function __extractHostPort(args) {
    if (args.length === 0) return { host: '', port: 0, isSocket: false };
    const a0 = args[0];
    if (typeof a0 === 'object' && a0 !== null) {
      if (a0.path) return { host: '', port: 0, isSocket: true };
      return {
        host: a0.host || a0.hostname || '',
        port: Number(a0.port) || 0,
        isSocket: false,
      };
    }
    if (typeof a0 === 'string' && !/^\d+$/.test(a0)) {
      // 视为 Unix socket path
      return { host: '', port: 0, isSocket: true };
    }
    // (port[, host][, cb])
    const port = Number(a0) || 0;
    let host = '';
    if (typeof args[1] === 'string') host = args[1];
    return { host: host, port: port, isSocket: false };
  }

  function __checkAndMaybeBlock(kind, host, port, isSocket) {
    if (isSocket) return null;               // Unix socket 一律放行
    if (!__isRestricted()) return null;      // 本请求未标 restricted
    if (__isWhitelisted(host)) return null;  // 命中白名单

    if (__observeOnly) {
      __logObserve(kind, host, port);
      return null;
    }
    return __buildError(host, port);
  }

  // ---------- Hook net.createConnection / net.connect ----------
  const __origCreateConnection = __net.createConnection;
  const __origConnect = __net.connect;

  function __wrappedCreateConnection() {
    const args = Array.from(arguments);
    const { host, port, isSocket } = __extractHostPort(args);
    const err = __checkAndMaybeBlock('net', host, port, isSocket);
    if (err) {
      // 返回一个立即 emit('error') 的 socket，行为对齐 net 原生的异步错误
      const s = new __net.Socket();
      // 找 callback 参数（最后一个是 function 的）以便同步告知
      const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      process.nextTick(() => {
        s.emit('error', err);
        if (cb) { try { cb(err); } catch (_) {} }
        try { s.destroy(err); } catch (_) {}
      });
      return s;
    }
    return __origCreateConnection.apply(__net, args);
  }

  __net.createConnection = __wrappedCreateConnection;
  __net.connect = __wrappedCreateConnection;

  // ---------- Hook tls.connect ----------
  // TLS 建连时 tls.connect 内部会走一次 socket 建连（可能通过 net.createConnection，
  // 也可能自行创建），这里补一层同层拦截，避免依赖内部实现细节。
  const __origTlsConnect = __tls.connect;
  __tls.connect = function() {
    const args = Array.from(arguments);
    let host = '';
    let port = 0;
    const a0 = args[0];
    if (typeof a0 === 'object' && a0 !== null) {
      host = a0.host || a0.hostname || a0.servername || '';
      port = Number(a0.port) || 0;
    } else if (typeof a0 === 'number' || (typeof a0 === 'string' && /^\d+$/.test(a0))) {
      port = Number(a0) || 0;
      if (typeof args[1] === 'string') host = args[1];
      else if (typeof args[1] === 'object' && args[1] !== null) {
        host = args[1].host || args[1].hostname || args[1].servername || '';
      }
    }
    const err = __checkAndMaybeBlock('tls', host, port, false);
    if (err) {
      const s = new __tls.TLSSocket(new __net.Socket());
      const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      process.nextTick(() => {
        s.emit('error', err);
        if (cb) { try { cb(err); } catch (_) {} }
        try { s.destroy(err); } catch (_) {}
      });
      return s;
    }
    return __origTlsConnect.apply(__tls, args);
  };
})();



var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __publicField = (obj, key, value) => {
  __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
  return value;
};
var __accessCheck = (obj, member, msg) => {
  if (!member.has(obj))
    throw TypeError("Cannot " + msg);
};
var __privateGet = (obj, member, getter) => {
  __accessCheck(obj, member, "read from private field");
  return getter ? getter.call(obj) : member.get(obj);
};
var __privateAdd = (obj, member, value) => {
  if (member.has(obj))
    throw TypeError("Cannot add the same private member more than once");
  member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
};
var __privateSet = (obj, member, value, setter) => {
  __accessCheck(obj, member, "write to private field");
  setter ? setter.call(obj, value) : member.set(obj, value);
  return value;
};
var require_stdin = __commonJS({
  "<stdin>"(exports, module) {
    var _e, _t, _a;
    var hs = Object.create;
    var he = Object.defineProperty;
    var us = Object.getOwnPropertyDescriptor;
    var ds = Object.getOwnPropertyNames;
    var ps = Object.getPrototypeOf, gs = Object.prototype.hasOwnProperty;
    var b = (t, e) => () => (e || t((e = { exports: {} }).exports, e), e.exports), _s = (t, e) => {
      for (var s in e)
        he(t, s, { get: e[s], enumerable: true });
    }, Ze = (t, e, s, r) => {
      if (e && typeof e == "object" || typeof e == "function")
        for (let n of ds(e))
          !gs.call(t, n) && n !== s && he(t, n, { get: () => e[n], enumerable: !(r = us(e, n)) || r.enumerable });
      return t;
    };
    var P = (t, e, s) => (s = t != null ? hs(ps(t)) : {}, Ze(e || !t || !t.__esModule ? he(s, "default", { value: t, enumerable: true }) : s, t)), ms = (t) => Ze(he({}, "__esModule", { value: true }), t);
    var N = b((gn, tt) => {
      "use strict";
      var Qe = ["nodebuffer", "arraybuffer", "fragments"], et = typeof Blob < "u";
      et && Qe.push("blob");
      tt.exports = { BINARY_TYPES: Qe, CLOSE_TIMEOUT: 3e4, EMPTY_BUFFER: Buffer.alloc(0), GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11", hasBlob: et, kForOnEventAttribute: Symbol("kIsForOnEventAttribute"), kListener: Symbol("kListener"), kStatusCode: Symbol("status-code"), kWebSocket: Symbol("websocket"), NOOP: () => {
      } };
    });
    var ne = b((_n, ue) => {
      "use strict";
      var { EMPTY_BUFFER: ys } = N(), Pe = Buffer[Symbol.species];
      function Ss(t, e) {
        if (t.length === 0)
          return ys;
        if (t.length === 1)
          return t[0];
        let s = Buffer.allocUnsafe(e), r = 0;
        for (let n = 0; n < t.length; n++) {
          let i = t[n];
          s.set(i, r), r += i.length;
        }
        return r < e ? new Pe(s.buffer, s.byteOffset, r) : s;
      }
      function st(t, e, s, r, n) {
        for (let i = 0; i < n; i++)
          s[r + i] = t[i] ^ e[i & 3];
      }
      function rt(t, e) {
        for (let s = 0; s < t.length; s++)
          t[s] ^= e[s & 3];
      }
      function Es(t) {
        return t.length === t.buffer.byteLength ? t.buffer : t.buffer.slice(t.byteOffset, t.byteOffset + t.length);
      }
      function Ne(t) {
        if (Ne.readOnly = true, Buffer.isBuffer(t))
          return t;
        let e;
        return t instanceof ArrayBuffer ? e = new Pe(t) : ArrayBuffer.isView(t) ? e = new Pe(t.buffer, t.byteOffset, t.byteLength) : (e = Buffer.from(t), Ne.readOnly = false), e;
      }
      ue.exports = { concat: Ss, mask: st, toArrayBuffer: Es, toBuffer: Ne, unmask: rt };
      if (!process.env.WS_NO_BUFFER_UTIL)
        try {
          let t = require("bufferutil");
          ue.exports.mask = function(e, s, r, n, i) {
            i < 48 ? st(e, s, r, n, i) : t.mask(e, s, r, n, i);
          }, ue.exports.unmask = function(e, s) {
            e.length < 32 ? rt(e, s) : t.unmask(e, s);
          };
        } catch {
        }
    });
    var ot = b((mn, it) => {
      "use strict";
      var nt = Symbol("kDone"), Ae = Symbol("kRun"), Be = class {
        constructor(e) {
          this[nt] = () => {
            this.pending--, this[Ae]();
          }, this.concurrency = e || 1 / 0, this.jobs = [], this.pending = 0;
        }
        add(e) {
          this.jobs.push(e), this[Ae]();
        }
        [Ae]() {
          if (this.pending !== this.concurrency && this.jobs.length) {
            let e = this.jobs.shift();
            this.pending++, e(this[nt]);
          }
        }
      };
      it.exports = Be;
    });
    var J = b((yn, ct) => {
      "use strict";
      var ie = require("zlib"), at = ne(), xs = ot(), { kStatusCode: lt } = N(), bs = Buffer[Symbol.species], ws = Buffer.from([0, 0, 255, 255]), pe = Symbol("permessage-deflate"), A = Symbol("total-length"), K = Symbol("callback"), M = Symbol("buffers"), X = Symbol("error"), de, Ie = class {
        constructor(e) {
          if (this._options = e || {}, this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024, this._maxPayload = this._options.maxPayload | 0, this._isServer = !!this._options.isServer, this._deflate = null, this._inflate = null, this.params = null, !de) {
            let s = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
            de = new xs(s);
          }
        }
        static get extensionName() {
          return "permessage-deflate";
        }
        offer() {
          let e = {};
          return this._options.serverNoContextTakeover && (e.server_no_context_takeover = true), this._options.clientNoContextTakeover && (e.client_no_context_takeover = true), this._options.serverMaxWindowBits && (e.server_max_window_bits = this._options.serverMaxWindowBits), this._options.clientMaxWindowBits ? e.client_max_window_bits = this._options.clientMaxWindowBits : this._options.clientMaxWindowBits == null && (e.client_max_window_bits = true), e;
        }
        accept(e) {
          return e = this.normalizeParams(e), this.params = this._isServer ? this.acceptAsServer(e) : this.acceptAsClient(e), this.params;
        }
        cleanup() {
          if (this._inflate && (this._inflate.close(), this._inflate = null), this._deflate) {
            let e = this._deflate[K];
            this._deflate.close(), this._deflate = null, e && e(new Error("The deflate stream was closed while data was being processed"));
          }
        }
        acceptAsServer(e) {
          let s = this._options, r = e.find((n) => !(s.serverNoContextTakeover === false && n.server_no_context_takeover || n.server_max_window_bits && (s.serverMaxWindowBits === false || typeof s.serverMaxWindowBits == "number" && s.serverMaxWindowBits > n.server_max_window_bits) || typeof s.clientMaxWindowBits == "number" && (typeof n.client_max_window_bits == "number" ? s.clientMaxWindowBits > n.client_max_window_bits : !n.client_max_window_bits)));
          if (!r)
            throw new Error("None of the extension offers can be accepted");
          return s.serverNoContextTakeover && (r.server_no_context_takeover = true), s.clientNoContextTakeover && (r.client_no_context_takeover = true), typeof s.serverMaxWindowBits == "number" && (r.server_max_window_bits = s.serverMaxWindowBits), typeof s.clientMaxWindowBits == "number" ? r.client_max_window_bits = s.clientMaxWindowBits : (r.client_max_window_bits === true || s.clientMaxWindowBits === false) && delete r.client_max_window_bits, r;
        }
        acceptAsClient(e) {
          let s = e[0];
          if (this._options.clientNoContextTakeover === false && s.client_no_context_takeover)
            throw new Error('Unexpected parameter "client_no_context_takeover"');
          if (!s.client_max_window_bits)
            typeof this._options.clientMaxWindowBits == "number" && (s.client_max_window_bits = this._options.clientMaxWindowBits);
          else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits == "number" && s.client_max_window_bits > this._options.clientMaxWindowBits)
            throw new Error('Unexpected or invalid parameter "client_max_window_bits"');
          return s;
        }
        normalizeParams(e) {
          return e.forEach((s) => {
            Object.keys(s).forEach((r) => {
              let n = s[r];
              if (n.length > 1)
                throw new Error(`Parameter "${r}" must have only a single value`);
              if (n = n[0], r === "client_max_window_bits") {
                if (n !== true) {
                  let i = +n;
                  if (!Number.isInteger(i) || i < 8 || i > 15)
                    throw new TypeError(`Invalid value for parameter "${r}": ${n}`);
                  n = i;
                } else if (!this._isServer)
                  throw new TypeError(`Invalid value for parameter "${r}": ${n}`);
              } else if (r === "server_max_window_bits") {
                let i = +n;
                if (!Number.isInteger(i) || i < 8 || i > 15)
                  throw new TypeError(`Invalid value for parameter "${r}": ${n}`);
                n = i;
              } else if (r === "client_no_context_takeover" || r === "server_no_context_takeover") {
                if (n !== true)
                  throw new TypeError(`Invalid value for parameter "${r}": ${n}`);
              } else
                throw new Error(`Unknown parameter "${r}"`);
              s[r] = n;
            });
          }), e;
        }
        decompress(e, s, r) {
          de.add((n) => {
            this._decompress(e, s, (i, o) => {
              n(), r(i, o);
            });
          });
        }
        compress(e, s, r) {
          de.add((n) => {
            this._compress(e, s, (i, o) => {
              n(), r(i, o);
            });
          });
        }
        _decompress(e, s, r) {
          let n = this._isServer ? "client" : "server";
          if (!this._inflate) {
            let i = `${n}_max_window_bits`, o = typeof this.params[i] != "number" ? ie.Z_DEFAULT_WINDOWBITS : this.params[i];
            this._inflate = ie.createInflateRaw({ ...this._options.zlibInflateOptions, windowBits: o }), this._inflate[pe] = this, this._inflate[A] = 0, this._inflate[M] = [], this._inflate.on("error", vs), this._inflate.on("data", ft);
          }
          this._inflate[K] = r, this._inflate.write(e), s && this._inflate.write(ws), this._inflate.flush(() => {
            let i = this._inflate[X];
            if (i) {
              this._inflate.close(), this._inflate = null, r(i);
              return;
            }
            let o = at.concat(this._inflate[M], this._inflate[A]);
            this._inflate._readableState.endEmitted ? (this._inflate.close(), this._inflate = null) : (this._inflate[A] = 0, this._inflate[M] = [], s && this.params[`${n}_no_context_takeover`] && this._inflate.reset()), r(null, o);
          });
        }
        _compress(e, s, r) {
          let n = this._isServer ? "server" : "client";
          if (!this._deflate) {
            let i = `${n}_max_window_bits`, o = typeof this.params[i] != "number" ? ie.Z_DEFAULT_WINDOWBITS : this.params[i];
            this._deflate = ie.createDeflateRaw({ ...this._options.zlibDeflateOptions, windowBits: o }), this._deflate[A] = 0, this._deflate[M] = [], this._deflate.on("data", Ts);
          }
          this._deflate[K] = r, this._deflate.write(e), this._deflate.flush(ie.Z_SYNC_FLUSH, () => {
            if (!this._deflate)
              return;
            let i = at.concat(this._deflate[M], this._deflate[A]);
            s && (i = new bs(i.buffer, i.byteOffset, i.length - 4)), this._deflate[K] = null, this._deflate[A] = 0, this._deflate[M] = [], s && this.params[`${n}_no_context_takeover`] && this._deflate.reset(), r(null, i);
          });
        }
      };
      ct.exports = Ie;
      function Ts(t) {
        this[M].push(t), this[A] += t.length;
      }
      function ft(t) {
        if (this[A] += t.length, this[pe]._maxPayload < 1 || this[A] <= this[pe]._maxPayload) {
          this[M].push(t);
          return;
        }
        this[X] = new RangeError("Max payload size exceeded"), this[X].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH", this[X][lt] = 1009, this.removeListener("data", ft), this.reset();
      }
      function vs(t) {
        if (this[pe]._inflate = null, this[X]) {
          this[K](this[X]);
          return;
        }
        t[lt] = 1007, this[K](t);
      }
    });
    var Z = b((Sn, ge) => {
      "use strict";
      var { isUtf8: ht } = require("buffer"), { hasBlob: ks } = N(), Os = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 0];
      function Ls(t) {
        return t >= 1e3 && t <= 1014 && t !== 1004 && t !== 1005 && t !== 1006 || t >= 3e3 && t <= 4999;
      }
      function Re(t) {
        let e = t.length, s = 0;
        for (; s < e; )
          if (!(t[s] & 128))
            s++;
          else if ((t[s] & 224) === 192) {
            if (s + 1 === e || (t[s + 1] & 192) !== 128 || (t[s] & 254) === 192)
              return false;
            s += 2;
          } else if ((t[s] & 240) === 224) {
            if (s + 2 >= e || (t[s + 1] & 192) !== 128 || (t[s + 2] & 192) !== 128 || t[s] === 224 && (t[s + 1] & 224) === 128 || t[s] === 237 && (t[s + 1] & 224) === 160)
              return false;
            s += 3;
          } else if ((t[s] & 248) === 240) {
            if (s + 3 >= e || (t[s + 1] & 192) !== 128 || (t[s + 2] & 192) !== 128 || (t[s + 3] & 192) !== 128 || t[s] === 240 && (t[s + 1] & 240) === 128 || t[s] === 244 && t[s + 1] > 143 || t[s] > 244)
              return false;
            s += 4;
          } else
            return false;
        return true;
      }
      function Cs(t) {
        return ks && typeof t == "object" && typeof t.arrayBuffer == "function" && typeof t.type == "string" && typeof t.stream == "function" && (t[Symbol.toStringTag] === "Blob" || t[Symbol.toStringTag] === "File");
      }
      ge.exports = { isBlob: Cs, isValidStatusCode: Ls, isValidUTF8: Re, tokenChars: Os };
      if (ht)
        ge.exports.isValidUTF8 = function(t) {
          return t.length < 24 ? Re(t) : ht(t);
        };
      else if (!process.env.WS_NO_UTF_8_VALIDATE)
        try {
          let t = require("utf-8-validate");
          ge.exports.isValidUTF8 = function(e) {
            return e.length < 32 ? Re(e) : t(e);
          };
        } catch {
        }
    });
    var qe = b((En, yt) => {
      "use strict";
      var { Writable: Ps } = require("stream"), ut = J(), { BINARY_TYPES: Ns, EMPTY_BUFFER: dt, kStatusCode: As, kWebSocket: Bs } = N(), { concat: Me, toArrayBuffer: Is, unmask: Rs } = ne(), { isValidStatusCode: Ms, isValidUTF8: pt } = Z(), _e2 = Buffer[Symbol.species], T = 0, gt = 1, _t2 = 2, mt = 3, De = 4, Ue = 5, me = 6, Fe = class extends Ps {
        constructor(e = {}) {
          super(), this._allowSynchronousEvents = e.allowSynchronousEvents !== void 0 ? e.allowSynchronousEvents : true, this._binaryType = e.binaryType || Ns[0], this._extensions = e.extensions || {}, this._isServer = !!e.isServer, this._maxBufferedChunks = e.maxBufferedChunks | 0, this._maxFragments = e.maxFragments | 0, this._maxPayload = e.maxPayload | 0, this._skipUTF8Validation = !!e.skipUTF8Validation, this[Bs] = void 0, this._bufferedBytes = 0, this._buffers = [], this._compressed = false, this._payloadLength = 0, this._mask = void 0, this._fragmented = 0, this._masked = false, this._fin = false, this._opcode = 0, this._totalPayloadLength = 0, this._messageLength = 0, this._numFragments = 0, this._fragments = [], this._errored = false, this._loop = false, this._state = T;
        }
        _write(e, s, r) {
          if (this._opcode === 8 && this._state == T)
            return r();
          if (this._maxBufferedChunks > 0 && this._buffers.length >= this._maxBufferedChunks) {
            r(this.createError(RangeError, "Too many buffered chunks", false, 1008, "WS_ERR_TOO_MANY_BUFFERED_PARTS"));
            return;
          }
          this._bufferedBytes += e.length, this._buffers.push(e), this.startLoop(r);
        }
        consume(e) {
          if (this._bufferedBytes -= e, e === this._buffers[0].length)
            return this._buffers.shift();
          if (e < this._buffers[0].length) {
            let r = this._buffers[0];
            return this._buffers[0] = new _e2(r.buffer, r.byteOffset + e, r.length - e), new _e2(r.buffer, r.byteOffset, e);
          }
          let s = Buffer.allocUnsafe(e);
          do {
            let r = this._buffers[0], n = s.length - e;
            e >= r.length ? s.set(this._buffers.shift(), n) : (s.set(new Uint8Array(r.buffer, r.byteOffset, e), n), this._buffers[0] = new _e2(r.buffer, r.byteOffset + e, r.length - e)), e -= r.length;
          } while (e > 0);
          return s;
        }
        startLoop(e) {
          this._loop = true;
          do
            switch (this._state) {
              case T:
                this.getInfo(e);
                break;
              case gt:
                this.getPayloadLength16(e);
                break;
              case _t2:
                this.getPayloadLength64(e);
                break;
              case mt:
                this.getMask();
                break;
              case De:
                this.getData(e);
                break;
              case Ue:
              case me:
                this._loop = false;
                return;
            }
          while (this._loop);
          this._errored || e();
        }
        getInfo(e) {
          if (this._bufferedBytes < 2) {
            this._loop = false;
            return;
          }
          let s = this.consume(2);
          if (s[0] & 48) {
            let n = this.createError(RangeError, "RSV2 and RSV3 must be clear", true, 1002, "WS_ERR_UNEXPECTED_RSV_2_3");
            e(n);
            return;
          }
          let r = (s[0] & 64) === 64;
          if (r && !this._extensions[ut.extensionName]) {
            let n = this.createError(RangeError, "RSV1 must be clear", true, 1002, "WS_ERR_UNEXPECTED_RSV_1");
            e(n);
            return;
          }
          if (this._fin = (s[0] & 128) === 128, this._opcode = s[0] & 15, this._payloadLength = s[1] & 127, this._opcode === 0) {
            if (r) {
              let n = this.createError(RangeError, "RSV1 must be clear", true, 1002, "WS_ERR_UNEXPECTED_RSV_1");
              e(n);
              return;
            }
            if (!this._fragmented) {
              let n = this.createError(RangeError, "invalid opcode 0", true, 1002, "WS_ERR_INVALID_OPCODE");
              e(n);
              return;
            }
            this._opcode = this._fragmented;
          } else if (this._opcode === 1 || this._opcode === 2) {
            if (this._fragmented) {
              let n = this.createError(RangeError, `invalid opcode ${this._opcode}`, true, 1002, "WS_ERR_INVALID_OPCODE");
              e(n);
              return;
            }
            this._compressed = r;
          } else if (this._opcode > 7 && this._opcode < 11) {
            if (!this._fin) {
              let n = this.createError(RangeError, "FIN must be set", true, 1002, "WS_ERR_EXPECTED_FIN");
              e(n);
              return;
            }
            if (r) {
              let n = this.createError(RangeError, "RSV1 must be clear", true, 1002, "WS_ERR_UNEXPECTED_RSV_1");
              e(n);
              return;
            }
            if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
              let n = this.createError(RangeError, `invalid payload length ${this._payloadLength}`, true, 1002, "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH");
              e(n);
              return;
            }
          } else {
            let n = this.createError(RangeError, `invalid opcode ${this._opcode}`, true, 1002, "WS_ERR_INVALID_OPCODE");
            e(n);
            return;
          }
          if (!this._fin && !this._fragmented && (this._fragmented = this._opcode), this._masked = (s[1] & 128) === 128, this._isServer) {
            if (!this._masked) {
              let n = this.createError(RangeError, "MASK must be set", true, 1002, "WS_ERR_EXPECTED_MASK");
              e(n);
              return;
            }
          } else if (this._masked) {
            let n = this.createError(RangeError, "MASK must be clear", true, 1002, "WS_ERR_UNEXPECTED_MASK");
            e(n);
            return;
          }
          this._payloadLength === 126 ? this._state = gt : this._payloadLength === 127 ? this._state = _t2 : this.haveLength(e);
        }
        getPayloadLength16(e) {
          if (this._bufferedBytes < 2) {
            this._loop = false;
            return;
          }
          this._payloadLength = this.consume(2).readUInt16BE(0), this.haveLength(e);
        }
        getPayloadLength64(e) {
          if (this._bufferedBytes < 8) {
            this._loop = false;
            return;
          }
          let s = this.consume(8), r = s.readUInt32BE(0);
          if (r > Math.pow(2, 21) - 1) {
            let n = this.createError(RangeError, "Unsupported WebSocket frame: payload length > 2^53 - 1", false, 1009, "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH");
            e(n);
            return;
          }
          this._payloadLength = r * Math.pow(2, 32) + s.readUInt32BE(4), this.haveLength(e);
        }
        haveLength(e) {
          if (this._payloadLength && this._opcode < 8 && (this._totalPayloadLength += this._payloadLength, this._totalPayloadLength > this._maxPayload && this._maxPayload > 0)) {
            let s = this.createError(RangeError, "Max payload size exceeded", false, 1009, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH");
            e(s);
            return;
          }
          this._masked ? this._state = mt : this._state = De;
        }
        getMask() {
          if (this._bufferedBytes < 4) {
            this._loop = false;
            return;
          }
          this._mask = this.consume(4), this._state = De;
        }
        getData(e) {
          let s = dt;
          if (this._payloadLength) {
            if (this._bufferedBytes < this._payloadLength) {
              this._loop = false;
              return;
            }
            s = this.consume(this._payloadLength), this._masked && this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3] && Rs(s, this._mask);
          }
          if (this._opcode > 7) {
            this.controlMessage(s, e);
            return;
          }
          if (this._maxFragments > 0 && ++this._numFragments > this._maxFragments) {
            let r = this.createError(RangeError, "Too many message fragments", false, 1008, "WS_ERR_TOO_MANY_BUFFERED_PARTS");
            e(r);
            return;
          }
          if (this._compressed) {
            this._state = Ue, this.decompress(s, e);
            return;
          }
          s.length && (this._messageLength = this._totalPayloadLength, this._fragments.push(s)), this.dataMessage(e);
        }
        decompress(e, s) {
          this._extensions[ut.extensionName].decompress(e, this._fin, (n, i) => {
            if (n)
              return s(n);
            if (i.length) {
              if (this._messageLength += i.length, this._messageLength > this._maxPayload && this._maxPayload > 0) {
                let o = this.createError(RangeError, "Max payload size exceeded", false, 1009, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH");
                s(o);
                return;
              }
              this._fragments.push(i);
            }
            this.dataMessage(s), this._state === T && this.startLoop(s);
          });
        }
        dataMessage(e) {
          if (!this._fin) {
            this._state = T;
            return;
          }
          let s = this._messageLength, r = this._fragments;
          if (this._totalPayloadLength = 0, this._messageLength = 0, this._fragmented = 0, this._numFragments = 0, this._fragments = [], this._opcode === 2) {
            let n;
            this._binaryType === "nodebuffer" ? n = Me(r, s) : this._binaryType === "arraybuffer" ? n = Is(Me(r, s)) : this._binaryType === "blob" ? n = new Blob(r) : n = r, this._allowSynchronousEvents ? (this.emit("message", n, true), this._state = T) : (this._state = me, setImmediate(() => {
              this.emit("message", n, true), this._state = T, this.startLoop(e);
            }));
          } else {
            let n = Me(r, s);
            if (!this._skipUTF8Validation && !pt(n)) {
              let i = this.createError(Error, "invalid UTF-8 sequence", true, 1007, "WS_ERR_INVALID_UTF8");
              e(i);
              return;
            }
            this._state === Ue || this._allowSynchronousEvents ? (this.emit("message", n, false), this._state = T) : (this._state = me, setImmediate(() => {
              this.emit("message", n, false), this._state = T, this.startLoop(e);
            }));
          }
        }
        controlMessage(e, s) {
          if (this._opcode === 8) {
            if (e.length === 0)
              this._loop = false, this.emit("conclude", 1005, dt), this.end();
            else {
              let r = e.readUInt16BE(0);
              if (!Ms(r)) {
                let i = this.createError(RangeError, `invalid status code ${r}`, true, 1002, "WS_ERR_INVALID_CLOSE_CODE");
                s(i);
                return;
              }
              let n = new _e2(e.buffer, e.byteOffset + 2, e.length - 2);
              if (!this._skipUTF8Validation && !pt(n)) {
                let i = this.createError(Error, "invalid UTF-8 sequence", true, 1007, "WS_ERR_INVALID_UTF8");
                s(i);
                return;
              }
              this._loop = false, this.emit("conclude", r, n), this.end();
            }
            this._state = T;
            return;
          }
          this._allowSynchronousEvents ? (this.emit(this._opcode === 9 ? "ping" : "pong", e), this._state = T) : (this._state = me, setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", e), this._state = T, this.startLoop(s);
          }));
        }
        createError(e, s, r, n, i) {
          this._loop = false, this._errored = true;
          let o = new e(r ? `Invalid WebSocket frame: ${s}` : s);
          return Error.captureStackTrace(o, this.createError), o.code = i, o[As] = n, o;
        }
      };
      yt.exports = Fe;
    });
    var je = b((bn, xt) => {
      "use strict";
      var { Duplex: xn } = require("stream"), { randomFillSync: Ds } = require("crypto"), { types: { isUint8Array: Us } } = require("util"), St = J(), { EMPTY_BUFFER: Fs, kWebSocket: qs, NOOP: Ws } = N(), { isBlob: Q, isValidStatusCode: $s } = Z(), { mask: Et, toBuffer: W } = ne(), v = Symbol("kByteLength"), js = Buffer.alloc(4), ye = 8 * 1024, $, ee = ye, O = 0, Gs = 1, Vs = 2, We = class t {
        constructor(e, s, r) {
          this._extensions = s || {}, r && (this._generateMask = r, this._maskBuffer = Buffer.alloc(4)), this._socket = e, this._firstFragment = true, this._compress = false, this._bufferedBytes = 0, this._queue = [], this._state = O, this.onerror = Ws, this[qs] = void 0;
        }
        static frame(e, s) {
          let r, n = false, i = 2, o = false;
          s.mask && (r = s.maskBuffer || js, s.generateMask ? s.generateMask(r) : (ee === ye && ($ === void 0 && ($ = Buffer.alloc(ye)), Ds($, 0, ye), ee = 0), r[0] = $[ee++], r[1] = $[ee++], r[2] = $[ee++], r[3] = $[ee++]), o = (r[0] | r[1] | r[2] | r[3]) === 0, i = 6);
          let l;
          typeof e == "string" ? (!s.mask || o) && s[v] !== void 0 ? l = s[v] : (e = Buffer.from(e), l = e.length) : (l = e.length, n = s.mask && s.readOnly && !o);
          let f = l;
          l >= 65536 ? (i += 8, f = 127) : l > 125 && (i += 2, f = 126);
          let a = Buffer.allocUnsafe(n ? l + i : i);
          return a[0] = s.fin ? s.opcode | 128 : s.opcode, s.rsv1 && (a[0] |= 64), a[1] = f, f === 126 ? a.writeUInt16BE(l, 2) : f === 127 && (a[2] = a[3] = 0, a.writeUIntBE(l, 4, 6)), s.mask ? (a[1] |= 128, a[i - 4] = r[0], a[i - 3] = r[1], a[i - 2] = r[2], a[i - 1] = r[3], o ? [a, e] : n ? (Et(e, r, a, i, l), [a]) : (Et(e, r, e, 0, l), [a, e])) : [a, e];
        }
        close(e, s, r, n) {
          let i;
          if (e === void 0)
            i = Fs;
          else {
            if (typeof e != "number" || !$s(e))
              throw new TypeError("First argument must be a valid error code number");
            if (s === void 0 || !s.length)
              i = Buffer.allocUnsafe(2), i.writeUInt16BE(e, 0);
            else {
              let l = Buffer.byteLength(s);
              if (l > 123)
                throw new RangeError("The message must not be greater than 123 bytes");
              if (i = Buffer.allocUnsafe(2 + l), i.writeUInt16BE(e, 0), typeof s == "string")
                i.write(s, 2);
              else if (Us(s))
                i.set(s, 2);
              else
                throw new TypeError("Second argument must be a string or a Uint8Array");
            }
          }
          let o = { [v]: i.length, fin: true, generateMask: this._generateMask, mask: r, maskBuffer: this._maskBuffer, opcode: 8, readOnly: false, rsv1: false };
          this._state !== O ? this.enqueue([this.dispatch, i, false, o, n]) : this.sendFrame(t.frame(i, o), n);
        }
        ping(e, s, r) {
          let n, i;
          if (typeof e == "string" ? (n = Buffer.byteLength(e), i = false) : Q(e) ? (n = e.size, i = false) : (e = W(e), n = e.length, i = W.readOnly), n > 125)
            throw new RangeError("The data size must not be greater than 125 bytes");
          let o = { [v]: n, fin: true, generateMask: this._generateMask, mask: s, maskBuffer: this._maskBuffer, opcode: 9, readOnly: i, rsv1: false };
          Q(e) ? this._state !== O ? this.enqueue([this.getBlobData, e, false, o, r]) : this.getBlobData(e, false, o, r) : this._state !== O ? this.enqueue([this.dispatch, e, false, o, r]) : this.sendFrame(t.frame(e, o), r);
        }
        pong(e, s, r) {
          let n, i;
          if (typeof e == "string" ? (n = Buffer.byteLength(e), i = false) : Q(e) ? (n = e.size, i = false) : (e = W(e), n = e.length, i = W.readOnly), n > 125)
            throw new RangeError("The data size must not be greater than 125 bytes");
          let o = { [v]: n, fin: true, generateMask: this._generateMask, mask: s, maskBuffer: this._maskBuffer, opcode: 10, readOnly: i, rsv1: false };
          Q(e) ? this._state !== O ? this.enqueue([this.getBlobData, e, false, o, r]) : this.getBlobData(e, false, o, r) : this._state !== O ? this.enqueue([this.dispatch, e, false, o, r]) : this.sendFrame(t.frame(e, o), r);
        }
        send(e, s, r) {
          let n = this._extensions[St.extensionName], i = s.binary ? 2 : 1, o = s.compress, l, f;
          typeof e == "string" ? (l = Buffer.byteLength(e), f = false) : Q(e) ? (l = e.size, f = false) : (e = W(e), l = e.length, f = W.readOnly), this._firstFragment ? (this._firstFragment = false, o && n && n.params[n._isServer ? "server_no_context_takeover" : "client_no_context_takeover"] && (o = l >= n._threshold), this._compress = o) : (o = false, i = 0), s.fin && (this._firstFragment = true);
          let a = { [v]: l, fin: s.fin, generateMask: this._generateMask, mask: s.mask, maskBuffer: this._maskBuffer, opcode: i, readOnly: f, rsv1: o };
          Q(e) ? this._state !== O ? this.enqueue([this.getBlobData, e, this._compress, a, r]) : this.getBlobData(e, this._compress, a, r) : this._state !== O ? this.enqueue([this.dispatch, e, this._compress, a, r]) : this.dispatch(e, this._compress, a, r);
        }
        getBlobData(e, s, r, n) {
          this._bufferedBytes += r[v], this._state = Vs, e.arrayBuffer().then((i) => {
            if (this._socket.destroyed) {
              let l = new Error("The socket was closed while the blob was being read");
              process.nextTick($e, this, l, n);
              return;
            }
            this._bufferedBytes -= r[v];
            let o = W(i);
            s ? this.dispatch(o, s, r, n) : (this._state = O, this.sendFrame(t.frame(o, r), n), this.dequeue());
          }).catch((i) => {
            process.nextTick(zs, this, i, n);
          });
        }
        dispatch(e, s, r, n) {
          if (!s) {
            this.sendFrame(t.frame(e, r), n);
            return;
          }
          let i = this._extensions[St.extensionName];
          this._bufferedBytes += r[v], this._state = Gs, i.compress(e, r.fin, (o, l) => {
            if (this._socket.destroyed) {
              let f = new Error("The socket was closed while data was being compressed");
              $e(this, f, n);
              return;
            }
            this._bufferedBytes -= r[v], this._state = O, r.readOnly = false, this.sendFrame(t.frame(l, r), n), this.dequeue();
          });
        }
        dequeue() {
          for (; this._state === O && this._queue.length; ) {
            let e = this._queue.shift();
            this._bufferedBytes -= e[3][v], Reflect.apply(e[0], this, e.slice(1));
          }
        }
        enqueue(e) {
          this._bufferedBytes += e[3][v], this._queue.push(e);
        }
        sendFrame(e, s) {
          e.length === 2 ? (this._socket.cork(), this._socket.write(e[0]), this._socket.write(e[1], s), this._socket.uncork()) : this._socket.write(e[0], s);
        }
      };
      xt.exports = We;
      function $e(t, e, s) {
        typeof s == "function" && s(e);
        for (let r = 0; r < t._queue.length; r++) {
          let n = t._queue[r], i = n[n.length - 1];
          typeof i == "function" && i(e);
        }
      }
      function zs(t, e, s) {
        $e(t, e, s), t.onerror(e);
      }
    });
    var Pt = b((wn, Ct) => {
      "use strict";
      var { kForOnEventAttribute: oe, kListener: Ge } = N(), bt = Symbol("kCode"), wt = Symbol("kData"), Tt = Symbol("kError"), vt = Symbol("kMessage"), kt = Symbol("kReason"), te = Symbol("kTarget"), Ot = Symbol("kType"), Lt = Symbol("kWasClean"), B = class {
        constructor(e) {
          this[te] = null, this[Ot] = e;
        }
        get target() {
          return this[te];
        }
        get type() {
          return this[Ot];
        }
      };
      Object.defineProperty(B.prototype, "target", { enumerable: true });
      Object.defineProperty(B.prototype, "type", { enumerable: true });
      var j = class extends B {
        constructor(e, s = {}) {
          super(e), this[bt] = s.code === void 0 ? 0 : s.code, this[kt] = s.reason === void 0 ? "" : s.reason, this[Lt] = s.wasClean === void 0 ? false : s.wasClean;
        }
        get code() {
          return this[bt];
        }
        get reason() {
          return this[kt];
        }
        get wasClean() {
          return this[Lt];
        }
      };
      Object.defineProperty(j.prototype, "code", { enumerable: true });
      Object.defineProperty(j.prototype, "reason", { enumerable: true });
      Object.defineProperty(j.prototype, "wasClean", { enumerable: true });
      var se = class extends B {
        constructor(e, s = {}) {
          super(e), this[Tt] = s.error === void 0 ? null : s.error, this[vt] = s.message === void 0 ? "" : s.message;
        }
        get error() {
          return this[Tt];
        }
        get message() {
          return this[vt];
        }
      };
      Object.defineProperty(se.prototype, "error", { enumerable: true });
      Object.defineProperty(se.prototype, "message", { enumerable: true });
      var ae = class extends B {
        constructor(e, s = {}) {
          super(e), this[wt] = s.data === void 0 ? null : s.data;
        }
        get data() {
          return this[wt];
        }
      };
      Object.defineProperty(ae.prototype, "data", { enumerable: true });
      var Hs = { addEventListener(t, e, s = {}) {
        for (let n of this.listeners(t))
          if (!s[oe] && n[Ge] === e && !n[oe])
            return;
        let r;
        if (t === "message")
          r = function(i, o) {
            let l = new ae("message", { data: o ? i : i.toString() });
            l[te] = this, Se(e, this, l);
          };
        else if (t === "close")
          r = function(i, o) {
            let l = new j("close", { code: i, reason: o.toString(), wasClean: this._closeFrameReceived && this._closeFrameSent });
            l[te] = this, Se(e, this, l);
          };
        else if (t === "error")
          r = function(i) {
            let o = new se("error", { error: i, message: i.message });
            o[te] = this, Se(e, this, o);
          };
        else if (t === "open")
          r = function() {
            let i = new B("open");
            i[te] = this, Se(e, this, i);
          };
        else
          return;
        r[oe] = !!s[oe], r[Ge] = e, s.once ? this.once(t, r) : this.on(t, r);
      }, removeEventListener(t, e) {
        for (let s of this.listeners(t))
          if (s[Ge] === e && !s[oe]) {
            this.removeListener(t, s);
            break;
          }
      } };
      Ct.exports = { CloseEvent: j, ErrorEvent: se, Event: B, EventTarget: Hs, MessageEvent: ae };
      function Se(t, e, s) {
        typeof t == "object" && t.handleEvent ? t.handleEvent.call(t, s) : t.call(e, s);
      }
    });
    var Ee = b((Tn, Nt) => {
      "use strict";
      var { tokenChars: le } = Z();
      function L(t, e, s) {
        t[e] === void 0 ? t[e] = [s] : t[e].push(s);
      }
      function Ys(t) {
        let e = /* @__PURE__ */ Object.create(null), s = /* @__PURE__ */ Object.create(null), r = false, n = false, i = false, o, l, f = -1, a = -1, c = -1, h = 0;
        for (; h < t.length; h++)
          if (a = t.charCodeAt(h), o === void 0)
            if (c === -1 && le[a] === 1)
              f === -1 && (f = h);
            else if (h !== 0 && (a === 32 || a === 9))
              c === -1 && f !== -1 && (c = h);
            else if (a === 59 || a === 44) {
              if (f === -1)
                throw new SyntaxError(`Unexpected character at index ${h}`);
              c === -1 && (c = h);
              let _ = t.slice(f, c);
              a === 44 ? (L(e, _, s), s = /* @__PURE__ */ Object.create(null)) : o = _, f = c = -1;
            } else
              throw new SyntaxError(`Unexpected character at index ${h}`);
          else if (l === void 0)
            if (c === -1 && le[a] === 1)
              f === -1 && (f = h);
            else if (a === 32 || a === 9)
              c === -1 && f !== -1 && (c = h);
            else if (a === 59 || a === 44) {
              if (f === -1)
                throw new SyntaxError(`Unexpected character at index ${h}`);
              c === -1 && (c = h), L(s, t.slice(f, c), true), a === 44 && (L(e, o, s), s = /* @__PURE__ */ Object.create(null), o = void 0), f = c = -1;
            } else if (a === 61 && f !== -1 && c === -1)
              l = t.slice(f, h), f = c = -1;
            else
              throw new SyntaxError(`Unexpected character at index ${h}`);
          else if (n) {
            if (le[a] !== 1)
              throw new SyntaxError(`Unexpected character at index ${h}`);
            f === -1 ? f = h : r || (r = true), n = false;
          } else if (i)
            if (le[a] === 1)
              f === -1 && (f = h);
            else if (a === 34 && f !== -1)
              i = false, c = h;
            else if (a === 92)
              n = true;
            else
              throw new SyntaxError(`Unexpected character at index ${h}`);
          else if (a === 34 && t.charCodeAt(h - 1) === 61)
            i = true;
          else if (c === -1 && le[a] === 1)
            f === -1 && (f = h);
          else if (f !== -1 && (a === 32 || a === 9))
            c === -1 && (c = h);
          else if (a === 59 || a === 44) {
            if (f === -1)
              throw new SyntaxError(`Unexpected character at index ${h}`);
            c === -1 && (c = h);
            let _ = t.slice(f, c);
            r && (_ = _.replace(/\\/g, ""), r = false), L(s, l, _), a === 44 && (L(e, o, s), s = /* @__PURE__ */ Object.create(null), o = void 0), l = void 0, f = c = -1;
          } else
            throw new SyntaxError(`Unexpected character at index ${h}`);
        if (f === -1 || i || a === 32 || a === 9)
          throw new SyntaxError("Unexpected end of input");
        c === -1 && (c = h);
        let p = t.slice(f, c);
        return o === void 0 ? L(e, p, s) : (l === void 0 ? L(s, p, true) : r ? L(s, l, p.replace(/\\/g, "")) : L(s, l, p), L(e, o, s)), e;
      }
      function Ks(t) {
        return Object.keys(t).map((e) => {
          let s = t[e];
          return Array.isArray(s) || (s = [s]), s.map((r) => [e].concat(Object.keys(r).map((n) => {
            let i = r[n];
            return Array.isArray(i) || (i = [i]), i.map((o) => o === true ? n : `${n}=${o}`).join("; ");
          })).join("; ")).join(", ");
        }).join(", ");
      }
      Nt.exports = { format: Ks, parse: Ys };
    });
    var Te = b((On, jt) => {
      "use strict";
      var Xs = require("events"), Js = require("https"), Zs = require("http"), It = require("net"), Qs = require("tls"), { randomBytes: er, createHash: tr } = require("crypto"), { Duplex: vn, Readable: kn } = require("stream"), { URL: Ve } = require("url"), D = J(), sr = qe(), rr = je(), { isBlob: nr } = Z(), { BINARY_TYPES: At, CLOSE_TIMEOUT: ir, EMPTY_BUFFER: xe, GUID: or, kForOnEventAttribute: ze, kListener: ar, kStatusCode: lr, kWebSocket: S, NOOP: Rt } = N(), { EventTarget: { addEventListener: fr, removeEventListener: cr } } = Pt(), { format: hr, parse: ur } = Ee(), { toBuffer: dr } = ne(), Mt = Symbol("kAborted"), He = [8, 13], I = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"], pr = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/, g = class t extends Xs {
        constructor(e, s, r) {
          super(), this._binaryType = At[0], this._closeCode = 1006, this._closeFrameReceived = false, this._closeFrameSent = false, this._closeMessage = xe, this._closeTimer = null, this._errorEmitted = false, this._extensions = {}, this._paused = false, this._protocol = "", this._readyState = t.CONNECTING, this._receiver = null, this._sender = null, this._socket = null, e !== null ? (this._bufferedAmount = 0, this._isServer = false, this._redirects = 0, s === void 0 ? s = [] : Array.isArray(s) || (typeof s == "object" && s !== null ? (r = s, s = []) : s = [s]), Dt(this, e, s, r)) : (this._autoPong = r.autoPong, this._closeTimeout = r.closeTimeout, this._isServer = true);
        }
        get binaryType() {
          return this._binaryType;
        }
        set binaryType(e) {
          At.includes(e) && (this._binaryType = e, this._receiver && (this._receiver._binaryType = e));
        }
        get bufferedAmount() {
          return this._socket ? this._socket._writableState.length + this._sender._bufferedBytes : this._bufferedAmount;
        }
        get extensions() {
          return Object.keys(this._extensions).join();
        }
        get isPaused() {
          return this._paused;
        }
        get onclose() {
          return null;
        }
        get onerror() {
          return null;
        }
        get onopen() {
          return null;
        }
        get onmessage() {
          return null;
        }
        get protocol() {
          return this._protocol;
        }
        get readyState() {
          return this._readyState;
        }
        get url() {
          return this._url;
        }
        setSocket(e, s, r) {
          let n = new sr({ allowSynchronousEvents: r.allowSynchronousEvents, binaryType: this.binaryType, extensions: this._extensions, isServer: this._isServer, maxBufferedChunks: r.maxBufferedChunks, maxFragments: r.maxFragments, maxPayload: r.maxPayload, skipUTF8Validation: r.skipUTF8Validation }), i = new rr(e, this._extensions, r.generateMask);
          this._receiver = n, this._sender = i, this._socket = e, n[S] = this, i[S] = this, e[S] = this, n.on("conclude", mr), n.on("drain", yr), n.on("error", Sr), n.on("message", Er), n.on("ping", xr), n.on("pong", br), i.onerror = wr, e.setTimeout && e.setTimeout(0), e.setNoDelay && e.setNoDelay(), s.length > 0 && e.unshift(s), e.on("close", qt), e.on("data", we), e.on("end", Wt), e.on("error", $t), this._readyState = t.OPEN, this.emit("open");
        }
        emitClose() {
          if (!this._socket) {
            this._readyState = t.CLOSED, this.emit("close", this._closeCode, this._closeMessage);
            return;
          }
          this._extensions[D.extensionName] && this._extensions[D.extensionName].cleanup(), this._receiver.removeAllListeners(), this._readyState = t.CLOSED, this.emit("close", this._closeCode, this._closeMessage);
        }
        close(e, s) {
          if (this.readyState !== t.CLOSED) {
            if (this.readyState === t.CONNECTING) {
              w(this, this._req, "WebSocket was closed before the connection was established");
              return;
            }
            if (this.readyState === t.CLOSING) {
              this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted) && this._socket.end();
              return;
            }
            this._readyState = t.CLOSING, this._sender.close(e, s, !this._isServer, (r) => {
              r || (this._closeFrameSent = true, (this._closeFrameReceived || this._receiver._writableState.errorEmitted) && this._socket.end());
            }), Ft(this);
          }
        }
        pause() {
          this.readyState === t.CONNECTING || this.readyState === t.CLOSED || (this._paused = true, this._socket.pause());
        }
        ping(e, s, r) {
          if (this.readyState === t.CONNECTING)
            throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
          if (typeof e == "function" ? (r = e, e = s = void 0) : typeof s == "function" && (r = s, s = void 0), typeof e == "number" && (e = e.toString()), this.readyState !== t.OPEN) {
            Ye(this, e, r);
            return;
          }
          s === void 0 && (s = !this._isServer), this._sender.ping(e || xe, s, r);
        }
        pong(e, s, r) {
          if (this.readyState === t.CONNECTING)
            throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
          if (typeof e == "function" ? (r = e, e = s = void 0) : typeof s == "function" && (r = s, s = void 0), typeof e == "number" && (e = e.toString()), this.readyState !== t.OPEN) {
            Ye(this, e, r);
            return;
          }
          s === void 0 && (s = !this._isServer), this._sender.pong(e || xe, s, r);
        }
        resume() {
          this.readyState === t.CONNECTING || this.readyState === t.CLOSED || (this._paused = false, this._receiver._writableState.needDrain || this._socket.resume());
        }
        send(e, s, r) {
          if (this.readyState === t.CONNECTING)
            throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
          if (typeof s == "function" && (r = s, s = {}), typeof e == "number" && (e = e.toString()), this.readyState !== t.OPEN) {
            Ye(this, e, r);
            return;
          }
          let n = { binary: typeof e != "string", mask: !this._isServer, compress: true, fin: true, ...s };
          this._extensions[D.extensionName] || (n.compress = false), this._sender.send(e || xe, n, r);
        }
        terminate() {
          if (this.readyState !== t.CLOSED) {
            if (this.readyState === t.CONNECTING) {
              w(this, this._req, "WebSocket was closed before the connection was established");
              return;
            }
            this._socket && (this._readyState = t.CLOSING, this._socket.destroy());
          }
        }
      };
      Object.defineProperty(g, "CONNECTING", { enumerable: true, value: I.indexOf("CONNECTING") });
      Object.defineProperty(g.prototype, "CONNECTING", { enumerable: true, value: I.indexOf("CONNECTING") });
      Object.defineProperty(g, "OPEN", { enumerable: true, value: I.indexOf("OPEN") });
      Object.defineProperty(g.prototype, "OPEN", { enumerable: true, value: I.indexOf("OPEN") });
      Object.defineProperty(g, "CLOSING", { enumerable: true, value: I.indexOf("CLOSING") });
      Object.defineProperty(g.prototype, "CLOSING", { enumerable: true, value: I.indexOf("CLOSING") });
      Object.defineProperty(g, "CLOSED", { enumerable: true, value: I.indexOf("CLOSED") });
      Object.defineProperty(g.prototype, "CLOSED", { enumerable: true, value: I.indexOf("CLOSED") });
      ["binaryType", "bufferedAmount", "extensions", "isPaused", "protocol", "readyState", "url"].forEach((t) => {
        Object.defineProperty(g.prototype, t, { enumerable: true });
      });
      ["open", "error", "close", "message"].forEach((t) => {
        Object.defineProperty(g.prototype, `on${t}`, { enumerable: true, get() {
          for (let e of this.listeners(t))
            if (e[ze])
              return e[ar];
          return null;
        }, set(e) {
          for (let s of this.listeners(t))
            if (s[ze]) {
              this.removeListener(t, s);
              break;
            }
          typeof e == "function" && this.addEventListener(t, e, { [ze]: true });
        } });
      });
      g.prototype.addEventListener = fr;
      g.prototype.removeEventListener = cr;
      jt.exports = g;
      function Dt(t, e, s, r) {
        let n = { allowSynchronousEvents: true, autoPong: true, closeTimeout: ir, protocolVersion: He[1], maxBufferedChunks: 262144, maxFragments: 16384, maxPayload: 104857600, skipUTF8Validation: false, perMessageDeflate: true, followRedirects: false, maxRedirects: 10, ...r, socketPath: void 0, hostname: void 0, protocol: void 0, timeout: void 0, method: "GET", host: void 0, path: void 0, port: void 0 };
        if (t._autoPong = n.autoPong, t._closeTimeout = n.closeTimeout, !He.includes(n.protocolVersion))
          throw new RangeError(`Unsupported protocol version: ${n.protocolVersion} (supported versions: ${He.join(", ")})`);
        let i;
        if (e instanceof Ve)
          i = e;
        else
          try {
            i = new Ve(e);
          } catch {
            throw new SyntaxError(`Invalid URL: ${e}`);
          }
        i.protocol === "http:" ? i.protocol = "ws:" : i.protocol === "https:" && (i.protocol = "wss:"), t._url = i.href;
        let o = i.protocol === "wss:", l = i.protocol === "ws+unix:", f;
        if (i.protocol !== "ws:" && !o && !l ? f = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"` : l && !i.pathname ? f = "The URL's pathname is empty" : i.hash && (f = "The URL contains a fragment identifier"), f) {
          let u = new SyntaxError(f);
          if (t._redirects === 0)
            throw u;
          be(t, u);
          return;
        }
        let a = o ? 443 : 80, c = er(16).toString("base64"), h = o ? Js.request : Zs.request, p = /* @__PURE__ */ new Set(), _;
        if (n.createConnection = n.createConnection || (o ? _r : gr), n.defaultPort = n.defaultPort || a, n.port = i.port || a, n.host = i.hostname.startsWith("[") ? i.hostname.slice(1, -1) : i.hostname, n.headers = { ...n.headers, "Sec-WebSocket-Version": n.protocolVersion, "Sec-WebSocket-Key": c, Connection: "Upgrade", Upgrade: "websocket" }, n.path = i.pathname + i.search, n.timeout = n.handshakeTimeout, n.perMessageDeflate && (_ = new D({ ...n.perMessageDeflate, isServer: false, maxPayload: n.maxPayload }), n.headers["Sec-WebSocket-Extensions"] = hr({ [D.extensionName]: _.offer() })), s.length) {
          for (let u of s) {
            if (typeof u != "string" || !pr.test(u) || p.has(u))
              throw new SyntaxError("An invalid or duplicated subprotocol was specified");
            p.add(u);
          }
          n.headers["Sec-WebSocket-Protocol"] = s.join(",");
        }
        if (n.origin && (n.protocolVersion < 13 ? n.headers["Sec-WebSocket-Origin"] = n.origin : n.headers.Origin = n.origin), (i.username || i.password) && (n.auth = `${i.username}:${i.password}`), l) {
          let u = n.path.split(":");
          n.socketPath = u[0], n.path = u[1];
        }
        let m;
        if (n.followRedirects) {
          if (t._redirects === 0) {
            t._originalIpc = l, t._originalSecure = o, t._originalHostOrSocketPath = l ? n.socketPath : i.host;
            let u = r && r.headers;
            if (r = { ...r, headers: {} }, u)
              for (let [y, R] of Object.entries(u))
                r.headers[y.toLowerCase()] = R;
          } else if (t.listenerCount("redirect") === 0) {
            let u = l ? t._originalIpc ? n.socketPath === t._originalHostOrSocketPath : false : t._originalIpc ? false : i.host === t._originalHostOrSocketPath;
            (!u || t._originalSecure && !o) && (delete n.headers.authorization, delete n.headers.cookie, u || delete n.headers.host, n.auth = void 0);
          }
          n.auth && !r.headers.authorization && (r.headers.authorization = "Basic " + Buffer.from(n.auth).toString("base64")), m = t._req = h(n), t._redirects && t.emit("redirect", t.url, m);
        } else
          m = t._req = h(n);
        n.timeout && m.on("timeout", () => {
          w(t, m, "Opening handshake has timed out");
        }), m.on("error", (u) => {
          m === null || m[Mt] || (m = t._req = null, be(t, u));
        }), m.on("response", (u) => {
          let y = u.headers.location, R = u.statusCode;
          if (y && n.followRedirects && R >= 300 && R < 400) {
            if (++t._redirects > n.maxRedirects) {
              w(t, m, "Maximum redirects exceeded");
              return;
            }
            m.abort();
            let d;
            try {
              d = new Ve(y, e);
            } catch {
              let q = new SyntaxError(`Invalid URL: ${y}`);
              be(t, q);
              return;
            }
            Dt(t, d, s, r);
          } else
            t.emit("unexpected-response", m, u) || w(t, m, `Unexpected server response: ${u.statusCode}`);
        }), m.on("upgrade", (u, y, R) => {
          if (t.emit("upgrade", u), t.readyState !== g.CONNECTING)
            return;
          m = t._req = null;
          let d = u.headers.upgrade;
          if (d === void 0 || d.toLowerCase() !== "websocket") {
            w(t, y, "Invalid Upgrade header");
            return;
          }
          let Ce = tr("sha1").update(c + or).digest("base64");
          if (u.headers["sec-websocket-accept"] !== Ce) {
            w(t, y, "Invalid Sec-WebSocket-Accept header");
            return;
          }
          let q = u.headers["sec-websocket-protocol"], C;
          if (q !== void 0 ? p.size ? p.has(q) || (C = "Server sent an invalid subprotocol") : C = "Server sent a subprotocol but none was requested" : p.size && (C = "Server sent no subprotocol"), C) {
            w(t, y, C);
            return;
          }
          q && (t._protocol = q);
          let E = u.headers["sec-websocket-extensions"];
          if (E !== void 0) {
            if (!_) {
              w(t, y, "Server sent a Sec-WebSocket-Extensions header but no extension was requested");
              return;
            }
            let x;
            try {
              x = ur(E);
            } catch {
              w(t, y, "Invalid Sec-WebSocket-Extensions header");
              return;
            }
            let H = Object.keys(x);
            if (H.length !== 1 || H[0] !== D.extensionName) {
              w(t, y, "Server indicated an extension that was not requested");
              return;
            }
            try {
              _.accept(x[D.extensionName]);
            } catch {
              w(t, y, "Invalid Sec-WebSocket-Extensions header");
              return;
            }
            t._extensions[D.extensionName] = _;
          }
          t.setSocket(y, R, { allowSynchronousEvents: n.allowSynchronousEvents, generateMask: n.generateMask, maxBufferedChunks: n.maxBufferedChunks, maxFragments: n.maxFragments, maxPayload: n.maxPayload, skipUTF8Validation: n.skipUTF8Validation });
        }), n.finishRequest ? n.finishRequest(m, t) : m.end();
      }
      function be(t, e) {
        t._readyState = g.CLOSING, t._errorEmitted = true, t.emit("error", e), t.emitClose();
      }
      function gr(t) {
        return t.path = t.socketPath, It.connect(t);
      }
      function _r(t) {
        return t.path = void 0, !t.servername && t.servername !== "" && (t.servername = It.isIP(t.host) ? "" : t.host), Qs.connect(t);
      }
      function w(t, e, s) {
        t._readyState = g.CLOSING;
        let r = new Error(s);
        Error.captureStackTrace(r, w), e.setHeader ? (e[Mt] = true, e.abort(), e.socket && !e.socket.destroyed && e.socket.destroy(), process.nextTick(be, t, r)) : (e.destroy(r), e.once("error", t.emit.bind(t, "error")), e.once("close", t.emitClose.bind(t)));
      }
      function Ye(t, e, s) {
        if (e) {
          let r = nr(e) ? e.size : dr(e).length;
          t._socket ? t._sender._bufferedBytes += r : t._bufferedAmount += r;
        }
        if (s) {
          let r = new Error(`WebSocket is not open: readyState ${t.readyState} (${I[t.readyState]})`);
          process.nextTick(s, r);
        }
      }
      function mr(t, e) {
        let s = this[S];
        s._closeFrameReceived = true, s._closeMessage = e, s._closeCode = t, s._socket[S] !== void 0 && (s._socket.removeListener("data", we), process.nextTick(Ut, s._socket), t === 1005 ? s.close() : s.close(t, e));
      }
      function yr() {
        let t = this[S];
        t.isPaused || t._socket.resume();
      }
      function Sr(t) {
        let e = this[S];
        e._socket[S] !== void 0 && (e._socket.removeListener("data", we), process.nextTick(Ut, e._socket), e.close(t[lr])), e._errorEmitted || (e._errorEmitted = true, e.emit("error", t));
      }
      function Bt() {
        this[S].emitClose();
      }
      function Er(t, e) {
        this[S].emit("message", t, e);
      }
      function xr(t) {
        let e = this[S];
        e._autoPong && e.pong(t, !this._isServer, Rt), e.emit("ping", t);
      }
      function br(t) {
        this[S].emit("pong", t);
      }
      function Ut(t) {
        t.resume();
      }
      function wr(t) {
        let e = this[S];
        e.readyState !== g.CLOSED && (e.readyState === g.OPEN && (e._readyState = g.CLOSING, Ft(e)), this._socket.end(), e._errorEmitted || (e._errorEmitted = true, e.emit("error", t)));
      }
      function Ft(t) {
        t._closeTimer = setTimeout(t._socket.destroy.bind(t._socket), t._closeTimeout);
      }
      function qt() {
        let t = this[S];
        if (this.removeListener("close", qt), this.removeListener("data", we), this.removeListener("end", Wt), t._readyState = g.CLOSING, !this._readableState.endEmitted && !t._closeFrameReceived && !t._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
          let e = this.read(this._readableState.length);
          t._receiver.write(e);
        }
        t._receiver.end(), this[S] = void 0, clearTimeout(t._closeTimer), t._receiver._writableState.finished || t._receiver._writableState.errorEmitted ? t.emitClose() : (t._receiver.on("error", Bt), t._receiver.on("finish", Bt));
      }
      function we(t) {
        this[S]._receiver.write(t) || this.pause();
      }
      function Wt() {
        let t = this[S];
        t._readyState = g.CLOSING, t._receiver.end(), this.end();
      }
      function $t() {
        let t = this[S];
        this.removeListener("error", $t), this.on("error", Rt), t && (t._readyState = g.CLOSING, this.destroy());
      }
    });
    var Ht = b((Cn, zt) => {
      "use strict";
      var Ln = Te(), { Duplex: Tr } = require("stream");
      function Gt(t) {
        t.emit("close");
      }
      function vr() {
        !this.destroyed && this._writableState.finished && this.destroy();
      }
      function Vt(t) {
        this.removeListener("error", Vt), this.destroy(), this.listenerCount("error") === 0 && this.emit("error", t);
      }
      function kr(t, e) {
        let s = true, r = new Tr({ ...e, autoDestroy: false, emitClose: false, objectMode: false, writableObjectMode: false });
        return t.on("message", function(i, o) {
          let l = !o && r._readableState.objectMode ? i.toString() : i;
          r.push(l) || t.pause();
        }), t.once("error", function(i) {
          r.destroyed || (s = false, r.destroy(i));
        }), t.once("close", function() {
          r.destroyed || r.push(null);
        }), r._destroy = function(n, i) {
          if (t.readyState === t.CLOSED) {
            i(n), process.nextTick(Gt, r);
            return;
          }
          let o = false;
          t.once("error", function(f) {
            o = true, i(f);
          }), t.once("close", function() {
            o || i(n), process.nextTick(Gt, r);
          }), s && t.terminate();
        }, r._final = function(n) {
          if (t.readyState === t.CONNECTING) {
            t.once("open", function() {
              r._final(n);
            });
            return;
          }
          t._socket !== null && (t._socket._writableState.finished ? (n(), r._readableState.endEmitted && r.destroy()) : (t._socket.once("finish", function() {
            n();
          }), t.close()));
        }, r._read = function() {
          t.isPaused && t.resume();
        }, r._write = function(n, i, o) {
          if (t.readyState === t.CONNECTING) {
            t.once("open", function() {
              r._write(n, i, o);
            });
            return;
          }
          t.send(n, o);
        }, r.on("end", vr), r.on("error", Vt), r;
      }
      zt.exports = kr;
    });
    var Ke = b((Pn, Yt) => {
      "use strict";
      var { tokenChars: Or } = Z();
      function Lr(t) {
        let e = /* @__PURE__ */ new Set(), s = -1, r = -1, n = 0;
        for (n; n < t.length; n++) {
          let o = t.charCodeAt(n);
          if (r === -1 && Or[o] === 1)
            s === -1 && (s = n);
          else if (n !== 0 && (o === 32 || o === 9))
            r === -1 && s !== -1 && (r = n);
          else if (o === 44) {
            if (s === -1)
              throw new SyntaxError(`Unexpected character at index ${n}`);
            r === -1 && (r = n);
            let l = t.slice(s, r);
            if (e.has(l))
              throw new SyntaxError(`The "${l}" subprotocol is duplicated`);
            e.add(l), s = r = -1;
          } else
            throw new SyntaxError(`Unexpected character at index ${n}`);
        }
        if (s === -1 || r !== -1)
          throw new SyntaxError("Unexpected end of input");
        let i = t.slice(s, n);
        if (e.has(i))
          throw new SyntaxError(`The "${i}" subprotocol is duplicated`);
        return e.add(i), e;
      }
      Yt.exports = { parse: Lr };
    });
    var ts = b((An, es) => {
      "use strict";
      var Cr = require("events"), ve = require("http"), { Duplex: Nn } = require("stream"), { createHash: Pr } = require("crypto"), Kt = Ee(), G = J(), Nr = Ke(), Ar = Te(), { CLOSE_TIMEOUT: Br, GUID: Ir, kWebSocket: Rr } = N(), Mr = /^[+/0-9A-Za-z]{22}==$/, Xt = 0, Jt = 1, Qt = 2, Xe = class extends Cr {
        constructor(e, s) {
          if (super(), e = { allowSynchronousEvents: true, autoPong: true, maxBufferedChunks: 256 * 1024, maxFragments: 16 * 1024, maxPayload: 100 * 1024 * 1024, skipUTF8Validation: false, perMessageDeflate: false, handleProtocols: null, clientTracking: true, closeTimeout: Br, verifyClient: null, noServer: false, backlog: null, server: null, host: null, path: null, port: null, WebSocket: Ar, ...e }, e.port == null && !e.server && !e.noServer || e.port != null && (e.server || e.noServer) || e.server && e.noServer)
            throw new TypeError('One and only one of the "port", "server", or "noServer" options must be specified');
          if (e.port != null ? (this._server = ve.createServer((r, n) => {
            let i = ve.STATUS_CODES[426];
            n.writeHead(426, { "Content-Length": i.length, "Content-Type": "text/plain" }), n.end(i);
          }), this._server.listen(e.port, e.host, e.backlog, s)) : e.server && (this._server = e.server), this._server) {
            let r = this.emit.bind(this, "connection");
            this._removeListeners = Dr(this._server, { listening: this.emit.bind(this, "listening"), error: this.emit.bind(this, "error"), upgrade: (n, i, o) => {
              this.handleUpgrade(n, i, o, r);
            } });
          }
          e.perMessageDeflate === true && (e.perMessageDeflate = {}), e.clientTracking && (this.clients = /* @__PURE__ */ new Set(), this._shouldEmitClose = false), this.options = e, this._state = Xt;
        }
        address() {
          if (this.options.noServer)
            throw new Error('The server is operating in "noServer" mode');
          return this._server ? this._server.address() : null;
        }
        close(e) {
          if (this._state === Qt) {
            e && this.once("close", () => {
              e(new Error("The server is not running"));
            }), process.nextTick(fe, this);
            return;
          }
          if (e && this.once("close", e), this._state !== Jt)
            if (this._state = Jt, this.options.noServer || this.options.server)
              this._server && (this._removeListeners(), this._removeListeners = this._server = null), this.clients ? this.clients.size ? this._shouldEmitClose = true : process.nextTick(fe, this) : process.nextTick(fe, this);
            else {
              let s = this._server;
              this._removeListeners(), this._removeListeners = this._server = null, s.close(() => {
                fe(this);
              });
            }
        }
        shouldHandle(e) {
          if (this.options.path) {
            let s = e.url.indexOf("?");
            if ((s !== -1 ? e.url.slice(0, s) : e.url) !== this.options.path)
              return false;
          }
          return true;
        }
        handleUpgrade(e, s, r, n) {
          s.on("error", Zt);
          let i = e.headers["sec-websocket-key"], o = e.headers.upgrade, l = +e.headers["sec-websocket-version"];
          if (e.method !== "GET") {
            V(this, e, s, 405, "Invalid HTTP method");
            return;
          }
          if (o === void 0 || o.toLowerCase() !== "websocket") {
            V(this, e, s, 400, "Invalid Upgrade header");
            return;
          }
          if (i === void 0 || !Mr.test(i)) {
            V(this, e, s, 400, "Missing or invalid Sec-WebSocket-Key header");
            return;
          }
          if (l !== 13 && l !== 8) {
            V(this, e, s, 400, "Missing or invalid Sec-WebSocket-Version header", { "Sec-WebSocket-Version": "13, 8" });
            return;
          }
          if (!this.shouldHandle(e)) {
            ce(s, 400);
            return;
          }
          let f = e.headers["sec-websocket-protocol"], a = /* @__PURE__ */ new Set();
          if (f !== void 0)
            try {
              a = Nr.parse(f);
            } catch {
              V(this, e, s, 400, "Invalid Sec-WebSocket-Protocol header");
              return;
            }
          let c = e.headers["sec-websocket-extensions"], h = {};
          if (this.options.perMessageDeflate && c !== void 0) {
            let p = new G({ ...this.options.perMessageDeflate, isServer: true, maxPayload: this.options.maxPayload });
            try {
              let _ = Kt.parse(c);
              _[G.extensionName] && (p.accept(_[G.extensionName]), h[G.extensionName] = p);
            } catch {
              V(this, e, s, 400, "Invalid or unacceptable Sec-WebSocket-Extensions header");
              return;
            }
          }
          if (this.options.verifyClient) {
            let p = { origin: e.headers[`${l === 8 ? "sec-websocket-origin" : "origin"}`], secure: !!(e.socket.authorized || e.socket.encrypted), req: e };
            if (this.options.verifyClient.length === 2) {
              this.options.verifyClient(p, (_, m, u, y) => {
                if (!_)
                  return ce(s, m || 401, u, y);
                this.completeUpgrade(h, i, a, e, s, r, n);
              });
              return;
            }
            if (!this.options.verifyClient(p))
              return ce(s, 401);
          }
          this.completeUpgrade(h, i, a, e, s, r, n);
        }
        completeUpgrade(e, s, r, n, i, o, l) {
          if (!i.readable || !i.writable)
            return i.destroy();
          if (i[Rr])
            throw new Error("server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration");
          if (this._state > Xt)
            return ce(i, 503);
          let a = ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${Pr("sha1").update(s + Ir).digest("base64")}`], c = new this.options.WebSocket(null, void 0, this.options);
          if (r.size) {
            let h = this.options.handleProtocols ? this.options.handleProtocols(r, n) : r.values().next().value;
            h && (a.push(`Sec-WebSocket-Protocol: ${h}`), c._protocol = h);
          }
          if (e[G.extensionName]) {
            let h = e[G.extensionName].params, p = Kt.format({ [G.extensionName]: [h] });
            a.push(`Sec-WebSocket-Extensions: ${p}`), c._extensions = e;
          }
          this.emit("headers", a, n), i.write(a.concat(`\r
`).join(`\r
`)), i.removeListener("error", Zt), c.setSocket(i, o, { allowSynchronousEvents: this.options.allowSynchronousEvents, maxBufferedChunks: this.options.maxBufferedChunks, maxFragments: this.options.maxFragments, maxPayload: this.options.maxPayload, skipUTF8Validation: this.options.skipUTF8Validation }), this.clients && (this.clients.add(c), c.on("close", () => {
            this.clients.delete(c), this._shouldEmitClose && !this.clients.size && process.nextTick(fe, this);
          })), l(c, n);
        }
      };
      es.exports = Xe;
      function Dr(t, e) {
        for (let s of Object.keys(e))
          t.on(s, e[s]);
        return function() {
          for (let r of Object.keys(e))
            t.removeListener(r, e[r]);
        };
      }
      function fe(t) {
        t._state = Qt, t.emit("close");
      }
      function Zt() {
        this.destroy();
      }
      function ce(t, e, s, r) {
        s = s || ve.STATUS_CODES[e], r = { Connection: "close", "Content-Type": "text/html", "Content-Length": Buffer.byteLength(s), ...r }, t.once("finish", t.destroy), t.end(`HTTP/1.1 ${e} ${ve.STATUS_CODES[e]}\r
` + Object.keys(r).map((n) => `${n}: ${r[n]}`).join(`\r
`) + `\r
\r
` + s);
      }
      function V(t, e, s, r, n, i) {
        if (t.listenerCount("wsClientError")) {
          let o = new Error(n);
          Error.captureStackTrace(o, V), t.emit("wsClientError", o, s, e);
        } else
          ce(s, r, n, i);
      }
    });
    var dn = {};
    _s(dn, { PagesAI: () => Le, buildApiMeta: () => on });
    module.exports = ms(dn);
    var Ur = P(Ht(), 1), Fr = P(Ee(), 1), qr = P(J(), 1), Wr = P(qe(), 1), $r = P(je(), 1), jr = P(Ke(), 1), ss = P(Te(), 1), Gr = P(ts(), 1);
    var rs = ss.default;
    var Vr = "https://pages-api.cloud.tencent.com", zr = "https://pages-api.edgeone.ai", Hr = [Vr, zr], ke = "/v1", Oe = class {
      baseUrl;
      baseSelectionPromise;
      apiToken;
      defaultEngineModelType;
      defaultTtsVoiceId;
      appId;
      requestMeta;
      baseCandidates;
      debugLog;
      constructor(e) {
        if (!e.apiToken)
          throw new Error("PAGES_API_TOKEN is required");
        this.baseUrl = null, this.baseSelectionPromise = null, this.apiToken = e.apiToken.trim(), this.defaultEngineModelType = e.defaultEngineModelType, this.defaultTtsVoiceId = e.defaultTtsVoiceId, this.appId = e.appId, this.requestMeta = e.requestMeta || {}, this.baseCandidates = Xr(e.baseUrls), this.debugLog = typeof e.debugLog == "function" ? e.debugLog : null;
      }
      async signAsr(e = {}) {
        var _a2;
        let s = await this.request(ke, { Action: "SignPagesAiAsr", EngineModelType: e.engineModelType || this.defaultEngineModelType, VoiceId: e.voiceId, ApiToken: this.apiToken, ...this.requestMeta, ...this.appId !== void 0 ? { AppId: this.appId } : {} });
        if (!((_a2 = s == null ? void 0 : s.Asr) == null ? void 0 : _a2.websocketUrl)) {
          let r = is(s);
          throw new Error(`ASR signature response is invalid${r ? `: ${r}` : ""}`);
        }
        return s.Asr;
      }
      async signTts(e, s = {}) {
        var _a2, _b, _c;
        let r = (e || "").trim();
        if (!r)
          throw new Error("TTS text is empty");
        let n = await this.request(ke, { Action: "SignPagesAiTts", ApiToken: this.apiToken, VoiceId: s.voiceId || this.defaultTtsVoiceId, Text: r, ...this.requestMeta, ...this.appId !== void 0 ? { AppId: this.appId } : {} });
        if (!((_a2 = n.Tts) == null ? void 0 : _a2.headers) || !((_b = n.Tts) == null ? void 0 : _b.endpoint) || !((_c = n.Tts) == null ? void 0 : _c.payload)) {
          let i = is(n);
          throw new Error(`TTS signature response is invalid${i ? `: ${i}` : ""}`);
        }
        return n.Tts;
      }
      async completeLlm(e) {
        var _a2;
        let r = (_a2 = await this.callLlmEndpoint({ ApiToken: this.apiToken, ...this.requestMeta, ...this.appId !== void 0 ? { AppId: this.appId } : {}, Messages: e })) == null ? void 0 : _a2.Content;
        if (typeof r != "string" || !r.trim())
          throw new Error("LLM response missing content");
        return r;
      }
      async callLlmEndpoint(e) {
        return this.request(ke, { ...e, Action: "CompletePagesAiLlm" });
      }
      async request(e, s) {
        let r = await this.ensureBaseUrl(), n = new URL(e, r), i;
        U(this.debugLog, "pages-ai:http:request", { url: n.toString(), payload: s, headers: { "Content-Type": "application/json", Authorization: Jr(`Bearer ${this.apiToken}`) } });
        try {
          i = await fetch(n.toString(), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiToken}` }, body: JSON.stringify(s) });
        } catch (a) {
          throw U(this.debugLog, "pages-ai:http:error", { url: n.toString(), error: (a == null ? void 0 : a.message) || String(a) }), new Error((a == null ? void 0 : a.message) || String(a));
        }
        let o = await i.text();
        U(this.debugLog, "pages-ai:http:response", { url: n.toString(), status: i.status, statusText: i.statusText, headers: os(i.headers), body: o });
        let l = {};
        try {
          l = o ? JSON.parse(o) : {};
        } catch {
          l = {};
        }
        let f = Yr(l);
        if (!i.ok) {
          let a = Kr(f) || i.statusText || "Request failed";
          throw new Error(`[${i.status}] ${a}`);
        }
        return f || {};
      }
      async ensureBaseUrl() {
        if (this.baseUrl)
          return this.baseUrl;
        if (this.baseSelectionPromise)
          return this.baseSelectionPromise;
        this.baseSelectionPromise = this.detectBaseUrl();
        try {
          let e = await this.baseSelectionPromise;
          return this.baseUrl = e, e;
        } finally {
          this.baseSelectionPromise = null;
        }
      }
      async detectBaseUrl() {
        U(this.debugLog, "pages-ai:http:detect-base", { candidates: this.baseCandidates });
        let e = await Promise.all(this.baseCandidates.map((n) => this.probeBase(n))), s = e.find((n) => n.ok);
        if (U(this.debugLog, "pages-ai:http:detect-base:result", { probes: e, winner: (s == null ? void 0 : s.base) || null }), s == null ? void 0 : s.base)
          return s.base;
        let r = e.map((n) => `${n.base}: ${n.reason || "Unknown error"}`).join("; ");
        throw new Error(`All endpoints failed: ${r}`);
      }
      async probeBase(e) {
        let s = new URL(ke, e);
        U(this.debugLog, "pages-ai:http:probe:request", { base: e, url: s.toString() });
        try {
          let r = await fetch(s.toString(), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiToken}` }, body: JSON.stringify({ Action: "TokenPing" }) }), n = await r.text();
          U(this.debugLog, "pages-ai:http:probe:response", { base: e, status: r.status, statusText: r.statusText, headers: os(r.headers), body: n });
          let i = {};
          try {
            i = n ? JSON.parse(n) : {};
          } catch {
            i = {};
          }
          if (!r.ok)
            return { base: e, ok: false, reason: `[${r.status}] ${r.statusText || "Request failed"}` };
          let o = (i == null ? void 0 : i.Code) ?? (i == null ? void 0 : i.code), l = (i == null ? void 0 : i.Message) ?? (i == null ? void 0 : i.message) ?? "";
          if (o === 109 || typeof l == "string" && l.toLowerCase().includes("region")) {
            let a = [o, l].filter(Boolean).join(": ");
            return { base: e, ok: false, reason: a || "Token not allowed for this region" };
          }
          return { base: e, ok: true };
        } catch (r) {
          return U(this.debugLog, "pages-ai:http:probe:error", { base: e, url: s.toString(), error: (r == null ? void 0 : r.message) || String(r) }), { base: e, ok: false, reason: (r == null ? void 0 : r.message) || String(r) };
        }
      }
    };
    function ns(t) {
      let e = (t || "").trim(), s = e && /^[a-z]+:\/\//i.test(e) ? e : `https://${e}`;
      return s.endsWith("/") ? s : `${s}/`;
    }
    function Yr(t) {
      if (t && typeof t == "object") {
        if (t.Data && typeof t.Data == "object")
          return t.Data.Response && typeof t.Data.Response == "object" ? t.Data.Response : t.Data;
        if (t.Response && typeof t.Response == "object")
          return t.Response;
      }
      return t || {};
    }
    function Kr(t) {
      if (!t || typeof t != "object")
        return "";
      let e = t.Error || t.error;
      return (e == null ? void 0 : e.Message) ? e.Message : typeof e == "string" ? e : t.message || t.Message || "";
    }
    function is(t) {
      try {
        return JSON.stringify(t);
      } catch {
        return "";
      }
    }
    function Xr(t) {
      let e = Hr.map(ns), s = (t || []).map(ns).filter((i) => !!i), r = /* @__PURE__ */ new Set(), n = [];
      return [...s, ...e].forEach((i) => {
        !i || r.has(i) || (r.add(i), n.push(i));
      }), n.length ? n : e;
    }
    function U(t, e, s) {
      if (t)
        try {
          t(e, s);
        } catch {
        }
    }
    function Jr(t) {
      if (!t)
        return t;
      let e = Math.min(6, Math.floor(t.length / 3));
      return `${t.slice(0, e)}***${t.slice(-e)}`;
    }
    function os(t) {
      if (!t)
        return {};
      if (typeof t.entries == "function")
        return Array.from(t.entries()).reduce((r, [n, i]) => (r[n] = i, r), {});
      let e = {};
      return Object.entries(t).forEach(([s, r]) => {
        e[s.toLowerCase()] = r;
      }), e;
    }
    var Je = P(require("https")), Zr = Je.default.request.bind(Je.default);
    function as(t, e = {}, s = null) {
      let { endpoint: r, payload: n, headers: i } = t;
      if (!n)
        throw new Error("TTS payload missing");
      let { signal: o } = e;
      if (o == null ? void 0 : o.aborted)
        throw new Error("Aborted");
      let l = { ...i, "Content-Length": (i == null ? void 0 : i["Content-Length"]) ?? Buffer.byteLength(n) };
      F(s, "pages-ai:tts:sse:request", { endpoint: r, headers: l, payload: n });
      let f = null, a = false, c = null, h = [], p = null, _ = () => {
        p && (p(), p = null);
      }, m = (d) => {
        a || (h.push(d), _());
      }, u = () => {
        a || (a = true, _());
      }, y = (d) => {
        a || (c = d instanceof Error ? d : new Error(String(d)), a = true, _());
      }, R = { async next() {
        if (h.length)
          return { value: h.shift(), done: false };
        if (c)
          throw c;
        if (a)
          return { value: void 0, done: true };
        if (await new Promise((d) => {
          p = d;
        }), h.length)
          return { value: h.shift(), done: false };
        if (c)
          throw c;
        return { value: void 0, done: true };
      }, async return() {
        if (u(), f)
          try {
            f.destroy();
          } catch {
          }
        return { value: void 0, done: true };
      }, [Symbol.asyncIterator]() {
        return this;
      } };
      return f = Zr({ hostname: r, port: 443, path: "/", method: "POST", signal: o, headers: l }, (d) => {
        if (F(s, "pages-ai:tts:sse:response", { endpoint: r, statusCode: d.statusCode, statusMessage: d.statusMessage, headers: d.headers }), !(d.headers["content-type"] || "").toLowerCase().includes("text/event-stream")) {
          let E = "";
          d.on("data", (x) => {
            E += x.toString();
          }), d.on("end", () => {
            var _a2, _b;
            let x = `TTS request failed with status ${d.statusCode ?? ""}`.trim();
            if (E)
              try {
                let k = (_b = (_a2 = JSON.parse(E)) == null ? void 0 : _a2.Response) == null ? void 0 : _b.Error;
                (k == null ? void 0 : k.Message) ? x = `${k.Code || "Error"}: ${k.Message}` : x = `${x}: ${E.slice(0, 200)}`;
              } catch {
                x = `${x}: ${E.slice(0, 200)}`;
              }
            F(s, "pages-ai:tts:sse:error-response", { endpoint: r, statusCode: d.statusCode, statusMessage: d.statusMessage, headers: d.headers, body: E }), y(new Error(x));
          }), d.on("error", y);
          return;
        }
        let C = "";
        d.on("data", (E) => {
          C += E.toString();
          let x = C.split(`
`);
          C = x.pop() || "";
          for (let H of x)
            if (H.startsWith("data:")) {
              let k = H.slice(5).trim();
              if (k)
                try {
                  m({ data: k }), F(s, "pages-ai:tts:sse:event", { endpoint: r, data: Qr(k) });
                } catch (Y) {
                  let cs = Y instanceof Error ? Y.message : String(Y);
                  console.error("\u89E3\u6790 SSE \u6570\u636E\u5931\u8D25:", cs);
                }
            }
        }), d.on("end", () => {
          F(s, "pages-ai:tts:sse:end", { endpoint: r }), u();
        }), d.on("error", (E) => {
          F(s, "pages-ai:tts:sse:error", { endpoint: r, message: E instanceof Error ? E.message : String(E) }), y(E);
        });
      }), f.on("error", (d) => {
        F(s, "pages-ai:tts:sse:request-error", { endpoint: r, message: d instanceof Error ? d.message : String(d) }), y(d);
      }), o && o.addEventListener("abort", () => {
        F(s, "pages-ai:tts:sse:aborted", { endpoint: r }), y(new Error("Aborted")), f == null ? void 0 : f.destroy(new Error("Aborted"));
      }, { once: true }), f.write(n), f.end(), R;
    }
    function F(t, e, s) {
      if (t)
        try {
          t(e, s);
        } catch {
        }
    }
    function Qr(t) {
      return !t || t.length <= 200 ? t : { preview: t.slice(0, 200), length: t.length };
    }
    var en = 251195406, tn = "16k_zh_en", sn = void 0, rn = ["https://pages-api.cloud.tencent.com", "https://pages-api.edgeone.ai"], ls = { Version: "2022-09-01", Region: "ch", Language: "zh", RequestId: "111", ClientIp: "1.1.1.1", ApiModule: "teo", RequestSource: "API", CamContext: "hall", AccountArea: "0", Uin: "100000043181", SubAccountUin: "100000043181", Timestamp: "111" }, fs = false, Le = (_a = class {
      constructor(e) {
        __publicField(this, "asr");
        __publicField(this, "llm");
        __publicField(this, "tts");
        __privateAdd(this, _e, void 0);
        __privateAdd(this, _t, void 0);
        if (!(e == null ? void 0 : e.apiToken))
          throw new Error("apiToken is required to initialize PagesAI");
        let s = nn(e), r = cn(s.debugLogger);
        __privateSet(this, _t, r), __privateSet(this, _e, new Oe({ apiToken: s.apiToken, defaultEngineModelType: s.engineModelType, defaultTtsVoiceId: s.ttsVoiceId, appId: s.appId, baseUrls: s.apiBaseUrls, requestMeta: s.apiMeta, debugLog: r })), this.asr = re(an(__privateGet(this, _e), r)), this.llm = re(ln(__privateGet(this, _e), r)), this.tts = re(fn(__privateGet(this, _e), r)), re(this);
      }
    }, _e = new WeakMap(), _t = new WeakMap(), _a);
    function nn(t) {
      return { apiToken: t.apiToken, engineModelType: tn, ttsVoiceId: sn, appId: en, apiBaseUrls: rn, apiMeta: ls, debugLogger: fs ? t.debugLogger : null };
    }
    function on() {
      return { ...ls };
    }
    function an(t, e) {
      return { async createSocket() {
        try {
          let s = await t.signAsr();
          z(e, "pages-ai:asr:sign", s);
          let r = new rs(s.websocketUrl, { perMessageDeflate: false, headers: s.headers });
          return r.on("open", () => z(e, "pages-ai:asr:socket:open", { url: s.websocketUrl })), r.on("close", (n, i) => {
            var _a2;
            return z(e, "pages-ai:asr:socket:close", { url: s.websocketUrl, code: n, reason: (_a2 = i == null ? void 0 : i.toString) == null ? void 0 : _a2.call(i) });
          }), r.on("error", (n) => z(e, "pages-ai:asr:socket:error", { url: s.websocketUrl, message: (n == null ? void 0 : n.message) || String(n) })), r.on("message", (n) => z(e, "pages-ai:asr:socket:message", { url: s.websocketUrl, message: hn(n) })), re({ socket: r, engineModelType: s.engineModelType, voiceId: s.voiceId });
        } catch (s) {
          let r = s instanceof Error ? s.message : String(s);
          throw new Error(`ASR runtime not configured: ${r}`);
        }
      } };
    }
    function ln(t, e) {
      return { async complete(s) {
        if (!Array.isArray(s) || !s.length)
          throw new Error("LLM messages are empty");
        return z(e, "pages-ai:llm:complete", { messages: s }), t.completeLlm(s);
      } };
    }
    function fn(t, e) {
      return { async synthesize(s, r = {}) {
        let n = (s || "").trim();
        if (!n)
          throw new Error("TTS text is empty");
        z(e, "pages-ai:tts:synthesize", { text: n });
        let i = await t.signTts(n);
        return as(i, { signal: r == null ? void 0 : r.signal }, e);
      } };
    }
    function re(t) {
      if (!t || typeof t != "object" || Object.isFrozen(t))
        return t;
      let e = Object.getPrototypeOf(t);
      return !(e === Object.prototype || e === null) && !Array.isArray(t) || (Object.freeze(t), Object.getOwnPropertyNames(t).forEach((r) => {
        let n = t[r];
        n && typeof n == "object" && !Object.isFrozen(n) && re(n);
      })), t;
    }
    function cn(t) {
      return fs && typeof t == "function" ? (e, s) => {
        try {
          t(e, s);
        } catch {
        }
      } : null;
    }
    function z(t, e, s) {
      t && t(e, s);
    }
    function hn(t) {
      return t == null || typeof t == "string" ? t : Buffer.isBuffer(t) ? { type: "buffer", length: t.length, preview: t.toString("utf8", 0, Math.min(128, t.length)) } : typeof t.toString == "function" ? t.toString() : t;
    }
    function un() {
      if (typeof globalThis > "u")
        return;
      let t = globalThis;
      t.PagesAI || Object.defineProperty(t, "PagesAI", { configurable: false, enumerable: false, writable: false, value: Le });
    }
    un();
  }
});
export default require_stdin();

var __getOwnPropNames = Object.getOwnPropertyNames;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined")
    return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// ../../../../node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "../../../../node_modules/ws/lib/constants.js"(exports, module) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob)
      BINARY_TYPES.push("blob");
    module.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: Symbol("kIsForOnEventAttribute"),
      kListener: Symbol("kListener"),
      kStatusCode: Symbol("status-code"),
      kWebSocket: Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// ../../../../node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "../../../../node_modules/ws/lib/buffer-util.js"(exports, module) {
    "use strict";
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0)
        return EMPTY_BUFFER;
      if (list.length === 1)
        return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length) {
      for (let i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data))
        return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = __require("bufferutil");
        module.exports.mask = function(source, mask, output, offset, length) {
          if (length < 48)
            _mask(source, mask, output, offset, length);
          else
            bufferUtil.mask(source, mask, output, offset, length);
        };
        module.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32)
            _unmask(buffer, mask);
          else
            bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// ../../../../node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "../../../../node_modules/ws/lib/limiter.js"(exports, module) {
    "use strict";
    var kDone = Symbol("kDone");
    var kRun = Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency)
          return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module.exports = Limiter;
  }
});

// ../../../../node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "../../../../node_modules/ws/lib/permessage-deflate.js"(exports, module) {
    "use strict";
    var zlib = __require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = Symbol("permessage-deflate");
    var kTotalLength = Symbol("total-length");
    var kCallback = Symbol("callback");
    var kBuffers = Symbol("buffers");
    var kError = Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {Boolean} [options.isServer=false] Create the instance in either
       *     server or client mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       */
      constructor(options) {
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._maxPayload = this._options.maxPayload | 0;
        this._isServer = !!this._options.isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && (typeof params.client_max_window_bits === "number" ? opts.clientMaxWindowBits > params.client_max_window_bits : !params.client_max_window_bits)) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key) => {
            let value = params[key];
            if (value.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value = value[0];
            if (key === "client_max_window_bits") {
              if (value !== true) {
                const num = +value;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value}`
                  );
                }
                value = num;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num = +value;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
              value = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params[key] = value;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin)
          this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module.exports = PerMessageDeflate;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// ../../../../node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "../../../../node_modules/ws/lib/validation.js"(exports, module) {
    "use strict";
    var { isUtf8 } = __require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value) {
      return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
    }
    module.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = __require("utf-8-validate");
        module.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// ../../../../node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "../../../../node_modules/ws/lib/receiver.js"(exports, module) {
    "use strict";
    var { Writable } = __require("stream");
    var PerMessageDeflate = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxBufferedChunks = options.maxBufferedChunks | 0;
        this._maxFragments = options.maxFragments | 0;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._numFragments = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO)
          return cb();
        if (this._maxBufferedChunks > 0 && this._buffers.length >= this._maxBufferedChunks) {
          cb(
            this.createError(
              RangeError,
              "Too many buffered chunks",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            )
          );
          return;
        }
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length)
          return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored)
          cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented)
          this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126)
          this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127)
          this._state = GET_PAYLOAD_LENGTH_64;
        else
          this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked)
          this._state = GET_MASK;
        else
          this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._maxFragments > 0 && ++this._numFragments > this._maxFragments) {
          const error = this.createError(
            RangeError,
            "Too many message fragments",
            false,
            1008,
            "WS_ERR_TOO_MANY_BUFFERED_PARTS"
          );
          cb(error);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err)
            return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO)
            this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._numFragments = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module.exports = Receiver;
  }
});

// ../../../../node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "../../../../node_modules/ws/lib/sender.js"(exports, module) {
    "use strict";
    var { Duplex } = __require("stream");
    var { randomFillSync } = __require("crypto");
    var {
      types: { isUint8Array }
    } = __require("util");
    var PerMessageDeflate = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1)
          target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask)
          return [target, data];
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (skipMasking)
          return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else if (isUint8Array(data)) {
            buf.set(data, 2);
          } else {
            throw new TypeError("Second argument must be a string or a Uint8Array");
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin)
          this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module.exports = Sender;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function")
        cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function")
          callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// ../../../../node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "../../../../node_modules/ws/lib/event-target.js"(exports, module) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = Symbol("kCode");
    var kData = Symbol("kData");
    var kError = Symbol("kError");
    var kMessage = Symbol("kMessage");
    var kReason = Symbol("kReason");
    var kTarget = Symbol("kTarget");
    var kType = Symbol("kType");
    var kWasClean = Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// ../../../../node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "../../../../node_modules/ws/lib/extension.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0)
        dest[name] = [elem];
      else
        dest[name].push(elem);
    }
    function parse(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1)
              start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1)
              end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1)
              end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1)
              start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1)
              end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1)
              end = i;
            push(params, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1)
              start = i;
            else if (!mustUnescape)
              mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1)
                start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1)
              start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1)
              end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1)
              end = i;
            let value = header.slice(start, end);
            if (mustUnescape) {
              value = value.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1)
        end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params);
      } else {
        if (paramName === void 0) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension) => {
        let configurations = extensions[extension];
        if (!Array.isArray(configurations))
          configurations = [configurations];
        return configurations.map((params) => {
          return [extension].concat(
            Object.keys(params).map((k) => {
              let values = params[k];
              if (!Array.isArray(values))
                values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module.exports = { format, parse };
  }
});

// ../../../../node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "../../../../node_modules/ws/lib/websocket.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var https = __require("https");
    var http2 = __require("http");
    var net2 = __require("net");
    var tls = __require("tls");
    var { randomBytes, createHash } = __require("crypto");
    var { Duplex, Readable } = __require("stream");
    var { URL: URL2 } = __require("url");
    var PerMessageDeflate = require_permessage_deflate();
    var Receiver = require_receiver();
    var Sender = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener, removeEventListener }
    } = require_event_target();
    var { format, parse } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket = class _WebSocket extends EventEmitter {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            protocols = [];
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              protocols = [];
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type))
          return;
        this._binaryType = type;
        if (this._receiver)
          this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket)
          return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxBufferedChunks: options.maxBufferedChunks,
          maxFragments: options.maxFragments,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout)
          socket.setTimeout(0);
        if (socket.setNoDelay)
          socket.setNoDelay();
        if (head.length > 0)
          socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate.extensionName]) {
          this._extensions[PerMessageDeflate.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED)
          return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._readyState = _WebSocket.CLOSING;
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err)
            return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number")
          data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0)
          mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number")
          data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0)
          mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain)
          this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number")
          data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED)
          return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute])
              return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function")
            return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket.prototype.addEventListener = addEventListener;
    WebSocket.prototype.removeEventListener = removeEventListener;
    module.exports = WebSocket;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxBufferedChunks: 256 * 1024,
        maxFragments: 16 * 1024,
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL2) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL2(address);
        } catch {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes(16).toString("base64");
      const request = isSecure ? https.request : http2.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate({
          ...opts.perMessageDeflate,
          isServer: false,
          maxPayload: opts.maxPayload
        });
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const parts = opts.path.split(":");
        opts.socketPath = parts[0];
        opts.path = parts[1];
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost)
              delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted])
          return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode;
        if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL2(location, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket.CONNECTING)
          return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt)
          websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxBufferedChunks: opts.maxBufferedChunks,
          maxFragments: opts.maxFragments,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net2.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net2.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket)
          websocket._sender._bufferedBytes += length;
        else
          websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0)
        return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005)
        websocket.close();
      else
        websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused)
        websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong)
        websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket.CLOSED)
        return;
      if (websocket.readyState === WebSocket.OPEN) {
        websocket._readyState = WebSocket.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket.CLOSING;
        this.destroy();
      }
    }
  }
});

// ../../../../node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "../../../../node_modules/ws/lib/stream.js"(exports, module) {
    "use strict";
    var WebSocket = require_websocket();
    var { Duplex } = __require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data))
          ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed)
          return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed)
          return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called)
            callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy)
          ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null)
          return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted)
            duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused)
          ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module.exports = createWebSocketStream;
  }
});

// ../../../../node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "../../../../node_modules/ws/lib/subprotocol.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1)
            start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1)
            end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1)
            end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module.exports = { parse };
  }
});

// ../../../../node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "../../../../node_modules/ws/lib/websocket-server.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var http2 = __require("http");
    var { Duplex } = __require("stream");
    var { createHash } = __require("crypto");
    var extension = require_extension();
    var PerMessageDeflate = require_permessage_deflate();
    var subprotocol = require_subprotocol();
    var WebSocket = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer = class extends EventEmitter {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxBufferedChunks=262144] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=16384] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxBufferedChunks: 256 * 1024,
          maxFragments: 16 * 1024,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http2.createServer((req, res) => {
            const body = http2.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true)
          options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server)
          return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb)
          this.once("close", cb);
        if (this._state === CLOSING)
          return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server2 = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server2.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname2 = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname2 !== this.options.path)
            return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate({
            ...this.options.perMessageDeflate,
            isServer: true,
            maxPayload: this.options.maxPayload
          });
          try {
            const offers = extension.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate.extensionName]);
              extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info))
            return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable)
          return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING)
          return abortHandshake(socket, 503);
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate.extensionName]) {
          const params = extensions[PerMessageDeflate.extensionName].params;
          const value = extension.format({
            [PerMessageDeflate.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxBufferedChunks: this.options.maxBufferedChunks,
          maxFragments: this.options.maxFragments,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module.exports = WebSocketServer;
    function addListeners(server2, map) {
      for (const event of Object.keys(map))
        server2.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server2.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server2) {
      server2._state = CLOSED;
      server2.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http2.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http2.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server2, req, socket, code, message, headers) {
      if (server2.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server2.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// ../../../../node_modules/ws/index.js
var require_ws = __commonJS({
  "../../../../node_modules/ws/index.js"(exports, module) {
    "use strict";
    var createWebSocketStream = require_stream();
    var extension = require_extension();
    var PerMessageDeflate = require_permessage_deflate();
    var Receiver = require_receiver();
    var Sender = require_sender();
    var subprotocol = require_subprotocol();
    var WebSocket = require_websocket();
    var WebSocketServer = require_websocket_server();
    WebSocket.createWebSocketStream = createWebSocketStream;
    WebSocket.extension = extension;
    WebSocket.PerMessageDeflate = PerMessageDeflate;
    WebSocket.Receiver = Receiver;
    WebSocket.Sender = Sender;
    WebSocket.Server = WebSocketServer;
    WebSocket.subprotocol = subprotocol;
    WebSocket.WebSocket = WebSocket;
    WebSocket.WebSocketServer = WebSocketServer;
    module.exports = WebSocket;
  }
});

// <stdin>
import http from "http";
import { default as net } from "net";
import dns from "dns/promises";
import { timingSafeEqual } from "crypto";
(async function() {
  var kvModule = { exports: {} };
  (function(module, exports) {
    var O = Object.create;
    var v = Object.defineProperty;
    var Y = Object.getOwnPropertyDescriptor;
    var F = Object.getOwnPropertyNames;
    var Z = Object.getPrototypeOf, X = Object.prototype.hasOwnProperty;
    var J = (r, e) => {
      for (var t in e)
        v(r, t, { get: e[t], enumerable: true });
    }, x = (r, e, t, n) => {
      if (e && typeof e == "object" || typeof e == "function")
        for (let o of F(e))
          !X.call(r, o) && o !== t && v(r, o, { get: () => e[o], enumerable: !(n = Y(e, o)) || n.enumerable });
      return r;
    };
    var W = (r, e, t) => (t = r != null ? O(Z(r)) : {}, x(e || !r || !r.__esModule ? v(t, "default", { value: r, enumerable: true }) : t, r)), q = (r) => x(v({}, "__esModule", { value: true }), r);
    var ne = {};
    J(ne, { bootstrap: () => re, createKVClient: () => S, getConfigs: () => M, initKVBindings: () => z });
    module.exports = q(ne);
    var k = W(__require("net"));
    var K = class {
      static encodeCommand(e) {
        let t = [];
        t.push(`*${e.length}\r
`);
        for (let n of e) {
          let o = Buffer.byteLength(n, "utf8");
          t.push("$" + o + `\r
` + n + `\r
`);
        }
        return t.join("");
      }
      static encodeCommandBuffer(e) {
        let t = [];
        t.push(Buffer.from(`*${e.length}\r
`));
        for (let n of e) {
          let o = typeof n == "string" ? Buffer.from(n, "utf8") : n;
          t.push(Buffer.from("$" + o.length + `\r
`)), t.push(o), t.push(Buffer.from(`\r
`));
        }
        return Buffer.concat(t);
      }
    }, w = class {
      buffer = "";
      append(e) {
        Buffer.isBuffer(e) ? this.buffer += e.toString("utf8") : this.buffer += e;
      }
      get bufferLength() {
        return this.buffer.length;
      }
      clear() {
        this.buffer = "";
      }
      parse() {
        var o;
        if (this.buffer.length === 0)
          return null;
        let e = this.buffer[0], t = this.buffer.indexOf(`\r
`);
        if (t === -1)
          return null;
        let n = this.buffer.substring(1, t);
        switch (e) {
          case "+":
            return this.buffer = this.buffer.substring(t + 2), { type: "simple_string", value: n };
          case "-":
            return this.buffer = this.buffer.substring(t + 2), { type: "error", value: n };
          case ":":
            return this.buffer = this.buffer.substring(t + 2), { type: "integer", value: parseInt(n, 10) };
          case "$":
            return this.parseBulkString(n, t);
          case "*":
            return this.parseArray(n, t);
          default: {
            let f = e.charCodeAt(0), a = this.buffer.substring(0, 100).replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t"), u = ((o = Buffer.from(this.buffer.substring(0, 20)).toString("hex").match(/.{1,2}/g)) == null ? void 0 : o.join(" ")) || "";
            throw new Error(`Unknown RESP type: '${e}' (char code: ${f}, hex: 0x${f.toString(16)})
Buffer length: ${this.buffer.length}
Buffer preview (first 100 chars): ${a}
Buffer hex (first 20 bytes): ${u}`);
          }
        }
      }
      parseBulkString(e, t) {
        let n = parseInt(e, 10);
        if (n === -1)
          return this.buffer = this.buffer.substring(t + 2), { type: "null", value: null };
        let o = t + 2, f = o + n, a = f + 2;
        if (this.buffer.length < a)
          return null;
        let u = this.buffer.substring(o, f);
        return this.buffer = this.buffer.substring(a), { type: "bulk_string", value: u };
      }
      parseArray(e, t) {
        let n = parseInt(e, 10);
        if (n === -1)
          return this.buffer = this.buffer.substring(t + 2), { type: "null", value: null };
        if (n === 0)
          return this.buffer = this.buffer.substring(t + 2), { type: "array", value: [] };
        let o = this.buffer;
        this.buffer = this.buffer.substring(t + 2);
        let f = [];
        for (let a = 0; a < n; a++) {
          let u = this.parse();
          if (u === null)
            return this.buffer = o, null;
          f.push(u);
        }
        return { type: "array", value: f };
      }
    };
    var R = "EO_KV_BINDINGS";
    var A = /^[a-zA-Z0-9_]+$/;
    var V = class {
      socket = null;
      decoder = new w();
      responseQueue = [];
      host;
      port;
      timeout;
      debug;
      connected = false;
      constructor(e) {
        this.host = e.host, this.port = e.port, this.timeout = e.timeout ?? 1e4, this.debug = e.debug ?? false;
      }
      log(e, ...t) {
        this.debug && console.log(`[RespConnection] ${e}`, ...t);
      }
      connect() {
        return new Promise((e, t) => {
          this.log("Connecting to KV service..."), this.socket = k.createConnection({ host: this.host, port: this.port }), this.socket.on("connect", () => {
            this.log("TCP connection established"), this.connected = true, e();
          }), this.socket.on("data", (n) => {
            this.decoder.append(n), this.processResponses();
          }), this.socket.on("error", (n) => {
            this.log(`Socket error: ${n.message}`), t(new Error("KV connection failed"));
          }), this.socket.on("close", (n) => {
            for (this.log(`Connection closed (hadError: ${n}, pending: ${this.responseQueue.length})`), this.connected = false; this.responseQueue.length > 0; ) {
              let { reject: o } = this.responseQueue.shift();
              o(new Error("Connection closed by server"));
            }
          }), this.socket.setTimeout(this.timeout, () => {
            this.log(`Connection timeout after ${this.timeout}ms`), t(new Error("KV connection timeout"));
          });
        });
      }
      processResponses() {
        let e;
        for (; (e = this.decoder.parse()) !== null; )
          if (this.responseQueue.length > 0) {
            let { resolve: t, reject: n } = this.responseQueue.shift();
            e.type === "error" ? n(new Error(e.value)) : t(e);
          }
      }
      sendCommand(e) {
        return new Promise((t, n) => {
          if (!this.socket || !this.connected) {
            n(new Error("Not connected"));
            return;
          }
          let o = K.encodeCommand(e);
          this.log(`Sending command: ${e[0]} (${o.length} bytes)`), this.responseQueue.push({ resolve: t, reject: n }), this.socket.write(o, (f) => {
            f && this.log(`Write error: ${f.message}`);
          });
        });
      }
      close() {
        this.socket && (this.socket.end(), this.socket = null), this.connected = false;
      }
    };
    function I(r) {
      if (!r || typeof r != "string")
        throw new Error("Key must be a non-empty string");
      let e = Buffer.byteLength(r, "utf-8");
      if (e > 512)
        throw new Error(`Key size exceeds maximum limit of ${512} bytes (got ${e} bytes)`);
      if (!A.test(r))
        throw new Error("Key can only contain letters, numbers, and underscores");
    }
    function L(r) {
      if (r.length > 26214400)
        throw new Error(`Value size exceeds maximum limit of ${26214400} bytes (${Math.round(26214400 / 1024 / 1024)} MB), got ${r.length} bytes`);
    }
    async function N(r) {
      if (typeof r == "string")
        return Buffer.from(r, "utf-8");
      if (r instanceof ArrayBuffer)
        return Buffer.from(r);
      if (ArrayBuffer.isView(r))
        return Buffer.from(r.buffer, r.byteOffset, r.byteLength);
      if (typeof ReadableStream < "u" && r instanceof ReadableStream) {
        let e = [], t = r.getReader();
        try {
          for (; ; ) {
            let { done: a, value: u } = await t.read();
            if (a)
              break;
            e.push(u);
          }
        } finally {
          t.releaseLock();
        }
        let n = e.reduce((a, u) => a + u.length, 0), o = new Uint8Array(n), f = 0;
        for (let a of e)
          o.set(a, f), f += a.length;
        return Buffer.from(o);
      }
      throw new Error(`Unsupported value type: ${typeof r}`);
    }
    function U(r, e) {
      switch (e) {
        case "json":
          try {
            return JSON.parse(r.toString("utf-8"));
          } catch {
            return r.toString("utf-8");
          }
        case "arrayBuffer":
          return r.buffer.slice(r.byteOffset, r.byteOffset + r.byteLength);
        case "stream": {
          let t = r;
          return new ReadableStream({ start(n) {
            n.enqueue(new Uint8Array(t)), n.close();
          } });
        }
        case "text":
        default:
          return r.toString("utf-8");
      }
    }
    function S(r, e) {
      let t = null, n = null, o = (e == null ? void 0 : e.debug) ?? false, f = `${r.userId}@${r.userKey}`, a = `/${r.namespace}/`, u = (s, ...i) => {
        o && console.log(`[KVClient] ${s}`, ...i);
      }, m = (s) => a + s, C = (s) => s.startsWith(a) ? s.substring(a.length) : s, D = async (s) => {
        u("Authenticating...");
        let i = await s.sendCommand(["AUTH", f]);
        if (i.type === "simple_string" && i.value === "OK")
          u("Authentication successful");
        else
          throw new Error("Authentication failed");
      }, Q = async (s) => {
        u("Selecting namespace...");
        let i = await s.sendCommand(["SELECT", r.namespace]);
        if (i.type === "simple_string" && i.value === "OK")
          u("Namespace selected");
        else
          throw new Error("Namespace selection failed");
      }, b = async () => {
        if (t && !t.connected && (t = null, n = null), t && t.connected)
          return t;
        if (n) {
          if (await n, t && t.connected)
            return t;
          t = null, n = null;
        }
        let s = typeof r.servicePort == "string" ? parseInt(r.servicePort, 10) : r.servicePort;
        return t = new V({ host: r.serviceName, port: s, timeout: e == null ? void 0 : e.timeout, debug: o }), n = (async () => {
          try {
            await t.connect(), await D(t), await Q(t);
          } catch (i) {
            throw t == null || t.close(), t = null, n = null, i;
          }
        })(), await n, t;
      }, j = (s) => {
        if (s.type === "null")
          return null;
        if (s.type === "array" && Array.isArray(s.value)) {
          let i = s.value;
          if (i.length > 0) {
            let l = i[0];
            return l.type === "null" ? null : Buffer.from(l.value, "utf-8");
          }
          return null;
        }
        return s.type === "bulk_string" ? Buffer.from(s.value, "utf-8") : null;
      };
      return { async get(s, i) {
        let l = await b(), c = m(s);
        u(`GET: ${c}`);
        let h = await l.sendCommand(["oget", c]), p = j(h);
        if (p === null)
          return null;
        let g = typeof i == "string" ? i : (i == null ? void 0 : i.type) ?? "text";
        return U(p, g);
      }, async put(s, i) {
        I(s);
        let l = await b(), c = m(s), h = await N(i);
        L(h);
        let p = h.toString("utf-8");
        u(`PUT: ${c} = ${p.substring(0, 100)}${p.length > 100 ? "..." : ""}`);
        let g = ["oset", c, p], d = await l.sendCommand(g);
        if (d.type !== "simple_string" || d.value !== "OK")
          throw new Error("PUT operation failed");
      }, async delete(s) {
        let i = await b(), l = m(s);
        u(`DELETE: ${l}`);
        let c = await i.sendCommand(["odel", l]);
        if (c.type === "error")
          throw new Error(`DELETE failed: ${c.value}`);
        u(`DELETE response: type=${c.type}, value=${c.value}`);
      }, async list(s) {
        var d, $, T;
        let i = await b(), l = (s == null ? void 0 : s.prefix) ?? "", c = (s == null ? void 0 : s.limit) ?? 10, h = m(l);
        u(`LIST: ${h}, limit: ${c}`);
        let p = ["list", h, "count", c.toString()];
        s != null && s.cursor && p.push("cursor", m(s.cursor));
        let g = await i.sendCommand(p);
        if (g.type === "array" && Array.isArray(g.value)) {
          let y = g.value;
          if (y.length >= 2) {
            let _ = { cursor: C(((d = y[0]) == null ? void 0 : d.value) || "") || void 0, complete: ((($ = y[1]) == null ? void 0 : $.value) || "").toLowerCase() === "true", keys: [] };
            for (let E = 2; E + 3 <= y.length; E += 3) {
              let G = { key: C(((T = y[E]) == null ? void 0 : T.value) || "") };
              _.keys.push(G);
            }
            return _;
          }
        }
        return { keys: [], complete: true };
      } };
    }
    function M() {
      let r = process.env[R];
      if (!r)
        return [];
      delete process.env[R];
      try {
        return JSON.parse(r);
      } catch {
        try {
          let e = Buffer.from(r, "base64").toString("utf-8");
          return JSON.parse(e);
        } catch {
          return [];
        }
      }
    }
    function z(r) {
      for (let e of r)
        globalThis[e.name] = S(e);
    }
    function re() {
      try {
        let r = M();
        r && r.length > 0 && (z(r), console.log(`[cli] Initialized ${r.length} KV binding(s)`));
      } catch {
        console.error("[cli] Initialization failed");
      }
    }
  })(kvModule, kvModule.exports);
  if (kvModule.exports.bootstrap) {
    await kvModule.exports.bootstrap();
  }
})();
var env = {
  "ProjectId": "makers-ups8kxpndc47",
  "NG_CLI_ANALYTICS": "false",
  "NUXT_TELEMETRY_DISABLED": "1",
  "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0",
  "COREPACK_ENABLE_STRICT": "0",
  "YARN_ENABLE_INTERACTIVE": "0",
  "NPM_CONFIG_YES": "true",
  "CI": "true",
  "TMPDIR": "/var/folders/0q/1hgpgp_169sf17dn3jxb3dcw0000gp/T/",
  "CLOUDPROXY_NODE_TOKEN": "c-MG1Rj47__18PZmXFtmKc8ZV5iD8p37XPZZUNzdwTg2U81jhY1G18vH73lY4TMO",
  "EDGEONE_PROJECT_ID": "makers-ups8kxpndc47",
  "PAGES_PROJECT_ID": "makers-ups8kxpndc47"
};
Object.assign(env, process.env || {});
delete env.TENCENTCLOUD_UIN;
delete env.TENCENTCLOUD_APPID;
function resolveAgentConversationId(_req) {
  return "";
}
function stripRequestSignal(request) {
  if (!request) {
    return request;
  }
  try {
    Object.defineProperty(request, "signal", {
      value: void 0,
      configurable: true
    });
  } catch {
  }
  return request;
}
function createCloudFunctionContext(options) {
  return {
    ...options.request ? { request: stripRequestSignal(options.request) } : {},
    env,
    params: options.params || {},
    uuid: options.req.headers["eo-log-uuid"] || "",
    server: {
      region: options.req.headers["x-scf-region"] || "",
      requestId: options.req.headers["x-scf-request-id"] || ""
    },
    clientIp: options.req.headers["eo-connecting-ip"] || "",
    geo: options.safeGeo
  };
}
function stripInternalRequestHeaders(req) {
  const rawRestricted = req.headers["x-cube-outer-flux-restricted"];
  const restrictedVal = Array.isArray(rawRestricted) ? rawRestricted[0] : rawRestricted;
  req.__edgeoneOuterFluxRestricted = typeof restrictedVal === "string" && restrictedVal.toLowerCase() === "true";
  for (const key in req.headers) {
    if (key.startsWith("x-scf-")) {
      delete req.headers[key];
    }
    if (key.startsWith("x-cube-")) {
      delete req.headers[key];
    }
  }
}
async function __edgeoneWithRestricted(req, fn) {
  const als = globalThis.__edgeoneRestrictedALS;
  if (!als)
    return fn();
  const store = {
    restricted: !!(req && req.__edgeoneOuterFluxRestricted),
    requestId: req && req.headers ? String(req.headers["x-scf-request-id"] || "") : ""
  };
  return als.run(store, fn);
}
function getResponsePassHeaders(context, _fallbackConversationId = "") {
  return {
    "functions-request-id": (context == null ? void 0 : context.server) ? context.server.requestId : ""
  };
}
try {
  process.removeAllListeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");
  process.on("uncaughtException", (error) => {
    console.error("Uncaught Exception:", error);
  });
  process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection:", reason);
  });
} catch (error) {
  console.error("Uncaught Exception:", error);
}
var port = 9e3;
var EdgeoneBodyParser = class {
  /**
   * Parse request body according to Content-Type, strictly following Edgeone rules
   * @param {Buffer} buffer Raw request body data
   * @param {string} contentType Content-Type header
   * @returns Parsed data
   */
  static parseBodyByContentType(buffer, contentType = "") {
    if (!buffer || buffer.length === 0) {
      return void 0;
    }
    const normalizedContentType = contentType.split(";")[0].trim().toLowerCase();
    switch (normalizedContentType) {
      case "application/json":
        try {
          const text = buffer.toString("utf-8");
          return JSON.parse(text);
        } catch (error) {
          throw new Error(`Invalid JSON in request body: ${error.message}`);
        }
      case "application/x-www-form-urlencoded":
        const formText = buffer.toString("utf-8");
        const params = new URLSearchParams(formText);
        const result = {};
        for (const [key, value] of params) {
          result[key] = value;
        }
        return result;
      case "text/plain":
        return buffer.toString("utf-8");
      case "application/octet-stream":
        return buffer;
      default:
        return buffer;
    }
  }
  /**
   * Parse URL query parameters
   * @param {string} url Full URL or query string
   * @returns {Object} Parsed query parameters object
   */
  static parseQuery(url) {
    if (!url)
      return {};
    const queryStart = url.indexOf("?");
    const queryString = queryStart >= 0 ? url.substring(queryStart + 1) : url;
    if (!queryString)
      return {};
    const params = {};
    const pairs = queryString.split("&");
    for (const pair of pairs) {
      if (!pair)
        continue;
      const equalIndex = pair.indexOf("=");
      let key, value;
      if (equalIndex === -1) {
        key = pair;
        value = true;
      } else if (equalIndex === 0) {
        continue;
      } else {
        key = pair.substring(0, equalIndex);
        value = pair.substring(equalIndex + 1);
        if (value === "") {
          value = "";
        }
      }
      if (key) {
        try {
          const decodedKey = decodeURIComponent(key);
          let decodedValue;
          if (typeof value === "boolean") {
            decodedValue = value;
          } else {
            decodedValue = decodeURIComponent(value);
            if (decodedValue === "true") {
              decodedValue = true;
            } else if (decodedValue === "false") {
              decodedValue = false;
            } else if (decodedValue === "null") {
              decodedValue = null;
            } else if (decodedValue === "undefined") {
              decodedValue = void 0;
            } else if (/^-?d+$/.test(decodedValue)) {
              const num = parseInt(decodedValue, 10);
              if (!isNaN(num) && num.toString() === decodedValue) {
                decodedValue = num;
              }
            } else if (/^-?d*.d+$/.test(decodedValue)) {
              const num = parseFloat(decodedValue);
              if (!isNaN(num) && num.toString() === decodedValue) {
                decodedValue = num;
              }
            }
          }
          if (params[decodedKey] !== void 0) {
            if (Array.isArray(params[decodedKey])) {
              params[decodedKey].push(decodedValue);
            } else {
              params[decodedKey] = [params[decodedKey], decodedValue];
            }
          } else {
            params[decodedKey] = decodedValue;
          }
        } catch (error) {
          if (typeof value === "boolean") {
            params[key] = value;
          } else {
            params[key] = value || "";
          }
        }
      }
    }
    return params;
  }
  /**
   * Parse Cookie header
   * @param {string} cookieHeader Cookie header string
   * @returns {Object} Parsed cookies object
   */
  static parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader || typeof cookieHeader !== "string") {
      return cookies;
    }
    cookieHeader.split(";").forEach((cookie) => {
      const trimmed = cookie.trim();
      const equalIndex = trimmed.indexOf("=");
      if (equalIndex > 0) {
        const name = trimmed.substring(0, equalIndex).trim();
        let value = trimmed.substring(equalIndex + 1).trim();
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        }
        try {
          cookies[name] = decodeURIComponent(value);
        } catch (error) {
          cookies[name] = value;
        }
      }
    });
    return cookies;
  }
  /**
   * Read the full request body data from the stream
   */
  static async readBodyFromStream(req, maxSize = 50 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      if (req.readableEnded || req.destroyed) {
        resolve(Buffer.alloc(0));
        return;
      }
      if (req._bodyBuffer !== void 0) {
        resolve(req._bodyBuffer);
        return;
      }
      const chunks = [];
      let totalSize = 0;
      const cleanup = () => {
        req.removeListener("data", onData);
        req.removeListener("end", onEnd);
        req.removeListener("error", onError);
      };
      const onData = (chunk) => {
        totalSize += chunk.length;
        if (totalSize > maxSize) {
          cleanup();
          reject(new Error(`Request body too large. Max size: ${maxSize} bytes`));
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = () => {
        cleanup();
        const buffer = Buffer.concat(chunks);
        req._bodyBuffer = buffer;
        resolve(buffer);
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      req.on("data", onData);
      req.on("end", onEnd);
      req.on("error", onError);
      if (req.readable && !req.readableFlowing) {
        req.resume();
      }
    });
  }
};
function firstForwardedProto(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || "").split(",")[0].trim().toLowerCase();
}
function createBodyReadError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause)
    err.cause = cause;
  return err;
}
async function readIncomingBody(req) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      chunks.push(chunk);
    }
  } catch (error) {
    throw createBodyReadError(
      "EO_BODY_READ_FAILED",
      "Request body read failed after " + size + " bytes: " + (error && error.message || String(error)),
      error
    );
  }
  const buf = chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, size);
  const declaredRaw = req.headers && req.headers["content-length"];
  if (declaredRaw !== void 0 && declaredRaw !== "") {
    const declared = Number(declaredRaw);
    if (Number.isFinite(declared) && declared !== buf.length) {
      throw createBodyReadError("EO_BODY_TRUNCATED", "Request body truncated: received " + buf.length + " of " + declared + " bytes");
    }
  }
  return buf;
}
function respondBodyReadError(req, res, error, pathname2) {
  const code = error && error.code || "EO_BODY_READ_FAILED";
  const status = 400;
  const requestId = req.headers["x-scf-request-id"] || req.headers["functions-request-id"] || "";
  try {
    console.error("[body-read] failed " + JSON.stringify({
      scfRequestId: requestId,
      method: req.method,
      path: pathname2,
      contentLength: req.headers["content-length"] || "",
      transferEncoding: req.headers["transfer-encoding"] || "",
      reqComplete: !!req.complete,
      reqAborted: !!req.aborted,
      reqDestroyed: !!req.destroyed,
      code,
      error: (error && error.name ? error.name + ": " : "") + (error && error.message || String(error)),
      cause: error && error.cause ? String(error.cause.message || error.cause) : ""
    }));
  } catch {
  }
  if (res.headersSent || res.writableEnded)
    return;
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Functions-Request-Id": requestId,
    "eo-pages-inner-body-error": code
  });
  res.end(JSON.stringify({
    error: "Request body read failed",
    code,
    message: error && error.message || "",
    functions_request_id: requestId || null
  }));
}
async function createEdgeoneCompatibleRequest(originalReq, isFramework = false) {
  const method = (originalReq.method || "GET").toUpperCase();
  const protocol = firstForwardedProto(originalReq.headers["x-forwarded-proto"]) || "http";
  const host = originalReq.headers.host || "localhost";
  const url = protocol + "://" + host + (originalReq.url || "/");
  const headerPairs = [];
  for (const key in originalReq.headers) {
    const v = originalReq.headers[key];
    if (typeof v === "string") {
      headerPairs.push([key, v]);
    } else if (Array.isArray(v)) {
      headerPairs.push([key, v.join(", ")]);
    } else if (v != null) {
      headerPairs.push([key, String(v)]);
    }
  }
  const init = {
    method,
    headers: new Headers(headerPairs)
  };
  let rawBody = void 0;
  let bodyReadError = null;
  if (method !== "GET" && method !== "HEAD") {
    try {
      rawBody = await readIncomingBody(originalReq);
    } catch (err) {
      bodyReadError = err;
    }
    if (rawBody && rawBody.length > 0) {
      init.body = rawBody;
    }
  }
  const request = new Request(url, init);
  request._rawBodyBuffer = rawBody;
  request._bodyReadError = bodyReadError;
  let parsedBodyCache = void 0;
  let parsedBodyReady = false;
  let parsedBodyError = null;
  const contentType = request.headers.get("content-type") || "";
  const ensureParsedBody = () => {
    if (parsedBodyReady)
      return;
    parsedBodyReady = true;
    if (bodyReadError) {
      parsedBodyError = bodyReadError;
      return;
    }
    try {
      parsedBodyCache = EdgeoneBodyParser.parseBodyByContentType(rawBody, contentType);
    } catch (err) {
      parsedBodyError = err;
    }
  };
  if (!("cookies" in request)) {
    Object.defineProperty(request, "cookies", {
      get() {
        return EdgeoneBodyParser.parseCookies(request.headers.get("cookie") || "");
      },
      configurable: true,
      enumerable: true
    });
  }
  if (!("query" in request)) {
    Object.defineProperty(request, "query", {
      get() {
        return EdgeoneBodyParser.parseQuery(request.url || "");
      },
      configurable: true,
      enumerable: true
    });
  }
  Object.defineProperty(request, "body", {
    get() {
      ensureParsedBody();
      if (parsedBodyError)
        throw parsedBodyError;
      return parsedBodyCache;
    },
    configurable: true,
    enumerable: true
  });
  return request;
}
async function handleResponse(res, response, passHeaders = {}) {
  var _a, _b, _c;
  const startTime = Date.now();
  const conversationId = passHeaders["makers-conversation-id"] || "";
  if (!response) {
    const requestId = passHeaders["functions-request-id"] || "";
    const headers = {
      "Functions-Request-Id": requestId,
      "eo-pages-inner-scf-status": "404",
      "eo-pages-inner-status-intercept": "true"
    };
    if (conversationId) {
      headers["makers-conversation-id"] = conversationId;
    }
    res.writeHead(404, headers);
    res.end(JSON.stringify({
      error: "Not Found",
      message: "The requested path does not exist"
    }));
    const endTime = Date.now();
    return;
  }
  try {
    if (response instanceof Response) {
      let validateCacheControlHeader = function(headers2) {
        const cacheControl = headers2["cache-control"];
        if (cacheControl) {
          const directives = cacheControl.split(",").map((directive) => directive.trim());
          const validatedDirectives = [];
          for (const directive of directives) {
            if (!directive)
              continue;
            const [key, value] = directive.split("=");
            const standardDirectives = ["max-age", "public", "private", "s-maxage", "no-cache", "no-store", "no-transform", "must-revalidate", "proxy-revalidate", "must-understand", "stale-while-revalidate", "stale-if-error", "immutable"];
            if (!standardDirectives.includes(key)) {
              continue;
            }
            if (key === "stale-while-revalidate" || key === "stale-if-error") {
              if (!value) {
                const defaultValue = "31536000";
                validatedDirectives.push(key + "=" + defaultValue);
                continue;
              }
            }
            validatedDirectives.push(directive);
          }
          headers2["cache-control"] = validatedDirectives.join(", ");
        }
      };
      const requestId = passHeaders["functions-request-id"] || "";
      const responseStatus = response.status;
      const headers = Object.fromEntries(response.headers);
      validateCacheControlHeader(headers);
      headers["Functions-Request-Id"] = requestId;
      if (conversationId) {
        headers["makers-conversation-id"] = conversationId;
      }
      if (!headers["eo-pages-inner-scf-status"]) {
        headers["eo-pages-inner-scf-status"] = String(responseStatus);
      }
      if (!headers["eo-pages-inner-status-intercept"]) {
        headers["eo-pages-inner-status-intercept"] = "false";
      }
      if (response.headers.get("eop-client-geo")) {
        response.headers.delete("eop-client-geo");
      }
      delete headers["x-content-type-stream"];
      delete headers["X-Content-Type-Stream"];
      const isStream = response.body && (((_a = response.headers.get("content-type")) == null ? void 0 : _a.includes("text/event-stream")) || ((_b = response.headers.get("transfer-encoding")) == null ? void 0 : _b.includes("chunked")) || response.body instanceof ReadableStream || typeof response.body.pipe === "function" || response.headers.get("x-content-type-stream") === "true");
      if (isStream) {
        const streamHeaders = {
          ...headers
        };
        if ((_c = response.headers.get("content-type")) == null ? void 0 : _c.includes("text/event-stream")) {
          streamHeaders["Content-Type"] = "text/event-stream";
        }
        res.writeHead(response.status, streamHeaders);
        if (typeof response.body.pipe === "function") {
          response.body.pipe(res);
        } else {
          const reader = response.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done)
                break;
              if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
                res.write(value);
              } else {
                const chunk = new TextDecoder().decode(value);
                res.write(chunk);
              }
            }
          } finally {
            reader.releaseLock();
            res.end();
          }
        }
      } else {
        res.writeHead(response.status, headers);
        const body = await response.text();
        res.end(body);
      }
    } else {
      const requestId = passHeaders["functions-request-id"] || "";
      const headers = {
        "Content-Type": "application/json",
        "Functions-Request-Id": requestId,
        "eo-pages-inner-scf-status": "200",
        "eo-pages-inner-status-intercept": "false"
      };
      if (conversationId) {
        headers["makers-conversation-id"] = conversationId;
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify(response));
    }
  } catch (error) {
    const requestId = passHeaders["functions-request-id"] || "";
    const headers = {
      "Functions-Request-Id": requestId,
      "eo-pages-inner-scf-status": "502",
      "eo-pages-inner-status-intercept": "true"
    };
    if (conversationId) {
      headers["makers-conversation-id"] = conversationId;
    }
    res.writeHead(502, headers);
    res.end(JSON.stringify({
      error: "Internal Server Error",
      message: error.message
    }));
  } finally {
    const endTime = Date.now();
  }
}
var server = http.createServer(async (req, res) => {
  let agentConversationId = "";
  let fullPath = "";
  try {
    const requestStartTime = Date.now();
    const geoStr = decodeURIComponent(req.headers["eo-connecting-geo"]) || "";
    const geo = geoStr ? (() => {
      const result = {};
      const matches = geoStr.match(/[a-z_]+="[^"]*"|[a-z_]+=[A-Za-z0-9.-]+/g) || [];
      matches.forEach((match) => {
        const [key, value] = match.split("=", 2);
        result[key] = value.replace(/^"|"$/g, "");
      });
      return result;
    })() : {};
    const newGeo = {
      asn: geo.asn,
      countryName: geo.nation_name,
      countryCodeAlpha2: geo.region_code && geo.region_code.split("-")[0],
      countryCodeNumeric: geo.nation_numeric,
      regionName: geo.region_name,
      regionCode: geo.region_code,
      cityName: geo.city_name,
      latitude: geo.latitude,
      longitude: geo.longitude,
      cisp: geo.network_operator
    };
    const safeGeo = {};
    for (const [key, value] of Object.entries(newGeo)) {
      if (value !== void 0 && value !== null) {
        if (typeof value === "string" && /[\u4e00-\u9fff]/.test(value)) {
          safeGeo[key] = Buffer.from(value, "utf8").toString("utf8");
        } else {
          safeGeo[key] = value;
        }
      }
    }
    req.headers["eo-connecting-geo"] = safeGeo;
    let context = {};
    let enhancedRequest = {};
    req.headers["functions-request-id"] = req.headers["x-scf-request-id"] || "";
    agentConversationId = resolveAgentConversationId(req);
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname2 = url.pathname;
    if (pathname2 !== "/" && pathname2.endsWith("/")) {
      pathname2 = pathname2.slice(0, -1);
    }
    if (req.headers.host === "localhost:9000") {
      fullPath = pathname2;
    } else {
      const host = req.headers["eo-pages-host"] || req.headers.host || "";
      const xForwardedProto = firstForwardedProto(req.headers["x-forwarded-proto"]);
      fullPath = (xForwardedProto || "https") + "://" + host + req.url;
      if (fullPath.endsWith("?")) {
        fullPath = fullPath.slice(0, -1);
      }
    }
    if (!req.headers["eo-pages-host"] || req.headers["eo-pages-host"] === "localhost:9000" || req.headers["eo-pages-host"] === "undefined" || req.headers["eo-pages-host"] === "null" || req.headers.host === "localhost:9000") {
      console.log(`Makers request info: ${JSON.stringify({
        host: req.headers.host,
        "user-agent": req.headers["user-agent"],
        "eo-pages-host": req.headers["eo-pages-host"],
        "eo-connecting-ip": req.headers["eo-connecting-ip"],
        "x-forwarded-for": req.headers["x-forwarded-for"],
        "x-real-ip": req.headers["x-real-ip"],
        "functions-request-id": req.headers["functions-request-id"],
        path: pathname2,
        url: req.url
      })}`);
    }
    const scfRequestId = req.headers["x-scf-request-id"] || "";
    let response = null;
    if (pathname2 === "/tunnel") {
      const mod_0 = (() => {
        var __create = Object.create;
        var __defProp = Object.defineProperty;
        var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
        var __getOwnPropNames2 = Object.getOwnPropertyNames;
        var __getProtoOf = Object.getPrototypeOf;
        var __hasOwnProp = Object.prototype.hasOwnProperty;
        var __commonJS2 = (cb, mod) => function __require2() {
          return mod || (0, cb[__getOwnPropNames2(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
        };
        var __copyProps = (to, from, except, desc) => {
          if (from && typeof from === "object" || typeof from === "function") {
            for (let key of __getOwnPropNames2(from))
              if (!__hasOwnProp.call(to, key) && key !== except)
                __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
          }
          return to;
        };
        var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
          // If the importer is in node compatibility mode or this is not an ESM
          // file that has been converted to a CommonJS file using a Babel-
          // compatible transform (i.e. "__esModule" has not been set), then set
          // "default" to the CommonJS "module.exports" for node compatibility.
          isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
          mod
        ));
        var require_ipaddr = __commonJS2({
          "node_modules/ipaddr.js/lib/ipaddr.js"(exports, module) {
            (function(root) {
              "use strict";
              const ipv4Part = "(0?\\d+|0x[a-f0-9]+)";
              const ipv4Regexes = {
                fourOctet: new RegExp(`^${ipv4Part}\\.${ipv4Part}\\.${ipv4Part}\\.${ipv4Part}$`, "i"),
                threeOctet: new RegExp(`^${ipv4Part}\\.${ipv4Part}\\.${ipv4Part}$`, "i"),
                twoOctet: new RegExp(`^${ipv4Part}\\.${ipv4Part}$`, "i"),
                longValue: new RegExp(`^${ipv4Part}$`, "i")
              };
              const octalRegex = new RegExp(`^0[0-7]+$`, "i");
              const hexRegex = new RegExp(`^0x[a-f0-9]+$`, "i");
              const zoneIndex = "%[0-9a-z]{1,}";
              const ipv6Part = "(?:[0-9a-f]+::?)+";
              const ipv6Regexes = {
                zoneIndex: new RegExp(zoneIndex, "i"),
                "native": new RegExp(`^(::)?(${ipv6Part})?([0-9a-f]+)?(::)?(${zoneIndex})?$`, "i"),
                deprecatedTransitional: new RegExp(`^(?:::)(${ipv4Part}\\.${ipv4Part}\\.${ipv4Part}\\.${ipv4Part}(${zoneIndex})?)$`, "i"),
                transitional: new RegExp(`^((?:${ipv6Part})|(?:::)(?:${ipv6Part})?)${ipv4Part}\\.${ipv4Part}\\.${ipv4Part}\\.${ipv4Part}(${zoneIndex})?$`, "i")
              };
              function expandIPv6(string, parts) {
                if (string.indexOf("::") !== string.lastIndexOf("::")) {
                  return null;
                }
                let colonCount = 0;
                let lastColon = -1;
                let zoneId = (string.match(ipv6Regexes.zoneIndex) || [])[0];
                let replacement, replacementCount;
                if (zoneId) {
                  zoneId = zoneId.substring(1);
                  string = string.replace(/%.+$/, "");
                }
                while ((lastColon = string.indexOf(":", lastColon + 1)) >= 0) {
                  colonCount++;
                }
                if (string.substr(0, 2) === "::") {
                  colonCount--;
                }
                if (string.substr(-2, 2) === "::") {
                  colonCount--;
                }
                if (colonCount >= parts) {
                  return null;
                }
                replacementCount = parts - colonCount;
                replacement = ":";
                while (replacementCount--) {
                  replacement += "0:";
                }
                string = string.replace("::", replacement);
                if (string[0] === ":") {
                  string = string.slice(1);
                }
                if (string[string.length - 1] === ":") {
                  string = string.slice(0, -1);
                }
                parts = function() {
                  const ref = string.split(":");
                  const results = [];
                  for (let i = 0; i < ref.length; i++) {
                    results.push(ref[i].length > 4 ? NaN : parseInt(ref[i], 16));
                  }
                  return results;
                }();
                return {
                  parts,
                  zoneId
                };
              }
              function matchCIDR(first, second, partSize, cidrBits) {
                if (first.length !== second.length) {
                  throw new Error("ipaddr: cannot match CIDR for objects with different lengths");
                }
                let part = 0;
                let shift;
                while (cidrBits > 0) {
                  shift = partSize - cidrBits;
                  if (shift < 0) {
                    shift = 0;
                  }
                  if (first[part] >> shift !== second[part] >> shift) {
                    return false;
                  }
                  cidrBits -= partSize;
                  part += 1;
                }
                return true;
              }
              function parseIntAuto(string) {
                if (hexRegex.test(string)) {
                  return parseInt(string, 16);
                }
                if (string[0] === "0" && !isNaN(parseInt(string[1], 10))) {
                  if (octalRegex.test(string)) {
                    return parseInt(string, 8);
                  }
                  throw new Error(`ipaddr: cannot parse ${string} as octal`);
                }
                return parseInt(string, 10);
              }
              function padPart(part, length) {
                while (part.length < length) {
                  part = `0${part}`;
                }
                return part;
              }
              const ipaddr2 = {};
              ipaddr2.IPv4 = function() {
                function IPv4(octets) {
                  if (octets.length !== 4) {
                    throw new Error("ipaddr: ipv4 octet count should be 4");
                  }
                  let i, octet;
                  for (i = 0; i < octets.length; i++) {
                    octet = octets[i];
                    if (!(0 <= octet && octet <= 255)) {
                      throw new Error("ipaddr: ipv4 octet should fit in 8 bits");
                    }
                  }
                  this.octets = octets;
                }
                IPv4.prototype.SpecialRanges = {
                  unspecified: [[new IPv4([0, 0, 0, 0]), 8]],
                  broadcast: [[new IPv4([255, 255, 255, 255]), 32]],
                  // RFC3171
                  multicast: [[new IPv4([224, 0, 0, 0]), 4]],
                  // RFC3927
                  linkLocal: [[new IPv4([169, 254, 0, 0]), 16]],
                  // RFC5735
                  loopback: [[new IPv4([127, 0, 0, 0]), 8]],
                  // RFC6598
                  carrierGradeNat: [[new IPv4([100, 64, 0, 0]), 10]],
                  // RFC1918
                  "private": [
                    [new IPv4([10, 0, 0, 0]), 8],
                    [new IPv4([172, 16, 0, 0]), 12],
                    [new IPv4([192, 168, 0, 0]), 16]
                  ],
                  // Reserved and testing-only ranges; RFCs 5735, 5737, 2544, 1700
                  reserved: [
                    [new IPv4([192, 0, 0, 0]), 24],
                    [new IPv4([192, 0, 2, 0]), 24],
                    [new IPv4([192, 88, 99, 0]), 24],
                    [new IPv4([198, 18, 0, 0]), 15],
                    [new IPv4([198, 51, 100, 0]), 24],
                    [new IPv4([203, 0, 113, 0]), 24],
                    [new IPv4([240, 0, 0, 0]), 4]
                  ],
                  // RFC7534, RFC7535
                  as112: [
                    [new IPv4([192, 175, 48, 0]), 24],
                    [new IPv4([192, 31, 196, 0]), 24]
                  ],
                  // RFC7450
                  amt: [
                    [new IPv4([192, 52, 193, 0]), 24]
                  ]
                };
                IPv4.prototype.kind = function() {
                  return "ipv4";
                };
                IPv4.prototype.match = function(other, cidrRange) {
                  let ref;
                  if (cidrRange === void 0) {
                    ref = other;
                    other = ref[0];
                    cidrRange = ref[1];
                  }
                  if (other.kind() !== "ipv4") {
                    throw new Error("ipaddr: cannot match ipv4 address with non-ipv4 one");
                  }
                  return matchCIDR(this.octets, other.octets, 8, cidrRange);
                };
                IPv4.prototype.prefixLengthFromSubnetMask = function() {
                  let cidr = 0;
                  let stop = false;
                  const zerotable = {
                    0: 8,
                    128: 7,
                    192: 6,
                    224: 5,
                    240: 4,
                    248: 3,
                    252: 2,
                    254: 1,
                    255: 0
                  };
                  let i, octet, zeros;
                  for (i = 3; i >= 0; i -= 1) {
                    octet = this.octets[i];
                    if (octet in zerotable) {
                      zeros = zerotable[octet];
                      if (stop && zeros !== 0) {
                        return null;
                      }
                      if (zeros !== 8) {
                        stop = true;
                      }
                      cidr += zeros;
                    } else {
                      return null;
                    }
                  }
                  return 32 - cidr;
                };
                IPv4.prototype.range = function() {
                  return ipaddr2.subnetMatch(this, this.SpecialRanges);
                };
                IPv4.prototype.toByteArray = function() {
                  return this.octets.slice(0);
                };
                IPv4.prototype.toIPv4MappedAddress = function() {
                  return ipaddr2.IPv6.parse(`::ffff:${this.toString()}`);
                };
                IPv4.prototype.toNormalizedString = function() {
                  return this.toString();
                };
                IPv4.prototype.toString = function() {
                  return this.octets.join(".");
                };
                return IPv4;
              }();
              ipaddr2.IPv4.broadcastAddressFromCIDR = function(string) {
                try {
                  const cidr = this.parseCIDR(string);
                  const ipInterfaceOctets = cidr[0].toByteArray();
                  const subnetMaskOctets = this.subnetMaskFromPrefixLength(cidr[1]).toByteArray();
                  const octets = [];
                  let i = 0;
                  while (i < 4) {
                    octets.push(parseInt(ipInterfaceOctets[i], 10) | parseInt(subnetMaskOctets[i], 10) ^ 255);
                    i++;
                  }
                  return new this(octets);
                } catch (e) {
                  throw new Error("ipaddr: the address does not have IPv4 CIDR format", { cause: e });
                }
              };
              ipaddr2.IPv4.isIPv4 = function(string) {
                return this.parser(string) !== null;
              };
              ipaddr2.IPv4.isValid = function(string) {
                try {
                  new this(this.parser(string));
                  return true;
                } catch {
                  return false;
                }
              };
              ipaddr2.IPv4.isValidCIDR = function(string) {
                try {
                  this.parseCIDR(string);
                  return true;
                } catch {
                  return false;
                }
              };
              ipaddr2.IPv4.isValidFourPartDecimal = function(string) {
                if (ipaddr2.IPv4.isValid(string) && string.match(/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){3}$/)) {
                  return true;
                } else {
                  return false;
                }
              };
              ipaddr2.IPv4.isValidCIDRFourPartDecimal = function(string) {
                const match = string.match(/^(.+)\/(\d+)$/);
                if (!ipaddr2.IPv4.isValidCIDR(string) || !match) {
                  return false;
                }
                return ipaddr2.IPv4.isValidFourPartDecimal(match[1]);
              };
              ipaddr2.IPv4.networkAddressFromCIDR = function(string) {
                let cidr, i, ipInterfaceOctets, octets, subnetMaskOctets;
                try {
                  cidr = this.parseCIDR(string);
                  ipInterfaceOctets = cidr[0].toByteArray();
                  subnetMaskOctets = this.subnetMaskFromPrefixLength(cidr[1]).toByteArray();
                  octets = [];
                  i = 0;
                  while (i < 4) {
                    octets.push(parseInt(ipInterfaceOctets[i], 10) & parseInt(subnetMaskOctets[i], 10));
                    i++;
                  }
                  return new this(octets);
                } catch (e) {
                  throw new Error("ipaddr: the address does not have IPv4 CIDR format", { cause: e });
                }
              };
              ipaddr2.IPv4.parse = function(string) {
                const parts = this.parser(string);
                if (parts === null) {
                  throw new Error("ipaddr: string is not formatted like an IPv4 Address");
                }
                return new this(parts);
              };
              ipaddr2.IPv4.parseCIDR = function(string) {
                let match;
                if (match = string.match(/^(.+)\/(\d+)$/)) {
                  const maskLength = parseInt(match[2]);
                  if (maskLength >= 0 && maskLength <= 32) {
                    const parsed = [this.parse(match[1]), maskLength];
                    Object.defineProperty(parsed, "toString", {
                      value: function() {
                        return this.join("/");
                      }
                    });
                    return parsed;
                  }
                }
                throw new Error("ipaddr: string is not formatted like an IPv4 CIDR range");
              };
              ipaddr2.IPv4.parser = function(string) {
                let match, part, value;
                if (match = string.match(ipv4Regexes.fourOctet)) {
                  return function() {
                    const ref = match.slice(1, 6);
                    const results = [];
                    for (let i = 0; i < ref.length; i++) {
                      part = ref[i];
                      results.push(parseIntAuto(part));
                    }
                    return results;
                  }();
                } else if (match = string.match(ipv4Regexes.longValue)) {
                  value = parseIntAuto(match[1]);
                  if (value > 4294967295 || value < 0) {
                    throw new Error("ipaddr: address outside defined range");
                  }
                  return function() {
                    const results = [];
                    let shift;
                    for (shift = 0; shift <= 24; shift += 8) {
                      results.push(value >> shift & 255);
                    }
                    return results;
                  }().reverse();
                } else if (match = string.match(ipv4Regexes.twoOctet)) {
                  return function() {
                    const ref = match.slice(1, 4);
                    const results = [];
                    value = parseIntAuto(ref[1]);
                    if (value > 16777215 || value < 0) {
                      throw new Error("ipaddr: address outside defined range");
                    }
                    results.push(parseIntAuto(ref[0]));
                    results.push(value >> 16 & 255);
                    results.push(value >> 8 & 255);
                    results.push(value & 255);
                    return results;
                  }();
                } else if (match = string.match(ipv4Regexes.threeOctet)) {
                  return function() {
                    const ref = match.slice(1, 5);
                    const results = [];
                    value = parseIntAuto(ref[2]);
                    if (value > 65535 || value < 0) {
                      throw new Error("ipaddr: address outside defined range");
                    }
                    results.push(parseIntAuto(ref[0]));
                    results.push(parseIntAuto(ref[1]));
                    results.push(value >> 8 & 255);
                    results.push(value & 255);
                    return results;
                  }();
                } else {
                  return null;
                }
              };
              ipaddr2.IPv4.subnetMaskFromPrefixLength = function(prefix) {
                prefix = parseInt(prefix);
                if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) {
                  throw new Error("ipaddr: invalid IPv4 prefix length");
                }
                const octets = [0, 0, 0, 0];
                let j = 0;
                const filledOctetCount = Math.floor(prefix / 8);
                while (j < filledOctetCount) {
                  octets[j] = 255;
                  j++;
                }
                if (filledOctetCount < 4) {
                  octets[filledOctetCount] = Math.pow(2, prefix % 8) - 1 << 8 - prefix % 8;
                }
                return new this(octets);
              };
              ipaddr2.IPv6 = function() {
                function IPv6(parts, zoneId) {
                  let i, part;
                  if (parts.length === 16) {
                    this.parts = [];
                    for (i = 0; i <= 14; i += 2) {
                      this.parts.push(parts[i] << 8 | parts[i + 1]);
                    }
                  } else if (parts.length === 8) {
                    this.parts = parts;
                  } else {
                    throw new Error("ipaddr: ipv6 part count should be 8 or 16");
                  }
                  for (i = 0; i < this.parts.length; i++) {
                    part = this.parts[i];
                    if (!(0 <= part && part <= 65535)) {
                      throw new Error("ipaddr: ipv6 part should fit in 16 bits");
                    }
                  }
                  if (zoneId) {
                    this.zoneId = zoneId;
                  }
                }
                IPv6.prototype.SpecialRanges = {
                  // RFC4291, here and after
                  unspecified: [new IPv6([0, 0, 0, 0, 0, 0, 0, 0]), 128],
                  linkLocal: [new IPv6([65152, 0, 0, 0, 0, 0, 0, 0]), 10],
                  multicast: [new IPv6([65280, 0, 0, 0, 0, 0, 0, 0]), 8],
                  loopback: [new IPv6([0, 0, 0, 0, 0, 0, 0, 1]), 128],
                  uniqueLocal: [new IPv6([64512, 0, 0, 0, 0, 0, 0, 0]), 7],
                  ipv4Mapped: [new IPv6([0, 0, 0, 0, 0, 65535, 0, 0]), 96],
                  // RFC3879
                  deprecatedSiteLocal: [new IPv6([65216, 0, 0, 0, 0, 0, 0, 0]), 10],
                  // RFC6666
                  discard: [new IPv6([256, 0, 0, 0, 0, 0, 0, 0]), 64],
                  // RFC6145
                  rfc6145: [new IPv6([0, 0, 0, 0, 65535, 0, 0, 0]), 96],
                  rfc6052: [
                    // RFC6052
                    [new IPv6([100, 65435, 0, 0, 0, 0, 0, 0]), 96],
                    // RFC8215
                    [new IPv6([100, 65435, 1, 0, 0, 0, 0, 0]), 48]
                  ],
                  // RFC3056
                  "6to4": [new IPv6([8194, 0, 0, 0, 0, 0, 0, 0]), 16],
                  // RFC6052, RFC6146
                  teredo: [new IPv6([8193, 0, 0, 0, 0, 0, 0, 0]), 32],
                  // RFC5180
                  benchmarking: [new IPv6([8193, 2, 0, 0, 0, 0, 0, 0]), 48],
                  // RFC7450
                  amt: [new IPv6([8193, 3, 0, 0, 0, 0, 0, 0]), 32],
                  as112v6: [
                    // RFC7535
                    [new IPv6([8193, 4, 274, 0, 0, 0, 0, 0]), 48],
                    // RFC7534
                    [new IPv6([9760, 79, 32768, 0, 0, 0, 0, 0]), 48]
                  ],
                  // RFC4843
                  deprecatedOrchid: [new IPv6([8193, 16, 0, 0, 0, 0, 0, 0]), 28],
                  // RFC7343
                  orchid2: [new IPv6([8193, 32, 0, 0, 0, 0, 0, 0]), 28],
                  // RFC9374
                  droneRemoteIdProtocolEntityTags: [new IPv6([8193, 48, 0, 0, 0, 0, 0, 0]), 28],
                  // RFC9602
                  segmentRouting: [new IPv6([24320, 0, 0, 0, 0, 0, 0, 0]), 16],
                  reserved: [
                    // RFC3849
                    [new IPv6([8193, 0, 0, 0, 0, 0, 0, 0]), 23],
                    // RFC2928
                    [new IPv6([8193, 3512, 0, 0, 0, 0, 0, 0]), 32],
                    // RFC9637
                    [new IPv6([16383, 0, 0, 0, 0, 0, 0, 0]), 20]
                  ]
                };
                IPv6.prototype.isIPv4MappedAddress = function() {
                  return this.range() === "ipv4Mapped";
                };
                IPv6.prototype.kind = function() {
                  return "ipv6";
                };
                IPv6.prototype.match = function(other, cidrRange) {
                  let ref;
                  if (cidrRange === void 0) {
                    ref = other;
                    other = ref[0];
                    cidrRange = ref[1];
                  }
                  if (other.kind() !== "ipv6") {
                    throw new Error("ipaddr: cannot match ipv6 address with non-ipv6 one");
                  }
                  return matchCIDR(this.parts, other.parts, 16, cidrRange);
                };
                IPv6.prototype.prefixLengthFromSubnetMask = function() {
                  let cidr = 0;
                  let stop = false;
                  const zerotable = {
                    0: 16,
                    32768: 15,
                    49152: 14,
                    57344: 13,
                    61440: 12,
                    63488: 11,
                    64512: 10,
                    65024: 9,
                    65280: 8,
                    65408: 7,
                    65472: 6,
                    65504: 5,
                    65520: 4,
                    65528: 3,
                    65532: 2,
                    65534: 1,
                    65535: 0
                  };
                  let part, zeros;
                  for (let i = 7; i >= 0; i -= 1) {
                    part = this.parts[i];
                    if (part in zerotable) {
                      zeros = zerotable[part];
                      if (stop && zeros !== 0) {
                        return null;
                      }
                      if (zeros !== 16) {
                        stop = true;
                      }
                      cidr += zeros;
                    } else {
                      return null;
                    }
                  }
                  return 128 - cidr;
                };
                IPv6.prototype.range = function() {
                  return ipaddr2.subnetMatch(this, this.SpecialRanges);
                };
                IPv6.prototype.toByteArray = function() {
                  let part;
                  const bytes = [];
                  const ref = this.parts;
                  for (let i = 0; i < ref.length; i++) {
                    part = ref[i];
                    bytes.push(part >> 8);
                    bytes.push(part & 255);
                  }
                  return bytes;
                };
                IPv6.prototype.toFixedLengthString = function() {
                  const addr = function() {
                    const results = [];
                    for (let i = 0; i < this.parts.length; i++) {
                      results.push(padPart(this.parts[i].toString(16), 4));
                    }
                    return results;
                  }.call(this).join(":");
                  let suffix = "";
                  if (this.zoneId) {
                    suffix = `%${this.zoneId}`;
                  }
                  return addr + suffix;
                };
                IPv6.prototype.toIPv4Address = function() {
                  if (!this.isIPv4MappedAddress()) {
                    throw new Error("ipaddr: trying to convert a generic ipv6 address to ipv4");
                  }
                  const ref = this.parts.slice(-2);
                  const high = ref[0];
                  const low = ref[1];
                  return new ipaddr2.IPv4([high >> 8, high & 255, low >> 8, low & 255]);
                };
                IPv6.prototype.toNormalizedString = function() {
                  const addr = function() {
                    const results = [];
                    for (let i = 0; i < this.parts.length; i++) {
                      results.push(this.parts[i].toString(16));
                    }
                    return results;
                  }.call(this).join(":");
                  let suffix = "";
                  if (this.zoneId) {
                    suffix = `%${this.zoneId}`;
                  }
                  return addr + suffix;
                };
                IPv6.prototype.toRFC5952String = function() {
                  const regex = /((^|:)(0(:|$)){2,})/g;
                  let suffix = "";
                  if (this.zoneId) {
                    suffix = `%${this.zoneId}`;
                  }
                  const normalized = this.toNormalizedString();
                  const string = normalized.slice(0, normalized.length - suffix.length);
                  let bestMatchIndex = 0;
                  let bestMatchLength = -1;
                  let bestMatchGroups = -1;
                  let match;
                  while (match = regex.exec(string)) {
                    const groups = (match[0].match(/0/g) || []).length;
                    if (groups > bestMatchGroups) {
                      bestMatchGroups = groups;
                      bestMatchIndex = match.index;
                      bestMatchLength = match[0].length;
                    }
                  }
                  if (bestMatchLength < 0) {
                    return string + suffix;
                  }
                  return `${string.substring(0, bestMatchIndex)}::${string.substring(bestMatchIndex + bestMatchLength)}${suffix}`;
                };
                IPv6.prototype.toString = function() {
                  return this.toRFC5952String();
                };
                return IPv6;
              }();
              ipaddr2.IPv6.broadcastAddressFromCIDR = function(string) {
                try {
                  const cidr = this.parseCIDR(string);
                  const ipInterfaceOctets = cidr[0].toByteArray();
                  const subnetMaskOctets = this.subnetMaskFromPrefixLength(cidr[1]).toByteArray();
                  const octets = [];
                  let i = 0;
                  while (i < 16) {
                    octets.push(parseInt(ipInterfaceOctets[i], 10) | parseInt(subnetMaskOctets[i], 10) ^ 255);
                    i++;
                  }
                  return new this(octets);
                } catch (e) {
                  throw new Error("ipaddr: the address does not have IPv6 CIDR format", { cause: e });
                }
              };
              ipaddr2.IPv6.isIPv6 = function(string) {
                return this.parser(string) !== null;
              };
              ipaddr2.IPv6.isValid = function(string) {
                if (typeof string === "string" && string.indexOf(":") === -1) {
                  return false;
                }
                try {
                  const addr = this.parser(string);
                  new this(addr.parts, addr.zoneId);
                  return true;
                } catch {
                  return false;
                }
              };
              ipaddr2.IPv6.isValidCIDR = function(string) {
                if (typeof string === "string" && string.indexOf(":") === -1) {
                  return false;
                }
                try {
                  this.parseCIDR(string);
                  return true;
                } catch {
                  return false;
                }
              };
              ipaddr2.IPv6.networkAddressFromCIDR = function(string) {
                let cidr, i, ipInterfaceOctets, octets, subnetMaskOctets;
                try {
                  cidr = this.parseCIDR(string);
                  ipInterfaceOctets = cidr[0].toByteArray();
                  subnetMaskOctets = this.subnetMaskFromPrefixLength(cidr[1]).toByteArray();
                  octets = [];
                  i = 0;
                  while (i < 16) {
                    octets.push(parseInt(ipInterfaceOctets[i], 10) & parseInt(subnetMaskOctets[i], 10));
                    i++;
                  }
                  return new this(octets);
                } catch (e) {
                  throw new Error("ipaddr: the address does not have IPv6 CIDR format", { cause: e });
                }
              };
              ipaddr2.IPv6.parse = function(string) {
                const addr = this.parser(string);
                if (addr === null) {
                  throw new Error("ipaddr: string is not formatted like an IPv6 Address");
                }
                return new this(addr.parts, addr.zoneId);
              };
              ipaddr2.IPv6.parseCIDR = function(string) {
                let maskLength, match, parsed;
                if (match = string.match(/^(.+)\/(\d+)$/)) {
                  maskLength = parseInt(match[2]);
                  if (maskLength >= 0 && maskLength <= 128) {
                    parsed = [this.parse(match[1]), maskLength];
                    Object.defineProperty(parsed, "toString", {
                      value: function() {
                        return this.join("/");
                      }
                    });
                    return parsed;
                  }
                }
                throw new Error("ipaddr: string is not formatted like an IPv6 CIDR range");
              };
              ipaddr2.IPv6.parser = function(string) {
                let addr, i, match, octet, octets, zoneId;
                if (match = string.match(ipv6Regexes.deprecatedTransitional)) {
                  return this.parser(`::ffff:${match[1]}`);
                }
                if (ipv6Regexes.native.test(string)) {
                  return expandIPv6(string, 8);
                }
                if (match = string.match(ipv6Regexes.transitional)) {
                  zoneId = match[6] || "";
                  addr = match[1];
                  if (!match[1].endsWith("::")) {
                    addr = addr.slice(0, -1);
                  }
                  addr = expandIPv6(addr + zoneId, 6);
                  if (addr && addr.parts) {
                    octets = [
                      parseInt(match[2]),
                      parseInt(match[3]),
                      parseInt(match[4]),
                      parseInt(match[5])
                    ];
                    for (i = 0; i < octets.length; i++) {
                      octet = octets[i];
                      if (!(0 <= octet && octet <= 255)) {
                        return null;
                      }
                    }
                    addr.parts.push(octets[0] << 8 | octets[1]);
                    addr.parts.push(octets[2] << 8 | octets[3]);
                    return {
                      parts: addr.parts,
                      zoneId: addr.zoneId
                    };
                  }
                }
                return null;
              };
              ipaddr2.IPv6.subnetMaskFromPrefixLength = function(prefix) {
                prefix = parseInt(prefix);
                if (Number.isNaN(prefix) || prefix < 0 || prefix > 128) {
                  throw new Error("ipaddr: invalid IPv6 prefix length");
                }
                const octets = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
                let j = 0;
                const filledOctetCount = Math.floor(prefix / 8);
                while (j < filledOctetCount) {
                  octets[j] = 255;
                  j++;
                }
                if (filledOctetCount < 16) {
                  octets[filledOctetCount] = Math.pow(2, prefix % 8) - 1 << 8 - prefix % 8;
                }
                return new this(octets);
              };
              ipaddr2.fromByteArray = function(bytes) {
                const length = bytes.length;
                if (length === 4) {
                  return new ipaddr2.IPv4(bytes);
                } else if (length === 16) {
                  return new ipaddr2.IPv6(bytes);
                } else {
                  throw new Error("ipaddr: the binary input is neither an IPv6 nor IPv4 address");
                }
              };
              ipaddr2.isValid = function(string) {
                return ipaddr2.IPv6.isValid(string) || ipaddr2.IPv4.isValid(string);
              };
              ipaddr2.isValidCIDR = function(string) {
                return ipaddr2.IPv6.isValidCIDR(string) || ipaddr2.IPv4.isValidCIDR(string);
              };
              ipaddr2.parse = function(string) {
                if (ipaddr2.IPv6.isValid(string)) {
                  return ipaddr2.IPv6.parse(string);
                } else if (ipaddr2.IPv4.isValid(string)) {
                  return ipaddr2.IPv4.parse(string);
                } else {
                  throw new Error("ipaddr: the address has neither IPv6 nor IPv4 format");
                }
              };
              ipaddr2.parseCIDR = function(string) {
                try {
                  return ipaddr2.IPv6.parseCIDR(string);
                } catch {
                  try {
                    return ipaddr2.IPv4.parseCIDR(string);
                  } catch (e) {
                    throw new Error("ipaddr: the address has neither IPv6 nor IPv4 CIDR format", { cause: e });
                  }
                }
              };
              ipaddr2.process = function(string) {
                const addr = this.parse(string);
                if (addr.kind() === "ipv6" && addr.isIPv4MappedAddress()) {
                  return addr.toIPv4Address();
                } else {
                  return addr;
                }
              };
              ipaddr2.subnetMatch = function(address, rangeList, defaultName) {
                let i, rangeName, rangeSubnets, subnet;
                if (defaultName === void 0 || defaultName === null) {
                  defaultName = "unicast";
                }
                for (rangeName in rangeList) {
                  if (Object.prototype.hasOwnProperty.call(rangeList, rangeName)) {
                    rangeSubnets = rangeList[rangeName];
                    if (rangeSubnets[0] && !(rangeSubnets[0] instanceof Array)) {
                      rangeSubnets = [rangeSubnets];
                    }
                    for (i = 0; i < rangeSubnets.length; i++) {
                      subnet = rangeSubnets[i];
                      if (address.kind() === subnet[0].kind() && address.match.apply(address, subnet)) {
                        return rangeName;
                      }
                    }
                  }
                }
                return defaultName;
              };
              if (typeof module !== "undefined" && module.exports) {
                module.exports = ipaddr2;
              } else {
                root.ipaddr = ipaddr2;
              }
            })(exports);
          }
        });
        var import_ipaddr = __toESM(require_ipaddr());
        function header(request, name) {
          var _a;
          return ((_a = request == null ? void 0 : request.headers) == null ? void 0 : _a.get(name)) || "";
        }
        function authorized(request, token) {
          if (!token)
            return false;
          const a = Buffer.from(header(request, "x-tunnel-token"));
          const b = Buffer.from(token);
          return a.length === b.length && timingSafeEqual(a, b);
        }
        function publicAddress(host) {
          const address = import_ipaddr.default.parse(host);
          if (address.kind() === "ipv6" && address.isIPv4MappedAddress()) {
            return publicAddress(address.toIPv4Address().toString());
          }
          const ranges = address.kind() === "ipv6" ? ["unspecified", "loopback", "linkLocal", "uniqueLocal", "ipv4Mapped", "multicast", "reserved"] : ["unspecified", "loopback", "linkLocal", "private", "broadcast", "carrierGradeNat", "multicast", "reserved"];
          return ranges.indexOf(address.range()) === -1;
        }
        async function resolveTarget(raw) {
          if (!raw || raw.length > 260 || /[\r\n@/?#\s]/.test(raw))
            throw Error("invalid target");
          const colon = raw.lastIndexOf(":");
          const host = raw.startsWith("[") ? raw.slice(1, raw.indexOf("]")) : raw.slice(0, colon);
          const port2 = Number(raw.slice(colon + 1));
          if (!host || !Number.isInteger(port2) || port2 < 1 || port2 > 65535 || raw.startsWith("[") && !raw.startsWith("[" + host + "]:")) {
            throw Error("invalid target");
          }
          const addresses = import_ipaddr.default.isValid(host) ? [{
            address: host,
            family: import_ipaddr.default.parse(host).kind() === "ipv6" ? 6 : 4
          }] : await dns.lookup(host, {
            all: true,
            verbatim: true
          });
          if (!addresses.length || addresses.some((item) => !publicAddress(item.address)))
            throw Error("target address is not public");
          return {
            host,
            port: port2
          };
        }
        function connectTarget(target) {
          const socket = net.connect({
            host: target.host,
            port: target.port,
            autoSelectFamily: true,
            autoSelectFamilyAttemptTimeout: 2500,
            timeout: 8e3
          });
          socket.on("timeout", () => socket.destroy(Error("target connect timeout")));
          return socket;
        }
        async function onRequest(context2) {
          if (header(context2.request, "upgrade").toLowerCase() !== "websocket") {
            return new Response(JSON.stringify({
              runtime: typeof net.connect,
              dns: typeof dns.lookup,
              websocketHandler: "node"
            }), {
              status: 426,
              headers: {
                "Content-Type": "application/json"
              }
            });
          }
          return {
            websocket: createTunnel(context2)
          };
        }
        function createTunnel({
          request,
          env: env2 = {}
        }) {
          let target;
          let ready = false;
          let ended = false;
          const fail = () => {
            if (target && !target.destroyed)
              target.destroy();
          };
          const send = (ws, data) => {
            if (!ended)
              ws.send(data);
          };
          return {
            async onopen(ws) {
              try {
                if (!authorized(request, env2.CLOUDPROXY_NODE_TOKEN))
                  throw Error("invalid node token");
                if (header(request, "x-tunnel-protocol") !== "2")
                  throw Error("protocol 2 required");
                const address = await resolveTarget(header(request, "x-tunnel-target"));
                target = connectTarget(address);
                target.once("connect", () => {
                  if (ended) {
                    target.destroy();
                    return;
                  }
                  ready = true;
                  send(ws, JSON.stringify({
                    ok: true
                  }));
                  target.on("data", (chunk) => send(ws, chunk));
                  target.on("end", () => send(ws, "EOF"));
                  target.on("close", () => {
                    ended = true;
                    ws.close(1e3);
                  });
                  target.on("error", () => {
                    if (ready) {
                      ended = true;
                      ws.close(1011, "target connection failed");
                    }
                  });
                });
                target.once("error", (error) => {
                  if (ready)
                    return;
                  send(ws, JSON.stringify({
                    ok: false,
                    error: "target",
                    detail: String((error == null ? void 0 : error.message) || error).slice(0, 400)
                  }));
                  ended = true;
                  ws.close(1e3, "target unavailable");
                });
              } catch (error) {
                send(ws, JSON.stringify({
                  ok: false,
                  error: "target",
                  detail: String((error == null ? void 0 : error.message) || error).slice(0, 400)
                }));
                ended = true;
                ws.close(1e3, "target unavailable");
              }
            },
            onmessage(ws, data, isBinary) {
              if (!ready || ended)
                return;
              if (!isBinary) {
                if (String(data) === "EOF")
                  target.end();
                return;
              }
              target.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
            },
            onclose() {
              ended = true;
              fail();
            },
            onerror() {
              ended = true;
              fail();
            }
          };
        }
        return {
          onRequest: typeof onRequest !== "undefined" ? onRequest : void 0,
          onRequestGet: typeof onRequestGet !== "undefined" ? onRequestGet : void 0,
          onRequestPost: typeof onRequestPost !== "undefined" ? onRequestPost : void 0,
          onRequestPut: typeof onRequestPut !== "undefined" ? onRequestPut : void 0,
          onRequestDelete: typeof onRequestDelete !== "undefined" ? onRequestDelete : void 0,
          onRequestPatch: typeof onRequestPatch !== "undefined" ? onRequestPatch : void 0,
          onRequestHead: typeof onRequestHead !== "undefined" ? onRequestHead : void 0,
          onRequestOptions: typeof onRequestOptions !== "undefined" ? onRequestOptions : void 0
        };
      })();
      enhancedRequest = await createEdgeoneCompatibleRequest(req, false);
      if (enhancedRequest._bodyReadError) {
        respondBodyReadError(req, res, enhancedRequest._bodyReadError, pathname2);
        console.log("Makers request path: " + fullPath + " |scfRequestId=" + (req.headers["x-scf-request-id"] || "") + "|statusCode=400|");
        return;
      }
      context = createCloudFunctionContext({
        req,
        safeGeo,
        request: enhancedRequest,
        params: {},
        conversation_id: agentConversationId
      });
      stripInternalRequestHeaders(req);
      try {
        const handler = (() => {
          const method = req.method;
          if (method === "GET" && mod_0.onRequestGet) {
            return mod_0.onRequestGet;
          } else if (method === "POST" && mod_0.onRequestPost) {
            return mod_0.onRequestPost;
          } else if (method === "PUT" && mod_0.onRequestPut) {
            return mod_0.onRequestPut;
          } else if (method === "DELETE" && mod_0.onRequestDelete) {
            return mod_0.onRequestDelete;
          } else if (method === "PATCH" && mod_0.onRequestPatch) {
            return mod_0.onRequestPatch;
          } else if (method === "HEAD" && mod_0.onRequestHead) {
            return mod_0.onRequestHead;
          } else if (method === "OPTIONS" && mod_0.onRequestOptions) {
            return mod_0.onRequestOptions;
          } else {
            return mod_0.onRequest;
          }
        })();
        if (handler) {
          response = await __edgeoneWithRestricted(req, () => handler(context));
          if (response && typeof response === "object" && response.websocket) {
            console.log("[WebSocket] WebSocket configuration detected for:", pathname2);
            const upgradeHeader = req.headers["upgrade"];
            if (upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
              console.log("[WebSocket] Executing WebSocket handshake...");
              try {
                const { WebSocketServer } = require_ws();
                const wss = new WebSocketServer({ noServer: true });
                wss.on("connection", (ws, request) => {
                  console.log("[WebSocket] Connection established");
                  if (response.websocket.onopen) {
                    try {
                      response.websocket.onopen(ws, request);
                    } catch (error) {
                      console.error("[WebSocket] Error in onopen:", error);
                    }
                  }
                  ws.on("message", (data, isBinary) => {
                    if (response.websocket.onmessage) {
                      try {
                        response.websocket.onmessage(ws, data, isBinary);
                      } catch (error) {
                        console.error("[WebSocket] Error in onmessage:", error);
                        ws.close(1011, "Internal error");
                      }
                    }
                  });
                  ws.on("close", (code, reason) => {
                    if (response.websocket.onclose) {
                      try {
                        response.websocket.onclose(ws, code, reason);
                      } catch (error) {
                        console.error("[WebSocket] Error in onclose:", error);
                      }
                    }
                  });
                  ws.on("error", (error) => {
                    if (response.websocket.onerror) {
                      try {
                        response.websocket.onerror(ws, error);
                      } catch (err) {
                        console.error("[WebSocket] Error in onerror:", err);
                      }
                    } else {
                      console.error("[WebSocket] Connection error:", error);
                    }
                  });
                });
                wss.handleUpgrade(req, req.socket, Buffer.alloc(0), (ws) => {
                  wss.emit("connection", ws, req);
                });
                console.log("[WebSocket] Handshake complete, connection established");
                return;
              } catch (wsError) {
                console.error("[WebSocket] Handshake error:", wsError);
                response = new Response(JSON.stringify({
                  error: "WebSocket Handshake Failed",
                  message: wsError.message
                }), {
                  status: 500,
                  headers: {
                    "Content-Type": "application/json"
                  }
                });
              }
            } else {
              response = new Response("WebSocket endpoint. Use ws:// protocol to connect.", {
                status: 426,
                headers: {
                  "Content-Type": "text/plain",
                  "Upgrade": "websocket"
                }
              });
            }
          }
        }
      } catch (handlerError) {
        console.log("Makers request path: " + fullPath + " |scfRequestId=" + (context.server ? context.server.requestId : "") + "|statusCode=502|");
        response = new Response(JSON.stringify({
          error: "Internal Server Error",
          message: handlerError.message
        }), {
          status: 502,
          headers: {
            "Content-Type": "application/json",
            // 'Functions-Request-Id': context.server ? context.server.requestId : '',
            "eo-pages-inner-scf-status": "502",
            "eo-pages-inner-status-intercept": "true"
          }
        });
      }
      const requestEndTime2 = Date.now();
      console.log("Makers request path: " + fullPath + " |scfRequestId=" + (context.server ? context.server.requestId : "") + "|statusCode=" + String((response == null ? void 0 : response.status) || 200) + "|");
      await handleResponse(res, response, getResponsePassHeaders(context, agentConversationId));
      return;
    }
    if (!response) {
      response = new Response(JSON.stringify({
        error: "Not Found",
        message: "The requested path does not exist"
      }), {
        status: 404,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    const requestEndTime = Date.now();
    if (!res.headers) {
      res.headers = {};
    }
    console.log(`Makers request path: ${fullPath} |scfRequestId=${scfRequestId}|statusCode=${(response == null ? void 0 : response.status) || 200}|`);
    await handleResponse(res, response, getResponsePassHeaders(context, agentConversationId));
  } catch (error) {
    console.error("server error", error);
    console.log("Makers request path: " + fullPath + " |scfRequestId=" + (req.headers["x-scf-request-id"] || "") + "|statusCode=502|");
    if (!req.headers["eo-pages-host"] || req.headers["eo-pages-host"] === "localhost:9000" || req.headers["eo-pages-host"] === "undefined" || req.headers["eo-pages-host"] === "null" || req.headers.host === "localhost:9000") {
      console.log(`Makers request info: ${JSON.stringify({
        host: req.headers.host,
        "user-agent": req.headers["user-agent"],
        "eo-pages-host": req.headers["eo-pages-host"],
        "eo-connecting-ip": req.headers["eo-connecting-ip"],
        "x-forwarded-for": req.headers["x-forwarded-for"],
        "x-real-ip": req.headers["x-real-ip"],
        "functions-request-id": req.headers["functions-request-id"],
        path: typeof pathname !== "undefined" ? pathname : void 0,
        url: req.url
      })}`);
    }
    res.writeHead(502, {
      "Content-Type": "application/json",
      "Functions-Request-Id": req.headers["x-scf-request-id"] || "",
      ...agentConversationId ? { [REQUEST_CONVERSATION_ID_HEADER]: agentConversationId } : {},
      "eo-pages-inner-scf-status": "502",
      "eo-pages-inner-status-intercept": "true"
    });
    res.end(JSON.stringify({
      error: "Internal Server Error",
      code: "FUNCTION_INVOCATION_FAILED",
      message: error.message,
      trace: error.stack
    }));
  }
});
server.headersTimeout = 0;
server.requestTimeout = 0;
server.listen(port, () => {
});
export {
  server
};
