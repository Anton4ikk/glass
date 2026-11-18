const { contextBridge, ipcRenderer } = require('electron');

// One namespace per UI component; the comment above each names its consumer.
contextBridge.exposeInMainWorld('api', {
  platform: {
    isLinux: process.platform === 'linux',
    isMacOS: process.platform === 'darwin',
    isWindows: process.platform === 'win32',
    platform: process.platform
  },

  common: {
    quitApplication: () => ipcRenderer.invoke('quit-application'),
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
  },

  // src/ui/app/ApiKeyHeader.js
  apiKeyHeader: {
    getProviderConfig: () => ipcRenderer.invoke('model:get-provider-config'),
    getLocalAIStatus: (service) => ipcRenderer.invoke('localai:get-status', service),
    installLocalAI: (service, options) => ipcRenderer.invoke('localai:install', { service, options }),
    startLocalAIService: (service) => ipcRenderer.invoke('localai:start-service', service),
    stopLocalAIService: (service) => ipcRenderer.invoke('localai:stop-service', service),
    installLocalAIModel: (service, modelId, options) => ipcRenderer.invoke('localai:install-model', { service, modelId, options }),
    getInstalledModels: (service) => ipcRenderer.invoke('localai:get-installed-models', service),
    
    // Legacy aliases, kept for compatibility.
    getOllamaStatus: () => ipcRenderer.invoke('localai:get-status', 'ollama'),
    getModelSuggestions: () => ipcRenderer.invoke('ollama:get-model-suggestions'),
    ensureOllamaReady: () => ipcRenderer.invoke('ollama:ensure-ready'),
    installOllama: () => ipcRenderer.invoke('localai:install', { service: 'ollama' }),
    startOllamaService: () => ipcRenderer.invoke('localai:start-service', 'ollama'),
    pullOllamaModel: (modelName) => ipcRenderer.invoke('ollama:pull-model', modelName),
    downloadWhisperModel: (modelId) => ipcRenderer.invoke('whisper:download-model', modelId),
    validateKey: (data) => ipcRenderer.invoke('model:validate-key', data),
    setSelectedModel: (data) => ipcRenderer.invoke('model:set-selected-model', data),
    areProvidersConfigured: () => ipcRenderer.invoke('model:are-providers-configured'),
    getSttLanguage: () => ipcRenderer.invoke('settings:get-stt-language'),
    setSttLanguage: (language) => ipcRenderer.invoke('settings:set-stt-language', language),

    getHeaderPosition: () => ipcRenderer.invoke('get-header-position'),
    moveHeaderTo: (x, y) => ipcRenderer.invoke('move-header-to', x, y),

    onLocalAIProgress: (callback) => ipcRenderer.on('localai:install-progress', callback),
    removeOnLocalAIProgress: (callback) => ipcRenderer.removeListener('localai:install-progress', callback),
    onLocalAIComplete: (callback) => ipcRenderer.on('localai:installation-complete', callback),
    removeOnLocalAIComplete: (callback) => ipcRenderer.removeListener('localai:installation-complete', callback),
    onLocalAIError: (callback) => ipcRenderer.on('localai:error-occurred', callback),
    removeOnLocalAIError: (callback) => ipcRenderer.removeListener('localai:error-occurred', callback),
    onLocalAIModelReady: (callback) => ipcRenderer.on('localai:model-ready', callback),
    removeOnLocalAIModelReady: (callback) => ipcRenderer.removeListener('localai:model-ready', callback),

    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('localai:install-progress');
      ipcRenderer.removeAllListeners('localai:installation-complete');
      ipcRenderer.removeAllListeners('localai:error-occurred');
      ipcRenderer.removeAllListeners('localai:model-ready');
      ipcRenderer.removeAllListeners('localai:service-status-changed');
    }
  },

  // src/ui/app/HeaderController.js
  headerController: {
    sendHeaderStateChanged: (state) => ipcRenderer.send('header-state-changed', state),
    reInitializeModelState: () => ipcRenderer.invoke('model:re-initialize-state'),

    resizeHeaderWindow: (dimensions) => ipcRenderer.invoke('resize-header-window', dimensions),

    checkSystemPermissions: () => ipcRenderer.invoke('check-system-permissions'),
    checkPermissionsCompleted: () => ipcRenderer.invoke('check-permissions-completed'),

    onForceShowApiKeyHeader: (callback) => ipcRenderer.on('force-show-apikey-header', callback),
    removeOnForceShowApiKeyHeader: (callback) => ipcRenderer.removeListener('force-show-apikey-header', callback),
  },

  // src/ui/app/MainHeader.js
  mainHeader: {
    getHeaderPosition: () => ipcRenderer.invoke('get-header-position'),
    moveHeaderTo: (x, y) => ipcRenderer.invoke('move-header-to', x, y),
    sendHeaderAnimationFinished: (state) => ipcRenderer.send('header-animation-finished', state),

    cancelHideSettingsWindow: () => ipcRenderer.send('cancel-hide-settings-window'),
    showSettingsWindow: () => ipcRenderer.send('show-settings-window'),
    hideSettingsWindow: () => ipcRenderer.send('hide-settings-window'),

    sendListenButtonClick: (listenButtonText) => ipcRenderer.invoke('listen:changeSession', listenButtonText),
    sendAskButtonClick: () => ipcRenderer.invoke('ask:toggleAskButton'),

    onListenChangeSessionResult: (callback) => ipcRenderer.on('listen:changeSessionResult', callback),
    removeOnListenChangeSessionResult: (callback) => ipcRenderer.removeListener('listen:changeSessionResult', callback),
    onShortcutsUpdated: (callback) => ipcRenderer.on('shortcuts-updated', callback),
    removeOnShortcutsUpdated: (callback) => ipcRenderer.removeListener('shortcuts-updated', callback)
  },

  // src/ui/app/PermissionHeader.js
  permissionHeader: {
    checkSystemPermissions: () => ipcRenderer.invoke('check-system-permissions'),
    requestMicrophonePermission: () => ipcRenderer.invoke('request-microphone-permission'),
    openSystemPreferences: (preference) => ipcRenderer.invoke('open-system-preferences', preference),
  },

  // src/ui/app/PickleGlassApp.js
  pickleGlassApp: {
    onClickThroughToggled: (callback) => ipcRenderer.on('click-through-toggled', callback),
    removeOnClickThroughToggled: (callback) => ipcRenderer.removeListener('click-through-toggled', callback),
    removeAllClickThroughListeners: () => ipcRenderer.removeAllListeners('click-through-toggled')
  },

  // src/ui/ask/AskView.js
  askView: {
    closeAskWindow: () => ipcRenderer.invoke('ask:closeAskWindow'),
    adjustWindowHeight: (winName, height) => ipcRenderer.invoke('adjust-window-height', { winName, height }),

    sendMessage: (text) => ipcRenderer.invoke('ask:sendQuestionFromAsk', text),

    onAskStateUpdate: (callback) => ipcRenderer.on('ask:stateUpdate', callback),
    removeOnAskStateUpdate: (callback) => ipcRenderer.removeListener('ask:stateUpdate', callback),

    onAskStreamError: (callback) => ipcRenderer.on('ask-response-stream-error', callback),
    removeOnAskStreamError: (callback) => ipcRenderer.removeListener('ask-response-stream-error', callback),

    onShowTextInput: (callback) => ipcRenderer.on('ask:showTextInput', callback),
    removeOnShowTextInput: (callback) => ipcRenderer.removeListener('ask:showTextInput', callback),
    
    onScrollResponseUp: (callback) => ipcRenderer.on('aks:scrollResponseUp', callback),
    removeOnScrollResponseUp: (callback) => ipcRenderer.removeListener('aks:scrollResponseUp', callback),
    onScrollResponseDown: (callback) => ipcRenderer.on('aks:scrollResponseDown', callback),
    removeOnScrollResponseDown: (callback) => ipcRenderer.removeListener('aks:scrollResponseDown', callback)
  },

  // src/ui/listen/ListenView.js
  listenView: {
    adjustWindowHeight: (winName, height) => ipcRenderer.invoke('adjust-window-height', { winName, height }),

    onSessionStateChanged: (callback) => ipcRenderer.on('session-state-changed', callback),
    removeOnSessionStateChanged: (callback) => ipcRenderer.removeListener('session-state-changed', callback)
  },

  // src/ui/listen/stt/SttView.js
  sttView: {
    onSttUpdate: (callback) => ipcRenderer.on('stt-update', callback),
    removeOnSttUpdate: (callback) => ipcRenderer.removeListener('stt-update', callback)
  },

  // src/ui/listen/summary/SummaryView.js
  summaryView: {
    sendQuestionFromSummary: (text) => ipcRenderer.invoke('ask:sendQuestionFromSummary', text),

    onSummaryUpdate: (callback) => ipcRenderer.on('summary-update', callback),
    removeOnSummaryUpdate: (callback) => ipcRenderer.removeListener('summary-update', callback),
    removeAllSummaryUpdateListeners: () => ipcRenderer.removeAllListeners('summary-update')
  },

  // src/ui/settings/SettingsView.js
  settingsView: {
    getModelSettings: () => ipcRenderer.invoke('settings:get-model-settings'),
    getProviderConfig: () => ipcRenderer.invoke('model:get-provider-config'),
    getAllKeys: () => ipcRenderer.invoke('model:get-all-keys'),
    getAvailableModels: (type) => ipcRenderer.invoke('model:get-available-models', type),
    getSelectedModels: () => ipcRenderer.invoke('model:get-selected-models'),
    getSttLanguage: () => ipcRenderer.invoke('settings:get-stt-language'),
    setSttLanguage: (language) => ipcRenderer.invoke('settings:set-stt-language', language),
    getAskThinking: () => ipcRenderer.invoke('settings:get-ask-thinking'),
    setAskThinking: (enabled) => ipcRenderer.invoke('settings:set-ask-thinking', enabled),
    getAboutMe: () => ipcRenderer.invoke('settings:get-about-me'),
    setAboutMe: (text) => ipcRenderer.invoke('settings:set-about-me', text),
    validateKey: (data) => ipcRenderer.invoke('model:validate-key', data),
    saveApiKey: (key) => ipcRenderer.invoke('model:save-api-key', key),
    removeApiKey: (provider) => ipcRenderer.invoke('model:remove-api-key', provider),
    setSelectedModel: (data) => ipcRenderer.invoke('model:set-selected-model', data),

    getOllamaStatus: () => ipcRenderer.invoke('ollama:get-status'),
    ensureOllamaReady: () => ipcRenderer.invoke('ollama:ensure-ready'),
    shutdownOllama: (graceful) => ipcRenderer.invoke('ollama:shutdown', graceful),

    getWhisperInstalledModels: () => ipcRenderer.invoke('whisper:get-installed-models'),
    downloadWhisperModel: (modelId) => ipcRenderer.invoke('whisper:download-model', modelId),

    getPresets: () => ipcRenderer.invoke('settings:getPresets'),
    getContentProtectionStatus: () => ipcRenderer.invoke('get-content-protection-status'),
    toggleContentProtection: () => ipcRenderer.invoke('toggle-content-protection'),
    getCurrentShortcuts: () => ipcRenderer.invoke('settings:getCurrentShortcuts'),
    openShortcutSettingsWindow: () => ipcRenderer.invoke('shortcut:openShortcutSettingsWindow'),

    moveWindowStep: (direction) => ipcRenderer.invoke('move-window-step', direction),
    cancelHideSettingsWindow: () => ipcRenderer.send('cancel-hide-settings-window'),
    hideSettingsWindow: () => ipcRenderer.send('hide-settings-window'),

    quitApplication: () => ipcRenderer.invoke('quit-application'),

    pullOllamaModel: (modelName) => ipcRenderer.invoke('ollama:pull-model', modelName),

    onSettingsUpdated: (callback) => ipcRenderer.on('settings-updated', callback),
    removeOnSettingsUpdated: (callback) => ipcRenderer.removeListener('settings-updated', callback),
    onPresetsUpdated: (callback) => ipcRenderer.on('presets-updated', callback),
    removeOnPresetsUpdated: (callback) => ipcRenderer.removeListener('presets-updated', callback),
    onShortcutsUpdated: (callback) => ipcRenderer.on('shortcuts-updated', callback),
    removeOnShortcutsUpdated: (callback) => ipcRenderer.removeListener('shortcuts-updated', callback),
    onLocalAIInstallProgress: (callback) => ipcRenderer.on('localai:install-progress', callback),
    removeOnLocalAIInstallProgress: (callback) => ipcRenderer.removeListener('localai:install-progress', callback),
    onLocalAIInstallationComplete: (callback) => ipcRenderer.on('localai:installation-complete', callback),
    removeOnLocalAIInstallationComplete: (callback) => ipcRenderer.removeListener('localai:installation-complete', callback)
  },

  // src/ui/settings/ShortCutSettingsView.js
  shortcutSettingsView: {
    saveShortcuts: (shortcuts) => ipcRenderer.invoke('shortcut:saveShortcuts', shortcuts),
    getDefaultShortcuts: () => ipcRenderer.invoke('shortcut:getDefaultShortcuts'),
    closeShortcutSettingsWindow: () => ipcRenderer.invoke('shortcut:closeShortcutSettingsWindow'),

    onLoadShortcuts: (callback) => ipcRenderer.on('shortcut:loadShortcuts', callback),
    removeOnLoadShortcuts: (callback) => ipcRenderer.removeListener('shortcut:loadShortcuts', callback)
  },

  // src/ui/app/content.html inline scripts
  content: {
    onSettingsWindowHideAnimation: (callback) => ipcRenderer.on('settings-window-hide-animation', callback),
    removeOnSettingsWindowHideAnimation: (callback) => ipcRenderer.removeListener('settings-window-hide-animation', callback),    
  },

  // src/ui/listen/audioCore/listenCapture.js
  listenCapture: {
    sendMicAudioContent: (data) => ipcRenderer.invoke('listen:sendMicAudio', data),
    sendSystemAudioContent: (data) => ipcRenderer.invoke('listen:sendSystemAudio', data),
    startMacosSystemAudio: () => ipcRenderer.invoke('listen:startMacosSystemAudio'),
    stopMacosSystemAudio: () => ipcRenderer.invoke('listen:stopMacosSystemAudio'),
    log: (msg) => ipcRenderer.send('listen:rendererLog', msg),

    isSessionActive: () => ipcRenderer.invoke('listen:isSessionActive'),

    onSystemAudioData: (callback) => ipcRenderer.on('system-audio-data', callback),
    removeOnSystemAudioData: (callback) => ipcRenderer.removeListener('system-audio-data', callback)
  },

  // src/ui/listen/audioCore/renderer.js
  renderer: {
    onChangeListenCaptureState: (callback) => ipcRenderer.on('change-listen-capture-state', callback),
    removeOnChangeListenCaptureState: (callback) => ipcRenderer.removeListener('change-listen-capture-state', callback)
  }
});