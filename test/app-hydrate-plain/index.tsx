import React from "react";

// No _layout.tsx and no <html>/<body> tags at all in the rendered output — used to
// exercise the injectHydrationAssets plain-append fallback path.
export default function PlainPage() {
    return <span>Plain</span>;
}
