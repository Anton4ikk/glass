const { app, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('node:path');
const Store = require('electron-store');
const internalBridge = require('../../bridge/internalBridge');

const ASSETS_DIR = path.join(__dirname, '../../ui/assets');
const TRAY_ASSETS_DIR = path.join(ASSETS_DIR, 'tray');

class TrayService {
    constructor() {
        this.tray = null;
        this.store = null;
        this.keybinds = {};
        this.isListening = false;
    }

    initialize() {
        if (this.tray) return this.tray;

        this._getStore();

        this.tray = new Tray(this._buildIcon(false));
        this.tray.setToolTip('Glass');
        if (process.platform === 'darwin') {
            this.tray.setIgnoreDoubleClickEvents(true);
        }

        if (process.platform === 'linux') {
            // Linux only shows a menu that was attached with setContextMenu().
            this._syncStaticMenu();
        } else {
            // Build the menu on every click so it always reflects the live state.
            this.tray.on('click', () => this._popUpMenu());
            this.tray.on('right-click', () => this._popUpMenu());
        }

        internalBridge.on('listen:sessionStateChanged', ({ isActive }) => {
            this.isListening = !!isActive;
            this._refreshIcon();
            this._syncStaticMenu();
        });
        internalBridge.on('reregister-shortcuts', () => this._refreshKeybinds());

        this._refreshKeybinds();
        this.applyDockPreference();

        console.log('[TrayService] Tray icon created.');
        return this.tray;
    }

    destroy() {
        if (this.tray && !this.tray.isDestroyed()) {
            this.tray.destroy();
        }
        this.tray = null;
    }

    /* ────────────────[ icon ]─────────────── */

    _buildIcon(isListening) {
        if (process.platform === 'darwin') {
            const name = isListening ? 'glassActiveTemplate.png' : 'glassTemplate.png';
            const image = nativeImage.createFromPath(path.join(TRAY_ASSETS_DIR, name));
            image.setTemplateImage(true);
            return image;
        }

        // Windows / Linux have no template images - use the app logo instead.
        const image = nativeImage.createFromPath(path.join(ASSETS_DIR, 'logo.png'));
        return image.isEmpty() ? image : image.resize({ width: 16, height: 16 });
    }

    _refreshIcon() {
        if (!this.tray || this.tray.isDestroyed()) return;
        this.tray.setImage(this._buildIcon(this.isListening));
        this.tray.setToolTip(this.isListening ? 'Glass - listening' : 'Glass');
    }

    /* ────────────────[ state helpers ]─────────────── */

    async _refreshKeybinds() {
        try {
            const shortcutsService = require('../shortcuts/shortcutsService');
            this.keybinds = await shortcutsService.loadKeybinds();
        } catch (error) {
            console.warn('[TrayService] Could not load keybinds:', error.message);
        }
    }

    _getHeader() {
        const { windowPool } = require('../../window/windowManager');
        const header = windowPool.get('header');
        return header && !header.isDestroyed() ? header : null;
    }

    _isMainState() {
        // Feature windows only exist once the user is past the api-key / permission screens.
        const { windowPool } = require('../../window/windowManager');
        const ask = windowPool.get('ask');
        return !!(ask && !ask.isDestroyed());
    }

    async _ensureWindowsVisible() {
        const header = this._getHeader();
        if (!header || header.isVisible()) return;
        const shortcutsService = require('../shortcuts/shortcutsService');
        await shortcutsService.toggleAllWindowsVisibility();
    }

    /* ────────────────[ menu ]─────────────── */

    _popUpMenu() {
        if (!this.tray || this.tray.isDestroyed()) return;
        this._refreshKeybinds();
        this.tray.popUpContextMenu(this._buildMenu());
    }

    _syncStaticMenu() {
        if (process.platform !== 'linux') return;
        if (!this.tray || this.tray.isDestroyed()) return;
        this.tray.setContextMenu(this._buildMenu());
    }

    _buildMenu() {
        const { getContentProtectionStatus, setContentProtection } = require('../../window/windowManager');
        const listenService = require('../listen/listenService');
        const askService = require('../ask/askService');
        const shortcutsService = require('../shortcuts/shortcutsService');

        const header = this._getHeader();
        const isVisible = !!header && header.isVisible();
        const isMain = this._isMainState();
        const isSessionActive = listenService.isSessionActive();
        const hideDockIcon = this._getHideDockIconPreference();

        const template = [
            {
                label: isVisible ? 'Hide Glass' : 'Show Glass',
                accelerator: this.keybinds.toggleVisibility,
                registerAccelerator: false,
                click: async () => {
                    await shortcutsService.toggleAllWindowsVisibility();
                    this._syncStaticMenu();
                },
            },
            { type: 'separator' },
            {
                label: 'Ask...',
                accelerator: this.keybinds.nextStep,
                registerAccelerator: false,
                enabled: isMain,
                click: async () => {
                    await this._ensureWindowsVisible();
                    askService.toggleAskButton();
                },
            },
            {
                label: isSessionActive ? 'Stop Listening' : 'Start Listening',
                enabled: isMain,
                click: async () => {
                    await this._ensureWindowsVisible();
                    try {
                        await listenService.handleListenRequest(isSessionActive ? 'Stop' : 'Listen');
                    } catch (error) {
                        console.error('[TrayService] Listen request failed:', error);
                    }
                },
            },
            {
                label: 'Settings',
                enabled: isMain,
                click: async () => {
                    await this._ensureWindowsVisible();
                    internalBridge.emit('window:requestVisibility', { name: 'settings', visible: true });
                },
            },
            {
                label: 'Keyboard Shortcuts...',
                enabled: isMain,
                click: async () => {
                    await this._ensureWindowsVisible();
                    shortcutsService.openShortcutSettingsWindow();
                },
            },
            { type: 'separator' },
            {
                label: 'Activity & History',
                click: () => {
                    const webUrl = process.env.pickleglass_WEB_URL || 'http://localhost:3000';
                    shell.openExternal(`${webUrl}/activity`);
                },
            },
            {
                label: 'Invisible to Screen Sharing',
                type: 'checkbox',
                checked: getContentProtectionStatus(),
                click: menuItem => {
                    setContentProtection(menuItem.checked);
                    this._syncStaticMenu();
                },
            },
        ];

        if (process.platform === 'darwin') {
            template.push({
                label: 'Show Icon in Dock',
                type: 'checkbox',
                checked: !hideDockIcon,
                click: menuItem => this._setHideDockIconPreference(!menuItem.checked),
            });
        }

        template.push(
            { type: 'separator' },
            {
                label: 'Quit Glass',
                accelerator: process.platform === 'darwin' ? 'Cmd+Q' : undefined,
                registerAccelerator: false,
                click: () => app.quit(),
            }
        );

        return Menu.buildFromTemplate(template);
    }

    /* ────────────────[ dock icon ]─────────────── */

    _getStore() {
        if (!this.store) {
            this.store = new Store({ name: 'tray-preferences' });
        }
        return this.store;
    }

    _getHideDockIconPreference() {
        // Glass lives in the menu bar - the dock icon is opt-in.
        return this._getStore().get('hideDockIcon', true);
    }

    _setHideDockIconPreference(hide) {
        this._getStore().set('hideDockIcon', hide);
        this.applyDockPreference();
    }

    applyDockPreference() {
        if (process.platform !== 'darwin' || !app.dock) return;
        if (this._getHideDockIconPreference()) {
            app.dock.hide();
        } else {
            Promise.resolve(app.dock.show()).catch(error => {
                console.warn('[TrayService] Could not show dock icon:', error.message);
            });
        }
    }
}

const trayService = new TrayService();
module.exports = trayService;
