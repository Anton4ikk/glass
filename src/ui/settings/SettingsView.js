import { html, css, LitElement } from '../assets/lit-core-2.7.4.min.js';
// import { getOllamaProgressTracker } from '../../features/common/services/localProgressTracker.js'; // 제거됨

// Mirrors MAX_ABOUT_ME_LENGTH in features/common/prompts/aboutMe.js.
const ABOUT_ME_MAX_LENGTH = 4000;

export class SettingsView extends LitElement {
    static styles = css`
        * {
            font-family: 'Helvetica Neue', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            cursor: default;
            user-select: none;
        }

        :host {
            display: block;
            width: 240px;
            height: 100%;
            color: white;
        }

        .settings-container {
            display: flex;
            flex-direction: column;
            height: 100%;
            width: 100%;
            background: rgba(20, 20, 20, 0.8);
            border-radius: 12px;
            outline: 0.5px rgba(255, 255, 255, 0.2) solid;
            outline-offset: -1px;
            box-sizing: border-box;
            position: relative;
            overflow-y: auto;
            padding: 12px 12px;
            z-index: 1000;
        }

        .settings-container::-webkit-scrollbar {
            width: 6px;
        }

        .settings-container::-webkit-scrollbar-track {
            background: rgba(255, 255, 255, 0.05);
            border-radius: 3px;
        }

        .settings-container::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.2);
            border-radius: 3px;
        }

        .settings-container::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.3);
        }

        .settings-container::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.15);
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            border-radius: 12px;
            filter: blur(10px);
            z-index: -1;
        }
            
        .settings-button[disabled],
        .api-key-section input[disabled] {
            opacity: 0.4;
            cursor: not-allowed;
            pointer-events: none;
        }

        .header-section {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            padding-bottom: 6px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            position: relative;
            z-index: 1;
        }

        .title-line {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .app-title {
            font-size: 13px;
            font-weight: 500;
            color: white;
            margin: 0 0 4px 0;
        }

        .invisibility-icon {
            padding-top: 2px;
            opacity: 0;
            transition: opacity 0.3s ease;
        }

        .invisibility-icon.visible {
            opacity: 1;
        }

        .invisibility-icon svg {
            width: 16px;
            height: 16px;
        }

        .shortcuts-section {
            display: flex;
            flex-direction: column;
            gap: 2px;
            padding: 4px 0;
            position: relative;
            z-index: 1;
        }

        .shortcut-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px 0;
            color: white;
            font-size: 11px;
        }

        .shortcut-name {
            font-weight: 300;
        }

        .shortcut-keys {
            display: flex;
            align-items: center;
            gap: 3px;
        }

        .cmd-key, .shortcut-key {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 3px;
            width: 16px;
            height: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            font-weight: 500;
            color: rgba(255, 255, 255, 0.9);
        }

        /* Buttons Section */
        /* Actions come first, right under the header's own divider. */
        .buttons-section.actions-section {
            flex: none;
            border-top: none;
            padding-top: 0;
            padding-bottom: 6px;
        }

        .buttons-section {
            display: flex;
            flex-direction: column;
            gap: 4px;
            padding-top: 6px;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            position: relative;
            z-index: 1;
            flex: 1;
        }

        .settings-button {
            background: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 4px;
            color: white;
            padding: 5px 10px;
            font-size: 11px;
            font-weight: 400;
            cursor: pointer;
            transition: all 0.15s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            white-space: nowrap;
        }

        .settings-button:hover {
            background: rgba(255, 255, 255, 0.15);
            border-color: rgba(255, 255, 255, 0.3);
        }

        .settings-button:active {
            transform: translateY(1px);
        }

        .settings-button.full-width {
            width: 100%;
        }

        .settings-button.half-width {
            flex: 1;
        }

        .settings-button.danger {
            background: rgba(255, 59, 48, 0.1);
            border-color: rgba(255, 59, 48, 0.3);
            color: rgba(255, 59, 48, 0.9);
        }

        .settings-button.danger:hover {
            background: rgba(255, 59, 48, 0.15);
            border-color: rgba(255, 59, 48, 0.4);
        }

        .move-buttons {
            display: flex;
            gap: 4px;
        }

        .api-key-section {
            padding: 6px 0;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
        }

        .api-key-section input {
            width: 100%;
            background: rgba(0,0,0,0.2);
            border: 1px solid rgba(255,255,255,0.2);
            color: white;
            border-radius: 4px;
            padding: 4px;
            font-size: 11px;
            margin-bottom: 4px;
            box-sizing: border-box;
        }

        .api-key-section input::placeholder {
            color: rgba(255, 255, 255, 0.4);
        }

        /* About Me sub-page */
        .about-me-section {
            display: flex;
            flex-direction: column;
            gap: 6px;
            padding: 8px 0;
            position: relative;
            z-index: 1;
        }

        .about-me-hint {
            margin: 0;
            font-size: 10px;
            line-height: 1.4;
            color: rgba(255, 255, 255, 0.6);
        }

        .about-me-input {
            width: 100%;
            min-height: 180px;
            resize: vertical;
            box-sizing: border-box;
            background: rgba(0, 0, 0, 0.2);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 4px;
            color: white;
            padding: 6px 8px;
            font-size: 11px;
            line-height: 1.4;
            font-family: inherit;
        }

        .about-me-input:focus {
            outline: none;
            border-color: rgba(0, 122, 255, 0.6);
        }

        .about-me-input::placeholder {
            color: rgba(255, 255, 255, 0.35);
        }

        .about-me-footer {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 8px;
        }

        .about-me-status {
            font-size: 10px;
            color: rgba(255, 255, 255, 0.5);
        }

        .loading-state {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
            color: rgba(255, 255, 255, 0.7);
            font-size: 11px;
        }

        .loading-spinner {
            width: 12px;
            height: 12px;
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-top: 1px solid rgba(255, 255, 255, 0.8);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-right: 6px;
        }

        .hidden {
            display: none;
        }

        /* Rows that open a sub-page (API keys, shortcuts). */
        .nav-section {
            display: flex;
            flex-direction: column;
            gap: 4px;
            padding: 6px 0;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
        }

        .nav-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            width: 100%;
            background: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 4px;
            color: white;
            padding: 5px 10px;
            font-size: 11px;
            font-family: inherit;
            cursor: pointer;
            transition: all 0.15s ease;
        }

        .nav-row:hover {
            background: rgba(255, 255, 255, 0.15);
            border-color: rgba(255, 255, 255, 0.3);
        }

        .nav-row-meta {
            display: flex;
            align-items: center;
            gap: 6px;
            color: rgba(255, 255, 255, 0.5);
            font-size: 10px;
        }

        .nav-chevron {
            font-size: 13px;
            line-height: 1;
            color: rgba(255, 255, 255, 0.7);
        }

        .subpage-header {
            display: flex;
            align-items: center;
            gap: 8px;
            padding-bottom: 6px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            position: relative;
            z-index: 1;
        }

        .back-button {
            background: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 4px;
            color: white;
            padding: 3px 8px;
            font-size: 11px;
            font-family: inherit;
            cursor: pointer;
        }

        .back-button:hover {
            background: rgba(255, 255, 255, 0.15);
        }

        .subpage-title {
            font-size: 13px;
            font-weight: 500;
            margin: 0;
        }

        /* The sub-page header already draws the divider. */
        .subpage .api-key-section,
        .subpage .buttons-section {
            border-top: none;
        }

        .api-key-section, .model-selection-section {
            padding: 8px 0;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .provider-key-group, .model-select-group {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        /* Two options only, so a segmented toggle beats a dropdown. */
        .lang-toggle-options {
            display: flex;
            padding: 2px;
            gap: 2px;
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 4px;
        }
        .lang-toggle-option {
            flex: 1;
            padding: 5px 8px;
            background: transparent;
            border: none;
            border-radius: 3px;
            color: rgba(255, 255, 255, 0.7);
            font-size: 11px;
            font-family: inherit;
            font-weight: 500;
            cursor: pointer;
        }
        .lang-toggle-option:hover:not([data-selected='true']) {
            background: rgba(255, 255, 255, 0.1);
        }
        .lang-toggle-option[data-selected='true'] {
            background: rgba(0, 122, 255, 0.55);
            color: white;
        }
        label {
            font-size: 11px;
            font-weight: 500;
            color: rgba(255, 255, 255, 0.8);
            margin-left: 2px;
        }
        label > strong {
            color: white;
            font-weight: 600;
        }
        .provider-key-group input {
            width: 100%; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.2);
            color: white; border-radius: 4px; padding: 5px 8px; font-size: 11px; box-sizing: border-box;
        }
        .key-buttons { display: flex; gap: 4px; }
        .key-buttons .settings-button { flex: 1; padding: 4px; }
        .model-list {
            display: flex; flex-direction: column; gap: 2px; max-height: 120px;
            overflow-y: auto; background: rgba(0,0,0,0.3); border-radius: 4px;
            padding: 4px; margin-top: 4px;
        }
        .model-item { 
            padding: 5px 8px; 
            font-size: 11px; 
            border-radius: 3px; 
            cursor: pointer; 
            transition: background-color 0.15s; 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
        }
        .model-item:hover { background-color: rgba(255,255,255,0.1); }
        .model-item.selected { background-color: rgba(0, 122, 255, 0.4); font-weight: 500; }
        .model-status { 
            font-size: 9px; 
            color: rgba(255,255,255,0.6); 
            margin-left: 8px; 
        }
        .model-status.installed { color: rgba(0, 255, 0, 0.8); }
        .model-status.not-installed { color: rgba(255, 200, 0, 0.8); }
        .install-progress {
            flex: 1;
            height: 4px;
            background: rgba(255,255,255,0.1);
            border-radius: 2px;
            margin-left: 8px;
            overflow: hidden;
        }
        .install-progress-bar {
            height: 100%;
            background: rgba(0, 122, 255, 0.8);
            transition: width 0.3s ease;
        }
        
        /* Dropdown styles */
        select.model-dropdown {
            background: rgba(0,0,0,0.2);
            color: white;
            cursor: pointer;
        }
        
        select.model-dropdown option {
            background: #1a1a1a;
            color: white;
        }
        
        select.model-dropdown option:disabled {
            color: rgba(255,255,255,0.4);
        }
            
        /* ────────────────[ GLASS BYPASS ]─────────────── */
        :host-context(body.has-glass) {
            animation: none !important;
            transition: none !important;
            transform: none !important;
            will-change: auto !important;
        }

        :host-context(body.has-glass) * {
            background: transparent !important;
            filter: none !important;
            backdrop-filter: none !important;
            box-shadow: none !important;
            outline: none !important;
            border: none !important;
            border-radius: 0 !important;
            transition: none !important;
            animation: none !important;
        }

        :host-context(body.has-glass) .settings-container::before {
            display: none !important;
        }
    `;


