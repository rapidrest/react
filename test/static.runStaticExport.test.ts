///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `runStaticExport()` is a thin orchestration wrapper around a real `@rapidrest/service-core`
// `Server` — but that `Server` registers prom-client metrics on a process-wide singleton
// registry at construction time, and a second real `Server` in the same process (alongside the
// one `test/static.test.ts` already constructs to exercise `exportStaticSite()` for real)
// collides on those metric names. `exportStaticSite()`'s actual crawl behavior is already
// covered end-to-end there, so this file mocks `Server` and only verifies the wiring that's
// unique to `runStaticExport()` itself: it constructs a `Server` with the given options, starts
// it, crawls it via `exportStaticSite()` using the bound port, and stops it again.
import { vi } from "vitest";

const { startMock, stopMock, capturedRef } = vi.hoisted(() => ({
    startMock: vi.fn(async () => undefined),
    stopMock: vi.fn(async () => undefined),
    capturedRef: { options: undefined as any },
}));

vi.mock("@rapidrest/service-core", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@rapidrest/service-core")>();
    class FakeServer {
        public port = 4242;
        constructor(options: any) {
            capturedRef.options = options;
        }
        start = startMock;
        stop = stopMock;
    }
    return { ...actual, Server: FakeServer };
});

import { runStaticExport } from "../src/static.js";
import { STATIC_EXPORT_ENV_VAR } from "../src/routeMatch.js";

describe("runStaticExport", () => {
    it("Constructs a Server with the given options, starts it, crawls it via exportStaticSite " +
        "using the bound port, and stops it again.", async () => {
        const serverOptions = { config: {} as any, basePath: "." };
        const result = await runStaticExport(serverOptions, {
            appDir: "test/fixtures/does-not-exist",
            paths: [],
            notFound: false,
        });

        expect(capturedRef.options).toBe(serverOptions);
        expect(startMock).toHaveBeenCalledTimes(1);
        expect(stopMock).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ pages: [], errors: [], dynamicRoutes: [] });
    });

    it("Sets STATIC_EXPORT_ENV_VAR for the duration of the crawl, then deletes it afterward " +
        "when it wasn't set beforehand.", async () => {
        delete process.env[STATIC_EXPORT_ENV_VAR];
        let sawDuringStart: string | undefined;
        startMock.mockImplementationOnce(async () => {
            sawDuringStart = process.env[STATIC_EXPORT_ENV_VAR];
        });

        await runStaticExport(
            { config: {} as any, basePath: "." },
            { appDir: "test/fixtures/does-not-exist", paths: [], notFound: false }
        );

        expect(sawDuringStart).toBe("true");
        expect(process.env[STATIC_EXPORT_ENV_VAR]).toBeUndefined();
    });

    it("Restores STATIC_EXPORT_ENV_VAR to its prior value afterward, rather than deleting it, " +
        "when it was already set before the call.", async () => {
        process.env[STATIC_EXPORT_ENV_VAR] = "was-already-here";
        try {
            await runStaticExport(
                { config: {} as any, basePath: "." },
                { appDir: "test/fixtures/does-not-exist", paths: [], notFound: false }
            );
            expect(process.env[STATIC_EXPORT_ENV_VAR]).toBe("was-already-here");
        } finally {
            delete process.env[STATIC_EXPORT_ENV_VAR];
        }
    });
});
