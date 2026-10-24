import { createRequire } from 'node:module';
import path from 'path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

import { sharedTestConfig } from '../../vitest.shared.mjs';

const require = createRequire(import.meta.url);

export default defineConfig({
    resolve: {
        /**
         * graphql ships both a CommonJS and an ESM build. graphql-yoga (and the rest of the
         * externalized dependencies) load the CommonJS one, but Vite prefers the `module` field when
         * it resolves `graphql` for a transformed spec file. graphql-js compares constructor
         * identity, so the two builds reject each other's types with "Cannot use X from another
         * module or realm". Pinning the specifier to the entry Node would pick keeps it to one copy
         * (the e2e config does the same).
         */
        alias: [{ find: /^graphql$/, replacement: require.resolve('graphql') }],
    },
    test: {
        ...sharedTestConfig,
        // Type-level tests (`*.spec-d.ts`) are run via `vitest --typecheck`.
        // `tsconfig.spec-d.json` scopes the type-check program to the `*.spec-d.ts` files
        // and their imports, so the runtime specs are not type-checked.
        typecheck: {
            tsconfig: path.join(__dirname, 'tsconfig.spec-d.json'),
        },
    },
    plugins: [
        // SWC required to support decorators used in test plugins
        // See https://github.com/vitest-dev/vitest/issues/708#issuecomment-1118628479
        // Vite plugin
        swc.vite({
            jsc: {
                transform: {
                    // See https://github.com/vendurehq/vendure/issues/2099
                    useDefineForClassFields: false,
                },
            },
        }),
    ],
});
