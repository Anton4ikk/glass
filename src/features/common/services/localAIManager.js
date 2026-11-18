const { EventEmitter } = require('events');
const ollamaService = require('./ollamaService');
const whisperService = require('./whisperService');

// Facade over the Ollama and Whisper services: one event stream and state map for both.
class LocalAIManager extends EventEmitter {
    constructor() {
        super();

        this.services = {
            ollama: ollamaService,
            whisper: whisperService
        };

        this.state = {
            ollama: {
                installed: false,
                running: false,
                models: []
            },
            whisper: {
                installed: false,
                initialized: false,
                models: []
            }
        };

        this.setupEventListeners();
    }

    // Re-emit each service's events tagged with the service name.
    setupEventListeners() {
        ollamaService.on('install-progress', (data) => {
            this.emit('install-progress', 'ollama', data);
        });
        
        ollamaService.on('installation-complete', () => {
            this.emit('installation-complete', 'ollama');
            this.updateServiceState('ollama');
        });
        
        ollamaService.on('error', (error) => {
            this.emit('error', { service: 'ollama', ...error });
        });
        
        ollamaService.on('model-pull-complete', (data) => {
            this.emit('model-ready', { service: 'ollama', ...data });
            this.updateServiceState('ollama');
        });
        
        ollamaService.on('state-changed', (state) => {
            this.emit('state-changed', 'ollama', state);
        });

        whisperService.on('install-progress', (data) => {
            this.emit('install-progress', 'whisper', data);
        });
        
        whisperService.on('installation-complete', () => {
            this.emit('installation-complete', 'whisper');
            this.updateServiceState('whisper');
        });
        
        whisperService.on('error', (error) => {
            this.emit('error', { service: 'whisper', ...error });
        });
        
        whisperService.on('model-download-complete', (data) => {
            this.emit('model-ready', { service: 'whisper', ...data });
            this.updateServiceState('whisper');
        });
    }

    async installService(serviceName, options = {}) {
        const service = this.services[serviceName];
        if (!service) {
            throw new Error(`Unknown service: ${serviceName}`);
        }
        
        try {
            if (serviceName === 'ollama') {
                return await service.handleInstall();
            } else if (serviceName === 'whisper') {
                // initialize() installs the whisper binary if it's missing.
                await service.initialize();
                return { success: true };
            }
        } catch (error) {
            this.emit('error', {
                service: serviceName,
                errorType: 'installation-failed',
                error: error.message
            });
            throw error;
        }
    }

    async getServiceStatus(serviceName) {
        const service = this.services[serviceName];
        if (!service) {
            throw new Error(`Unknown service: ${serviceName}`);
        }
        
        if (serviceName === 'ollama') {
            return await service.getStatus();
        } else if (serviceName === 'whisper') {
            const installed = await service.isInstalled();
            const running = await service.isServiceRunning();
            const models = await service.getInstalledModels();
            return {
                success: true,
                installed,
                running,
                models
            };
        }
    }

    async startService(serviceName) {
        const service = this.services[serviceName];
        if (!service) {
            throw new Error(`Unknown service: ${serviceName}`);
        }
        
        const result = await service.startService();
        await this.updateServiceState(serviceName);
        return { success: result };
    }

    async stopService(serviceName) {
        const service = this.services[serviceName];
        if (!service) {
            throw new Error(`Unknown service: ${serviceName}`);
        }
        
        let result;
        if (serviceName === 'ollama') {
            result = await service.shutdown(false);
        } else if (serviceName === 'whisper') {
            result = await service.stopService();
        }

        await this.updateServiceState(serviceName);

        return result;
    }

    async installModel(serviceName, modelId, options = {}) {
        const service = this.services[serviceName];
        if (!service) {
            throw new Error(`Unknown service: ${serviceName}`);
        }
        
        if (serviceName === 'ollama') {
            return await service.pullModel(modelId);
        } else if (serviceName === 'whisper') {
            return await service.downloadModel(modelId);
        }
    }

    async getInstalledModels(serviceName) {
        const service = this.services[serviceName];
        if (!service) {
            throw new Error(`Unknown service: ${serviceName}`);
        }
        
        if (serviceName === 'ollama') {
            return await service.getAllModelsWithStatus();
        } else if (serviceName === 'whisper') {
            return await service.getInstalledModels();
        }
    }

    // Ollama only.
    async warmUpModel(modelName, forceRefresh = false) {
        return await ollamaService.warmUpModel(modelName, forceRefresh);
    }

    // Ollama only.
    async autoWarmUp() {
        return await ollamaService.autoWarmUpSelectedModel();
    }

