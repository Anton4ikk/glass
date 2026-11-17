// ESLint flat config. Scopes match where the code actually runs:
// main process / Node (CommonJS), renderer UI (browser ESM, bundled by esbuild),
// and the preload script (CommonJS with DOM access).
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    {
        ignores: [
            '**/node_modules/**',
            'dist/**',
            'public/build/**',
            'aec/**',
            'src/ui/assets/**', // vendored lit/marked/highlight/dompurify
            'public/assets/**', // vendored dompurify copy
            'src/ui/listen/audioCore/aec.js', // emscripten-generated WASM glue
            // Next.js frontend has its own `next lint`; only backend_node runs inside Electron.
            'pickleglass_web/**',
            '!pickleglass_web/backend_node/**',
        ],
    },

    js.configs.recommended,

    {
        linterOptions: {
            reportUnusedDisableDirectives: 'warn',
        },
        rules: {
            // Upstream code has many unused leftovers; keep them visible without failing the run.
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
            'no-empty': ['warn', { allowEmptyCatch: true }],
            'no-useless-escape': 'warn',
            'no-useless-catch': 'warn',
        },
    },

    // Main process, services, bridges, web backend, Firebase functions, build scripts, tests.
    {
        files: ['**/*.js'],
        ignores: ['src/ui/**'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
    },

    // Preload runs in the renderer with Node's require available.
    {
        files: ['src/preload.js'],
        languageOptions: {
            globals: { ...globals.browser, ...globals.node },
        },
    },

    // Renderer UI: Lit components bundled by build.js.
    {
        files: ['src/ui/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.browser },
        },
    },

    // Audio capture scripts are CommonJS (require/module.exports) that esbuild bundles for the renderer.
    {
        files: ['src/ui/listen/audioCore/**/*.js'],
        languageOptions: {
            sourceType: 'commonjs',
            globals: { ...globals.browser, ...globals.commonjs },
        },
    },
];
