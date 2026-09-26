import React from "react";
import { useParams } from "../../../../src/routerContext.js";

export async function fetchProps(req: any) {
    return { petId: req.params.id };
}

export default function Pet(props: any) {
    return <p data-param={useParams().id}>{`pet ${props.petId}`}</p>;
}
