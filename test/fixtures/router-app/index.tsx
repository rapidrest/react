import React from "react";
import { Link, useRouter } from "../../../src/routerContext.js";

export async function fetchProps() {
    return { greeting: "hello" };
}

export default function Home(props: any) {
    const router = useRouter();
    return (
        <main>
            <h1>{props.greeting}</h1>
            <nav data-path={router.pathname} data-search={router.search} data-route={router.route}>
                <Link href="/pets">Pets</Link>
            </nav>
        </main>
    );
}