    async runDiagnostics(serviceName) {
        const service = this.services[serviceName];
        if (!service) {
            throw new Error(`Unknown service: ${serviceName}`);
        }
        
        const diagnostics = {
            service: serviceName,
            timestamp: new Date().toISOString(),
            checks: {}
        };
        
        try {
            diagnostics.checks.installation = {
                check: 'Installation',
                status: await service.isInstalled() ? 'pass' : 'fail',
                details: {}
            };

            diagnostics.checks.running = {
                check: 'Service Running',
                status: await service.isServiceRunning() ? 'pass' : 'fail',
                details: {}
            };

            if (serviceName === 'ollama') {
                try {
                    const health = await service.healthCheck();
                    diagnostics.checks.health = {
                        check: 'Service Health',
                        status: health.healthy ? 'pass' : 'fail',
                        details: health
                    };

                    // repairService() keys its port cleanup off this check.
                    diagnostics.checks.port = {
                        check: 'Port Connectivity',
                        status: health.checks.apiResponsive ? 'pass' : 'fail',
                        details: { connected: health.checks.apiResponsive }
                    };
                } catch (error) {
                    diagnostics.checks.health = {
                        check: 'Service Health',
                        status: 'fail',
                        details: { error: error.message }
                    };
                    diagnostics.checks.port = {
                        check: 'Port Connectivity',
                        status: 'fail',
                        details: { error: error.message }
                    };
                }

                if (diagnostics.checks.running.status === 'pass') {
                    try {
                        const models = await service.getInstalledModels();
                        diagnostics.checks.models = {
                            check: 'Installed Models',
                            status: 'pass',
                            details: { count: models.length, models: models.map(m => m.name) }
                        };

                        const warmupStatus = await service.getWarmUpStatus();
                        diagnostics.checks.warmup = {
                            check: 'Model Warm-up',
                            status: 'pass',
                            details: warmupStatus
                        };
                    } catch (error) {
                        diagnostics.checks.models = {
                            check: 'Installed Models',
                            status: 'fail',
                            details: { error: error.message }
                        };
                    }
                }
            }

            if (serviceName === 'whisper') {
                diagnostics.checks.binary = {
                    check: 'Whisper Binary',
                    status: service.whisperPath ? 'pass' : 'fail',
                    details: { path: service.whisperPath }
                };

                diagnostics.checks.modelDir = {
                    check: 'Model Directory',
                    status: service.modelsDir ? 'pass' : 'fail',
                    details: { path: service.modelsDir }
                };
            }

            const allChecks = Object.values(diagnostics.checks);
            diagnostics.summary = {
                total: allChecks.length,
                passed: allChecks.filter(c => c.status === 'pass').length,
                failed: allChecks.filter(c => c.status === 'fail').length,
                overallStatus: allChecks.every(c => c.status === 'pass') ? 'healthy' : 'unhealthy'
            };
            
        } catch (error) {
            diagnostics.error = error.message;
            diagnostics.summary = {
                overallStatus: 'error'
            };
        }
        
        return diagnostics;
    }

    async repairService(serviceName) {
        const service = this.services[serviceName];
        if (!service) {
            throw new Error(`Unknown service: ${serviceName}`);
        }
        
        console.log(`[LocalAIManager] Starting repair for ${serviceName}...`);
        const repairLog = [];
        
        try {
            repairLog.push('Running diagnostics...');
            const diagnostics = await this.runDiagnostics(serviceName);
            
            if (diagnostics.summary.overallStatus === 'healthy') {
                repairLog.push('Service is already healthy, no repair needed');
                return {
                    success: true,
                    repairLog,
                    diagnostics
                };
            }

            if (diagnostics.checks.installation?.status === 'fail') {
                repairLog.push('Installation missing, attempting to install...');
                try {
                    await this.installService(serviceName);
                    repairLog.push('Installation completed');
                } catch (error) {
                    repairLog.push(`Installation failed: ${error.message}`);
                    throw error;
                }
            }

            if (diagnostics.checks.running?.status === 'fail') {
                repairLog.push('Service not running, attempting to start...');

                try {
                    await this.stopService(serviceName);
                    repairLog.push('Stopped existing service');
                } catch (error) {
                    repairLog.push('Service was not running');
                }

                await new Promise(resolve => setTimeout(resolve, 2000));

                try {
                    await this.startService(serviceName);
                    repairLog.push('Service started successfully');
                } catch (error) {
                    repairLog.push(`Failed to start service: ${error.message}`);
                    throw error;
                }
            }

            if (serviceName === 'ollama' && diagnostics.checks.port?.status === 'fail') {
                repairLog.push('Port connectivity issue detected');

                if (process.platform === 'darwin') {
                    try {
                        const { exec } = require('child_process');
                        const { promisify } = require('util');
                        const execAsync = promisify(exec);
                        await execAsync('pkill -f ollama');
                        repairLog.push('Killed stale Ollama processes');
                    } catch (error) {
                        repairLog.push('No stale processes found');
                    }
                }
                else if (process.platform === 'win32') {
                    try {
                        const { exec } = require('child_process');
                        const { promisify } = require('util');
                        const execAsync = promisify(exec);
                        await execAsync('taskkill /F /IM ollama.exe');
                        repairLog.push('Killed stale Ollama processes');
                    } catch (error) {
                        repairLog.push('No stale processes found');
                    }
                }
                else if (process.platform === 'linux') {
                    try {
                        const { exec } = require('child_process');
                        const { promisify } = require('util');
                        const execAsync = promisify(exec);
                        await execAsync('pkill -f ollama');
                        repairLog.push('Killed stale Ollama processes');
                    } catch (error) {
                        repairLog.push('No stale processes found');
                    }
                }
                
                await new Promise(resolve => setTimeout(resolve, 1000));

                await this.startService(serviceName);
                repairLog.push('Restarted service after port cleanup');
            }

            if (serviceName === 'whisper') {
                if (diagnostics.checks.running?.status === 'pass') {
                    repairLog.push('Cleaning up Whisper sessions...');
                    await service.cleanup();
                    repairLog.push('Sessions cleaned up');
                }

                if (!service.installState.isInitialized) {
                    repairLog.push('Re-initializing Whisper...');
                    await service.initialize();
                    repairLog.push('Whisper re-initialized');
                }
            }

            repairLog.push('Verifying repair...');
            const finalDiagnostics = await this.runDiagnostics(serviceName);
            
            const success = finalDiagnostics.summary.overallStatus === 'healthy';
            repairLog.push(success ? 'Repair successful!' : 'Repair failed - manual intervention may be required');

            if (success) {
                await this.updateServiceState(serviceName);
            }
            
            return {
                success,
                repairLog,
                diagnostics: finalDiagnostics
            };
            
        } catch (error) {
            repairLog.push(`Repair error: ${error.message}`);
            return {
                success: false,
                repairLog,
                error: error.message
            };
        }
    }

