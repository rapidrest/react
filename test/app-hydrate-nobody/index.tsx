import React from "react";

// No _layout.tsx and no <body> tag in the rendered output — used to exercise the
// injectHydrationAssets </html>-only fallback path.
export default function NoBodyPage() {
    return (
        <html>
            <head></head>
            <span>NoBody</span>
        </html>
    );
}
