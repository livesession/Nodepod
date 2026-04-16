/**
 * napi-wasm-worker.ts
 *
 * Generic support for napi-rs WASM packages in nodepod.
 *
 * Every napi-rs v3 WASM package (targeting wasm32-wasip1-threads) generates
 * a `wasi-worker.mjs` script that needs to run in a real Web Worker to support
 * Atomics.wait() blocking. This module provides:
 *
 * 1. Detection of napi-rs WASI worker scripts
 * 2. Bundling of worker scripts + dependencies into self-contained blobs
 * 3. Creation of real Web Workers wrapping the Node.js worker_threads API
 *
 * This is GENERIC — no hardcoding for specific packages.
 */

import type { MemoryVolume } from "../memory-volume";
import { EventEmitter } from "../polyfills/events";
import { ref as eventLoopRef, unref as eventLoopUnref } from "./event-loop";

// ────────────────────────────────────────────────────────────────────────────
// Detection: is a given script path a napi-rs WASI worker?
// ────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if `scriptPath` is a wasi-worker script inside a node_modules
 * package that also contains a .wasm file (i.e., it's an napi-rs WASM package).
 *
 * Checks for the standard napi-rs generated filenames:
 * - wasi-worker.mjs
 * - wasi-worker-browser.mjs
 */
export function isNapiWasiWorkerScript(
  scriptPath: string,
  vol: MemoryVolume,
): boolean {
  const base = scriptPath.split("/").pop() ?? "";
  if (base !== "wasi-worker.mjs" && base !== "wasi-worker-browser.mjs") {
    return false;
  }
  // Check that the containing directory has a .wasm file
  const dir = scriptPath.substring(0, scriptPath.lastIndexOf("/"));
  try {
    const entries = vol.readdirSync(dir);
    return entries.some(
      (e: string) => e.endsWith(".wasm") || e.endsWith(".wasi.cjs"),
    );
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Bundle builder: collects a VFS entry point + all its deps into one script
// ────────────────────────────────────────────────────────────────────────────

/**
 * Builds a self-contained Web Worker script from a VFS entry point.
 * Recursively resolves imports/requires and bundles everything inline.
 */
export function buildNapiWorkerBundle(
  entryPath: string,
  vol: MemoryVolume,
  resolveModule: (id: string, fromDir: string) => string,
  processEnv: Record<string, string>,
): string {
  const modules = new Map<string, string>(); // resolvedPath → source code
  const moduleIds = new Map<string, number>(); // resolvedPath → numeric id
  let nextId = 0;
  const visited = new Set<string>();

  // Recursive dependency collector
  function collectDeps(filePath: string): void {
    if (visited.has(filePath)) return;
    visited.add(filePath);

    let source: string;
    try {
      const raw = vol.readFileSync(filePath);
      source =
        typeof raw === "string" ? raw : new TextDecoder().decode(raw as any);
    } catch {
      return; // skip unreadable files
    }

    const id = nextId++;
    moduleIds.set(filePath, id);
    modules.set(filePath, source);

    // Extract import/require targets (simplified but sufficient for napi-rs deps)
    const importRe =
      /(?:import\s+.*?\s+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)|export\s+.*?\s+from\s+['"]([^'"]+)['"])/g;
    let match: RegExpExecArray | null;
    const fromDir = filePath.substring(0, filePath.lastIndexOf("/")) || "/";

    while ((match = importRe.exec(source)) !== null) {
      const dep = match[1] || match[2] || match[3];
      if (!dep) continue;

      // Skip Node.js builtins — they'll be provided as stubs
      if (isBuiltin(dep)) continue;

      // Resolve the dependency
      try {
        const resolved = resolveModule(dep, fromDir);
        if (resolved && !isBuiltin(resolved)) {
          collectDeps(resolved);
        }
      } catch {
        // Unresolvable dependency — will be handled at runtime
      }
    }
  }

  collectDeps(entryPath);

  // Build the bundle
  const parts: string[] = [];

  // Preamble: minimal runtime stubs
  parts.push(WORKER_PREAMBLE(processEnv));

  // Module registry
  parts.push(`const __modules = {};`);
  parts.push(`const __moduleCache = {};`);

  // Register each collected module
  for (const [filePath, source] of modules) {
    const id = moduleIds.get(filePath)!;
    const dir = filePath.substring(0, filePath.lastIndexOf("/")) || "/";

    // Convert ESM to CJS-ish for the module wrapper
    let transformed = esmToCjs(source);

    parts.push(
      `__modules[${id}] = { dir: ${JSON.stringify(dir)}, path: ${JSON.stringify(filePath)}, fn: function(module, exports, require, __filename, __dirname) {\n${transformed}\n}};`,
    );
  }

  // Module path → id mapping
  parts.push(`const __pathToId = ${JSON.stringify(Object.fromEntries([...moduleIds.entries()]))};`);

  // require() implementation
  parts.push(REQUIRE_IMPL);

  // Entry point execution
  const entryId = moduleIds.get(entryPath);
  if (entryId !== undefined) {
    parts.push(`__require(${entryId});`);
  }

  return parts.join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// PatchedWorker: wraps a real Web Worker with Node.js worker_threads API
// ────────────────────────────────────────────────────────────────────────────

let _nextWasiThreadId = 100;

/**
 * Creates a PatchedWorker constructor that spawns real browser Web Workers
 * for napi-rs WASI worker scripts, falling back to the standard fork-based
 * worker for all other scripts.
 */
export function createNapiWorkerFactory(
  vol: MemoryVolume,
  resolveModule: (id: string, fromDir: string) => string,
  processEnv: Record<string, string>,
  fsBridge: any, // The fs bridge for handling __fs__ proxy messages
  fallbackWorkerFn: ((...args: any[]) => any) | null,
) {
  // Cache bundled scripts per entry path (they don't change at runtime)
  const bundleCache = new Map<string, string>();

  return function PatchedWorkerConstructor(
    this: any,
    script: string | URL,
    opts?: any,
  ) {
    const scriptStr = typeof script === "string" ? script : script.href;

    // Detect napi-rs WASI worker scripts
    if (isNapiWasiWorkerScript(scriptStr, vol)) {
      return createRealWebWorker.call(
        this,
        scriptStr,
        opts,
        vol,
        resolveModule,
        processEnv,
        fsBridge,
        bundleCache,
      );
    }

    // Non-WASI workers: fall back to standard fork-based worker
    if (!fallbackWorkerFn) {
      queueMicrotask(() => {
        this.emit?.(
          "error",
          new Error(
            "[Nodepod] worker_threads.Worker requires worker mode for non-WASI scripts.",
          ),
        );
      });
      return;
    }

    // Delegate to the standard fork path
    const workerDataVal = opts?.workerData ?? null;
    const isEval = !!opts?.eval;
    const env =
      opts?.env && typeof opts.env !== "symbol"
        ? (opts.env as Record<string, string>)
        : {};
    const self = this;

    const handle = fallbackWorkerFn(scriptStr, {
      workerData: workerDataVal,
      threadId: this.threadId,
      isEval,
      cwd: (globalThis as any).process?.cwd?.() ?? "/",
      env,
      onMessage: (data: unknown) => self.emit("message", data),
      onError: (err: Error) => self.emit("error", err),
      onExit: (code: number) => {
        if (self._isReffed) {
          self._isReffed = false;
          eventLoopUnref();
        }
        self._terminated = true;
        self.emit("exit", code);
      },
    });

    this._handle = handle;
    this._isReffed = true;
    eventLoopRef();
    queueMicrotask(() => {
      if (!self._terminated) self.emit("online");
    });
  };
}

/**
 * Creates a real browser Web Worker for a napi-rs WASI worker script.
 * The worker gets a bundled copy of the script + all its npm dependencies,
 * plus polyfills for Node.js builtins (worker_threads, path, fs, etc.)
 */
function createRealWebWorker(
  this: any,
  scriptPath: string,
  opts: any,
  vol: MemoryVolume,
  resolveModule: (id: string, fromDir: string) => string,
  processEnv: Record<string, string>,
  fsBridge: any,
  bundleCache: Map<string, string>,
) {
  const self = this;
  self.threadId = _nextWasiThreadId++;
  self.resourceLimits = {};
  self._handle = null;
  self._terminated = false;
  self._isReffed = false;

  // Build or retrieve cached bundle
  let bundleSource = bundleCache.get(scriptPath);
  if (!bundleSource) {
    try {
      bundleSource = buildNapiWorkerBundle(
        scriptPath,
        vol,
        resolveModule,
        processEnv,
      );
      bundleCache.set(scriptPath, bundleSource);
    } catch (err: any) {
      queueMicrotask(() =>
        self.emit(
          "error",
          new Error(`Failed to bundle WASI worker: ${err.message}`),
        ),
      );
      return;
    }
  }

  // Create blob URL and spawn real Web Worker
  let realWorker: globalThis.Worker;
  try {
    const blob = new Blob([bundleSource], { type: "application/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    realWorker = new globalThis.Worker(blobUrl, { name: `napi-wasi-${self.threadId}` });
    // Clean up blob URL after worker starts
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
  } catch (err: any) {
    queueMicrotask(() =>
      self.emit(
        "error",
        new Error(`Failed to create WASI Web Worker: ${err.message}`),
      ),
    );
    return;
  }

  // Bridge: real Web Worker ↔ Node.js Worker API
  realWorker.onmessage = (e: MessageEvent) => {
    const data = e.data;

    // Handle fs proxy requests from the worker (the __fs__ protocol)
    if (data && typeof data === "object" && data.__fs__) {
      handleFsProxy(data.__fs__, fsBridge);
      return;
    }

    self.emit("message", data);
  };

  realWorker.onerror = (e: ErrorEvent) => {
    self.emit("error", new Error(e.message || "Worker error"));
  };

  // Wire up the Worker API
  self._realWorker = realWorker;
  self.postMessage = (value: unknown, transferList?: unknown[]) => {
    if (!self._terminated) {
      realWorker.postMessage(value, transferList as Transferable[]);
    }
  };
  self.terminate = () => {
    if (!self._terminated) {
      if (self._isReffed) {
        self._isReffed = false;
        eventLoopUnref();
      }
      self._terminated = true;
      realWorker.terminate();
    }
    return Promise.resolve(0);
  };
  self.ref = () => {
    if (!self._isReffed && !self._terminated) {
      self._isReffed = true;
      eventLoopRef();
    }
    return self;
  };
  self.unref = () => {
    if (self._isReffed) {
      self._isReffed = false;
      eventLoopUnref();
    }
    return self;
  };

  // Start reffed (like Node.js)
  self._isReffed = true;
  eventLoopRef();

  queueMicrotask(() => {
    if (!self._terminated) self.emit("online");
  });
}

// ────────────────────────────────────────────────────────────────────────────
// FS Proxy handler: handles __fs__ messages from WASI workers
// ────────────────────────────────────────────────────────────────────────────

function handleFsProxy(
  req: { sab: Int32Array; type: string; payload: any[] },
  fsBridge: any,
): void {
  const { sab, type, payload } = req;
  try {
    const fn = fsBridge[type];
    if (typeof fn !== "function") {
      throw new Error(`fs.${type} is not a function`);
    }
    const result = fn.apply(fsBridge, payload);

    // Encode result into the SharedArrayBuffer
    const encoded = encodeValue(result);
    const resultType = getValueType(result);

    Atomics.store(sab, 1, resultType);
    Atomics.store(sab, 2, encoded.byteLength);
    // Write payload into the SharedArrayBuffer (bytes 16+)
    const payloadView = new Uint8Array(sab.buffer, 16, Math.min(encoded.byteLength, 10240));
    payloadView.set(encoded.subarray(0, payloadView.length));

    Atomics.store(sab, 0, 0); // success
  } catch (err: any) {
    // Encode error
    const errMsg = err?.message || String(err);
    const errCode = err?.code || "";
    const errObj = JSON.stringify({ message: errMsg, code: errCode });
    const encoded = new TextEncoder().encode(errObj);

    Atomics.store(sab, 1, 6); // type = json/object
    Atomics.store(sab, 2, encoded.byteLength);
    const payloadView = new Uint8Array(sab.buffer, 16, Math.min(encoded.byteLength, 10240));
    payloadView.set(encoded.subarray(0, payloadView.length));

    Atomics.store(sab, 0, 1); // error
  } finally {
    Atomics.notify(sab, 0);
  }
}

function getValueType(v: unknown): number {
  if (v === undefined) return 0;
  if (v === null) return 1;
  if (typeof v === "boolean") return 2;
  if (typeof v === "number") return 3;
  if (typeof v === "string") return 4;
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) return 5; // buffer
  if (typeof v === "bigint") return 9;
  return 6; // json/object
}

function encodeValue(v: unknown): Uint8Array {
  const enc = new TextEncoder();
  if (v === undefined || v === null) return new Uint8Array(0);
  if (typeof v === "boolean") return enc.encode(v ? "1" : "0");
  if (typeof v === "number") return enc.encode(String(v));
  if (typeof v === "string") return enc.encode(v);
  if (typeof v === "bigint") return enc.encode(v.toString());
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  // Object — serialize as JSON
  try {
    return enc.encode(JSON.stringify(v));
  } catch {
    return enc.encode("{}");
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster",
  "console", "constants", "crypto", "dgram", "dns", "domain",
  "events", "fs", "http", "http2", "https", "inspector", "module",
  "net", "os", "path", "perf_hooks", "process", "punycode",
  "querystring", "readline", "repl", "stream", "string_decoder",
  "test", "timers", "tls", "trace_events", "tty", "url", "util",
  "v8", "vm", "wasi", "worker_threads", "zlib",
]);

function isBuiltin(id: string): boolean {
  const bare = id.replace(/^node:/, "");
  return NODE_BUILTINS.has(bare);
}

/**
 * Minimal ESM → CJS conversion for worker bundling.
 * Handles the patterns used by @emnapi/*, @napi-rs/*, @tybys/* packages.
 */
function esmToCjs(source: string): string {
  let out = source;

  // import X from 'Y' → const X = require('Y')
  out = out.replace(
    /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    "const $1 = require('$2');",
  );

  // import { A, B } from 'Y' → const { A, B } = require('Y')
  out = out.replace(
    /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    "const {$1} = require('$2');",
  );

  // import * as X from 'Y' → const X = require('Y')
  out = out.replace(
    /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    "const $1 = require('$2');",
  );

  // import 'Y' → require('Y')
  out = out.replace(
    /import\s+['"]([^'"]+)['"]\s*;?/g,
    "require('$1');",
  );

  // Remove `const require = createRequire(...)` — the module wrapper already
  // provides `require` as a parameter. This line is common in napi-rs wasi-worker
  // scripts and causes "Identifier 'require' has already been declared".
  out = out.replace(
    /(?:const|let|var)\s+require\s*=\s*createRequire\s*\([^)]*\)\s*;?/g,
    "/* require provided by wrapper */",
  );

  // In real Web Workers, `self` is a read-only getter on WorkerGlobalScope.
  // napi-rs wasi-worker scripts do Object.assign(globalThis, {self: globalThis, ...})
  // which throws. Remove `self: globalThis` since self already === globalThis in Workers.
  out = out.replace(/self:\s*globalThis\s*,?/g, "/* self already set in Worker */ ");

  // export default X → module.exports.default = X; module.exports = module.exports.default
  out = out.replace(
    /export\s+default\s+/g,
    "module.exports.default = ",
  );

  // export { A, B } → module.exports.A = A; module.exports.B = B
  out = out.replace(
    /export\s+\{([^}]+)\}\s*;?/g,
    (_, names) => {
      return names
        .split(",")
        .map((n: string) => {
          const trimmed = n.trim();
          const asMatch = trimmed.match(/(\w+)\s+as\s+(\w+)/);
          if (asMatch) return `module.exports.${asMatch[2]} = ${asMatch[1]};`;
          return `module.exports.${trimmed} = ${trimmed};`;
        })
        .join("\n");
    },
  );

  // export const/let/var/function/class X
  out = out.replace(
    /export\s+(const|let|var|function|class)\s+(\w+)/g,
    "$1 $2; module.exports.$2 = $2; $1 $2",
  );
  // Clean up double declarations from the above
  out = out.replace(
    /(const|let|var)\s+(\w+);\s*module\.exports\.\2\s*=\s*\2;\s*\1\s+\2/g,
    "$1 $2",
  );

  // export { X } from 'Y' → Object.assign(module.exports, require('Y'))
  out = out.replace(
    /export\s+\*\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    "Object.assign(module.exports, require('$1'));",
  );

  // export { A } from 'Y'
  out = out.replace(
    /export\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    (_, names, mod) => {
      return names
        .split(",")
        .map((n: string) => {
          const trimmed = n.trim();
          const asMatch = trimmed.match(/(\w+)\s+as\s+(\w+)/);
          if (asMatch) return `module.exports.${asMatch[2]} = require('${mod}').${asMatch[1]};`;
          return `module.exports.${trimmed} = require('${mod}').${trimmed};`;
        })
        .join("\n");
    },
  );

  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Worker preamble: minimal Node.js stubs for running inside a Web Worker
// ────────────────────────────────────────────────────────────────────────────

function WORKER_PREAMBLE(env: Record<string, string>): string {
  return `
// === nodepod napi-rs WASI worker preamble ===
"use strict";

// Bridge parentPort ↔ Web Worker message API
const __parentPortListeners = [];
const __parentPort = {
  on(event, fn) {
    if (event === 'message') __parentPortListeners.push(fn);
    return __parentPort;
  },
  once(event, fn) {
    if (event === 'message') {
      const wrapped = (data) => { fn(data); const idx = __parentPortListeners.indexOf(wrapped); if (idx >= 0) __parentPortListeners.splice(idx, 1); };
      __parentPortListeners.push(wrapped);
    }
    return __parentPort;
  },
  off(event, fn) {
    if (event === 'message') {
      const idx = __parentPortListeners.indexOf(fn);
      if (idx >= 0) __parentPortListeners.splice(idx, 1);
    }
    return __parentPort;
  },
  removeListener(event, fn) { return __parentPort.off(event, fn); },
  addListener(event, fn) { return __parentPort.on(event, fn); },
  emit(event, ...args) {
    if (event === 'message') __parentPortListeners.forEach(fn => fn(...args));
    return true;
  },
  postMessage(data, transfer) { self.postMessage(data, transfer || []); },
  ref() {},
  unref() {},
  removeAllListeners() { __parentPortListeners.length = 0; return __parentPort; },
};

// Process stub
const process = {
  env: ${JSON.stringify(env)},
  cwd() { return "/"; },
  platform: "wasi",
  arch: "wasm32",
  version: "v20.0.0",
  versions: { node: "20.0.0" },
  exit(code) { throw new Error("process.exit(" + code + ")"); },
  nextTick(fn, ...args) { queueMicrotask(() => fn(...args)); },
  stdout: { write(s) { console.log(s); }, isTTY: false },
  stderr: { write(s) { console.error(s); }, isTTY: false },
  pid: 1,
  ppid: 0,
  argv: [],
  execArgv: [],
};
globalThis.process = process;

// Web Worker globals that napi-rs wasi-worker expects.
// self is already globalThis in a Web Worker (read-only getter, cannot set).
try { if (!globalThis.Worker) globalThis.Worker = class Worker {}; } catch {}
try { if (!globalThis.importScripts) globalThis.importScripts = function(f) {}; } catch {};

// parentPort bridge: route Web Worker messages to parentPort listeners
self.onmessage = function(e) {
  // Forward to globalThis.onmessage if user code sets it
  if (typeof globalThis.__userOnMessage === 'function') {
    globalThis.__userOnMessage(e);
  }
  __parentPortListeners.forEach(fn => fn(e.data));
};

// Override globalThis.onmessage setter to capture user handler
let __userOnMessageFn = null;
Object.defineProperty(globalThis, 'onmessage', {
  get() { return __userOnMessageFn; },
  set(fn) {
    __userOnMessageFn = fn;
    globalThis.__userOnMessage = fn;
  },
  configurable: true,
});

globalThis.postMessage = function(data, transfer) {
  self.postMessage(data, transfer || []);
};

// Minimal require for node builtins used by wasi-worker scripts
const __builtinRequire = function(id) {
  const bare = id.replace(/^node:/, '');
  if (bare === 'worker_threads') {
    return {
      parentPort: __parentPort,
      isMainThread: false,
      workerData: null,
      threadId: ${_nextWasiThreadId},
      Worker: globalThis.Worker,
      MessageChannel: globalThis.MessageChannel || class MessageChannel {
        constructor() { this.port1 = {}; this.port2 = {}; }
      },
      MessagePort: class MessagePort {},
    };
  }
  if (bare === 'path') return __pathStub;
  if (bare === 'fs') return __fsStub;
  if (bare === 'os') return __osStub;
  if (bare === 'url') return __urlStub;
  if (bare === 'util') return __utilStub;
  if (bare === 'events') return __eventsStub;
  if (bare === 'wasi') return __wasiStub;
  if (bare === 'buffer') return { Buffer: __BufferStub };
  if (bare === 'string_decoder') return { StringDecoder: class StringDecoder { write(buf) { return new TextDecoder().decode(buf); } end() { return ''; } } };
  if (bare === 'assert') return Object.assign(function assert(v, msg) { if (!v) throw new Error(msg || 'assertion failed'); }, { ok(v,m){if(!v) throw new Error(m);}, strictEqual(a,b,m){if(a!==b) throw new Error(m);}, deepStrictEqual(){} });
  return {};
};

// path stub
const __pathStub = {
  join(...parts) { return parts.join('/').replace(/\\/\\/+/g, '/'); },
  resolve(...parts) { return __pathStub.join(...parts); },
  dirname(p) { return p.substring(0, p.lastIndexOf('/')) || '/'; },
  basename(p, ext) { const b = p.split('/').pop() || ''; return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; },
  extname(p) { const d = p.lastIndexOf('.'); return d > p.lastIndexOf('/') ? p.slice(d) : ''; },
  normalize(p) { return p.replace(/\\/\\/+/g, '/'); },
  isAbsolute(p) { return p.startsWith('/'); },
  relative(from, to) { return to; },
  parse(p) {
    const lastSlash = p.lastIndexOf('/');
    const base = lastSlash >= 0 ? p.slice(lastSlash + 1) : p;
    const dotIdx = base.lastIndexOf('.');
    return {
      root: p.startsWith('/') ? '/' : '',
      dir: lastSlash >= 0 ? p.slice(0, lastSlash) : '',
      base: base,
      ext: dotIdx > 0 ? base.slice(dotIdx) : '',
      name: dotIdx > 0 ? base.slice(0, dotIdx) : base,
    };
  },
  format(obj) { return (obj.dir ? obj.dir + '/' : '') + (obj.base || obj.name + (obj.ext || '')); },
  sep: '/',
  delimiter: ':',
  posix: null,
};
__pathStub.posix = __pathStub;

// fs stub (operations go through __fs__ proxy to main thread)
const __fsStub = {
  readFileSync() { throw new Error('fs.readFileSync not available in WASI worker'); },
  existsSync() { return false; },
};

// os stub
const __osStub = {
  cpus() { return [{ model: 'wasm', speed: 0, times: {} }]; },
  platform() { return 'linux'; },
  arch() { return 'wasm32'; },
  homedir() { return '/'; },
  tmpdir() { return '/tmp'; },
  hostname() { return 'nodepod'; },
  type() { return 'Linux'; },
  release() { return '0.0.0'; },
  totalmem() { return 1073741824; },
  freemem() { return 536870912; },
  EOL: '\\n',
  endianness() { return 'LE'; },
};

// url stub
const __urlStub = {
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  fileURLToPath(u) {
    try { return decodeURIComponent(new URL(u).pathname); }
    catch { return u; }
  },
  pathToFileURL(p) { return new URL('file://' + p); },
};

// util stub
const __utilStub = {
  inherits(ctor, superCtor) { Object.setPrototypeOf(ctor.prototype, superCtor.prototype); },
  types: { isTypedArray(v) { return ArrayBuffer.isView(v); }, isUint8Array(v) { return v instanceof Uint8Array; } },
  promisify(fn) { return function(...args) { return new Promise((res, rej) => fn(...args, (err, val) => err ? rej(err) : res(val))); }; },
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
  deprecate(fn) { return fn; },
};

// events stub
const __eventsStub = {
  EventEmitter: class EventEmitter {
    constructor() { this._e = {}; }
    on(n, f) { (this._e[n] = this._e[n] || []).push(f); return this; }
    off(n, f) { const a = this._e[n]; if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } return this; }
    once(n, f) { const w = (...args) => { this.off(n, w); f(...args); }; this.on(n, w); return this; }
    emit(n, ...args) { (this._e[n] || []).forEach(f => f(...args)); return !!this._e[n]?.length; }
    removeListener(n, f) { return this.off(n, f); }
    addListener(n, f) { return this.on(n, f); }
    removeAllListeners(n) { if (n) delete this._e[n]; else this._e = {}; return this; }
    listeners(n) { return this._e[n] || []; }
    listenerCount(n) { return (this._e[n] || []).length; }
    setMaxListeners() { return this; }
    getMaxListeners() { return 10; }
    prependListener(n, f) { (this._e[n] = this._e[n] || []).unshift(f); return this; }
    prependOnceListener(n, f) { const w = (...args) => { this.off(n, w); f(...args); }; this.prependListener(n, w); return this; }
    eventNames() { return Object.keys(this._e); }
    rawListeners(n) { return this._e[n] || []; }
  }
};
__eventsStub.default = __eventsStub.EventEmitter;

// Buffer stub
const __BufferStub = {
  from(src, enc, len) {
    if (typeof src === 'string') return new TextEncoder().encode(src);
    if (src instanceof ArrayBuffer || src instanceof SharedArrayBuffer) {
      return new Uint8Array(src, typeof enc === 'number' ? enc : 0, len);
    }
    if (src instanceof Uint8Array) return new Uint8Array(src);
    return new Uint8Array(src || []);
  },
  alloc(len, fill) { const b = new Uint8Array(len); if (fill) b.fill(fill); return b; },
  allocUnsafe(len) { return new Uint8Array(len); },
  isBuffer(v) { return v instanceof Uint8Array; },
  isEncoding() { return true; },
  concat(list, totalLen) {
    if (!totalLen) totalLen = list.reduce((s, b) => s + b.length, 0);
    const out = new Uint8Array(totalLen); let off = 0;
    for (const b of list) { out.set(b, off); off += b.length; }
    return out;
  },
  byteLength(s, enc) { return new TextEncoder().encode(s).length; },
};

// Real WASI preview1 implementation for worker threads.
// Provides all required syscalls so WASM modules can initialize.
const __wasiStub = { WASI: class WASI {
  constructor(opts) {
    this._opts = opts || {};
    this._env = this._opts.env || {};
    this._args = this._opts.args || [];
    this._preopens = [];
    this._memory = null;
    this._instance = null;
    this._nextFd = 3;
    this._fds = new Map([[0, 'stdin'], [1, 'stdout'], [2, 'stderr']]);
    const po = this._opts.preopens || {};
    for (const [virt, real] of Object.entries(po)) {
      const fd = this._nextFd++;
      this._preopens.push({ fd, virtualPath: virt, realPath: real });
      this._fds.set(fd, { kind: 'dir', path: virt });
    }
  }
  initialize(inst) {
    this._instance = inst;
    this._memory = inst.exports.memory;
    const _init = inst.exports._initialize;
    if (typeof _init === 'function') _init();
  }
  start(inst) { this.initialize(inst); return 0; }
  getImportObject() { return { wasi_snapshot_preview1: this._buildImports() }; }
  get wasiImport() { return this._buildImports(); }
  _view() { return new DataView(this._memory.buffer); }
  _bytes() { return new Uint8Array(this._memory.buffer); }
  _buildImports() {
    const E = { SUCCESS: 0, BADF: 8, INVAL: 28, NOENT: 44, NOSYS: 52, IO: 29, ISDIR: 31, NOTDIR: 54, NOTEMPTY: 55, ACCES: 2, EXIST: 20 };
    const self = this;
    const enc = new TextEncoder();
    return {
      args_get(argv, buf) { const dv = self._view(); const b = self._bytes(); let off = buf; for (let i = 0; i < self._args.length; i++) { dv.setUint32(argv + i * 4, off, true); const a = enc.encode(self._args[i] + '\\0'); b.set(a, off); off += a.length; } return E.SUCCESS; },
      args_sizes_get(argc_out, bufsz_out) { const dv = self._view(); dv.setUint32(argc_out, self._args.length, true); let sz = 0; for (const a of self._args) sz += enc.encode(a).length + 1; dv.setUint32(bufsz_out, sz, true); return E.SUCCESS; },
      environ_get(env_ptr, buf) { const dv = self._view(); const b = self._bytes(); let off = buf; let i = 0; for (const [k, v] of Object.entries(self._env)) { dv.setUint32(env_ptr + i * 4, off, true); const e = enc.encode(k + '=' + v + '\\0'); b.set(e, off); off += e.length; i++; } return E.SUCCESS; },
      environ_sizes_get(count_out, bufsz_out) { const dv = self._view(); const entries = Object.entries(self._env); dv.setUint32(count_out, entries.length, true); let sz = 0; for (const [k, v] of entries) sz += enc.encode(k + '=' + v).length + 1; dv.setUint32(bufsz_out, sz, true); return E.SUCCESS; },
      clock_time_get(id, precision, time_out) { const dv = self._view(); const now = BigInt(Math.round(performance.now() * 1e6)); dv.setBigUint64(time_out, now, true); return E.SUCCESS; },
      clock_res_get(id, res_out) { const dv = self._view(); dv.setBigUint64(res_out, BigInt(1000000), true); return E.SUCCESS; },
      fd_prestat_get(fd, buf) { const p = self._preopens.find(x => x.fd === fd); if (!p) return E.BADF; const dv = self._view(); dv.setUint8(buf, 0); dv.setUint32(buf + 4, enc.encode(p.virtualPath).length, true); return E.SUCCESS; },
      fd_prestat_dir_name(fd, path, len) { const p = self._preopens.find(x => x.fd === fd); if (!p) return E.BADF; const e = enc.encode(p.virtualPath); self._bytes().set(e.subarray(0, Math.min(e.length, len)), path); return E.SUCCESS; },
      fd_fdstat_get(fd, buf) { const dv = self._view(); dv.setUint8(buf, fd <= 2 ? 2 : 3); dv.setUint16(buf + 2, 0, true); dv.setBigUint64(buf + 8, BigInt(0), true); dv.setBigUint64(buf + 16, BigInt(0), true); return E.SUCCESS; },
      fd_fdstat_set_flags() { return E.SUCCESS; },
      fd_fdstat_set_rights() { return E.SUCCESS; },
      fd_write(fd, iovs, iovs_len, nwritten) { const dv = self._view(); const b = self._bytes(); let total = 0; for (let i = 0; i < iovs_len; i++) { const ptr = dv.getUint32(iovs + i * 8, true); const len = dv.getUint32(iovs + i * 8 + 4, true); const chunk = b.slice(ptr, ptr + len); const txt = new TextDecoder().decode(chunk); if (fd === 1) console.log(txt); else if (fd === 2) console.error(txt); total += len; } dv.setUint32(nwritten, total, true); return E.SUCCESS; },
      fd_read(fd, iovs, iovs_len, nread) { const dv = self._view(); dv.setUint32(nread, 0, true); return E.SUCCESS; },
      fd_close(fd) { self._fds.delete(fd); return E.SUCCESS; },
      fd_seek(fd, offset, whence, newoff) { const dv = self._view(); dv.setBigUint64(newoff, BigInt(0), true); return E.SUCCESS; },
      fd_tell(fd, off) { const dv = self._view(); dv.setBigUint64(off, BigInt(0), true); return E.SUCCESS; },
      fd_sync() { return E.SUCCESS; },
      fd_datasync() { return E.SUCCESS; },
      fd_advise() { return E.SUCCESS; },
      fd_allocate() { return E.SUCCESS; },
      fd_filestat_get(fd, buf) { const dv = self._view(); const now = BigInt(Date.now()) * BigInt(1000000); for (let i = 0; i < 64; i++) dv.setUint8(buf + i, 0); dv.setUint8(buf + 16, fd <= 2 ? 2 : 3); dv.setBigUint64(buf + 48, now, true); dv.setBigUint64(buf + 56, now, true); return E.SUCCESS; },
      fd_filestat_set_size() { return E.SUCCESS; },
      fd_filestat_set_times() { return E.SUCCESS; },
      fd_pread() { return E.NOSYS; },
      fd_pwrite() { return E.NOSYS; },
      fd_readdir(fd, buf, buf_len, cookie, used) { const dv = self._view(); dv.setUint32(used, 0, true); return E.SUCCESS; },
      fd_renumber() { return E.NOSYS; },
      path_create_directory() { return E.NOSYS; },
      path_filestat_get(fd, flags, path_ptr, path_len, buf) { const dv = self._view(); const now = BigInt(Date.now()) * BigInt(1000000); for (let i = 0; i < 64; i++) dv.setUint8(buf + i, 0); dv.setUint8(buf + 16, 3); dv.setBigUint64(buf + 48, now, true); dv.setBigUint64(buf + 56, now, true); return E.SUCCESS; },
      path_filestat_set_times() { return E.SUCCESS; },
      path_link() { return E.NOSYS; },
      path_open(fd, dirflags, path_ptr, path_len, oflags, fs_rights_base, fs_rights_inheriting, fdflags, fd_out) { const dv = self._view(); const newFd = self._nextFd++; self._fds.set(newFd, { kind: 'file' }); dv.setUint32(fd_out, newFd, true); return E.SUCCESS; },
      path_readlink() { return E.NOSYS; },
      path_remove_directory() { return E.NOSYS; },
      path_rename() { return E.NOSYS; },
      path_symlink() { return E.NOSYS; },
      path_unlink_file() { return E.NOSYS; },
      poll_oneoff(in_ptr, out_ptr, nsubs, nevents_out) { const dv = self._view(); let n = 0; for (let i = 0; i < nsubs; i++) { const sp = in_ptr + i * 48; const ep = out_ptr + n * 32; const ud = dv.getBigUint64(sp, true); const ty = dv.getUint8(sp + 8); dv.setBigUint64(ep, ud, true); dv.setUint16(ep + 8, 0, true); dv.setUint8(ep + 10, ty); n++; } dv.setUint32(nevents_out, n, true); return E.SUCCESS; },
      proc_exit(code) { throw new Error('proc_exit(' + code + ')'); },
      proc_raise() { return E.NOSYS; },
      sched_yield() { return E.SUCCESS; },
      random_get(buf_ptr, buf_len) {
        const mem = self._memory;
        if (mem.buffer instanceof SharedArrayBuffer) {
          const tmp = new Uint8Array(buf_len); crypto.getRandomValues(tmp);
          new Uint8Array(mem.buffer).set(tmp, buf_ptr);
        } else {
          crypto.getRandomValues(new Uint8Array(mem.buffer, buf_ptr, buf_len));
        }
        return E.SUCCESS;
      },
      sock_recv() { return E.NOSYS; },
      sock_send() { return E.NOSYS; },
      sock_shutdown() { return E.NOSYS; },
      sock_accept() { return E.NOSYS; },
    };
  }
} };

// === end preamble ===
`;
}

// require() implementation for the bundled worker
const REQUIRE_IMPL = `
let __requireDepth = 0;
function __require(idOrPath) {
  __requireDepth++;
  if (__requireDepth > 100) {
    __requireDepth--;
    console.error('[worker] require depth > 100, circular dep? id=' + idOrPath);
    return {};
  }
  try { return __requireInner(idOrPath); } finally { __requireDepth--; }
}
function __requireInner(idOrPath) {
  // Numeric id → direct module lookup
  if (typeof idOrPath === 'number') {
    if (__moduleCache[idOrPath]) return __moduleCache[idOrPath].exports;
    const mod = __modules[idOrPath];
    if (!mod) throw new Error('Module not found: ' + idOrPath);
    const m = { exports: {}, id: mod.path, filename: mod.path, loaded: false };
    __moduleCache[idOrPath] = m;
    const localRequire = function(dep) {
      // Node builtins — check once, always return result (even empty object)
      const bare = dep.replace(/^node:/, '');
      const builtin = __builtinRequire(bare);
      if (builtin !== undefined) return builtin;
      // Resolve relative paths
      if (dep.startsWith('./') || dep.startsWith('../')) {
        const resolved = __resolvePath(mod.dir, dep);
        const resolvedId = __pathToId[resolved];
        if (resolvedId !== undefined) return __require(resolvedId);
        // Try with extensions
        for (const ext of ['.js', '.cjs', '.mjs', '.json', '/index.js', '/index.cjs', '/index.mjs']) {
          const withExt = __pathToId[resolved + ext];
          if (withExt !== undefined) return __require(withExt);
        }
        throw new Error('Cannot find module: ' + dep + ' from ' + mod.dir);
      }
      // Bare specifier: search in collected modules
      for (const [p, id] of Object.entries(__pathToId)) {
        if (p.includes('/node_modules/' + dep + '/') || p.endsWith('/node_modules/' + dep)) {
          return __require(id);
        }
        // Check package.json main field
        if (p.includes('/' + dep + '/') && (p.endsWith('/index.js') || p.endsWith('/index.cjs'))) {
          return __require(id);
        }
      }
      // Fall back to empty object for unknown modules (don't crash)
      console.warn('[worker] Unknown module: ' + dep);
      return {};
    };
    localRequire.resolve = function(id) { return id; };
    mod.fn(m, m.exports, localRequire, mod.path, mod.dir);
    m.loaded = true;
    return m.exports;
  }
  // String path → lookup in pathToId
  const id = __pathToId[idOrPath];
  if (id !== undefined) return __require(id);
  // Try builtin
  return __builtinRequire(idOrPath) || {};
}

function __resolvePath(base, rel) {
  const parts = (base + '/' + rel).split('/');
  const out = [];
  for (const seg of parts) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return '/' + out.join('/');
}
`;
