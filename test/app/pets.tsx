import React from "react";

export default function PetsPage({ pets }: { pets?: string[] }) {
    return <ul>{(pets ?? []).map((p) => <li key={p}>{p}</li>)}</ul>;
}

export async function fetchProps() {
    return { pets: ["Cat", "Dog"] };
}
