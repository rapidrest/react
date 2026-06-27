import React, { PropsWithChildren } from "react";

export function Layout({ children }: PropsWithChildren) {
    return (
        <html>
            <body>{children}</body>
        </html>
    );
}