    //////// after_modelStateService ////////
    static properties = {
        shortcuts: { type: Object, state: true },
        isLoading: { type: Boolean, state: true },
        isContentProtectionOn: { type: Boolean, state: true },
        saving: { type: Boolean, state: true },
        providerConfig: { type: Object, state: true },
        apiKeys: { type: Object, state: true },
        availableLlmModels: { type: Array, state: true },
        availableSttModels: { type: Array, state: true },
        selectedLlm: { type: String, state: true },
        selectedStt: { type: String, state: true },
        isLlmListVisible: { type: Boolean },
        isSttListVisible: { type: Boolean },
        // About Me: the stored text and the textarea's unsaved copy.
        aboutMe: { type: String, state: true },
        aboutMeDraft: { type: String, state: true },
        aboutMeSaving: { type: Boolean, state: true },
        aboutMeStatus: { type: String, state: true },
        // Ollama related properties
        ollamaStatus: { type: Object, state: true },
        ollamaModels: { type: Array, state: true },
        installingModels: { type: Object, state: true },
        // Whisper related properties
        whisperModels: { type: Array, state: true },
        sttLanguage: { type: String, state: true },
        askThinking: { type: Boolean, state: true },
        // null = main list; 'aboutMe' / 'apiKeys' / 'shortcuts' = that sub-page.
        activeSection: { type: String, state: true },
    };
    //////// after_modelStateService ////////

