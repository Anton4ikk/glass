// Runs node:test inside Electron's bundled Node (ELECTRON_RUN_AS_NODE=1).
// Native modules (better-sqlite3, keytar) are rebuilt for Electron's ABI by
// `postinstall`, so the system `node` can't load them; Electron's Node can,
// and it matches the runtime the app actually ships with.
//
// Usage: npm test                      -> all test/**/*.test.js
//        npm test -- test/whisper.test.js
//        npm test -- --test-name-pattern="cleanTranscription"
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const electronPath = require('electron'); // resolves to the binary path outside Electron

const root = path.join(__dirname, '..');

function findTests(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return findTests(full);
        return entry.name.endsWith('.test.js') ? [full] : [];
    });
}

const args = process.argv.slice(2);
const hasFiles = args.some(arg => !arg.startsWith('-'));
const files = hasFiles ? [] : findTests(path.join(root, 'test'));
// Spec output even when stdout isn't a TTY (CI, agents); --test-reporter=tap still works.
const reporter = args.some(arg => arg.startsWith('--test-reporter')) ? [] : ['--test-reporter=spec'];
const setup = ['--require', path.join(root, 'test', 'setup.js')];

const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'test' };
const result = spawnSync(electronPath, ['--test', ...setup, ...reporter, ...args, ...files], { cwd: root, env, stdio: 'inherit' });

if (result.error) {
    console.error('[run-tests] Failed to start Electron:', result.error.message);
    process.exit(1);
}
process.exit(result.status ?? 1);
