///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { fillRouteTemplate, matchRouteTemplate, parseDynamicSegmentName } from "../src/routeMatch.js";

describe("parseDynamicSegmentName", () => {
    it("Extracts the name from a well-formed bracket segment.", () => {
        expect(parseDynamicSegmentName("[id]")).toBe("id");
    });

    it("Returns null for a plain, non-bracketed name.", () => {
        expect(parseDynamicSegmentName("index")).toBeNull();
    });

    it("Returns null for an empty bracket pair.", () => {
        expect(parseDynamicSegmentName("[]")).toBeNull();
    });

    it("Returns null for multiple adjacent bracket groups.", () => {
        expect(parseDynamicSegmentName("[a][b]")).toBeNull();
    });

    it("Returns null for a bracket group containing a slash.", () => {
        expect(parseDynamicSegmentName("[a/b]")).toBeNull();
    });

    it("Returns null for an unterminated bracket.", () => {
        expect(parseDynamicSegmentName("[id")).toBeNull();
    });
});

describe("matchRouteTemplate", () => {
    it("Matches an exact literal template with no dynamic segments.", () => {
        expect(matchRouteTemplate("/pets", "/pets")).toEqual({});
    });

    it("Matches the root template against the root path.", () => {
        expect(matchRouteTemplate("/", "/")).toEqual({});
    });

    it("Captures a single dynamic segment.", () => {
        expect(matchRouteTemplate("/pets/:id", "/pets/42")).toEqual({ id: "42" });
    });

    it("Captures multiple dynamic segments.", () => {
        expect(matchRouteTemplate("/pets/:id/reviews/:reviewId", "/pets/42/reviews/7")).toEqual({
            id: "42",
            reviewId: "7",
        });
    });

    it("URI-decodes a captured value.", () => {
        expect(matchRouteTemplate("/pets/:name", "/pets/red%20panda")).toEqual({ name: "red panda" });
    });

    it("Returns null when the segment counts differ (no catch-all support).", () => {
        expect(matchRouteTemplate("/pets/:id", "/pets/42/reviews/7")).toBeNull();
    });

    it("Returns null when a literal segment does not match.", () => {
        expect(matchRouteTemplate("/pets/featured", "/pets/42")).toBeNull();
    });

    it("Returns null for malformed percent-encoding in a captured segment.", () => {
        expect(matchRouteTemplate("/pets/:id", "/pets/%E0%A4%A")).toBeNull();
    });
});

describe("fillRouteTemplate", () => {
    it("Returns a literal template unchanged when it has no dynamic segments.", () => {
        expect(fillRouteTemplate("/pets", {})).toBe("/pets");
    });

    it("Fills the root template.", () => {
        expect(fillRouteTemplate("/", {})).toBe("/");
    });

    it("Substitutes a single dynamic segment.", () => {
        expect(fillRouteTemplate("/pets/:id", { id: "42" })).toBe("/pets/42");
    });

    it("Substitutes multiple dynamic segments.", () => {
        expect(fillRouteTemplate("/pets/:id/reviews/:reviewId", { id: "42", reviewId: "7" })).toBe(
            "/pets/42/reviews/7"
        );
    });

    it("URI-encodes a substituted value.", () => {
        expect(fillRouteTemplate("/pets/:name", { name: "red panda" })).toBe("/pets/red%20panda");
    });

    it("Returns null when a required param is missing from the given params object.", () => {
        expect(fillRouteTemplate("/pets/:id/reviews/:reviewId", { id: "42" })).toBeNull();
    });

    it("Ignores extra params not referenced by the template.", () => {
        expect(fillRouteTemplate("/pets/:id", { id: "42", unused: "x" })).toBe("/pets/42");
    });
});