    async updateServiceState(serviceName) {
        try {
            const status = await this.getServiceStatus(serviceName);
            this.state[serviceName] = status;

            this.emit('state-changed', serviceName, status);
        } catch (error) {
            console.error(`[LocalAIManager] Failed to update ${serviceName} state:`, error);
        }
    }

    async getAllServiceStates() {
        const states = {};
        
        for (const serviceName of Object.keys(this.services)) {
            try {
                states[serviceName] = await this.getServiceStatus(serviceName);
            } catch (error) {
                states[serviceName] = {
                    success: false,
                    error: error.message
                };
            }
        }
        
        return states;
    }

    startPeriodicSync(interval = 30000) {
        if (this.syncInterval) {
            return;
        }
        
        this.syncInterval = setInterval(async () => {
            for (const serviceName of Object.keys(this.services)) {
                await this.updateServiceState(serviceName);
            }
        }, interval);

        ollamaService.startPeriodicSync();
    }

    stopPeriodicSync() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }

        ollamaService.stopPeriodicSync();
    }

    async shutdown() {
        this.stopPeriodicSync();
        
        const results = {};
        for (const [serviceName, service] of Object.entries(this.services)) {
            try {
                if (serviceName === 'ollama') {
                    results[serviceName] = await service.shutdown(false);
                } else if (serviceName === 'whisper') {
                    await service.cleanup();
                    results[serviceName] = true;
                }
            } catch (error) {
                results[serviceName] = false;
                console.error(`[LocalAIManager] Failed to shutdown ${serviceName}:`, error);
            }
        }
        
        return results;
    }

    async handleError(serviceName, errorType, details = {}) {
        console.error(`[LocalAIManager] Error in ${serviceName}: ${errorType}`, details);

        switch(errorType) {
            case 'installation-failed':
                this.emit('error-occurred', {
                    service: serviceName,
                    errorType,
                    error: details.error || 'Installation failed',
                    canRetry: true
                });
                break;
                
            case 'model-pull-failed':
            case 'model-download-failed':
                this.emit('error-occurred', {
                    service: serviceName,
                    errorType,
                    model: details.model,
                    error: details.error || 'Model download failed',
                    canRetry: true
                });
                break;
                
            case 'service-not-responding': {
                console.log(`[LocalAIManager] Attempting to repair ${serviceName}...`);
                const repairResult = await this.repairService(serviceName);
                
                this.emit('error-occurred', {
                    service: serviceName,
                    errorType,
                    error: details.error || 'Service not responding',
                    repairAttempted: true,
                    repairSuccessful: repairResult.success
                });
                break;
            }

            default:
                this.emit('error-occurred', {
                    service: serviceName,
                    errorType,
                    error: details.error || `Unknown error: ${errorType}`,
                    canRetry: false
                });
        }
    }
}

const localAIManager = new LocalAIManager();
module.exports = localAIManager;