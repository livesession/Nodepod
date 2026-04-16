// worker_threads polyfill using fork infrastructure for real Web Workers
// Enhanced with generic napi-rs WASI worker support


import { EventEmitter } from "./events";
import { ref as eventLoopRef, unref as eventLoopUnref } from "../helpers/event-loop";

// shared defaults for main thread; child workers get per-engine overrides via buildResolver
export let isMainThread = true;
export let parentPort: MessagePort | null = null;
export let workerData: unknown = null;
export let threadId = 0;

// fork callback, set by process-worker-entry.ts

export type WorkerThreadForkFn = (
  modulePath: string,
  opts: {
    workerData: unknown;
    threadId: number;
    isEval?: boolean;
    cwd: string;
    env: Record<string, string>;
    onMessage: (data: unknown) => void;
    onError: (err: Error) => void;
    onExit: (code: number) => void;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
  },
) => {
  postMessage: (data: unknown) => void;
  terminate: () => void;
  requestId: number;
};

let _workerThreadForkFn: WorkerThreadForkFn | null = null;

export function setWorkerThreadForkCallback(fn: WorkerThreadForkFn): void {
  _workerThreadForkFn = fn;
}

/**
 * Override the Worker constructor with a custom factory.
 * Used by the script-engine to inject PatchedWorker that supports napi-rs WASI workers.
 * The factory receives the same (script, opts) args as the Worker constructor.
 */
let _workerConstructorOverride: ((self: any, script: string | URL, opts?: any) => void) | null = null;

export function setWorkerConstructorOverride(fn: ((self: any, script: string | URL, opts?: any) => void) | null): void {
  _workerConstructorOverride = fn;
}

let _nextThreadId = 1;


export interface MessagePort extends EventEmitter {
  postMessage(_val: unknown, _transfer?: unknown[]): void;
  start(): void;
  close(): void;
  ref(): void;
  unref(): void;
}

interface MessagePortConstructor {
  new (): MessagePort;
  (this: any): void;
  prototype: any;
}

export const MessagePort = function MessagePort(this: any) {
  if (!this) return;
  EventEmitter.call(this);
} as unknown as MessagePortConstructor;

Object.setPrototypeOf(MessagePort.prototype, EventEmitter.prototype);

MessagePort.prototype.postMessage = function postMessage(_val: unknown, _transfer?: unknown[]): void {};
MessagePort.prototype.start = function start(): void {};
MessagePort.prototype.close = function close(): void {};
MessagePort.prototype.ref = function ref(): void {};
MessagePort.prototype.unref = function unref(): void {};


export interface MessageChannel {
  port1: MessagePort;
  port2: MessagePort;
}

interface MessageChannelConstructor {
  new (): MessageChannel;
  (this: any): void;
  prototype: any;
}

export const MessageChannel = function MessageChannel(this: any) {
  if (!this) return;
  this.port1 = new MessagePort();
  this.port2 = new MessagePort();

  // wire the two ports together
  const p1 = this.port1;
  const p2 = this.port2;
  p1.postMessage = (val: unknown) => {
    queueMicrotask(() => p2.emit("message", val));
  };
  p2.postMessage = (val: unknown) => {
    queueMicrotask(() => p1.emit("message", val));
  };
} as unknown as MessageChannelConstructor;


export interface Worker extends EventEmitter {
  threadId: number;
  resourceLimits: object;
  _handle: ReturnType<WorkerThreadForkFn> | null;
  _terminated: boolean;
  _isReffed: boolean;
  postMessage(value: unknown, _transferListOrOptions?: unknown): void;
  terminate(): Promise<number>;
  ref(): this;
  unref(): this;
  getHeapSnapshot(): Promise<unknown>;
}

