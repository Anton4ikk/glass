const { ipcMain, BrowserWindow } = require('electron');
const Store = require('electron-store');
const settingsRepository = require('./repositories');
const { LOCAL_UID } = require('../common/config/localUser');
const { getStoredApiKey, getStoredProvider, windowPool } = require('../../window/windowManager');

const modelStateService = require('../common/services/modelStateService');
const localAIManager = require('../common/services/localAIManager');

const store = new Store({
    name: 'pickle-glass-settings',
    defaults: {
        users: {}
    }
});

const NOTIFICATION_CONFIG = {
    RELEVANT_WINDOW_TYPES: ['settings', 'main'],
    DEBOUNCE_DELAY: 300, // prevent spam during bulk operations (ms)
    MAX_RETRY_ATTEMPTS: 3,
    RETRY_BASE_DELAY: 1000, // exponential backoff base (ms)
};

async function getModelSettings() {
    try {
        const [config, storedKeys, selectedModels, availableLlm, availableStt] = await Promise.all([
            modelStateService.getProviderConfig(),
            modelStateService.getAllApiKeys(),
            modelStateService.getSelectedModels(),
            modelStateService.getAvailableModels('llm'),
            modelStateService.getAvailableModels('stt')
        ]);
        
        return { success: true, data: { config, storedKeys, availableLlm, availableStt, selectedModels } };
    } catch (error) {
        console.error('[SettingsService] Error getting model settings:', error);
        return { success: false, error: error.message };
    }
}

async function clearApiKey(provider) {
    const success = await modelStateService.handleRemoveApiKey(provider);
    return { success };
}

async function setSelectedModel(type, modelId) {
    const success = await modelStateService.handleSetSelectedModel(type, modelId);
    return { success };
}

async function getOllamaStatus() {
    return localAIManager.getServiceStatus('ollama');
}

async function ensureOllamaReady() {
    const status = await localAIManager.getServiceStatus('ollama');
    if (!status.installed || !status.running) {
        await localAIManager.startService('ollama');
    }
    return { success: true };
}

async function shutdownOllama() {
    return localAIManager.stopService('ollama');
}

class WindowNotificationManager {
    constructor() {
        this.pendingNotifications = new Map();
    }

    notifyRelevantWindows(event, data = null, options = {}) {
        const { 
            windowTypes = NOTIFICATION_CONFIG.RELEVANT_WINDOW_TYPES,
            debounce = NOTIFICATION_CONFIG.DEBOUNCE_DELAY 
        } = options;

        if (debounce > 0) {
            this.debounceNotification(event, () => {
                this.sendToTargetWindows(event, data, windowTypes);
            }, debounce);
        } else {
            this.sendToTargetWindows(event, data, windowTypes);
        }
    }

    sendToTargetWindows(event, data, windowTypes) {
        const relevantWindows = this.getRelevantWindows(windowTypes);
        
        if (relevantWindows.length === 0) {
            console.log(`[WindowNotificationManager] No relevant windows found for event: ${event}`);
            return;
        }

        console.log(`[WindowNotificationManager] Sending ${event} to ${relevantWindows.length} relevant windows`);
        
        relevantWindows.forEach(win => {
            try {
                if (data) {
                    win.webContents.send(event, data);
                } else {
                    win.webContents.send(event);
                }
            } catch (error) {
                console.warn(`[WindowNotificationManager] Failed to send ${event} to window:`, error.message);
            }
        });
    }

    getRelevantWindows(windowTypes) {
        const allWindows = BrowserWindow.getAllWindows();
        const relevantWindows = [];

        allWindows.forEach(win => {
            if (win.isDestroyed()) return;

            for (const [windowName, poolWindow] of windowPool || []) {
                if (poolWindow === win && windowTypes.includes(windowName)) {
                    if (windowName === 'settings' || win.isVisible()) {
                        relevantWindows.push(win);
                    }
                    break;
                }
            }
        });

        return relevantWindows;
    }

    debounceNotification(key, fn, delay) {
        if (this.pendingNotifications.has(key)) {
            clearTimeout(this.pendingNotifications.get(key));
        }

        const timeoutId = setTimeout(() => {
            fn();
            this.pendingNotifications.delete(key);
        }, delay);

        this.pendingNotifications.set(key, timeoutId);
    }

    cleanup() {
        this.pendingNotifications.forEach(timeoutId => clearTimeout(timeoutId));
        this.pendingNotifications.clear();
    }
}

