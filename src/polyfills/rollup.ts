// Rollup polyfill that lazy-loads @rollup/browser from CDN

import * as acorn from "acorn";
import acornJsx from "acorn-jsx";
import {
  CDN_ROLLUP_BROWSER,
  PINNED_ROLLUP_BROWSER,
  cdnImport,
} from "../constants/cdn-urls";

// acorn parser extended with JSX support
const acornJsxParser = (acorn.Parser as any).extend(acornJsx());

let cachedRollup: unknown = null;
let loadingPromise: Promise<unknown> | null = null;

// injected by the script engine so bundle.write() can write to the VFS
let _vfsMkdirSync: ((path: string, opts?: { recursive?: boolean }) => void) | null = null;
let _vfsWriteFileSync: ((path: string, data: string | Uint8Array) => void) | null = null;

export function setVFSBridge(
  mkdirSync: (path: string, opts?: { recursive?: boolean }) => void,
  writeFileSync: (path: string, data: string | Uint8Array) => void,
): void {
  _vfsMkdirSync = mkdirSync;
  _vfsWriteFileSync = writeFileSync;
}

async function ensureRollup(): Promise<unknown> {
  if (cachedRollup) return cachedRollup;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      const mod = await cdnImport(CDN_ROLLUP_BROWSER);
      cachedRollup = mod;
      return mod;
    } catch (err) {
      loadingPromise = null;
      throw new Error(
        `rollup: failed to load @rollup/browser from CDN -- ${err}`,
      );
    }
  })();

  return loadingPromise;
}

export const VERSION: string = PINNED_ROLLUP_BROWSER;

// @rollup/browser blocks fs access in bundle.write() so we intercept it,
// call generate() instead, and write the output to the VFS ourselves
export async function rollup(inputOptions: unknown): Promise<unknown> {
  const r = (await ensureRollup()) as {
    rollup: (o: unknown) => Promise<unknown>;
  };
  const bundle = (await r.rollup(inputOptions)) as any;

  bundle.write = async function (outputOptions: any) {
    const result = await bundle.generate(outputOptions);

    const dir = outputOptions?.dir || "dist";
    if (!_vfsMkdirSync || !_vfsWriteFileSync) {
      throw new Error("rollup: VFS bridge not set up");
    }
    const mkdirSync = _vfsMkdirSync;
    const writeFileSync = _vfsWriteFileSync;

    try {
      mkdirSync(dir, { recursive: true });
    } catch { /* already exists */ }

    for (const chunk of result.output) {
      const filePath = dir + "/" + chunk.fileName;
      const fileDir = filePath.substring(0, filePath.lastIndexOf("/"));
      if (fileDir && fileDir !== dir) {
        try {
          mkdirSync(fileDir, { recursive: true });
        } catch { /* already exists */ }
      }

      if (chunk.type === "chunk") {
        writeFileSync(filePath, chunk.code);
        if (chunk.map) {
          writeFileSync(filePath + ".map", chunk.map.toString());
        }
      } else if (chunk.type === "asset") {
        writeFileSync(filePath, chunk.source);
      }
    }

    return result;
  };

  return bundle;
}

export async function watch(watchOptions: unknown): Promise<unknown> {
  const r = (await ensureRollup()) as { watch: (o: unknown) => unknown };
  return r.watch(watchOptions);
}

export function defineConfig<T>(config: T): T {
  return config;
}

// falls back to acorn-jsx if plain acorn fails (e.g. JSX in source)
export function parseAst(
  source: string,
  opts?: { allowReturnOutsideFunction?: boolean; jsx?: boolean },
): unknown {
  const parseOpts = {
    ecmaVersion: "latest" as const,
    sourceType: "module" as const,
    allowReturnOutsideFunction: opts?.allowReturnOutsideFunction ?? false,
    locations: true,
  };

  if (opts?.jsx) {
    return acornJsxParser.parse(source, parseOpts);
  }

  try {
    return acorn.parse(source, parseOpts);
  } catch {
    return acornJsxParser.parse(source, parseOpts);
  }
}

export async function parseAstAsync(
  source: string,
  opts?: {
    allowReturnOutsideFunction?: boolean;
    jsx?: boolean;
    signal?: AbortSignal;
  },
): Promise<unknown> {
  return parseAst(source, {
    allowReturnOutsideFunction: opts?.allowReturnOutsideFunction,
    jsx: opts?.jsx,
  });
}

// prevents "unsupported platform" error when Rollup probes for native bindings
export function getPackageBase(): string {
  return "";
}

export { ensureRollup as loadRollup };

export interface Plugin {
  name: string;
  [key: string]: unknown;
}

export interface PluginContext {
  meta: { rollupVersion: string };
  parse: (code: string) => unknown;
  [key: string]: unknown;
}

export default {
  VERSION,
  rollup,
  watch,
  defineConfig,
  parseAst,
  parseAstAsync,
  loadRollup: ensureRollup,
};
