import React, { PropsWithChildren } from "react";

// Deliberately reads a prop supplied only via the route's own `fetchProps()` override — see
// "ReactRoute passes page props to _layout.tsx" in test/ReactRoute.more.test.ts. Also reads
// `userUid`, one of the framework's own always-injected props, to confirm both sources land here.
export default function Layout({ children, siteTitle, userUid }: PropsWithChildren<{ siteTitle?: string; userUid?: string }>) {
    return (
        <html>
            <head>
                <title>{siteTitle ?? "Untitled"}</title>
            </head>
            <body data-user-uid={userUid ?? ""}>{children}</body>
        </html>
    );
}
