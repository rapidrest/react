import React from "react";

export async function fetchProps() {
    throw new Error("props failed");
}

export default function Boom() {
    return <p>never</p>;
}
