import './MainHeader.js';
import './ApiKeyHeader.js';
import './PermissionHeader.js';

class HeaderTransitionManager {
    constructor() {
        this.headerContainer      = document.getElementById('header-container');
        this.currentHeaderType    = null;   // 'apikey' | 'main' | 'permission'
        this.apiKeyHeader         = null;
        this.mainHeader            = null;
        this.permissionHeader      = null;

        /**
         * only one header window is allowed
         * @param {'apikey'|'main'|'permission'} type
         */
        this.ensureHeader = (type) => {
            console.log('[HeaderController] ensureHeader: Ensuring header of type:', type);
            if (this.currentHeaderType === type) {
                console.log('[HeaderController] ensureHeader: Header of type:', type, 'already exists.');
                return;
            }

            this.headerContainer.innerHTML = '';

            this.apiKeyHeader = null;
            this.mainHeader = null;
            this.permissionHeader = null;

            // Create new header element
            if (type === 'apikey') {
                this.apiKeyHeader = document.createElement('apikey-header');
                this.apiKeyHeader.stateUpdateCallback = () => this.handleStateUpdate();
                this.apiKeyHeader.addEventListener('request-resize', e => {
                    this._resizeForApiKey(e.detail.height); 
                });
                this.headerContainer.appendChild(this.apiKeyHeader);
                console.log('[HeaderController] ensureHeader: Header of type:', type, 'created.');
            } else if (type === 'permission') {
                this.permissionHeader = document.createElement('permission-setup');
                this.permissionHeader.addEventListener('request-resize', e => {
                    this._resizeForPermissionHeader(e.detail.height); 
                });
                this.permissionHeader.continueCallback = async () => {
                    if (window.api && window.api.headerController) {
                        console.log('[HeaderController] Re-initializing model state after permission grant...');
                        await window.api.headerController.reInitializeModelState();
                    }
                    this.transitionToMainHeader();
                };
                this.headerContainer.appendChild(this.permissionHeader);
            } else {
                this.mainHeader = document.createElement('main-header');
                this.headerContainer.appendChild(this.mainHeader);
                this.mainHeader.startSlideInAnimation?.();
            }

            this.currentHeaderType = type;
            this.notifyHeaderState(type === 'permission' ? 'apikey' : type); // Keep permission state as apikey for compatibility
        };

        console.log('[HeaderController] Manager initialized');

        this._bootstrap();

        if (window.api) {
            window.api.headerController.onForceShowApiKeyHeader(async () => {
                console.log('[HeaderController] Received broadcast to show apikey header. Switching now.');
                await this.transitionToApiKeyHeader();
            });
        }
    }

    notifyHeaderState(stateOverride) {
        const state = stateOverride || this.currentHeaderType || 'apikey';
        if (window.api) {
            window.api.headerController.sendHeaderStateChanged(state);
        }
    }

    async _bootstrap() {
        if (window.api) {
            this.handleStateUpdate();
        } else {
            // Fallback for non-electron environment (testing/web)
            this.ensureHeader('apikey');
        }
    }

    async handleStateUpdate() {
        const isConfigured = await window.api.apiKeyHeader.areProvidersConfigured();

        if (isConfigured) {
            const permissionResult = await this.checkPermissions();
            if (permissionResult.success) {
                this.transitionToMainHeader();
            } else {
                this.transitionToPermissionHeader();
            }
        } else {
            // No providers configured yet: ask for API keys / local models.
            await this.transitionToApiKeyHeader();
        }
    }

    async transitionToApiKeyHeader() {
        await this._resizeForApiKey(400);
        this.ensureHeader('apikey');
    }

    async transitionToPermissionHeader() {
        // Prevent duplicate transitions
        if (this.currentHeaderType === 'permission') {
            console.log('[HeaderController] Already showing permission setup, skipping transition');
            return;
        }

        // Check if permissions were previously completed
        if (window.api) {
            try {
                const permissionsCompleted = await window.api.headerController.checkPermissionsCompleted();
                if (permissionsCompleted) {
                    console.log('[HeaderController] Permissions were previously completed, checking current status...');
                    
                    // Double check current permission status
                    const permissionResult = await this.checkPermissions();
                    if (permissionResult.success) {
                        // Skip permission setup if already granted
                        this.transitionToMainHeader();
                        return;
                    }
                    
                    console.log('[HeaderController] Permissions were revoked, showing setup again');
                }
            } catch (error) {
                console.error('[HeaderController] Error checking permissions completed status:', error);
            }
        }

        await this._resizeForPermissionHeader(220);
        this.ensureHeader('permission');
    }

    async transitionToMainHeader(animate = true) {
        if (this.currentHeaderType === 'main') {
            return this._resizeForMain();
        }

        await this._resizeForMain();
        this.ensureHeader('main');
    }

    async _resizeForMain() {
        if (!window.api) return;
        console.log('[HeaderController] _resizeForMain: Resizing window to 353x47');
        return window.api.headerController.resizeHeaderWindow({ width: 353, height: 47 }).catch(() => {});
    }

    async _resizeForApiKey(height = 370) {
        if (!window.api) return;
        console.log(`[HeaderController] _resizeForApiKey: Resizing window to 456x${height}`);
        return window.api.headerController.resizeHeaderWindow({ width: 456, height: height }).catch(() => {});
    }

    async _resizeForPermissionHeader(height) {
        if (!window.api) return;
        const finalHeight = height || 220;
        return window.api.headerController.resizeHeaderWindow({ width: 285, height: finalHeight })
            .catch(() => {});
    }

    async checkPermissions() {
        if (!window.api) {
            return { success: true };
        }
        
        try {
            const permissions = await window.api.headerController.checkSystemPermissions();
            console.log('[HeaderController] Current permissions:', permissions);
            
            if (!permissions.needsSetup) {
                return { success: true };
            }

            let errorMessage = '';
            if (!permissions.microphone && !permissions.screen) {
                errorMessage = 'Microphone and screen recording access required';
            }
            
            return { 
                success: false, 
                error: errorMessage
            };
        } catch (error) {
            console.error('[HeaderController] Error checking permissions:', error);
            return { 
                success: false, 
                error: 'Failed to check permissions' 
            };
        }
    }
}

window.addEventListener('DOMContentLoaded', () => {
    new HeaderTransitionManager();
});