const windowNotificationManager = new WindowNotificationManager();

const DEFAULT_KEYBINDS = {
    mac: {
        moveUp: 'Cmd+Up',
        moveDown: 'Cmd+Down',
        moveLeft: 'Cmd+Left',
        moveRight: 'Cmd+Right',
        toggleVisibility: 'Cmd+\\',
        toggleClickThrough: 'Cmd+M',
        nextStep: 'Cmd+Enter',
        manualScreenshot: 'Cmd+Shift+S',
        previousResponse: 'Cmd+[',
        nextResponse: 'Cmd+]',
        scrollUp: 'Cmd+Shift+Up',
        scrollDown: 'Cmd+Shift+Down',
    },
    windows: {
        moveUp: 'Ctrl+Up',
        moveDown: 'Ctrl+Down',
        moveLeft: 'Ctrl+Left',
        moveRight: 'Ctrl+Right',
        toggleVisibility: 'Ctrl+\\',
        toggleClickThrough: 'Ctrl+M',
        nextStep: 'Ctrl+Enter',
        manualScreenshot: 'Ctrl+Shift+S',
        previousResponse: 'Ctrl+[',
        nextResponse: 'Ctrl+]',
        scrollUp: 'Ctrl+Shift+Up',
        scrollDown: 'Ctrl+Shift+Down',
    }
};

let currentSettings = null;

function getDefaultSettings() {
    const isMac = process.platform === 'darwin';
    return {
        profile: 'school',
        language: 'en',
        screenshotInterval: '5000',
        imageQuality: '0.8',
        layoutMode: 'stacked',
        keybinds: isMac ? DEFAULT_KEYBINDS.mac : DEFAULT_KEYBINDS.windows,
        throttleTokens: 500,
        maxTokens: 2000,
        throttlePercent: 80,
        googleSearchEnabled: false,
        backgroundTransparency: 0.5,
        fontSize: 14,
        contentProtection: true
    };
}

async function getSettings() {
    try {
        const userSettingsKey = `users.${LOCAL_UID}`;
        
        const defaultSettings = getDefaultSettings();
        const savedSettings = store.get(userSettingsKey, {});
        
        currentSettings = { ...defaultSettings, ...savedSettings };
        return currentSettings;
    } catch (error) {
        console.error('[SettingsService] Error getting settings from store:', error);
        return getDefaultSettings();
    }
}

async function saveSettings(settings) {
    try {
        const userSettingsKey = `users.${LOCAL_UID}`;
        
        const currentSaved = store.get(userSettingsKey, {});
        const newSettings = { ...currentSaved, ...settings };
        
        store.set(userSettingsKey, newSettings);
        currentSettings = newSettings;

        windowNotificationManager.notifyRelevantWindows('settings-updated', currentSettings);

        return { success: true };
    } catch (error) {
        console.error('[SettingsService] Error saving settings to store:', error);
        return { success: false, error: error.message };
    }
}

async function getPresets() {
    try {
        const presets = await settingsRepository.getPresets();
        return presets;
    } catch (error) {
        console.error('[SettingsService] Error getting presets:', error);
        return [];
    }
}

async function getPresetTemplates() {
    try {
        const templates = await settingsRepository.getPresetTemplates();
        return templates;
    } catch (error) {
        console.error('[SettingsService] Error getting preset templates:', error);
        return [];
    }
}

async function createPreset(title, prompt) {
    try {
        const result = await settingsRepository.createPreset({ title, prompt });
        
        windowNotificationManager.notifyRelevantWindows('presets-updated', {
            action: 'created',
            presetId: result.id,
            title
        });
        
        return { success: true, id: result.id };
    } catch (error) {
        console.error('[SettingsService] Error creating preset:', error);
        return { success: false, error: error.message };
    }
}

async function updatePreset(id, title, prompt) {
    try {
        await settingsRepository.updatePreset(id, { title, prompt });
        
        windowNotificationManager.notifyRelevantWindows('presets-updated', {
            action: 'updated',
            presetId: id,
            title
        });
        
        return { success: true };
    } catch (error) {
        console.error('[SettingsService] Error updating preset:', error);
        return { success: false, error: error.message };
    }
}

async function deletePreset(id) {
    try {
        await settingsRepository.deletePreset(id);
        
        windowNotificationManager.notifyRelevantWindows('presets-updated', {
            action: 'deleted',
            presetId: id
        });
        
        return { success: true };
    } catch (error) {
        console.error('[SettingsService] Error deleting preset:', error);
        return { success: false, error: error.message };
    }
}

