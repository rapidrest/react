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
});