    constructor() {
        super();
        //////// after_modelStateService ////////
        this.shortcuts = {};
        this.apiKeys = { openai: '', gemini: '', anthropic: '', whisper: '' };
        this.providerConfig = {};
        this.isLoading = true;
        this.isContentProtectionOn = true;
        this.saving = false;
        this.availableLlmModels = [];
        this.availableSttModels = [];
        this.selectedLlm = null;
        this.selectedStt = null;
        this.isLlmListVisible = false;
        this.isSttListVisible = false;
        this.aboutMe = '';
        this.aboutMeDraft = '';
        this.aboutMeSaving = false;
        this.aboutMeStatus = '';
        // Ollama related
        this.ollamaStatus = { installed: false, running: false };
        this.ollamaModels = [];
        this.installingModels = {}; // { modelName: progress }
        // Whisper related
        this.whisperModels = [];
        this.sttLanguage = 'en';
        this.askThinking = false;
        this.activeSection = null;
        this.whisperProgressTracker = null; // Will be initialized when needed
        this.handleUsePicklesKey = this.handleUsePicklesKey.bind(this)
        this.loadInitialData();
        //////// after_modelStateService ////////
    }

    async loadLocalAIStatus() {
        try {
            // Load Ollama status
            const ollamaStatus = await window.api.settingsView.getOllamaStatus();
            if (ollamaStatus?.success) {
                this.ollamaStatus = { installed: ollamaStatus.installed, running: ollamaStatus.running };
                this.ollamaModels = ollamaStatus.models || [];
            }
            
            // Load Whisper models status only if Whisper is enabled
            if (this.apiKeys?.whisper === 'local') {
                const whisperModelsResult = await window.api.settingsView.getWhisperInstalledModels();
                if (whisperModelsResult?.success) {
                    const installedWhisperModels = whisperModelsResult.models;
                    if (this.providerConfig?.whisper) {
                        this.providerConfig.whisper.sttModels.forEach(m => {
                            const installedInfo = installedWhisperModels.find(i => i.id === m.id);
                            if (installedInfo) {
                                m.installed = installedInfo.installed;
                            }
                        });
                    }
                }
            }
            
            // Trigger UI update
            this.requestUpdate();
        } catch (error) {
            console.error('Error loading LocalAI status:', error);
        }
    }

    //////// after_modelStateService ////////
    async loadInitialData() {
        if (!window.api) return;
        this.isLoading = true;
        try {
            // Load essential data first
            const [modelSettings, contentProtection, shortcuts, sttLanguage, askThinking, aboutMe] = await Promise.all([
                window.api.settingsView.getModelSettings(), // Facade call
                window.api.settingsView.getContentProtectionStatus(),
                window.api.settingsView.getCurrentShortcuts(),
                window.api.settingsView.getSttLanguage(),
                window.api.settingsView.getAskThinking(),
                window.api.settingsView.getAboutMe()
            ]);

            if (sttLanguage) this.sttLanguage = sttLanguage;
            this.askThinking = askThinking === true;
            this.aboutMe = aboutMe || '';
            this.aboutMeDraft = this.aboutMe;
            this.aboutMeStatus = '';
            
            if (modelSettings.success) {
                const { config, storedKeys, availableLlm, availableStt, selectedModels } = modelSettings.data;
                this.providerConfig = config;
                this.apiKeys = storedKeys;
                this.availableLlmModels = availableLlm;
                this.availableSttModels = availableStt;
                this.selectedLlm = selectedModels.llm;
                this.selectedStt = selectedModels.stt;
            }

            this.isContentProtectionOn = contentProtection;
            this.shortcuts = shortcuts || {};
            
            // Load LocalAI status asynchronously to improve initial load time
            this.loadLocalAIStatus();
        } catch (error) {
            console.error('Error loading initial settings data:', error);
        } finally {
            this.isLoading = false;
        }
    }


    async handleSaveKey(provider) {
        // For Ollama, we need to ensure it's ready first
        if (provider === 'ollama') {
            this.saving = true;
            
            // First ensure Ollama is installed and running
            const ensureResult = await window.api.settingsView.ensureOllamaReady();
            if (!ensureResult.success) {
                alert(`Failed to setup Ollama: ${ensureResult.error}`);
                this.saving = false;
                return;
            }
            
            // Now validate (which will check if service is running)
            const result = await window.api.settingsView.validateKey({ provider, key: 'local' });
            
            if (result.success) {
                await this.refreshModelData();
                await this.refreshOllamaStatus();
            } else {
                alert(`Failed to connect to Ollama: ${result.error}`);
            }
            this.saving = false;
            return;
        }
        
        // For Whisper, just enable it
        if (provider === 'whisper') {
            this.saving = true;
            const result = await window.api.settingsView.validateKey({ provider, key: 'local' });
            
            if (result.success) {
                await this.refreshModelData();
            } else {
                alert(`Failed to enable Whisper: ${result.error}`);
            }
            this.saving = false;
            return;
        }
        
        // For other providers, use the normal flow. Only these have a key
        // input; Ollama and Whisper are local and handled above.
        const input = this.shadowRoot.querySelector(`#key-input-${provider}`);
        if (!input) return;
        const key = input.value;
        this.saving = true;
        const result = await window.api.settingsView.validateKey({ provider, key });
        
        if (result.success) {
            await this.refreshModelData();
        } else {
            alert(`Failed to save ${provider} key: ${result.error}`);
            input.value = this.apiKeys[provider] || '';
        }
        this.saving = false;
    }
    
    async handleClearKey(provider) {
        console.log(`[SettingsView] handleClearKey: ${provider}`);
        this.saving = true;
        await window.api.settingsView.removeApiKey(provider);
        this.apiKeys = { ...this.apiKeys, [provider]: '' };
        await this.refreshModelData();
        this.saving = false;
    }

