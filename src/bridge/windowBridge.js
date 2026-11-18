const { ipcMain, shell } = require('electron');

// Only registers IPC handlers; no business logic here.
module.exports = {
  initialize() {
    // Required lazily to break a circular dependency with windowManager.
    const windowManager = require('../window/windowManager');

    ipcMain.handle('toggle-content-protection', () => windowManager.toggleContentProtection());
    ipcMain.handle('resize-header-window', (event, args) => windowManager.resizeHeaderWindow(args));
    ipcMain.handle('get-content-protection-status', () => windowManager.getContentProtectionStatus());
    ipcMain.on('show-settings-window', () => windowManager.showSettingsWindow());
    ipcMain.on('hide-settings-window', () => windowManager.hideSettingsWindow());
    ipcMain.on('cancel-hide-settings-window', () => windowManager.cancelHideSettingsWindow());

    ipcMain.handle('move-window-step', (event, direction) => windowManager.moveWindowStep(direction));
    ipcMain.handle('open-external', (event, url) => shell.openExternal(url));

    ipcMain.on('header-state-changed', (event, state) => windowManager.handleHeaderStateChanged(state));
    ipcMain.on('header-animation-finished', (event, state) => windowManager.handleHeaderAnimationFinished(state));
    ipcMain.handle('get-header-position', () => windowManager.getHeaderPosition());
    ipcMain.handle('move-header-to', (event, newX, newY) => windowManager.moveHeaderTo(newX, newY));
    ipcMain.handle('adjust-window-height', (event, { winName, height }) => windowManager.adjustWindowHeight(winName, height));
  },

  notifyFocusChange(win, isFocused) {
    win.webContents.send('window:focus-change', isFocused);
  }
};