interface WorkerConstructor {
  new (
    script: string | URL,
    opts?: {
      workerData?: unknown;
      eval?: boolean;
      env?: Record<string, string> | symbol;
      argv?: string[];
      execArgv?: string[];
      resourceLimits?: Record<string, number>;
      name?: string;
      transferList?: unknown[];
    },
  ): Worker;
  (this: any, script: string | URL, opts?: any): void;
  prototype: any;
}

export const Worker = function Worker(
  this: any,
  script: string | URL,
  opts?: {
    workerData?: unknown;
    eval?: boolean;
    env?: Record<string, string> | symbol;
    argv?: string[];
    execArgv?: string[];
    resourceLimits?: Record<string, number>;
    name?: string;
    transferList?: unknown[];
  },
) {
  if (!this) return;
  EventEmitter.call(this);

  this.threadId = _nextThreadId++;
  this.resourceLimits = {};
  this._handle = null;
  this._terminated = false;
  this._isReffed = false;

  // If a constructor override is installed (e.g. napi-rs WASI worker factory),
  // delegate to it. It handles both WASI workers (real Web Workers) and
  // standard workers (fallback to fork-based).
  if (_workerConstructorOverride) {
    _workerConstructorOverride(this, script, opts);
    return;
  }

  const scriptStr = typeof script === "string" ? script : script.href;
  const self = this;

  if (!_workerThreadForkFn) {
    // no fork callback wired
    queueMicrotask(() => {
      self.emit(
        "error",
        new Error(
          "[Nodepod] worker_threads.Worker requires worker mode. " +
            "Ensure the process is running in a worker context.",
        ),
      );
    });
    return;
  }

  const workerDataVal = opts?.workerData ?? null;
  const isEval = !!opts?.eval;
  const env =
    opts?.env && typeof opts.env !== "symbol"
      ? (opts.env as Record<string, string>)
      : {};

  const handle = _workerThreadForkFn(scriptStr, {
    workerData: workerDataVal,
    threadId: this.threadId,
    isEval,
    cwd: (globalThis as any).process?.cwd?.() ?? "/",
    env,
    onMessage: (data: unknown) => {
      self.emit("message", data);
    },
    onError: (err: Error) => {
      self.emit("error", err);
    },
    onExit: (code: number) => {
      if (self._isReffed) {
        self._isReffed = false;
        eventLoopUnref();
      }
      self._terminated = true;
      self.emit("exit", code);
    },
    onStdout: (data: string) => {
        const sink = (globalThis as any).process?.stdout?.write;
      if (typeof sink === "function") sink.call((globalThis as any).process.stdout, data);
    },
    onStderr: (data: string) => {
      const sink = (globalThis as any).process?.stderr?.write;
      if (typeof sink === "function") sink.call((globalThis as any).process.stderr, data);
    },
  });

  this._handle = handle;

  // keep parent alive while worker runs (Node.js default)
  this._isReffed = true;
  eventLoopRef();

  queueMicrotask(() => {
    if (!self._terminated) self.emit("online");
  });
} as unknown as WorkerConstructor;

Object.setPrototypeOf(Worker.prototype, EventEmitter.prototype);

Worker.prototype.postMessage = function postMessage(this: any, value: unknown, _transferListOrOptions?: unknown): void {
  if (this._handle && !this._terminated) {
    this._handle.postMessage(value);
  }
};

Worker.prototype.terminate = function terminate(this: any): Promise<number> {
  if (this._handle && !this._terminated) {
    if (this._isReffed) {
      this._isReffed = false;
      eventLoopUnref();
    }
    this._terminated = true;
    this._handle.terminate();
  }
  return Promise.resolve(0);
};

Worker.prototype.ref = function ref(this: any): any {
  if (!this._isReffed && !this._terminated) {
    this._isReffed = true;
    eventLoopRef();
  }
  return this;
};

Worker.prototype.unref = function unref(this: any): any {
  if (this._isReffed) {
    this._isReffed = false;
    eventLoopUnref();
  }
  return this;
};

