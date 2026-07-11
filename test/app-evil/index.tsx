///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// Fixture used to verify that a sibling directory sharing the app dir's name as
// a prefix (e.g. "test/app" vs "test/app-evil") is not treated as being inside
// the app directory by resolveAppFile's containment check.
export default function EvilIndex() {
    return <p>Evil</p>;
}
