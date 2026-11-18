const SttService = require('./stt/sttService');
const SummaryService = require('./summary/summaryService');
const sessionRepository = require('../common/repositories/session');
const sttRepository = require('./stt/repositories');
const internalBridge = require('../../bridge/internalBridge');
const modelStateService = require('../common/services/modelStateService');

const STT_INIT_MAX_ATTEMPTS = 10;
const STT_INIT_RETRY_DELAY_MS = 300;

// Lazy: these modules require feature services themselves.
const getWindowPool = () => require('../../window/windowManager').windowPool;
const getOllamaProvider = () => require('../common/ai/providers/ollama');

class ListenService {
    constructor() {
        this.sttService = new SttService();
        this.summaryService = new SummaryService();
        this.currentSessionId = null;
        this.isInitializingSession = false;
        this.finalAnalysis = Promise.resolve();

        this.sttService.setCallbacks({
            onTranscriptionComplete: (speaker, text) => this.handleTranscriptionComplete(speaker, text),
            onStatusUpdate: status => this.sendToRenderer('update-status', status),
        });
    }

    sendToRenderer(channel, data) {
        const listenWindow = getWindowPool()?.get('listen');
        if (listenWindow && !listenWindow.isDestroyed()) {
            listenWindow.webContents.send(channel, data);
        }
    }

    async handleListenRequest(listenButtonText) {
        const header = getWindowPool()?.get('header');
        const reply = success => {
            if (header && !header.isDestroyed()) header.webContents.send('listen:changeSessionResult', { success });
        };

        try {
            switch (listenButtonText) {
                case 'Listen':
                    internalBridge.emit('window:requestVisibility', { name: 'listen', visible: true });
                    if (!(await this.initializeSession())) {
                        throw new Error('Could not start listening (STT or database session failed).');
                    }
                    this.sendToRenderer('session-state-changed', { isActive: true });
                    internalBridge.emit('listen:sessionStateChanged', { isActive: true });
                    break;

                case 'Stop':
                    await this.closeSession();
                    this.sendToRenderer('session-state-changed', { isActive: false });
                    internalBridge.emit('listen:sessionStateChanged', { isActive: false });
                    break;

                case 'Done':
                    internalBridge.emit('window:requestVisibility', { name: 'listen', visible: false });
                    this.sendToRenderer('session-state-changed', { isActive: false });
                    break;

                default:
                    throw new Error(`[ListenService] unknown listenButtonText: ${listenButtonText}`);
            }
            reply(true);
        } catch (error) {
            console.error('[ListenService] error in handleListenRequest:', error);
            reply(false);
            throw error;
        }
    }

    async handleTranscriptionComplete(speaker, text) {
        // Analysis first: it is what the user is waiting for, the DB write isn't.
        this.summaryService.addConversationTurn(speaker, text);
        await this.saveConversationTurn(speaker, text);
    }

    async saveConversationTurn(speaker, transcription) {
        if (!this.currentSessionId) {
            console.error('[ListenService] Cannot save turn, no active session ID.');
            return;
        }
        const text = transcription.trim();
        if (!text) return;

        try {
            await sessionRepository.touch(this.currentSessionId);
            await sttRepository.addTranscript({ sessionId: this.currentSessionId, speaker, text });
        } catch (error) {
            console.error('[ListenService] Failed to save transcript:', error);
        }
    }

    async initializeNewSession() {
        try {
            this.currentSessionId = await sessionRepository.getOrCreateActive('listen');
            this.summaryService.setSessionId(this.currentSessionId);
            this.summaryService.resetConversationHistory();
            return true;
        } catch (error) {
            console.error('[ListenService] Failed to initialize new session in DB:', error);
            this.currentSessionId = null;
            return false;
        }
    }

