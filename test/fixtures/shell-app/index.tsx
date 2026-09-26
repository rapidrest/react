import React from "react";

export async function fetchProps() {
    return { user: "jp" };
}

/** A title made from the page's own props. */
export function title(props: { user: string }) {
    return `Home for ${props.user}`;
}

export default function Home() {
    return <h1>home</h1>;
}
