A bracket directory that exists but has no index.tsx/.jsx/.js inside it, and no sibling
[id].tsx-style leaf file either — used to prove resolveAppFile() returns null (rather than
throwing) when a bracket name is found but none of its candidate files actually exist.
