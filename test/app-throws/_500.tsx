import React from "react";

export default function ErrorPage({ error }: { error?: { message?: string } }) {
    return <p>Internal server error: {error?.message}</p>;
}
