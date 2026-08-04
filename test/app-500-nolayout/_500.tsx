import React from "react";

export default function ErrorPage({ error }: { error?: { message?: string } }) {
    return <p>Error page, no layout: {error?.message}</p>;
}
