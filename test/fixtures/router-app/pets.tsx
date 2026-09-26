import React from "react";

export async function fetchProps() {
    return { pets: ["rex", "tom"] };
}

export default function Pets(props: any) {
    return <ul>{props.pets.map((p: string) => <li key={p}>{p}</li>)}</ul>;
}
