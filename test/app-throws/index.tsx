// A page that always fails, for testing the 500 path (and how a static export records it) over real HTTP. It has an app
// of its own so that it isn't one of `test/app`'s pages, which the export tests expect to all render.
export default function ThrowsPage(): never {
    throw new Error("db connection failed at /secret/internal/path");
}
