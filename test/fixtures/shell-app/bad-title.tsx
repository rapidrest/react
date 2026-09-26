import React from "react";

export function title(): string {
    throw new Error("title failed");
}

export default function BadTitle() {
    return <p>bad</p>;
}
