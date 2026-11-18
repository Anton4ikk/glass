// Static checks over the renderer (src/ui). The Lit components can't run under
// node:test, so the two breakages that leave a window blank are caught by
// reading the sources instead:
//  - `this.foo = this.foo.bind(this)` after foo was deleted throws in the
//    constructor, and the custom element never renders;
//  - `window.api.ns.fn(...)` for a function preload.js no longer exposes.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UI_DIR = path.join(ROOT, 'src', 'ui');

function uiSources(dir = UI_DIR) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === 'assets' ? [] : uiSources(full);
        return entry.name.endsWith('.js') ? [full] : [];
    });
}

/** { namespace: Set(functionNames) } from the object passed to exposeInMainWorld('api', ...). */
function preloadApi() {
    const lines = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8').split('\n');
    const api = {};
    let current = null;
    for (const line of lines) {
        const ns = line.match(/^ {2}(\w+): \{/);
        if (ns) {
            current = api[ns[1]] = new Set();
            continue;
        }
        if (/^ {2}\},?\s*$/.test(line)) {
            current = null;
            continue;
        }
        const fn = current && line.match(/^ {4}(\w+):/);
        if (fn) current.add(fn[1]);
    }
    return api;
}

const relative = file => path.relative(ROOT, file);

describe('renderer contracts', () => {
    const files = uiSources();

    test('the preload API parser finds the namespaces', () => {
        const api = preloadApi();
        assert.ok(api.settingsView?.has('getAboutMe'), 'settingsView.getAboutMe');
        assert.ok(api.mainHeader?.has('showSettingsWindow'), 'mainHeader.showSettingsWindow');
    });

    test('every this.x.bind(this) refers to a method defined in the same file', () => {
        const problems = [];
        for (const file of files) {
            const src = fs.readFileSync(file, 'utf8');
            for (const [, name] of src.matchAll(/this\.(\w+)\s*=\s*this\.\1\.bind\(this\)/g)) {
                const defined = new RegExp(`^\\s+(?:async\\s+)?${name}\\s*(?:\\(|=)`, 'm').test(src);
                if (!defined) problems.push(`${relative(file)}: ${name}`);
            }
        }
        assert.deepEqual(problems, [], 'bind() of a method that does not exist throws in the constructor');
    });

    test('every non-optional window.api call exists in preload.js', () => {
        const api = preloadApi();
        const problems = [];
        for (const file of files) {
            const src = fs.readFileSync(file, 'utf8');
            // `window.api.ns.fn` and `window.api?.ns.fn`; `fn?.()` means the caller tolerates its absence.
            for (const [, ns, fn] of src.matchAll(/window\.api\??\.(\w+)\.(\w+)(?!\w|\?\.)/g)) {
                if (!api[ns]?.has(fn)) problems.push(`${relative(file)}: window.api.${ns}.${fn}`);
            }
        }
        assert.deepEqual([...new Set(problems)], []);
    });
});
