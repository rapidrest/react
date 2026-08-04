// Fixture whose import itself throws, to exercise the catch-around-_500-import fallback in ReactRoute.
throw new Error("boom - _500 page itself fails to import");
