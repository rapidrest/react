# react — Design Decisions & Session Notes

This file exists so that Claude sessions working in this repo don't re-litigate settled
decisions or re-discover the same issues from scratch. It is local to this repo (not tied to
any one machine's global Claude memory), so it travels with the code.

**Maintenance rule:** when a standing decision changes, update the section below in place
(don't just append a contradiction lower down). When a new investigation/session produces a
decision, finding, or reverted approach worth remembering, add a dated entry under Session Log.
Keep entries terse — this is a reference, not a transcript.

## Standing design decisions & constraints

- **Vulnerability/review threat model: externally-exploitable only.** This library is a power
  tool for developers building their own services, not a hardened black box. When reviewing for
  "vulnerabilities," only count issues reachable from a downstream, untrusted HTTP/WebSocket
  client hitting a service built on the framework (anonymous or low-privilege caller). Do NOT
  flag: developer-only footguns (misusing an API, a decorator applied wrong in your own code),
  internal utilities only the operator touches (build/CLI/startup wiring), or purely theoretical
  races with no concrete external trigger path. Every finding should be able to name the actual
  HTTP route/method or WS message type that reaches the code in question.

- **Commit discipline.** Don't `git commit` unless explicitly asked, even after a full
  review-and-fix cycle with passing tests. Leave changes staged/unstaged and say so.

## Session Log

- **2026-08-22** — `static.ts`'s `writeRouteHtml()` gained a path-containment check (refuses to
  write outside `outDir`). Initially reported as a "security" finding in a code review, but it
  doesn't meet the externally-exploitable bar above: the `route` value it checks only ever comes
  from `discoverRoutes()` (real filenames under the developer's own `appDir`) or `options.paths`
  (a value the developer writes directly into their own `src/export.ts`) — never from an HTTP/WS
  request. `exportStaticSite`/`runStaticExport` only run from a one-shot local/CI script, never a
  live listener. Decision: **kept anyway**, but recategorized — it's a fail-fast/DX guard against
  a self-inflicted typo (e.g. `paths: ["../admin"]`), not a vulnerability fix. When defending or
  reporting a finding like this in future reviews, say so explicitly up front (containment/DX
  guard vs. externally-exploitable) rather than reaching for security framing by default.
