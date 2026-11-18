// The header's shortcut list (src/ui/app/MainHeader.js) is ESM for the browser and
// can't be imported here, so its actions are read from the source.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const shortcutsService = require('../src/features/shortcuts/shortcutsService');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'app', 'MainHeader.js'), 'utf8');
const listed = src.match(/const LISTED_SHORTCUTS = \[([\s\S]*?)\n\];/)[1];
const listedActions = [...listed.matchAll(/action: '(\w+)'/g)].map(m => m[1]);

// Shown on the Ask button itself.
const ON_BUTTONS = ['nextStep'];
// Configurable, but registerShortcuts has no handler for them.
const UNHANDLED = ['manualScreenshot'];

test('header shortcut list names only real keybind actions', () => {
    const defaults = Object.keys(shortcutsService.getDefaultKeybinds());
    for (const action of listedActions) assert.ok(defaults.includes(action), action);
});

test('every working keybind is visible in the header', () => {
    const shown = new Set([...listedActions, ...ON_BUTTONS]);
    const missing = Object.keys(shortcutsService.getDefaultKeybinds())
        .filter(action => !shown.has(action) && !UNHANDLED.includes(action));
    assert.deepEqual(missing, []);
});

test('the actions treated as unhandled really have no handler', () => {
    const service = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'shortcuts', 'shortcutsService.js'), 'utf8');
    for (const action of UNHANDLED) assert.ok(!service.includes(`case '${action}':`), action);
});