async function saveApiKey(apiKey, provider = 'openai') {
    try {
        const modelStateService = global.modelStateService;
        if (!modelStateService) {
            throw new Error('ModelStateService not initialized');
        }

        await modelStateService.setApiKey(provider, apiKey);

        BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) {
                win.webContents.send('api-key-validated', apiKey);
            }
        });
        
        return { success: true };
    } catch (error) {
        console.error('[SettingsService] Error saving API key:', error);
        return { success: false, error: error.message };
    }
}

async function removeApiKey() {
    try {
        const modelStateService = global.modelStateService;
        if (!modelStateService) {
            throw new Error('ModelStateService not initialized');
        }

        const providers = ['openai', 'anthropic', 'gemini', 'ollama', 'whisper'];
        for (const provider of providers) {
            await modelStateService.removeApiKey(provider);
        }

        BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) {
                win.webContents.send('api-key-removed');
            }
        });
        
        console.log('[SettingsService] API key removed for all providers');
        return { success: true };
    } catch (error) {
        console.error('[SettingsService] Error removing API key:', error);
        return { success: false, error: error.message };
    }
}

async function updateContentProtection(enabled) {
    try {
        const settings = await getSettings();
        settings.contentProtection = enabled;

        const { app } = require('electron');
        const mainWindow = windowPool.get('main');
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setContentProtection(enabled);
        }
        
        return await saveSettings(settings);
    } catch (error) {
        console.error('[SettingsService] Error updating content protection:', error);
        return { success: false, error: error.message };
    }
}

async function getSttLanguageSetting() {
    try {
        return await settingsRepository.getSttLanguage();
    } catch (error) {
        console.error('[SettingsService] Error getting STT language setting:', error);
        return 'en'; // Fallback to the schema default
    }
}

async function setSttLanguageSetting(language) {
    try {
        const result = await settingsRepository.setSttLanguage(language);
        return { success: true, language: result?.language || language };
    } catch (error) {
        console.error('[SettingsService] Error setting STT language setting:', error);
        return { success: false, error: error.message };
    }
}

async function getAskThinkingSetting() {
    try {
        return await settingsRepository.getAskThinking();
    } catch (error) {
        console.error('[SettingsService] Error getting Ask thinking setting:', error);
        return false; // Fallback to the schema default
    }
}

async function setAskThinkingSetting(enabled) {
    try {
        const result = await settingsRepository.setAskThinking(!!enabled);
        if (result?.success === false) return result;
        return { success: true, enabled: !!enabled };
    } catch (error) {
        console.error('[SettingsService] Error setting Ask thinking setting:', error);
        return { success: false, error: error.message };
    }
}

async function getAboutMeSetting() {
    try {
        return await settingsRepository.getAboutMe();
    } catch (error) {
        console.error('[SettingsService] Error getting About me:', error);
        return '';
    }
}

async function setAboutMeSetting(text) {
    try {
        const result = await settingsRepository.setAboutMe(text);
        if (result?.success === false) return result;
        return { success: true, aboutMe: result?.aboutMe ?? '' };
    } catch (error) {
        console.error('[SettingsService] Error setting About me:', error);
        return { success: false, error: error.message };
    }
}

function initialize() {
    windowNotificationManager.cleanup();

    console.log('[SettingsService] Initialized and ready.');
}

function cleanup() {
    windowNotificationManager.cleanup();
    console.log('[SettingsService] Cleaned up resources.');
}

function notifyPresetUpdate(action, presetId, title = null) {
    const data = { action, presetId };
    if (title) data.title = title;
    
    windowNotificationManager.notifyRelevantWindows('presets-updated', data);
}

module.exports = {
    initialize,
    cleanup,
    notifyPresetUpdate,
    getSettings,
    saveSettings,
    getPresets,
    getPresetTemplates,
    createPreset,
    updatePreset,
    deletePreset,
    saveApiKey,
    removeApiKey,
    updateContentProtection,
    getSttLanguageSetting,
    setSttLanguageSetting,
    getAskThinkingSetting,
    setAskThinkingSetting,
    getAboutMeSetting,
    setAboutMeSetting,
    getModelSettings,
    clearApiKey,
    setSelectedModel,
    getOllamaStatus,
    ensureOllamaReady,
    shutdownOllama
};