    async refreshModelData() {
        const [availableLlm, availableStt, selected, storedKeys] = await Promise.all([
            window.api.settingsView.getAvailableModels({ type: 'llm' }),
            window.api.settingsView.getAvailableModels({ type: 'stt' }),
            window.api.settingsView.getSelectedModels(),
            window.api.settingsView.getAllKeys()
        ]);
        this.availableLlmModels = availableLlm;
        this.availableSttModels = availableStt;
        this.selectedLlm = selected.llm;
        this.selectedStt = selected.stt;
        this.apiKeys = storedKeys;
        // Installed badges come from ollamaModels / whisper flags, which are
        // otherwise only loaded once when the view opens.
        await this.loadLocalAIStatus();
        this.requestUpdate();
    }
    
    async toggleModelList(type) {
        const visibilityProp = type === 'llm' ? 'isLlmListVisible' : 'isSttListVisible';

        if (!this[visibilityProp]) {
            this.saving = true;
            this.requestUpdate();
            
            await this.refreshModelData();

            this.saving = false;
        }

        // 데이터 새로고침 후, 목록의 표시 상태를 토글합니다.
        this[visibilityProp] = !this[visibilityProp];
        this.requestUpdate();
    }
    
    async selectSttLanguage(language) {
        if (language === this.sttLanguage) return;

        const previous = this.sttLanguage;
        this.sttLanguage = language; // Optimistic: the toggle should feel instant
        this.requestUpdate();

        try {
            const result = await window.api.settingsView.setSttLanguage(language);
            if (result && result.success === false) {
                throw new Error(result.error || 'Failed to save language');
            }
        } catch (error) {
            console.error('Failed to save STT language:', error);
            this.sttLanguage = previous; // Do not show a choice that was not stored
            this.requestUpdate();
        }
    }

    async selectAskThinking(enabled) {
        if (enabled === this.askThinking) return;

        const previous = this.askThinking;
        this.askThinking = enabled; // Optimistic: the toggle should feel instant
        this.requestUpdate();

        try {
            const result = await window.api.settingsView.setAskThinking(enabled);
            if (result && result.success === false) {
                throw new Error(result.error || 'Failed to save reasoning mode');
            }
        } catch (error) {
            console.error('Failed to save Ask reasoning mode:', error);
            this.askThinking = previous; // Do not show a choice that was not stored
            this.requestUpdate();
        }
    }

    async selectModel(type, modelId) {
        // Check if this is an Ollama model that needs to be installed
        const provider = this.getProviderForModel(type, modelId);
        if (provider === 'ollama') {
            const ollamaModel = this.ollamaModels.find(m => m.name === modelId);
            if (ollamaModel && !ollamaModel.installed && !ollamaModel.installing) {
                // Need to install the model first
                await this.installOllamaModel(modelId);
                return;
            }
        }
        
        // Check if this is a Whisper model that needs to be downloaded
        if (provider === 'whisper' && type === 'stt') {
            const isInstalling = this.installingModels[modelId] !== undefined;
            const whisperModelInfo = this.providerConfig.whisper.sttModels.find(m => m.id === modelId);
            
            if (whisperModelInfo && !whisperModelInfo.installed && !isInstalling) {
                await this.downloadWhisperModel(modelId);
                return;
            }
        }
        
        this.saving = true;
        await window.api.settingsView.setSelectedModel({ type, modelId });
        if (type === 'llm') this.selectedLlm = modelId;
        if (type === 'stt') this.selectedStt = modelId;
        this.isLlmListVisible = false;
        this.isSttListVisible = false;
        this.saving = false;
        this.requestUpdate();
    }
    
    async refreshOllamaStatus() {
        const ollamaStatus = await window.api.settingsView.getOllamaStatus();
        if (ollamaStatus?.success) {
            this.ollamaStatus = { installed: ollamaStatus.installed, running: ollamaStatus.running };
            this.ollamaModels = ollamaStatus.models || [];
        }
    }
    
    async installOllamaModel(modelName) {
        try {
            // Ollama 모델 다운로드 시작
            this.installingModels = { ...this.installingModels, [modelName]: 0 };
            this.requestUpdate();

            // 진행률 이벤트 리스너 설정 - 통합 LocalAI 이벤트 사용
            const progressHandler = (event, data) => {
                if (data.service === 'ollama' && data.model === modelName) {
                    this.installingModels = { ...this.installingModels, [modelName]: data.progress || 0 };
                    this.requestUpdate();
                }
            };

            // 통합 LocalAI 이벤트 리스너 등록
            window.api.settingsView.onLocalAIInstallProgress(progressHandler);

            try {
                const result = await window.api.settingsView.pullOllamaModel(modelName);
                
                if (result.success) {
                    console.log(`[SettingsView] Model ${modelName} installed successfully`);
                    delete this.installingModels[modelName];
                    this.requestUpdate();
                    
                    // 상태 새로고침
                    await this.refreshOllamaStatus();
                    await this.refreshModelData();
                } else {
                    throw new Error(result.error || 'Installation failed');
                }
            } finally {
                // 통합 LocalAI 이벤트 리스너 제거
                window.api.settingsView.removeOnLocalAIInstallProgress(progressHandler);
            }
        } catch (error) {
            console.error(`[SettingsView] Error installing model ${modelName}:`, error);
            delete this.installingModels[modelName];
            this.requestUpdate();
        }
    }
    
