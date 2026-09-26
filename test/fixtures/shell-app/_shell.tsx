import React from "react";
import { NavLink, useRouter } from "../../../src/routerContext.js";
import "./shell.css";

/** A persistent shell: a nav rail (which knows where the page is) around the current page. */
export default function Shell({ children, user }: { children?: React.ReactNode; user?: string }) {
    const router = useRouter();
    return (
        <div id="shell" data-path={router.pathname} data-route={router.route} data-user={user}>
            <nav>
                <NavLink href="/">Home</NavLink>
                <NavLink href="/pets">Pets</NavLink>
            </nav>
            <main>{children}</main>
        </div>
    );
}
