///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { fillRouteTemplate, matchPathPattern, matchRouteTemplate, parseDynamicSegmentName } from "../src/routeMatch.js";

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

    it("Matches a literal segment against its URI-decoded form, as a page file named with spaces or non-ASCII is requested.", () => {
        expect(matchRouteTemplate("/café/:id", "/caf%C3%A9/7")).toEqual({ id: "7" });
        expect(matchRouteTemplate("/my page", "/my%20page")).toEqual({});
    });

    it("Compares a literal segment with a malformed escape as written.", () => {
        expect(matchRouteTemplate("/a%zz", "/a%zz")).toEqual({});
        expect(matchRouteTemplate("/a", "/a%zz")).toBeNull();
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

describe("matchPathPattern", () => {
    it("Matches a literal pattern exactly, ignoring trailing and doubled slashes.", () => {
        expect(matchPathPattern("/pets", "/pets")).toEqual({ params: {}, pathname: "/pets" });
        expect(matchPathPattern("/pets/", "//pets/")).toEqual({ params: {}, pathname: "/pets" });
        expect(matchPathPattern("/", "/")).toEqual({ params: {}, pathname: "/" });
    });

    it("Captures :name segments, decoded.", () => {
        expect(matchPathPattern("/pets/:id", "/pets/a%20b")?.params).toEqual({ id: "a b" });
        expect(matchPathPattern("/pets/:id/reviews/:rid", "/pets/1/reviews/2")?.params).toEqual({ id: "1", rid: "2" });
    });

    it("Compares literal segments as decoded, and case-sensitively.", () => {
        expect(matchPathPattern("/café", "/caf%C3%A9")).not.toBeNull();
        expect(matchPathPattern("/pets", "/Pets")).toBeNull();
        // A malformed escape is compared as written.
        expect(matchPathPattern("/a%zz", "/a%zz")).not.toBeNull();
    });

    it("Needs the whole path to match by default, so a longer or shorter path doesn't.", () => {
        expect(matchPathPattern("/pets", "/pets/1")).toBeNull();
        expect(matchPathPattern("/pets/:id", "/pets")).toBeNull();
        expect(matchPathPattern("/pets", "/other")).toBeNull();
    });

    it("Matches the start of the path, on whole segments, with end: false.", () => {
        expect(matchPathPattern("/settings", "/settings/profile", false)).toEqual({ params: {}, pathname: "/settings" });
        expect(matchPathPattern("/settings", "/settings", false)).not.toBeNull();
        expect(matchPathPattern("/settings", "/settingsx", false)).toBeNull();
        expect(matchPathPattern("/pets/:id", "/pets/7/reviews", false)).toEqual({ params: { id: "7" }, pathname: "/pets/7" });
    });

    it("Matches the rest of the path with a trailing *, and captures it as params['*'].", () => {
        expect(matchPathPattern("/settings/*", "/settings/profile/edit")).toEqual({
            params: { "*": "profile/edit" },
            pathname: "/settings/profile/edit",
        });
        expect(matchPathPattern("/settings/*", "/settings")?.params).toEqual({ "*": "" });
        expect(matchPathPattern("/settings/*", "/other/x")).toBeNull();
        expect(matchPathPattern("/*", "/a/b")?.params).toEqual({ "*": "a/b" });
        expect(matchPathPattern("/pets/:id/*", "/pets/7/x%20y")?.params).toEqual({ id: "7", "*": "x y" });
    });

    it("Is null when a captured value isn't valid percent-encoding.", () => {
        expect(matchPathPattern("/pets/:id", "/pets/%E0%A4%A")).toBeNull();
        expect(matchPathPattern("/pets/*", "/pets/%E0%A4%A")).toBeNull();
    });
});