    async downloadWhisperModel(modelId) {
        // Mark as installing
        this.installingModels = { ...this.installingModels, [modelId]: 0 };
        this.requestUpdate();
        
        try {
            // Set up progress listener - 통합 LocalAI 이벤트 사용
            const progressHandler = (event, data) => {
                if (data.service === 'whisper' && data.model === modelId) {
                    this.installingModels = { ...this.installingModels, [modelId]: data.progress || 0 };
                    this.requestUpdate();
                }
            };
            
            window.api.settingsView.onLocalAIInstallProgress(progressHandler);
            
            // Start download
            const result = await window.api.settingsView.downloadWhisperModel(modelId);
            
            if (result.success) {
                // Update the model's installed status
                if (this.providerConfig?.whisper?.sttModels) {
                    const modelInfo = this.providerConfig.whisper.sttModels.find(m => m.id === modelId);
                    if (modelInfo) {
                        modelInfo.installed = true;
                    }
                }
                
                // Remove from installing models
                delete this.installingModels[modelId];
                this.requestUpdate();
                
                // Reload LocalAI status to get fresh data
                await this.loadLocalAIStatus();
                
                // Auto-select the model after download
                await this.selectModel('stt', modelId);
            } else {
                // Remove from installing models on failure too
                delete this.installingModels[modelId];
                this.requestUpdate();
                alert(`Failed to download Whisper model: ${result.error}`);
            }
            
            // Cleanup
            window.api.settingsView.removeOnLocalAIInstallProgress(progressHandler);
        } catch (error) {
            console.error(`[SettingsView] Error downloading Whisper model ${modelId}:`, error);
            // Remove from installing models on error
            delete this.installingModels[modelId];
            this.requestUpdate();
            alert(`Error downloading ${modelId}: ${error.message}`);
        }
    }
    
    getProviderForModel(type, modelId) {
        for (const [providerId, config] of Object.entries(this.providerConfig)) {
            const models = type === 'llm' ? config.llmModels : config.sttModels;
            if (models?.some(m => m.id === modelId)) {
                return providerId;
            }
        }
        return null;
    }

    //////// after_modelStateService ////////

    openShortcutEditor() {
        window.api.settingsView.openShortcutSettingsWindow();
    }

    openSection(section) {
        this.activeSection = section;
        this.scrollSettingsToTop();
    }

    closeSection() {
        this.activeSection = null;
        this.scrollSettingsToTop();
    }

    scrollSettingsToTop() {
        this.updateComplete.then(() => {
            const container = this.shadowRoot?.querySelector('.settings-container');
            if (container) container.scrollTop = 0;
        });
    }

    // How many key-based providers have a key, for the API Keys row.
    getConfiguredKeyCount() {
        return Object.keys(this.providerConfig)
            .filter(id => id !== 'ollama' && id !== 'whisper')
            .filter(id => !!this.apiKeys?.[id])
            .length;
    }

    renderSubpage(title, content) {
        return html`
            <div class="settings-container subpage">
                <div class="subpage-header">
                    <button class="back-button" @click=${this.closeSection}>‹ Back</button>
                    <h1 class="subpage-title">${title}</h1>
                </div>
                ${content}
            </div>
        `;
    }

    connectedCallback() {
        super.connectedCallback();
        
        this.setupEventListeners();
        this.setupIpcListeners();
        this.setupWindowResize();
        // Force one height calculation immediately (innerHeight may be 0 at first)
        setTimeout(() => this.updateScrollHeight(), 0);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this.cleanupEventListeners();
        this.cleanupIpcListeners();
        this.cleanupWindowResize();
        
        // Cancel any ongoing Ollama installations when component is destroyed
        const installingModels = Object.keys(this.installingModels);
        if (installingModels.length > 0) {
            installingModels.forEach(modelName => {
                window.api.settingsView.cancelOllamaInstallation(modelName);
            });
        }
    }

    setupEventListeners() {
        this.addEventListener('mouseenter', this.handleMouseEnter);
        this.addEventListener('mouseleave', this.handleMouseLeave);
    }

    cleanupEventListeners() {
        this.removeEventListener('mouseenter', this.handleMouseEnter);
        this.removeEventListener('mouseleave', this.handleMouseLeave);
    }

    setupIpcListeners() {
        if (!window.api) return;
        
        this._settingsUpdatedListener = (event, settings) => {
            console.log('[SettingsView] Received settings-updated');
            this.settings = settings;
            this.requestUpdate();
        };

        this._shortcutListener = (event, keybinds) => {
            console.log('[SettingsView] Received updated shortcuts:', keybinds);
            this.shortcuts = keybinds;
        };
        
        window.api.settingsView.onSettingsUpdated(this._settingsUpdatedListener);
        window.api.settingsView.onShortcutsUpdated(this._shortcutListener);
    }

    cleanupIpcListeners() {
        if (!window.api) return;
        
        if (this._settingsUpdatedListener) {
            window.api.settingsView.removeOnSettingsUpdated(this._settingsUpdatedListener);
        }
        if (this._shortcutListener) {
            window.api.settingsView.removeOnShortcutsUpdated(this._shortcutListener);
        }
    }

    setupWindowResize() {
        this.resizeHandler = () => {
            this.requestUpdate();
            this.updateScrollHeight();
        };
        window.addEventListener('resize', this.resizeHandler);
        
        // Initial setup
        setTimeout(() => this.updateScrollHeight(), 100);
    }

    cleanupWindowResize() {
        if (this.resizeHandler) {
            window.removeEventListener('resize', this.resizeHandler);
        }
    }

    updateScrollHeight() {
        // Electron 일부 시점에서 window.innerHeight 가 0 으로 보고되는 버그 보호
        const rawHeight = window.innerHeight || (window.screen ? window.screen.height : 0);
        const MIN_HEIGHT = 300; // 최소 보장 높이
        const maxHeight = Math.max(MIN_HEIGHT, rawHeight);

        this.style.maxHeight = `${maxHeight}px`;

        const container = this.shadowRoot?.querySelector('.settings-container');
        if (container) {
            container.style.maxHeight = `${maxHeight}px`;
        }
    }

    handleMouseEnter = () => {
        window.api.settingsView.cancelHideSettingsWindow();
        // Recalculate height in case it was set to 0 before
        this.updateScrollHeight();
    }

    handleMouseLeave = () => {
        window.api.settingsView.hideSettingsWindow();
    }


    getMainShortcuts() {
        return [
            { name: 'Show / Hide', accelerator: this.shortcuts.toggleVisibility },
            { name: 'Ask Anything', accelerator: this.shortcuts.nextStep },
            { name: 'Scroll Up Response', accelerator: this.shortcuts.scrollUp },
            { name: 'Scroll Down Response', accelerator: this.shortcuts.scrollDown },
        ];
    }

