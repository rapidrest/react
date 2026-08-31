///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { vi } from "vitest";
import spawn from "cross-spawn";
import {
    findExportEntry,
    findServerEntry,
    isAvailable,
    resolveLocalBin,
    run,
    runParallel,
    runSequential,
    spawnProcess,
} from "../src/cli.js";

vi.mock("cross-spawn", () => ({ default: vi.fn() }));

// Symlink creation needs elevated privileges on Windows outside of Developer Mode; probe once so
// the symlink-specific regression test below can skip itself there instead of failing on an
// environment limitation unrelated to what it's actually testing.
const canSymlink = (() => {
    try {
        const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rapidreact-cli-symlink-probe-"));
        const target = path.join(probeDir, "target");
        fs.writeFileSync(target, "");
        fs.symlinkSync(target, path.join(probeDir, "link"));
        fs.rmSync(probeDir, { recursive: true, force: true });
        return true;
    } catch {
        return false;
    }
})();

class ProcessExitSignal extends Error {
    constructor(public code: number) {
        super(`process.exit(${code})`);
    }
}

class FakeChildProcess extends EventEmitter {
    public killed = false;
    public kill = vi.fn(() => {
        this.killed = true;
    });
}

describe("cli", () => {
    let tmpDir: string;
    let originalArgv: string[];
    let cwdSpy: ReturnType<typeof vi.spyOn>;
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let logSpy: ReturnType<typeof vi.spyOn>;
    let errSpy: ReturnType<typeof vi.spyOn>;
    let preexistingSigint: ((...args: any[]) => void)[];
    let preexistingSigterm: ((...args: any[]) => void)[];
    const children: FakeChildProcess[] = [];

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rapidreact-cli-"));
        originalArgv = process.argv;
        preexistingSigint = [...process.listeners("SIGINT")] as any;
        preexistingSigterm = [...process.listeners("SIGTERM")] as any;

        cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
        exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
            throw new ProcessExitSignal(code ?? 0);
        }) as any);
        logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        children.length = 0;
        vi.mocked(spawn).mockReset();
        vi.mocked(spawn).mockImplementation(() => {
            const child = new FakeChildProcess();
            children.push(child);
            return child as any;
        });
    });

    afterEach(() => {
        process.argv = originalArgv;
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        logSpy.mockRestore();
        errSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });

        for (const l of process.listeners("SIGINT")) {
            if (!preexistingSigint.includes(l)) process.removeListener("SIGINT", l);
        }
        for (const l of process.listeners("SIGTERM")) {
            if (!preexistingSigterm.includes(l)) process.removeListener("SIGTERM", l);
        }
    });

    function writeFile(relPath: string, content = ""): void {
        const full = path.join(tmpDir, relPath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }

    describe("resolveLocalBin", () => {
        it("Returns the local .bin path when it exists.", () => {
            writeFile("node_modules/.bin/tsx", "");
            const result = resolveLocalBin("tsx");
            expect(result).toBe(path.join(tmpDir, "node_modules", ".bin", "tsx"));
        });

        it("Falls back to the bare name when no local .bin entry exists.", () => {
            expect(resolveLocalBin("tsx")).toBe("tsx");
        });
    });

    describe("isAvailable", () => {
        it("Returns true when the local .bin entry exists.", () => {
            writeFile("node_modules/.bin/nodemon", "");
            expect(isAvailable("nodemon")).toBe(true);
        });

        it("Returns false when the local .bin entry does not exist.", () => {
            expect(isAvailable("nodemon")).toBe(false);
        });
    });

    describe("findServerEntry", () => {
        it("Finds the first matching candidate in priority order.", () => {
            writeFile("src/index.ts", "");
            writeFile("src/index.tsx", "");
            expect(findServerEntry()).toBe("src/index.ts");
        });

        it("Throws when no candidate exists.", () => {
            expect(() => findServerEntry()).toThrow(/Could not find server entry point/);
        });
    });

    describe("findExportEntry", () => {
        it("Finds the first matching candidate in priority order.", () => {
            writeFile("src/export.tsx", "");
            writeFile("src/export.ts", "");
            expect(findExportEntry()).toBe("src/export.ts");
        });

        it("Throws when no candidate exists.", () => {
            expect(() => findExportEntry()).toThrow(/Could not find a static export entry point/);
        });
    });

    describe("spawnProcess", () => {
        it("Logs and exits when the underlying process fails to start.", () => {
            const proc = spawnProcess("some-cmd", ["--flag"]);
            expect(() => proc.emit("error", new Error("boom"))).toThrow(ProcessExitSignal);
            expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to start "some-cmd": boom'));
            expect(exitSpy).toHaveBeenCalledWith(1);
        });

        it("Spawns without a custom env by default.", () => {
            spawnProcess("some-cmd", ["--flag"]);
            expect(vi.mocked(spawn)).toHaveBeenCalledWith("some-cmd", ["--flag"], { stdio: "inherit" });
        });

        it("Merges a provided env into process.env.", () => {
            spawnProcess("some-cmd", ["--flag"], { NODE_ENV: "production" });
            expect(vi.mocked(spawn)).toHaveBeenCalledWith("some-cmd", ["--flag"], {
                stdio: "inherit",
                env: expect.objectContaining({ NODE_ENV: "production" }),
            });
        });
    });

    describe("runParallel", () => {
        it("Exits 0 once every child process exits successfully.", () => {
            const a = new FakeChildProcess();
            const b = new FakeChildProcess();
            runParallel([
                ["a", []],
                ["b", []],
            ]);
            // runParallel spawns via spawnProcess -> resolveLocalBin -> spawn(); use the mocked children.
            expect(children.length).toBe(2);
            children[0].emit("exit", 0);
            expect(() => children[1].emit("exit", 0)).toThrow(ProcessExitSignal);
            expect(exitSpy).toHaveBeenCalledWith(0);
        });

        it("Shuts down remaining children and exits with the failing code when one exits non-zero.", () => {
            runParallel([
                ["a", []],
                ["b", []],
            ]);
            expect(children.length).toBe(2);
            expect(() => children[0].emit("exit", 2)).toThrow(ProcessExitSignal);
            expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Process exited with code 2"));
            expect(children[1].kill).toHaveBeenCalled();
            expect(exitSpy).toHaveBeenCalledWith(2);
        });

        it("Does not re-kill a child that already exited when shutting down via SIGINT.", () => {
            runParallel([
                ["a", []],
                ["b", []],
            ]);
            children[0].killed = true;
            process.emit("SIGINT" as any);
            expect(children[0].kill).not.toHaveBeenCalled();
            expect(children[1].kill).toHaveBeenCalled();
        });

        it("Shuts down children on SIGTERM.", () => {
            runParallel([["a", []]]);
            process.emit("SIGTERM" as any);
            expect(children[0].kill).toHaveBeenCalled();
        });
    });

    describe("runSequential", () => {
        it("Runs each step in order and resolves once all exit successfully.", async () => {
            const promise = runSequential([
                ["tsc", ["-p", "tsconfig.json"]],
                ["vite", ["build"]],
            ]);
            await vi.waitFor(() => expect(children.length).toBe(1));
            children[0].emit("exit", 0);
            await vi.waitFor(() => expect(children.length).toBe(2));
            children[1].emit("exit", 0);
            await expect(promise).resolves.toBeUndefined();
        });

        it("Rejects when a step exits with a non-zero code.", async () => {
            const promise = runSequential([["tsc", ["-p", "tsconfig.json"]]]);
            await vi.waitFor(() => expect(children.length).toBe(1));
            children[0].emit("exit", 3);
            await expect(promise).rejects.toThrow(/"tsc" exited with code 3/);
        });

        it("Passes a step's env through to spawnProcess.", async () => {
            const promise = runSequential([["tsx", ["src/export.ts"], { NODE_ENV: "production" }]]);
            await vi.waitFor(() => expect(children.length).toBe(1));
            expect(vi.mocked(spawn)).toHaveBeenNthCalledWith(1, "tsx", ["src/export.ts"], {
                stdio: "inherit",
                env: expect.objectContaining({ NODE_ENV: "production" }),
            });
            children[0].emit("exit", 0);
            await expect(promise).resolves.toBeUndefined();
        });
    });

    describe("run() - dev command", () => {
        it("Uses tsx --watch when nodemon is unavailable and an explicit entry is given.", () => {
            process.argv = ["node", "cli.js", "dev", "src/server.ts"];
            run();
            expect(children.length).toBe(2);
            expect(vi.mocked(spawn)).toHaveBeenNthCalledWith(1, "tsx", ["--watch", "src/server.ts"], {
                stdio: "inherit",
            });
            expect(vi.mocked(spawn)).toHaveBeenNthCalledWith(2, "vite", ["build", "--watch"], { stdio: "inherit" });
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("tsx --watch"));
        });

        it("Uses nodemon when available.", () => {
            writeFile("node_modules/.bin/nodemon", "");
            process.argv = ["node", "cli.js", "dev", "src/server.ts"];
            run();
            const nodemonPath = path.join(tmpDir, "node_modules", ".bin", "nodemon");
            expect(vi.mocked(spawn)).toHaveBeenNthCalledWith(
                1,
                nodemonPath,
                ["--exec", "tsx", "--watch", "src", "--watch", "apps", "--ext", "ts,tsx,json", "src/server.ts"],
                { stdio: "inherit" },
            );
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("nodemon --exec"));
        });

        it("Rejects an unsafe server entry path and exits without spawning.", () => {
            process.argv = ["node", "cli.js", "dev", "src/server.ts; rm -rf /"];
            expect(() => run()).toThrow(ProcessExitSignal);
            expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid server entry path"));
            expect(children.length).toBe(0);
        });

        it("Auto-detects the server entry when none is given.", () => {
            writeFile("src/index.ts", "");
            process.argv = ["node", "cli.js", "dev"];
            run();
            expect(vi.mocked(spawn)).toHaveBeenNthCalledWith(1, "tsx", ["--watch", "src/index.ts"], {
                stdio: "inherit",
            });
        });

        it("Throws when no server entry can be auto-detected.", () => {
            process.argv = ["node", "cli.js", "dev"];
            expect(() => run()).toThrow(/Could not find server entry point/);
            expect(children.length).toBe(0);
        });
    });

    describe("run() - build command", () => {
        it("Builds with only the server tsconfig when no client tsconfig exists.", async () => {
            process.argv = ["node", "cli.js", "build"];
            run();
            await vi.waitFor(() => expect(children.length).toBe(1));
            expect(vi.mocked(spawn)).toHaveBeenNthCalledWith(1, "tsc", ["-p", "tsconfig.json"], { stdio: "inherit" });
            children[0].emit("exit", 0);
            await vi.waitFor(() => expect(children.length).toBe(2));
            expect(vi.mocked(spawn)).toHaveBeenNthCalledWith(2, "vite", ["build"], { stdio: "inherit" });
            children[1].emit("exit", 0);
            await vi.waitFor(() => expect(exitSpy).not.toHaveBeenCalled());
        });

        it("Also builds the client tsconfig when tsconfig.client.json exists.", async () => {
            writeFile("tsconfig.client.json", "{}");
            process.argv = ["node", "cli.js", "build"];
            run();
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Pages:  tsc -p tsconfig.client.json"));
            await vi.waitFor(() => expect(children.length).toBe(1));
            children[0].emit("exit", 0);
            await vi.waitFor(() => expect(children.length).toBe(2));
            expect(vi.mocked(spawn)).toHaveBeenNthCalledWith(2, "tsc", ["-p", "tsconfig.client.json"], {
                stdio: "inherit",
            });
            children[1].emit("exit", 0);
            await vi.waitFor(() => expect(children.length).toBe(3));
            expect(vi.mocked(spawn)).toHaveBeenNthCalledWith(3, "vite", ["build"], { stdio: "inherit" });
            children[2].emit("exit", 0);
        });

        it("Rejects an unsafe tsconfig path and exits without spawning.", () => {
            process.argv = ["node", "cli.js", "build", "bad;arg"];
            expect(() => run()).toThrow(ProcessExitSignal);
            expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid tsconfig path"));
            expect(children.length).toBe(0);
        });

        it("Logs and exits 1 when a build step fails.", async () => {
            // The failure path runs inside an async .catch(), so process.exit must not throw here
            // (a throw there would become an unhandled rejection instead of surfacing synchronously).
            exitSpy.mockImplementation(() => undefined as never);
            process.argv = ["node", "cli.js", "build"];
            run();
            await vi.waitFor(() => expect(children.length).toBe(1));
            children[0].emit("exit", 5);
            await vi.waitFor(() =>
                expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[rapidreact] Build failed:')),
            );
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
    });

    describe("run() - export command", () => {
        it("Runs vite build then the export entry via tsx with NODE_ENV=production, in order.", async () => {
            writeFile("src/export.ts", "");
            process.argv = ["node", "cli.js", "export"];
            run();
            await vi.waitFor(() => expect(children.length).toBe(1));
            expect(vi.mocked(spawn)).toHaveBeenNthCalledWith(1, "vite", ["build"], { stdio: "inherit" });
            children[0].emit("exit", 0);
            await vi.waitFor(() => expect(children.length).toBe(2));
            expect(vi.mocked(spawn)).toHaveBeenNthCalledWith(2, "tsx", ["src/export.ts"], {
                stdio: "inherit",
                env: expect.objectContaining({ NODE_ENV: "production" }),
            });
            children[1].emit("exit", 0);
            await vi.waitFor(() => expect(exitSpy).not.toHaveBeenCalled());
        });

        it("Uses an explicit export entry argument instead of auto-detecting.", async () => {
            process.argv = ["node", "cli.js", "export", "src/myexport.ts"];
            run();
            await vi.waitFor(() => expect(children.length).toBe(1));
            children[0].emit("exit", 0);
            await vi.waitFor(() => expect(children.length).toBe(2));
            expect(vi.mocked(spawn)).toHaveBeenNthCalledWith(2, "tsx", ["src/myexport.ts"], {
                stdio: "inherit",
                env: expect.objectContaining({ NODE_ENV: "production" }),
            });
        });

        it("Rejects an unsafe export entry path and exits without spawning.", () => {
            process.argv = ["node", "cli.js", "export", "src/export.ts; rm -rf /"];
            expect(() => run()).toThrow(ProcessExitSignal);
            expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid export entry path"));
            expect(children.length).toBe(0);
        });

        it("Throws when no export entry can be auto-detected.", () => {
            process.argv = ["node", "cli.js", "export"];
            expect(() => run()).toThrow(/Could not find a static export entry point/);
            expect(children.length).toBe(0);
        });

        it("Logs and exits 1 when a step fails.", async () => {
            exitSpy.mockImplementation(() => undefined as never);
            writeFile("src/export.ts", "");
            process.argv = ["node", "cli.js", "export"];
            run();
            await vi.waitFor(() => expect(children.length).toBe(1));
            children[0].emit("exit", 7);
            await vi.waitFor(() =>
                expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[rapidreact] Export failed:')),
            );
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
    });

    describe("run() - unknown command", () => {
        it("Prints usage and exits 1 for an unrecognized command.", () => {
            process.argv = ["node", "cli.js", "frobnicate"];
            expect(() => run()).toThrow(ProcessExitSignal);
            expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Usage: rapidreact"));
        });

        it("Prints usage and exits 1 when no command is given.", () => {
            process.argv = ["node", "cli.js"];
            expect(() => run()).toThrow(ProcessExitSignal);
            expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Usage: rapidreact"));
        });
    });

    describe("main-module auto-run guard", () => {
        it("Automatically invokes run() when the module's own file is the process entry point.", async () => {
            cwdSpy.mockRestore();
            const cliAbsPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
            process.argv = ["node", cliAbsPath, "frobnicate"];
            vi.resetModules();
            await expect(import("../src/cli.js")).rejects.toThrow(ProcessExitSignal);
            expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Usage: rapidreact"));
        });

        it("Does not auto-invoke run() when imported as a module (not the process entry point).", async () => {
            process.argv = ["node", "some-other-entry.js"];
            vi.resetModules();
            const mod = await import("../src/cli.js");
            expect(mod.run).toBeTypeOf("function");
            expect(children.length).toBe(0);
        });

        // Regression test for a real bug: a package manager's `node_modules/.bin/rapidreact` entry
        // is a symlink on Linux/macOS (unlike Windows, where it's a generated .cmd/shim file that's
        // already the real path). `argv[1]` is left exactly as invoked — the symlink path — while
        // `import.meta.url` for the loaded module reflects Node's own symlink-resolved real path, so
        // a naive `path.resolve(argv[1])` comparison mismatched and silently skipped run() entirely
        // (no error, no output, exit 0) for every symlink-based install. Only reproducible on an OS
        // with real symlinks, hence the skip guard above.
        it.skipIf(!canSymlink)(
            "Automatically invokes run() when argv[1] is a symlink to this module's real file (e.g. a package-manager .bin entry).",
            async () => {
                cwdSpy.mockRestore();
                const cliAbsPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
                const symlinkPath = path.join(tmpDir, "rapidreact-symlink.ts");
                fs.symlinkSync(cliAbsPath, symlinkPath);
                process.argv = ["node", symlinkPath, "frobnicate"];
                vi.resetModules();
                await expect(import("../src/cli.js")).rejects.toThrow(ProcessExitSignal);
                expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Usage: rapidreact"));
            },
        );
    });
});