Worker.prototype.getHeapSnapshot = function getHeapSnapshot(): Promise<unknown> {
  return Promise.resolve({});
};

// Support direct onmessage/onerror/onexit setters — napi-rs .wasi.cjs loaders
// use `worker.onmessage = ({data}) => ...` instead of `.on('message', ...)`.
// onmessage wraps the value in {data} to match the Web Worker MessageEvent shape,
// since napi-rs expects `({data}) => ...` destructuring.
{
  const _onmessageSym = Symbol("onmessage");
  const _onmessageWrapperSym = Symbol("onmessageWrapper");
  Object.defineProperty(Worker.prototype, "onmessage", {
    get() { return this[_onmessageSym] ?? null; },
    set(fn: Function | null) {
      // Remove previous wrapper
      if (this[_onmessageWrapperSym]) this.off("message", this[_onmessageWrapperSym]);
      this[_onmessageSym] = fn;
      if (fn) {
        // Wrap: emit {data} like Web Worker MessageEvent
        const wrapper = (val: unknown) => fn({ data: val });
        this[_onmessageWrapperSym] = wrapper;
        this.on("message", wrapper);
      } else {
        this[_onmessageWrapperSym] = null;
      }
    },
    configurable: true,
  });

  const _onerrorSym = Symbol("onerror");
  Object.defineProperty(Worker.prototype, "onerror", {
    get() { return this[_onerrorSym] ?? null; },
    set(fn: Function | null) {
      if (this[_onerrorSym]) this.off("error", this[_onerrorSym]);
      this[_onerrorSym] = fn;
      if (fn) this.on("error", fn);
    },
    configurable: true,
  });

  const _onexitSym = Symbol("onexit");
  Object.defineProperty(Worker.prototype, "onexit", {
    get() { return this[_onexitSym] ?? null; },
    set(fn: Function | null) {
      if (this[_onexitSym]) this.off("exit", this[_onexitSym]);
      this[_onexitSym] = fn;
      if (fn) this.on("exit", fn);
    },
    configurable: true,
  });
}


export interface BroadcastChannel extends EventEmitter {
  name: string;
  postMessage(_msg: unknown): void;
  close(): void;
  ref(): void;
  unref(): void;
}

interface BroadcastChannelConstructor {
  new (label: string): BroadcastChannel;
  (this: any, label: string): void;
  prototype: any;
}

export const BroadcastChannel = function BroadcastChannel(this: any, label: string) {
  if (!this) return;
  EventEmitter.call(this);
  this.name = label;
} as unknown as BroadcastChannelConstructor;

Object.setPrototypeOf(BroadcastChannel.prototype, EventEmitter.prototype);

BroadcastChannel.prototype.postMessage = function postMessage(_msg: unknown): void {};
BroadcastChannel.prototype.close = function close(): void {};
BroadcastChannel.prototype.ref = function ref(): void {};
BroadcastChannel.prototype.unref = function unref(): void {};


export function moveMessagePortToContext(
  port: MessagePort,
  _ctx: unknown,
): MessagePort {
  return port;
}

export function receiveMessageOnPort(
  _port: MessagePort,
): { message: unknown } | undefined {
  return undefined;
}

export const SHARE_ENV = Symbol.for("nodejs.worker_threads.SHARE_ENV");

export function markAsUntransferable(_obj: unknown): void {}
export function getEnvironmentData(_key: unknown): unknown {
  return undefined;
}
export function setEnvironmentData(_key: unknown, _val: unknown): void {}


export default {
  isMainThread,
  parentPort,
  workerData,
  threadId,
  Worker,
  MessageChannel,
  MessagePort,
  BroadcastChannel,
  moveMessagePortToContext,
  receiveMessageOnPort,
  SHARE_ENV,
  markAsUntransferable,
  getEnvironmentData,
  setEnvironmentData,
  setWorkerThreadForkCallback,
  setWorkerConstructorOverride,
};