    /** @returns {Promise<boolean>} whether STT is running and capture was told to start */
    async initializeSession(language) {
        if (this.isInitializingSession) {
            console.log('[ListenService] Session initialization already in progress.');
            return false;
        }
        this.isInitializingSession = true;

        // Callers normally pass nothing, so the user's saved choice decides
        // what the STT engine transcribes as.
        if (!language) {
            try {
                language = await require('../settings/settingsService').getSttLanguageSetting();
            } catch (error) {
                console.warn('[ListenService] Could not read STT language setting, falling back to "en":', error.message);
                language = 'en';
            }
        }

        this.sendToRenderer('session-initializing', true);
        this.sendToRenderer('update-status', 'Initializing sessions...');

        let ready = false;
        try {
            if (!(await this.initializeNewSession())) {
                throw new Error('Failed to initialize database session');
            }
            await this.initializeSttWithRetry(language);
            this.holdLocalLlmLoaded();
            this.sendToRenderer('update-status', 'Connected. Ready to listen.');
            ready = true;
        } catch (error) {
            console.error('[ListenService] Failed to initialize listen service:', error);
            this.sendToRenderer('update-status', 'Initialization failed.');
            // Don't leave a session open that nothing is recording into.
            if (this.currentSessionId) {
                await sessionRepository.end(this.currentSessionId).catch(() => {});
                this.currentSessionId = null;
            }
        } finally {
            this.isInitializingSession = false;
            this.sendToRenderer('session-initializing', false);
        }
        // Capture without an STT session would only send audio nowhere.
        if (ready) this.sendToRenderer('change-listen-capture-state', { status: 'start' });
        return ready;
    }

    async initializeSttWithRetry(language) {
        for (let attempt = 1; ; attempt++) {
            try {
                await this.sttService.initializeSttSessions(language);
                return;
            } catch (error) {
                console.warn(`[ListenService] STT init attempt ${attempt} failed: ${error.message}`);
                if (attempt >= STT_INIT_MAX_ATTEMPTS) throw new Error(`STT init failed after retries: ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, STT_INIT_RETRY_DELAY_MS));
            }
        }
    }

    // A local Ollama LLM is kept in memory while listening, so the first Ask
    // after a quiet stretch doesn't wait ~7 s for the model to reload.
    async holdLocalLlmLoaded() {
        try {
            const modelInfo = await modelStateService.getCurrentModelInfo('llm');
            if (modelInfo?.provider === 'ollama' && modelInfo.model) {
                getOllamaProvider().holdModelLoaded(modelInfo.model);
            }
        } catch (error) {
            console.warn('[ListenService] Could not keep the local LLM loaded:', error.message);
        }
    }

    async sendMicAudioContent(data, mimeType) {
        return await this.sttService.sendMicAudioContent(data, mimeType);
    }

    stopMacOSAudioCapture() {
        this.sttService.stopMacOSAudioCapture();
    }

    isSessionActive() {
        return this.sttService.isSessionActive();
    }

    async closeSession() {
        try {
            this.sendToRenderer('change-listen-capture-state', { status: 'stop' });
            // Also stops SystemAudioDump and waits for the last turns to be saved.
            await this.sttService.closeSessions();

            // Analyzes the turns since the last live analysis in the background,
            // on a snapshot, so resetting the history below is safe.
            // Kept so quitting can wait for it before the DB closes.
            this.finalAnalysis = this.summaryService.finalizeSession().catch(() => {});
            getOllamaProvider().releaseModel();

            if (this.currentSessionId) {
                await sessionRepository.end(this.currentSessionId);
            }
            this.currentSessionId = null;
            this.summaryService.resetConversationHistory();
            return { success: true };
        } catch (error) {
            console.error('[ListenService] Error closing listen session:', error);
            return { success: false, error: error.message };
        }
    }

    getConversationHistory() {
        return this.summaryService.getConversationHistory();
    }

    // IPC handlers always resolve to {success, error?} instead of rejecting.
    _createHandler(asyncFn, errorMessage) {
        return async (...args) => {
            try {
                const result = await asyncFn.apply(this, args);
                return result && typeof result.success !== 'undefined' ? result : { success: true };
            } catch (e) {
                console.error(errorMessage, e);
                return { success: false, error: e.message };
            }
        };
    }

    handleSendMicAudioContent = this._createHandler(this.sendMicAudioContent, 'Error sending user audio:');

    handleStartMacosAudio = this._createHandler(async () => {
        if (process.platform !== 'darwin') {
            return { success: false, error: 'macOS audio capture only available on macOS' };
        }
        if (this.sttService.isMacOSAudioRunning()) {
            return { success: false, error: 'already_running' };
        }
        const started = await this.sttService.startMacOSAudioCapture();
        return started ? { success: true } : { success: false, error: 'SystemAudioDump did not start' };
    }, 'Error starting macOS audio capture:');

    handleStopMacosAudio = this._createHandler(this.stopMacOSAudioCapture, 'Error stopping macOS audio capture:');
}

const listenService = new ListenService();
module.exports = listenService;
