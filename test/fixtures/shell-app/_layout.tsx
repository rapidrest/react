import React from "react";

export default function Layout({ children }: { children?: React.ReactNode }) {
    return (
        <html>
            <head>
                <title>layout title</title>
            </head>
            <body>{children}</body>
        </html>
    );
}
