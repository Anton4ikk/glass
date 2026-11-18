const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// trayService pulls Tray/Menu from electron and its prefs from electron-store,
// neither of which works outside a running app. Swap in fakes via the require cache.
function mockModule(request, exports) {
    const id = require.resolve(request);
    require.cache[id] = { id, filename: id, loaded: true, exports };
}

const created = [];
class FakeTray {
    constructor() {
        this.destroyed = false;
        created.push(this);
    }
    setToolTip() {}
    setImage() {}
    setIgnoreDoubleClickEvents() {}
    setContextMenu() {}
    on() {}
    destroy() {
        this.destroyed = true;
    }
    isDestroyed() {
        return this.destroyed;
    }
}
const fakeImage = { setTemplateImage() {}, isEmpty: () => true };
mockModule('electron', {
    app: { dock: null },
    Tray: FakeTray,
    Menu: { buildFromTemplate: t => t },
    nativeImage: { createFromPath: () => fakeImage },
    shell: {},
});

const prefs = new Map();
mockModule('electron-store', class {
    get(key, fallback) {
        return prefs.has(key) ? prefs.get(key) : fallback;
    }
    set(key, value) {
        prefs.set(key, value);
    }
});

let protectionOn = true;
mockModule(path.join(__dirname, '../src/window/windowManager'), {
    getContentProtectionStatus: () => protectionOn,
    setContentProtection: () => {},
    windowPool: new Map(),
});

const internalBridge = require('../src/bridge/internalBridge');
const trayService = require('../src/features/tray/trayService');

const tick = () => new Promise(resolve => setImmediate(resolve));
const liveTrays = () => created.filter(t => !t.destroyed).length;

describe('TrayService: hide icon while invisible', () => {
    beforeEach(() => {
        trayService.destroy();
        trayService.disposed = false;
        prefs.clear();
        protectionOn = true;
        if (!trayService.initialized) trayService.initialize();
        trayService.applyTrayVisibility();
    });

    test('the icon is shown by default, even while invisible', () => {
        assert.equal(liveTrays(), 1);
    });

    test('turning the option on while invisible removes the icon', async () => {
        trayService._setHideTrayWhileInvisiblePreference(true);
        await tick();
        assert.equal(liveTrays(), 0);
        assert.equal(trayService.tray, null);
    });

    test('the icon follows invisibility on and off when the option is set', async () => {
        trayService._setHideTrayWhileInvisiblePreference(true);
        await tick();

        protectionOn = false;
        internalBridge.emit('window:contentProtectionChanged', { enabled: false });
        await tick();
        assert.equal(liveTrays(), 1);

        protectionOn = true;
        internalBridge.emit('window:contentProtectionChanged', { enabled: true });
        await tick();
        assert.equal(liveTrays(), 0);
    });

    test('a toggle after destroy() (quit) does not bring the icon back', async () => {
        trayService.destroy();
        protectionOn = false;
        internalBridge.emit('window:contentProtectionChanged', { enabled: false });
        await tick();
        assert.equal(liveTrays(), 0);
    });

    test('the tray menu offers the option with its current state', () => {
        prefs.set('hideTrayWhileInvisible', true);
        const item = trayService._buildMenu().find(i => /Icon While Invisible/.test(i.label || ''));
        assert.ok(item, 'menu item exists');
        assert.equal(item.checked, true);
    });
});
