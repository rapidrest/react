export default function ThrowsPage(): never {
    throw new Error("db connection failed at /secret/internal/path");
}