    renderShortcutKeys(accelerator) {
        if (!accelerator) return html`N/A`;
        
        const keyMap = {
            'Cmd': '⌘', 'Command': '⌘', 'Ctrl': '⌃', 'Alt': '⌥', 'Shift': '⇧', 'Enter': '↵',
            'Up': '↑', 'Down': '↓', 'Left': '←', 'Right': '→'
        };

        // scrollDown/scrollUp의 특수 처리
        if (accelerator.includes('↕')) {
            const keys = accelerator.replace('↕','').split('+');
            keys.push('↕');
             return html`${keys.map(key => html`<span class="shortcut-key">${keyMap[key] || key}</span>`)}`;
        }

        const keys = accelerator.split('+');
        return html`${keys.map(key => html`<span class="shortcut-key">${keyMap[key] || key}</span>`)}`;
    }

    isAboutMeDirty() {
        return this.aboutMeDraft.trim() !== this.aboutMe;
    }

    handleAboutMeKeydown = (e) => {
        // Cmd/Ctrl+Enter saves; plain Enter is a newline.
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            this.saveAboutMe();
        }
    }

    saveAboutMe = async () => {
        if (this.aboutMeSaving || !this.isAboutMeDirty()) return;
        this.aboutMeSaving = true;
        try {
            const result = await window.api.settingsView.setAboutMe(this.aboutMeDraft);
            if (!result?.success) throw new Error(result?.error || 'Unknown error');
            this.aboutMe = result.aboutMe;
            this.aboutMeDraft = result.aboutMe;
            this.aboutMeStatus = 'Saved';
        } catch (error) {
            console.error('[SettingsView] Failed to save About Me:', error);
            this.aboutMeStatus = `Not saved: ${error.message}`;
        } finally {
            this.aboutMeSaving = false;
        }
    }

    handleMoveLeft() {
        console.log('Move Left clicked');
        window.api.settingsView.moveWindowStep('left');
    }

    handleMoveRight() {
        console.log('Move Right clicked');
        window.api.settingsView.moveWindowStep('right');
    }

    async handleToggleInvisibility() {
        console.log('Toggle Invisibility clicked');
        this.isContentProtectionOn = await window.api.settingsView.toggleContentProtection();
        this.requestUpdate();
    }

    async handleSaveApiKey() {
        const input = this.shadowRoot.getElementById('api-key-input');
        if (!input || !input.value) return;

        const newApiKey = input.value;
        try {
            const result = await window.api.settingsView.saveApiKey(newApiKey);
            if (result.success) {
                console.log('API Key saved successfully via IPC.');
                this.apiKey = newApiKey;
                this.requestUpdate();
            } else {
                 console.error('Failed to save API Key via IPC:', result.error);
            }
        } catch(e) {
            console.error('Error invoking save-api-key IPC:', e);
        }
    }

    handleQuit() {
        console.log('Quit clicked');
        window.api.settingsView.quitApplication();
    }

    async handleOllamaShutdown() {
        console.log('[SettingsView] Shutting down Ollama service...');
        
        if (!window.api) return;
        
        try {
            // Show loading state
            this.ollamaStatus = { ...this.ollamaStatus, running: false };
            this.requestUpdate();
            
            const result = await window.api.settingsView.shutdownOllama(false); // Graceful shutdown
            
            if (result.success) {
                console.log('[SettingsView] Ollama shut down successfully');
                // Refresh status to reflect the change
                await this.refreshOllamaStatus();
            } else {
                console.error('[SettingsView] Failed to shutdown Ollama:', result.error);
                // Restore previous state on error
                await this.refreshOllamaStatus();
            }
        } catch (error) {
            console.error('[SettingsView] Error during Ollama shutdown:', error);
            // Restore previous state on error
            await this.refreshOllamaStatus();
        }
    }

    //////// after_modelStateService ////////
    render() {
        if (this.isLoading) {
            return html`
                <div class="settings-container">
                    <div class="loading-state">
                        <div class="loading-spinner"></div>
                        <span>Loading...</span>
                    </div>
                </div>
            `;
        }

        const apiKeyManagementHTML = html`
            <div class="api-key-section">
                ${Object.entries(this.providerConfig)
                    .map(([id, config]) => {
                        if (id === 'ollama') {
                            // Special UI for Ollama
                            return html`
                                <div class="provider-key-group">
                                    <label>${config.name} (Local)</label>
                                    ${this.ollamaStatus.installed && this.ollamaStatus.running ? html`
                                        <div style="padding: 8px; background: rgba(0,255,0,0.1); border-radius: 4px; font-size: 11px; color: rgba(0,255,0,0.8);">
                                            ✓ Ollama is running
                                        </div>
                                        <button class="settings-button full-width danger" @click=${this.handleOllamaShutdown}>
                                            Stop Ollama Service
                                        </button>
                                    ` : this.ollamaStatus.installed ? html`
                                        <div style="padding: 8px; background: rgba(255,200,0,0.1); border-radius: 4px; font-size: 11px; color: rgba(255,200,0,0.8);">
                                            ⚠ Ollama installed but not running
                                        </div>
                                        <button class="settings-button full-width" @click=${() => this.handleSaveKey(id)}>
                                            Start Ollama
                                        </button>
                                    ` : html`
                                        <div style="padding: 8px; background: rgba(255,100,100,0.1); border-radius: 4px; font-size: 11px; color: rgba(255,100,100,0.8);">
                                            ✗ Ollama not installed
                                        </div>
                                        <button class="settings-button full-width" @click=${() => this.handleSaveKey(id)}>
                                            Install & Setup Ollama
                                        </button>
                                    `}
                                </div>
                            `;
                        }
                        
                        if (id === 'whisper') {
                            // Simplified UI for Whisper without model selection
                            return html`
                                <div class="provider-key-group">
                                    <label>${config.name} (Local STT)</label>
                                    ${this.apiKeys[id] === 'local' ? html`
                                        <div style="padding: 8px; background: rgba(0,255,0,0.1); border-radius: 4px; font-size: 11px; color: rgba(0,255,0,0.8); margin-bottom: 8px;">
                                            ✓ Whisper is enabled
                                        </div>
                                        <button class="settings-button full-width danger" @click=${() => this.handleClearKey(id)}>
                                            Disable Whisper
                                        </button>
                                    ` : html`
                                        <button class="settings-button full-width" @click=${() => this.handleSaveKey(id)}>
                                            Enable Whisper STT
                                        </button>
                                    `}
                                </div>
                            `;
                        }
                        
                        // Regular providers
                        return html`
                        <div class="provider-key-group">
                            <label for="key-input-${id}">${config.name} API Key</label>
                            <input type="password" id="key-input-${id}"
                                placeholder=${`Enter ${config.name} API Key`} 
                                .value=${this.apiKeys[id] || ''}
                            >
                            <div class="key-buttons">
                               <button class="settings-button" @click=${() => this.handleSaveKey(id)} >Save</button>
                               <button class="settings-button danger" @click=${() => this.handleClearKey(id)} }>Clear</button>
                            </div>
                        </div>
                        `;
                    })}
            </div>
        `;
        
        const getModelName = (type, id) => {
            const models = type === 'llm' ? this.availableLlmModels : this.availableSttModels;
            const model = models.find(m => m.id === id);
            return model ? model.name : id;
        }

        const modelSelectionHTML = html`
            <div class="model-selection-section">
                <div class="model-select-group">
                    <label>LLM Model: <strong>${getModelName('llm', this.selectedLlm) || 'Not Set'}</strong></label>
                    <button class="settings-button full-width" @click=${() => this.toggleModelList('llm')} ?disabled=${this.saving || this.availableLlmModels.length === 0}>
                        Change LLM Model
                    </button>
                    ${this.isLlmListVisible ? html`
                        <div class="model-list">
                            ${this.availableLlmModels.map(model => {
                                const isOllama = this.getProviderForModel('llm', model.id) === 'ollama';
                                const ollamaModel = isOllama ? this.ollamaModels.find(m => m.name === model.id) : null;
                                const isInstalling = this.installingModels[model.id] !== undefined;
                                const installProgress = this.installingModels[model.id] || 0;
                                
                                return html`
                                    <div class="model-item ${this.selectedLlm === model.id ? 'selected' : ''}" 
                                         @click=${() => this.selectModel('llm', model.id)}>
                                        <span>${model.name}</span>
                                        ${isOllama ? html`
                                            ${isInstalling ? html`
                                                <div class="install-progress">
                                                    <div class="install-progress-bar" style="width: ${installProgress}%"></div>
                                </div>
                                            ` : ollamaModel?.installed ? html`
                                                <span class="model-status installed">✓ Installed</span>
                                            ` : html`
                                                <span class="model-status not-installed">Click to install</span>
                                            `}
                                        ` : ''}
                                    </div>
                                `;
                            })}
                        </div>
                    ` : ''}
                </div>
                <div class="model-select-group">
                    <label>STT Model: <strong>${getModelName('stt', this.selectedStt) || 'Not Set'}</strong></label>
                    <button class="settings-button full-width" @click=${() => this.toggleModelList('stt')} ?disabled=${this.saving || this.availableSttModels.length === 0}>
                        Change STT Model
                    </button>
                    ${this.isSttListVisible ? html`
                        <div class="model-list">
                            ${this.availableSttModels.map(model => {
                                const isWhisper = this.getProviderForModel('stt', model.id) === 'whisper';
                                const whisperModel = isWhisper && this.providerConfig?.whisper?.sttModels 
                                    ? this.providerConfig.whisper.sttModels.find(m => m.id === model.id) 
                                    : null;
                                const isInstalling = this.installingModels[model.id] !== undefined;
                                const installProgress = this.installingModels[model.id] || 0;
                                
                                return html`
                                    <div class="model-item ${this.selectedStt === model.id ? 'selected' : ''}" 
                                         @click=${() => this.selectModel('stt', model.id)}>
                                        <span>${model.name}</span>
                                        ${isWhisper ? html`
                                            ${isInstalling ? html`
                                                <div class="install-progress">
                                                    <div class="install-progress-bar" style="width: ${installProgress}%"></div>
                                                </div>
                                            ` : whisperModel?.installed ? html`
                                                <span class="model-status installed">✓ Installed</span>
                                            ` : html`
                                                <span class="model-status not-installed">Not Installed</span>
                                            `}
                                        ` : ''}
                                    </div>
                                `;
                            })}
                        </div>
                    ` : ''}
                </div>
                <div class="model-select-group">
                    <label>Speech Language</label>
                    <div class="lang-toggle-options">
                        ${[
                            { id: 'ru', label: 'Russian' },
                            { id: 'en', label: 'English' },
                        ].map(lang => html`
                            <button
                                class="lang-toggle-option"
                                data-selected=${this.sttLanguage === lang.id ? 'true' : 'false'}
                                @click=${() => this.selectSttLanguage(lang.id)}
                                ?disabled=${this.saving}
                            >
                                ${lang.label}
                            </button>
                        `)}
                    </div>
                </div>
                <div class="model-select-group">
                    <label title="For reasoning models such as gemma4 or qwen3: Deep thinks before answering - smarter, but the answer starts much later">Ask Reasoning</label>
                    <div class="lang-toggle-options">
                        ${[
                            { enabled: false, label: 'Fast' },
                            { enabled: true, label: 'Deep (slower)' },
                        ].map(mode => html`
                            <button
                                class="lang-toggle-option"
                                data-selected=${this.askThinking === mode.enabled ? 'true' : 'false'}
                                @click=${() => this.selectAskThinking(mode.enabled)}
                                ?disabled=${this.saving}
                            >
                                ${mode.label}
                            </button>
                        `)}
                    </div>
                </div>
            </div>
        `;

        if (this.activeSection === 'apiKeys') {
            return this.renderSubpage('API Keys', apiKeyManagementHTML);
        }

        if (this.activeSection === 'aboutMe') {
            const dirty = this.isAboutMeDirty();
            return this.renderSubpage('About Me', html`
                <div class="about-me-section">
                    <p class="about-me-hint">
                        Ask and the live summary read this to know who you are. Name, role, stack, the company, what your meetings are usually about.
                    </p>
                    <textarea
                        class="about-me-input"
                        .value=${this.aboutMeDraft}
                        maxlength=${ABOUT_ME_MAX_LENGTH}
                        placeholder="I'm Anna, a backend developer (Go, Postgres) at a fintech startup. In interviews, answer like a senior engineer."
                        @input=${e => { this.aboutMeDraft = e.target.value; this.aboutMeStatus = ''; }}
                        @keydown=${this.handleAboutMeKeydown}
                        ?disabled=${this.aboutMeSaving}
                    ></textarea>
                    <div class="about-me-footer">
                        <span class="about-me-status">
                            ${this.aboutMeStatus || `${this.aboutMeDraft.length} / ${ABOUT_ME_MAX_LENGTH}`}
                        </span>
                        <button
                            class="settings-button"
                            @click=${this.saveAboutMe}
                            ?disabled=${this.aboutMeSaving || !dirty}
                        >
                            ${this.aboutMeSaving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
                        </button>
                    </div>
                </div>
            `);
        }

        if (this.activeSection === 'shortcuts') {
            return this.renderSubpage('Shortcuts', html`
                <div class="shortcuts-section">
                    ${this.getMainShortcuts().map(shortcut => html`
                        <div class="shortcut-item">
                            <span class="shortcut-name">${shortcut.name}</span>
                            <div class="shortcut-keys">
                                ${this.renderShortcutKeys(shortcut.accelerator)}
                            </div>
                        </div>
                    `)}
                </div>
                <div class="buttons-section">
                    <button class="settings-button full-width" @click=${this.openShortcutEditor}>
                        Edit Shortcuts
                    </button>
                </div>
            `);
        }

        const keyCount = this.getConfiguredKeyCount();

        return html`
            <div class="settings-container">
                <div class="header-section">
                    <div>
                        <h1 class="app-title">Pickle Glass</h1>
                    </div>
                    <div class="invisibility-icon ${this.isContentProtectionOn ? 'visible' : ''}" title="Invisibility is On">
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M9.785 7.41787C8.7 7.41787 7.79 8.19371 7.55667 9.22621C7.0025 8.98704 6.495 9.05121 6.11 9.22037C5.87083 8.18204 4.96083 7.41787 3.88167 7.41787C2.61583 7.41787 1.58333 8.46204 1.58333 9.75121C1.58333 11.0404 2.61583 12.0845 3.88167 12.0845C5.08333 12.0845 6.06333 11.1395 6.15667 9.93787C6.355 9.79787 6.87417 9.53537 7.51 9.94954C7.615 11.1454 8.58333 12.0845 9.785 12.0845C11.0508 12.0845 12.0833 11.0404 12.0833 9.75121C12.0833 8.46204 11.0508 7.41787 9.785 7.41787ZM3.88167 11.4195C2.97167 11.4195 2.2425 10.6729 2.2425 9.75121C2.2425 8.82954 2.9775 8.08287 3.88167 8.08287C4.79167 8.08287 5.52083 8.82954 5.52083 9.75121C5.52083 10.6729 4.79167 11.4195 3.88167 11.4195ZM9.785 11.4195C8.875 11.4195 8.14583 10.6729 8.14583 9.75121C8.14583 8.82954 8.875 8.08287 9.785 8.08287C10.695 8.08287 11.43 8.82954 11.43 9.75121C11.43 10.6729 10.6892 11.4195 9.785 11.4195ZM12.6667 5.95954H1V6.83454H12.6667V5.95954ZM8.8925 1.36871C8.76417 1.08287 8.4375 0.931207 8.12833 1.03037L6.83333 1.46204L5.5325 1.03037L5.50333 1.02454C5.19417 0.93704 4.8675 1.10037 4.75083 1.39787L3.33333 5.08454H10.3333L8.91 1.39787L8.8925 1.36871Z" fill="white"/>
                        </svg>
                    </div>
                </div>

                <div class="buttons-section actions-section">
                    <div class="move-buttons">
                        <button class="settings-button half-width" @click=${this.handleMoveLeft}>
                            <span>← Move</span>
                        </button>
                        <button class="settings-button half-width" @click=${this.handleMoveRight}>
                            <span>Move →</span>
                        </button>
                    </div>
                    
                    <button class="settings-button full-width" @click=${this.handleToggleInvisibility}>
                        <span>${this.isContentProtectionOn ? 'Disable Invisibility' : 'Enable Invisibility'}</span>
                    </button>
                    
                    <button class="settings-button full-width danger" @click=${this.handleQuit}>
                        <span>Quit</span>
                    </button>
                </div>


                <div class="nav-section">
                    <button class="nav-row" @click=${() => this.openSection('aboutMe')}>
                        <span>About Me</span>
                        <span class="nav-row-meta">
                            ${this.isAboutMeDirty() ? 'unsaved' : this.aboutMe ? 'filled in' : 'empty'}
                            <span class="nav-chevron">›</span>
                        </span>
                    </button>
                    <button class="nav-row" @click=${() => this.openSection('apiKeys')}>
                        <span>API Keys</span>
                        <span class="nav-row-meta">
                            ${keyCount > 0 ? `${keyCount} set` : 'none set'}
                            <span class="nav-chevron">›</span>
                        </span>
                    </button>
                    <button class="nav-row" @click=${() => this.openSection('shortcuts')}>
                        <span>Shortcuts</span>
                        <span class="nav-row-meta">
                            <span class="nav-chevron">›</span>
                        </span>
                    </button>
                </div>

                ${modelSelectionHTML}
            </div>
        `;
    }
    //////// after_modelStateService ////////
}

customElements.define('settings-view', SettingsView);