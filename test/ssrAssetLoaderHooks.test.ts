///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    load,
    resolve,
    type LoadContext,
    type LoadResult,
    type ResolveContext,
    type ResolveResult,
} from "../src/ssrAssetLoaderHooks.js";

describe("ssrAssetLoaderHooks", () => {
    describe("resolve()", () => {
        const context: ResolveContext = { conditions: [], importAttributes: {} };

        it.each([".css", ".scss", ".sass", ".less"])(
            "Redirects a \"%s\" specifier to a short-circuited css-stub: URL without calling nextResolve.",
            async (ext) => {
                const nextResolve = vi.fn();
                const result = await resolve(`./styles${ext}`, context, nextResolve);
                expect(result).toEqual({ url: `css-stub:./styles${ext}`, shortCircuit: true });
                expect(nextResolve).not.toHaveBeenCalled();
            }
        );

        it("Delegates to nextResolve for a specifier that isn't a recognized static asset extension.", async () => {
            const expected: ResolveResult = { url: "file:///project/src/index.js", shortCircuit: true };
            const nextResolve = vi.fn().mockResolvedValue(expected);
            const result = await resolve("./index.js", context, nextResolve);
            expect(nextResolve).toHaveBeenCalledWith("./index.js", context);
            expect(result).toBe(expected);
        });
    });

    describe("load()", () => {
        const context: LoadContext = { format: null, importAttributes: {} };

        it("Returns an empty stub module for a css-stub: URL without calling nextLoad.", async () => {
            const nextLoad = vi.fn();
            const result = await load("css-stub:./styles.css", context, nextLoad);
            expect(result).toEqual({ format: "module", shortCircuit: true, source: "export default {};" });
            expect(nextLoad).not.toHaveBeenCalled();
        });

        it("Delegates to nextLoad for a URL that isn't a css-stub: URL.", async () => {
            const expected: LoadResult = { format: "module", source: "export default 1;" };
            const nextLoad = vi.fn().mockResolvedValue(expected);
            const result = await load("file:///project/src/index.js", context, nextLoad);
            expect(nextLoad).toHaveBeenCalledWith("file:///project/src/index.js", context);
            expect(result).toBe(expected);
        });
    });
});
