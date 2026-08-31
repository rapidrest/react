#!/usr/bin/env node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import { isSafePathArg } from "./cli/validate.js";

export function resolveLocalBin(name: string): string {
    const candidate = path.join(process.cwd(), "node_modules", ".bin", name);
    return fs.existsSync(candidate) ? candidate : name;
}

export function isAvailable(name: string): boolean {
    return fs.existsSync(path.join(process.cwd(), "node_modules", ".bin", name));
}

export function spawnProcess(cmd: string, cmdArgs: string[], env?: Record<string, string>): ChildProcess {
    const proc = spawn(cmd, cmdArgs, { stdio: "inherit", ...(env ? { env: { ...process.env, ...env } } : {}) });
    proc.on("error", (err) => {
        console.error(`[rapidreact] Failed to start "${cmd}": ${err.message}`);
        process.exit(1);
    });
    return proc;
}

export function runParallel(procs: Array<[string, string[]]>): void {
    const children = procs.map(([cmd, cmdArgs]) => spawnProcess(resolveLocalBin(cmd), cmdArgs));

    const shutdown = () => {
        for (const child of children) {
            if (!child.killed) child.kill();
        }
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    let exited = 0;
    for (const child of children) {
        child.on("exit", (code) => {
            exited++;
            if (code !== 0 && code !== null) {
                console.error(`[rapidreact] Process exited with code ${code}. Shutting down.`);
                shutdown();
                process.exit(code);
            }
            if (exited === children.length) process.exit(0);
        });
    }
}

export async function runSequential(procs: Array<[string, string[], Record<string, string>?]>): Promise<void> {
    for (const [cmd, cmdArgs, env] of procs) {
        await new Promise<void>((resolve, reject) => {
            const child = spawnProcess(resolveLocalBin(cmd), cmdArgs, env);
            child.on("exit", (code) => {
                if (code === 0) resolve();
                else reject(new Error(`"${cmd}" exited with code ${code}`));
            });
        });
    }
}

export function findServerEntry(): string {
    const candidates = ["src/server.ts", "src/server.tsx", "src/index.ts", "src/index.tsx"];
    for (const candidate of candidates) {
        if (fs.existsSync(path.join(process.cwd(), candidate))) return candidate;
    }
    throw new Error(
        "[rapidreact] Could not find server entry point. " +
            "Expected one of: src/server.ts, src/server.tsx, src/index.ts, src/index.tsx. " +
            "Pass the path as an argument: rapidreact dev src/myserver.ts",
    );
}

export function findExportEntry(): string {
    const candidates = ["src/export.ts", "src/export.tsx"];
    for (const candidate of candidates) {
        if (fs.existsSync(path.join(process.cwd(), candidate))) return candidate;
    }
    throw new Error(
        "[rapidreact] Could not find a static export entry point. " +
            "Expected one of: src/export.ts, src/export.tsx. " +
            "Pass the path as an argument: rapidreact export src/myexport.ts. " +
            "See the README's Static Export section for how to write one.",
    );
}

/** Validates a path-shaped CLI argument, exiting with a labeled error if it's unsafe. */
function validatePathArgOrExit(value: string, label: string): void {
    if (!isSafePathArg(value)) {
        console.error(`[rapidreact] Invalid ${label}: "${value}"`);
        process.exit(1);
    }
}

/** Runs `steps` sequentially, exiting with a labeled error if any step fails. */
function runStepsOrExit(steps: Array<[string, string[], Record<string, string>?]>, label: string): void {
    runSequential(steps).catch((err) => {
        console.error(`[rapidreact] ${label} failed: ${err.message}`);
        process.exit(1);
    });
}

export function run(): void {
    const [, , command, ...args] = process.argv;
    switch (command) {
    case "dev": {
        const serverEntry = args[0] ?? findServerEntry();
        validatePathArgOrExit(serverEntry, "server entry path");
        console.log("[rapidreact] Starting in development mode...");

        // Prefer nodemon for clean process restarts; fall back to tsx --watch
        const useNodemon = isAvailable("nodemon");
        const serverWatcher: [string, string[]] = useNodemon
            ? ["nodemon", ["--exec", "tsx", "--watch", "src", "--watch", "apps", "--ext", "ts,tsx,json", serverEntry]]
            : ["tsx", ["--watch", serverEntry]];

        console.log(`  Server: ${useNodemon ? `nodemon --exec "tsx ${serverEntry}"` : `tsx --watch ${serverEntry}`}`);
        console.log("  Client: vite build --watch");

        runParallel([serverWatcher, ["vite", ["build", "--watch"]]]);
        break;
    }

    case "build": {
        const tsconfigArg = args[0] ?? "tsconfig.json";
        validatePathArgOrExit(tsconfigArg, "tsconfig path");
        const clientTsconfig = "tsconfig.client.json";
        const hasClientTsconfig = fs.existsSync(path.join(process.cwd(), clientTsconfig));
        console.log("[rapidreact] Building for production...");
        console.log(`  Server: tsc -p ${tsconfigArg}`);
        if (hasClientTsconfig) console.log(`  Pages:  tsc -p ${clientTsconfig}`);
        console.log("  Client: vite build");
        const steps: Array<[string, string[]]> = [["tsc", ["-p", tsconfigArg]]];
        if (hasClientTsconfig) steps.push(["tsc", ["-p", clientTsconfig]]);
        steps.push(["vite", ["build"]]);
        runStepsOrExit(steps, "Build");
        break;
    }

    case "export": {
        const exportEntry = args[0] ?? findExportEntry();
        validatePathArgOrExit(exportEntry, "export entry path");
        console.log("[rapidreact] Exporting static site...");
        console.log("  Client: vite build");
        console.log(`  Export: tsx ${exportEntry}`);
        runStepsOrExit([
            ["vite", ["build"]],
            ["tsx", [exportEntry], { NODE_ENV: "production" }],
        ], "Export");
        break;
    }

    default:
        console.error(`
Usage: rapidreact <command> [options]

Commands:
  dev [entry]       Start the server with live reload and Vite bundle watcher.
                    Uses nodemon (if installed) or tsx --watch for server restarts.
                    Uses vite build --watch to rebuild client bundles on app/ changes.
                    entry: server entry file path (default: auto-detected from src/)

  build [tsconfig]  Build for production: compile server with tsc, then bundle client with vite.
                    tsconfig: tsconfig file path (default: tsconfig.json)

  export [entry]    Crawl every app page and write a static HTML/CSS/JS site to disk.
                    Runs vite build, then the export entry with tsx (NODE_ENV=production).
                    entry: export entry file path (default: src/export.ts or src/export.tsx)
                    See the README's Static Export section for the entry file convention.

Examples:
  rapidreact dev
  rapidreact dev src/server.ts
  rapidreact build
  rapidreact build tsconfig.server.json
  rapidreact export
  rapidreact export src/myexport.ts
`);
        process.exit(1);
    }
}

/**
 * Resolves `p` to its real (symlink-free) path, or `null` if it doesn't exist / can't be
 * resolved. `process.argv[1]` is left exactly as invoked by the shell — unlike `import.meta.url`
 * for the entry module, which Node resolves through symlinks by default (i.e. without
 * `--preserve-symlinks-main`). A package-manager `.bin` entry (e.g. `node_modules/.bin/rapidreact`)
 * is a real symlink on Linux/macOS, so comparing the raw argv path against the resolved module
 * URL always mismatches there, even though it's a byte-for-byte identical invocation to running
 * the resolved file directly. Windows package managers instead generate a `.cmd`/shim file rather
 * than a symlink, so `argv[1]` is already the real path there — which is why this only ever broke
 * cross-platform, not on any single OS in isolation.
 */
function resolveRealPath(p: string): string | null {
    try {
        return fs.realpathSync(p);
    } catch {
        return null;
    }
}

// Only auto-run when this file is executed directly (the `rapidreact` bin entry),
// not when imported (e.g. by tests).
const isMainModule = !!process.argv[1] && fileURLToPath(import.meta.url) === resolveRealPath(process.argv[1]);
if (isMainModule) {
    run();
}
