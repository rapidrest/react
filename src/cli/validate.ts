///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////

// Classic shell metacharacters. Blocking these is defense-in-depth: with `shell:true` removed
// from spawnProcess (see cli.ts), argv elements are passed to the child process verbatim and
// are not shell-interpreted, so this check is a secondary guard, not the primary fix.
const UNSAFE_CHARS = /[;&|`$(){}[\]<>"'\n\r]/;

export function isSafePathArg(value: string): boolean {
    return value.length > 0 && !UNSAFE_CHARS.test(value);
}
