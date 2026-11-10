// Kept in sync with package.json by hand — one constant instead of the three
// copies of the literal that had already drifted between cli.ts and build.ts.
// ponytail: reading package.json at runtime means resolving it from both src/
// and dist/; not worth it for a string that changes on release days only.
export const VERSION = '0.5.0';
