#!/usr/bin/env node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [, , command, ...args] = process.argv;

function resolveLocalBin(name: string): string {
    const candidate = path.join(process.cwd(), "node_modules", ".bin", name);
    return fs.existsSync(candidate) ? candidate : name;
}

function isAvailable(name: string): boolean {
    return fs.existsSync(path.join(process.cwd(), "node_modules", ".bin", name));
}

function spawnProcess(cmd: string, cmdArgs: string[]): ChildProcess {
    const proc = spawn(cmd, cmdArgs, { stdio: "inherit", shell: process.platform === "win32" });
    proc.on("error", (err) => {
        console.error(`[rapidreact] Failed to start "${cmd}": ${err.message}`);
        process.exit(1);
    });
    return proc;
}

function runParallel(procs: Array<[string, string[]]>): void {
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

async function runSequential(procs: Array<[string, string[]]>): Promise<void> {
    for (const [cmd, cmdArgs] of procs) {
        await new Promise<void>((resolve, reject) => {
            const child = spawnProcess(resolveLocalBin(cmd), cmdArgs);
            child.on("exit", (code) => {
                if (code === 0) resolve();
                else reject(new Error(`"${cmd}" exited with code ${code}`));
            });
        });
    }
}

function findServerEntry(): string {
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

switch (command) {
    case "dev": {
        const serverEntry = args[0] ?? findServerEntry();
        console.log("[rapidreact] Starting in development mode...");

        // Prefer nodemon for clean process restarts; fall back to tsx --watch
        const useNodemon = isAvailable("nodemon");
        const serverWatcher: [string, string[]] = useNodemon
            ? ["nodemon", ["--exec", `tsx ${serverEntry}`, "--watch", "src", "--watch", "app", "--ext", "ts,tsx,json"]]
            : ["tsx", ["--watch", serverEntry]];

        console.log(`  Server: ${useNodemon ? `nodemon --exec "tsx ${serverEntry}"` : `tsx --watch ${serverEntry}`}`);
        console.log("  Client: vite build --watch");

        runParallel([serverWatcher, ["vite", ["build", "--watch"]]]);
        break;
    }

    case "build": {
        const tsconfigArg = args[0] ?? "tsconfig.json";
        console.log("[rapidreact] Building for production...");
        console.log(`  Server: tsc -p ${tsconfigArg}`);
        console.log("  Client: vite build");
        runSequential([
            ["tsc", ["-p", tsconfigArg]],
            ["vite", ["build"]],
        ]).catch((err) => {
            console.error(`[rapidreact] Build failed: ${err.message}`);
            process.exit(1);
        });
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

Examples:
  rapidreact dev
  rapidreact dev src/server.ts
  rapidreact build
  rapidreact build tsconfig.server.json
`);
        process.exit(1);
}
