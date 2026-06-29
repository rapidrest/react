import React, { PropsWithChildren } from "react";

export default function Layout({ children }: PropsWithChildren) {
    return (
        <html>
            <head></head>
            <body>{children}</body>
        </html>
    );
}
