const { EventEmitter } = require('events');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs').promises;
const https = require('https');
const crypto = require('crypto');
const { app } = require('electron');
const { spawnAsync } = require('../utils/spawnHelper');
const { DOWNLOAD_CHECKSUMS } = require('../config/checksums');
const ollamaModelRepository = require('../repositories/ollamaModel');
const { NUM_CTX } = require('../ai/providers/ollama');

const execAsync = promisify(exec);

class OllamaService extends EventEmitter {
    constructor() {
        super();
        this.serviceName = 'OllamaService';
        this.baseUrl = 'http://localhost:11434';

        this.installState = {
            isInstalled: false,
            isInstalling: false,
            progress: 0
        };

        this.requestTimeout = 30000;

        this.installedModels = new Map();
        this.modelWarmupStatus = new Map();

        // Rollback points for a failed install.
        this.installCheckpoints = [];

        this.installationProgress = new Map();

        this.warmingModels = new Map();
        this.warmedModels = new Set();
        this.lastWarmUpAttempt = new Map();
        this.warmupTimeout = 120000;

        this._lastState = null;
        this._syncInterval = null;
        this._lastLoadedModels = [];
        this.modelLoadStatus = new Map();

        this.isShuttingDown = false;
    }

    getPlatform() {
        return process.platform;
    }

    async checkCommand(command) {
        try {
            const platform = this.getPlatform();
            const checkCmd = platform === 'win32' ? 'where' : 'which';
            const { stdout } = await execAsync(`${checkCmd} ${command}`);
            return stdout.trim();
        } catch (error) {
            return null;
        }
    }

    async waitForService(checkFn, maxAttempts = 30, delayMs = 1000) {
        for (let i = 0; i < maxAttempts; i++) {
            if (await checkFn()) {
                console.log(`[${this.serviceName}] Service is ready`);
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        throw new Error(`${this.serviceName} service failed to start within timeout`);
    }

    getInstallProgress(modelName) {
        return this.installationProgress.get(modelName) || 0;
    }

    setInstallProgress(modelName, progress) {
        this.installationProgress.set(modelName, progress);
    }

    clearInstallProgress(modelName) {
        this.installationProgress.delete(modelName);
    }

    async getStatus() {
        try {
            const installed = await this.isInstalled();
            if (!installed) {
                return { success: true, installed: false, running: false, models: [] };
            }

            const running = await this.isServiceRunning();
            if (!running) {
                return { success: true, installed: true, running: false, models: [] };
            }

            const models = await this.getInstalledModels();
            return { success: true, installed: true, running: true, models };
        } catch (error) {
            console.error('[OllamaService] Error getting status:', error);
            return { success: false, error: error.message, installed: false, running: false, models: [] };
        }
    }

    getOllamaCliPath() {
        if (this.getPlatform() === 'darwin') {
            return '/Applications/Ollama.app/Contents/Resources/ollama';
        }
        return 'ollama';
    }

    /**
     * fetch against the local Ollama API with a per-request timeout. No local
     * queue: Ollama serves concurrent requests itself, and the old lock handed
     * waiters the previous request's error.
     */
    async makeRequest(endpoint, { timeout = this.requestTimeout, ...options } = {}) {
        if (this.isShuttingDown) {
            throw new Error('Service is shutting down');
        }
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        try {
            return await fetch(`${this.baseUrl}${endpoint}`, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async isInstalled() {
        try {
            const platform = this.getPlatform();
            
            if (platform === 'darwin') {
                try {
                    await fs.access('/Applications/Ollama.app');
                    return true;
                } catch {
                    const ollamaPath = await this.checkCommand(this.getOllamaCliPath());
                    return !!ollamaPath;
                }
            } else {
                const ollamaPath = await this.checkCommand(this.getOllamaCliPath());
                return !!ollamaPath;
            }
        } catch (error) {
            console.log('[OllamaService] Ollama not found:', error.message);
            return false;
        }
    }

    async isServiceRunning() {
        try {
            const response = await this.makeRequest('/api/ps', {
                method: 'GET'
            });
            
            return response.ok;
        } catch (error) {
            console.log(`[OllamaService] Service health check failed: ${error.message}`);
            return false;
        }
    }

    async startService() {
        this.isShuttingDown = false;
        
        const platform = this.getPlatform();
        
        try {
            if (platform === 'darwin') {
                try {
                    await spawnAsync('open', ['-a', 'Ollama']);
                    await this.waitForService(() => this.isServiceRunning());
                    return true;
                } catch {
                    spawn(this.getOllamaCliPath(), ['serve'], {
                        detached: true,
                        stdio: 'ignore'
                    }).unref();
                    await this.waitForService(() => this.isServiceRunning());
                    return true;
                }
            } else {
                spawn(this.getOllamaCliPath(), ['serve'], {
                    detached: true,
                    stdio: 'ignore',
                    shell: platform === 'win32'
                }).unref();
                await this.waitForService(() => this.isServiceRunning());
                return true;
            }
        } catch (error) {
            console.error('[OllamaService] Failed to start service:', error);
            throw error;
        }
    }

    async stopService() {
        return await this.shutdown();
    }

    async healthCheck() {
        try {
            const checks = {
                serviceRunning: false,
                apiResponsive: false,
                modelsAccessible: false,
                memoryStatus: false
            };

            try {
                const psResponse = await this.makeRequest('/api/ps', { method: 'GET' });
                checks.serviceRunning = psResponse.ok;
                checks.memoryStatus = psResponse.ok;
            } catch (error) {
                console.log('[OllamaService] /api/ps check failed:', error.message);
            }

            try {
                const rootResponse = await this.makeRequest('/', { method: 'GET' });
                checks.apiResponsive = rootResponse.ok;
            } catch (error) {
                console.log('[OllamaService] Root endpoint check failed:', error.message);
            }

            try {
                const tagsResponse = await this.makeRequest('/api/tags', { method: 'GET' });
                checks.modelsAccessible = tagsResponse.ok;
            } catch (error) {
                console.log('[OllamaService] /api/tags check failed:', error.message);
            }
            
            const allHealthy = Object.values(checks).every(v => v === true);
            
            return {
                healthy: allHealthy,
                checks,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            console.error('[OllamaService] Health check failed:', error);
            return {
                healthy: false,
                error: error.message,
                timestamp: new Date().toISOString()
            };
        }
    }

    async getInstalledModels() {
        if (this.isShuttingDown) {
            console.log('[OllamaService] Service is shutting down, returning empty models list');
            return [];
        }
        
        try {
            const response = await this.makeRequest('/api/tags', {
                method: 'GET'
            });
            
            const data = await response.json();
            return data.models || [];
        } catch (error) {
            console.error('[OllamaService] Failed to get installed models:', error.message);
            return [];
        }
    }

    // Models currently loaded in memory (/api/ps), as opposed to installed (/api/tags).
    async getLoadedModels() {
        if (this.isShuttingDown) {
            console.log('[OllamaService] Service is shutting down, returning empty loaded models list');
            return [];
        }
        
        try {
            const response = await this.makeRequest('/api/ps', {
                method: 'GET'
            });
            
            if (!response.ok) {
                console.log('[OllamaService] Failed to get loaded models via /api/ps');
                return [];
            }
            
            const data = await response.json();
            return (data.models || []).map(m => m.name);
        } catch (error) {
            console.error('[OllamaService] Error getting loaded models:', error);
            return [];
        }
    }

    async getLoadedModelsWithMemoryInfo() {
        try {
            const response = await this.makeRequest('/api/ps', {
                method: 'GET'
            });
            
            if (!response.ok) {
                return [];
            }
            
            const data = await response.json();
            return data.models || [];
        } catch (error) {
            console.error('[OllamaService] Error getting loaded models info:', error);
            return [];
        }
    }

    async isModelLoaded(modelName) {
        const loadedModels = await this.getLoadedModels();
        return loadedModels.includes(modelName);
    }

    async getInstalledModelsList() {
        try {
            const { stdout } = await spawnAsync(this.getOllamaCliPath(), ['list']);
            const lines = stdout.split('\n').filter(line => line.trim());

            // Skip header line (NAME, ID, SIZE, MODIFIED)
            const modelLines = lines.slice(1);

            const models = [];
            for (const line of modelLines) {
                if (!line.trim()) continue;

                // "model:tag    model_id    size    modified_time"
                const parts = line.split(/\s+/);
                if (parts.length >= 3) {
                    models.push({
                        name: parts[0],
                        id: parts[1],
                        size: parts[2] + (parts[3] === 'GB' || parts[3] === 'MB' ? ' ' + parts[3] : ''),
                        status: 'installed'
                    });
                }
            }
            
            return models;
        } catch (error) {
            console.log('[OllamaService] Failed to get installed models via CLI, falling back to API');
            const apiModels = await this.getInstalledModels();
            return apiModels.map(model => ({
                name: model.name,
                id: model.digest || 'unknown',
                size: model.size || 'Unknown',
                status: 'installed'
            }));
        }
    }

    async getModelSuggestions() {
        try {
            const installedModels = await this.getInstalledModelsList();

            return installedModels;
        } catch (error) {
            console.error('[OllamaService] Failed to get model suggestions:', error);
            return [];
        }
    }

    async isModelInstalled(modelName) {
        const models = await this.getInstalledModels();
        return models.some(model => model.name === modelName);
    }

    async pullModel(modelName) {
        if (!modelName?.trim()) {
            throw new Error(`Invalid model name: ${modelName}`);
        }

        console.log(`[OllamaService] Starting to pull model: ${modelName} via API`);

        this.emit('install-progress', {
            model: modelName,
            progress: 0,
            status: 'starting'
        });
        
        try {
            const response = await fetch(`${this.baseUrl}/api/pull`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: modelName,
                    stream: true
                })
            });

            if (!response.ok) {
                throw new Error(`Pull API failed: ${response.status} ${response.statusText}`);
            }

            return new Promise((resolve, reject) => {
                let buffer = '';

                response.body.on('data', (chunk) => {
                    buffer += chunk.toString();
                    const lines = buffer.split('\n');

                    // Keep incomplete line in buffer
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (!line.trim()) continue;
                        
                        try {
                            const data = JSON.parse(line);
                            const progress = this._parseOllamaPullProgress(data, modelName);
                            
                            if (progress !== null) {
                                this.setInstallProgress(modelName, progress);
                                this.emit('install-progress', { 
                                    model: modelName, 
                                    progress,
                                    status: data.status || 'downloading'
                                });
                                console.log(`[OllamaService] API Progress: ${progress}% for ${modelName} (${data.status || 'downloading'})`);
                            }

                            if (data.status === 'success') {
                                console.log(`[OllamaService] Successfully pulled model: ${modelName}`);
                                this.emit('model-pull-complete', { model: modelName });
                                this.clearInstallProgress(modelName);
                                resolve();
                                return;
                            }
                        } catch (parseError) {
                            console.warn('[OllamaService] Failed to parse response line:', line);
                        }
                    }
                });

                response.body.on('end', () => {
                    if (buffer.trim()) {
                        try {
                            const data = JSON.parse(buffer);
                            if (data.status === 'success') {
                                console.log(`[OllamaService] Successfully pulled model: ${modelName}`);
                                this.emit('model-pull-complete', { model: modelName });
                            }
                        } catch (parseError) {
                            console.warn('[OllamaService] Failed to parse final buffer:', buffer);
                        }
                    }
                    this.clearInstallProgress(modelName);
                    resolve();
                });

                response.body.on('error', (error) => {
                    console.error(`[OllamaService] Stream error for ${modelName}:`, error);
                    this.clearInstallProgress(modelName);
                    reject(error);
                });
            });
        } catch (error) {
            this.clearInstallProgress(modelName);
            console.error(`[OllamaService] Pull model failed:`, error);
            throw error;
        }
    }

    _parseOllamaPullProgress(data, modelName) {
        if (data.status === 'success') {
            return 100;
        }

        if (data.total && data.completed !== undefined) {
            const progress = Math.round((data.completed / data.total) * 100);
            return Math.min(progress, 99); // Don't show 100% until success
        }

        // Statuses without byte counts get fixed milestones.
        const statusProgress = {
            'pulling manifest': 5,
            'downloading': 10,
            'verifying sha256 digest': 90,
            'writing manifest': 95,
            'removing any unused layers': 98
        };

        if (data.status && statusProgress[data.status] !== undefined) {
            return statusProgress[data.status];
        }

        return null;
    }



    async downloadFile(url, destination, options = {}) {
        const { 
            onProgress = null,
            headers = { 'User-Agent': 'Glass-App' },
            timeout = 300000,
            modelId = null
        } = options;

        return new Promise((resolve, reject) => {
            const file = require('fs').createWriteStream(destination);
            let downloadedSize = 0;
            let totalSize = 0;

            const request = https.get(url, { headers }, (response) => {
                if ([301, 302, 307, 308].includes(response.statusCode)) {
                    file.close();
                    require('fs').unlink(destination, () => {});
                    
                    if (!response.headers.location) {
                        reject(new Error('Redirect without location header'));
                        return;
                    }
                    
                    console.log(`[${this.serviceName}] Following redirect from ${url} to ${response.headers.location}`);
                    this.downloadFile(response.headers.location, destination, options)
                        .then(resolve)
                        .catch(reject);
                    return;
                }

                if (response.statusCode !== 200) {
                    file.close();
                    require('fs').unlink(destination, () => {});
                    reject(new Error(`Download failed: ${response.statusCode} ${response.statusMessage}`));
                    return;
                }

                totalSize = parseInt(response.headers['content-length'], 10) || 0;

                response.on('data', (chunk) => {
                    downloadedSize += chunk.length;
                    
                    if (totalSize > 0) {
                        const progress = Math.round((downloadedSize / totalSize) * 100);
                        
                        if (onProgress) {
                            onProgress(progress, downloadedSize, totalSize);
                        }
                    }
                });

                response.pipe(file);

                file.on('finish', () => {
                    file.close(() => {
                        resolve({ success: true, size: downloadedSize });
                    });
                });
            });

            request.on('timeout', () => {
                request.destroy();
                file.close();
                require('fs').unlink(destination, () => {});
                reject(new Error('Download timeout'));
            });

            request.on('error', (err) => {
                file.close();
                require('fs').unlink(destination, () => {});
                this.emit('download-error', { url, error: err, modelId });
                reject(err);
            });

            request.setTimeout(timeout);

            file.on('error', (err) => {
                require('fs').unlink(destination, () => {});
                reject(err);
            });
        });
    }

    async downloadWithRetry(url, destination, options = {}) {
        const { 
            maxRetries = 3, 
            retryDelay = 1000, 
            expectedChecksum = null,
            modelId = null,
            ...downloadOptions 
        } = options;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const result = await this.downloadFile(url, destination, { 
                    ...downloadOptions, 
                    modelId 
                });
                
                if (expectedChecksum) {
                    const isValid = await this.verifyChecksum(destination, expectedChecksum);
                    if (!isValid) {
                        require('fs').unlinkSync(destination);
                        throw new Error('Checksum verification failed');
                    }
                    console.log(`[${this.serviceName}] Checksum verified successfully`);
                }
                
                return result;
            } catch (error) {
                if (attempt === maxRetries) {
                    throw error;
                }
                
                console.log(`Download attempt ${attempt} failed, retrying in ${retryDelay}ms...`);
                await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
            }
        }
    }

    async verifyChecksum(filePath, expectedChecksum) {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = require('fs').createReadStream(filePath);
            
            stream.on('data', (data) => hash.update(data));
            stream.on('end', () => {
                const fileChecksum = hash.digest('hex');
                console.log(`[${this.serviceName}] File checksum: ${fileChecksum}`);
                console.log(`[${this.serviceName}] Expected checksum: ${expectedChecksum}`);
                resolve(fileChecksum === expectedChecksum);
            });
            stream.on('error', reject);
        });
    }

    async autoInstall(onProgress) {
        const platform = this.getPlatform();
        console.log(`[${this.serviceName}] Starting auto-installation for ${platform}`);
        
        try {
            switch(platform) {
                case 'darwin':
                    return await this.installMacOS(onProgress);
                case 'win32':
                    return await this.installWindows(onProgress);
                case 'linux':
                    return await this.installLinux();
                default:
                    throw new Error(`Unsupported platform: ${platform}`);
            }
        } catch (error) {
            console.error(`[${this.serviceName}] Auto-installation failed:`, error);
            throw error;
        }
    }

    async installMacOS(onProgress) {
        console.log('[OllamaService] Installing Ollama on macOS using DMG...');

        // Declared outside try: the catch block below cleans up dmgPath.
        const dmgUrl = 'https://ollama.com/download/Ollama.dmg';
        const tempDir = app.getPath('temp');
        const dmgPath = path.join(tempDir, 'Ollama.dmg');
        const mountPoint = path.join(tempDir, 'OllamaMount');

        try {

            await this.saveCheckpoint('pre-install');

            console.log('[OllamaService] Step 1: Downloading Ollama DMG...');
            onProgress?.({ stage: 'downloading', message: 'Downloading Ollama installer...', progress: 0 });
            const checksumInfo = DOWNLOAD_CHECKSUMS.ollama.dmg;
            await this.downloadWithRetry(dmgUrl, dmgPath, {
                expectedChecksum: checksumInfo?.sha256,
                onProgress: (progress) => {
                    onProgress?.({ stage: 'downloading', message: `Downloading... ${progress}%`, progress });
                }
            });
            
            await this.saveCheckpoint('post-download');
            
            console.log('[OllamaService] Step 2: Mounting DMG...');
            onProgress?.({ stage: 'mounting', message: 'Mounting disk image...', progress: 0 });
            await fs.mkdir(mountPoint, { recursive: true });
            await spawnAsync('hdiutil', ['attach', dmgPath, '-mountpoint', mountPoint]);
            onProgress?.({ stage: 'mounting', message: 'Disk image mounted.', progress: 100 });
            
            console.log('[OllamaService] Step 3: Installing Ollama.app...');
            onProgress?.({ stage: 'installing', message: 'Installing Ollama application...', progress: 0 });
            await spawnAsync('cp', ['-R', `${mountPoint}/Ollama.app`, '/Applications/']);
            onProgress?.({ stage: 'installing', message: 'Application installed.', progress: 100 });
            
            await this.saveCheckpoint('post-install');
            
            console.log('[OllamaService] Step 4: Setting up CLI path...');
            onProgress?.({ stage: 'linking', message: 'Creating command-line shortcut...', progress: 0 });
            try {
                const script = `do shell script "mkdir -p /usr/local/bin && ln -sf '${this.getOllamaCliPath()}' '/usr/local/bin/ollama'" with administrator privileges`;
                await spawnAsync('osascript', ['-e', script]);
                onProgress?.({ stage: 'linking', message: 'Shortcut created.', progress: 100 });
            } catch (linkError) {
                console.error('[OllamaService] CLI symlink creation failed:', linkError.message);
                onProgress?.({ stage: 'linking', message: 'Shortcut creation failed (permissions?).', progress: 100 });
                // Non-fatal: the app calls the CLI by its full path inside Ollama.app.
            }
            
            console.log('[OllamaService] Step 5: Cleanup...');
            onProgress?.({ stage: 'cleanup', message: 'Cleaning up installation files...', progress: 0 });
            await spawnAsync('hdiutil', ['detach', mountPoint]);
            await fs.unlink(dmgPath).catch(() => {});
            await fs.rmdir(mountPoint).catch(() => {});
            onProgress?.({ stage: 'cleanup', message: 'Cleanup complete.', progress: 100 });
            
            console.log('[OllamaService] Ollama installed successfully on macOS');
            
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            return true;
        } catch (error) {
            console.error('[OllamaService] macOS installation failed:', error);
            await fs.unlink(dmgPath).catch(() => {});
            throw new Error(`Failed to install Ollama on macOS: ${error.message}`);
        }
    }

    async installWindows(onProgress) {
        console.log('[OllamaService] Installing Ollama on Windows...');
        
        try {
            const exeUrl = 'https://ollama.com/download/OllamaSetup.exe';
            const tempDir = app.getPath('temp');
            const exePath = path.join(tempDir, 'OllamaSetup.exe');

            console.log('[OllamaService] Step 1: Downloading Ollama installer...');
            onProgress?.({ stage: 'downloading', message: 'Downloading Ollama installer...', progress: 0 });
            const checksumInfo = DOWNLOAD_CHECKSUMS.ollama.exe;
            await this.downloadWithRetry(exeUrl, exePath, {
                expectedChecksum: checksumInfo?.sha256,
                onProgress: (progress) => {
                    onProgress?.({ stage: 'downloading', message: `Downloading... ${progress}%`, progress });
                }
            });
            
            console.log('[OllamaService] Step 2: Running silent installation...');
            onProgress?.({ stage: 'installing', message: 'Installing Ollama...', progress: 0 });
            await spawnAsync(exePath, ['/VERYSILENT', '/NORESTART']);
            onProgress?.({ stage: 'installing', message: 'Installation complete.', progress: 100 });
            
            console.log('[OllamaService] Step 3: Cleanup...');
            onProgress?.({ stage: 'cleanup', message: 'Cleaning up installation files...', progress: 0 });
            await fs.unlink(exePath).catch(() => {});
            onProgress?.({ stage: 'cleanup', message: 'Cleanup complete.', progress: 100 });
            
            console.log('[OllamaService] Ollama installed successfully on Windows');
            
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            return true;
        } catch (error) {
            console.error('[OllamaService] Windows installation failed:', error);
            throw new Error(`Failed to install Ollama on Windows: ${error.message}`);
        }
    }

    async installLinux() {
        console.log('[OllamaService] Installing Ollama on Linux...');
        console.log('[OllamaService] Automatic installation on Linux is not supported for security reasons.');
        console.log('[OllamaService] Please install Ollama manually:');
        console.log('[OllamaService] 1. Visit https://ollama.com/download/linux');
        console.log('[OllamaService] 2. Follow the official installation instructions');
        console.log('[OllamaService] 3. Or use your package manager if available');
        throw new Error('Manual installation required on Linux. Please visit https://ollama.com/download/linux');
    }

    async saveCheckpoint(name) {
        this.installCheckpoints.push({
            name,
            timestamp: Date.now(),
            state: { ...this.installState }
        });
    }

    async rollbackToLastCheckpoint() {
        const checkpoint = this.installCheckpoints.pop();
        if (checkpoint) {
            console.log(`[OllamaService] Rolling back to checkpoint: ${checkpoint.name}`);
            await this._executeRollback(checkpoint);
        }
    }

    async _executeRollback(checkpoint) {
        const platform = this.getPlatform();
        
        if (platform === 'darwin' && checkpoint.name === 'post-install') {
            await fs.rm('/Applications/Ollama.app', { recursive: true, force: true }).catch(() => {});
        } else if (platform === 'win32') {
            // TODO: Windows rollback (uninstaller / registry) is not implemented.
        }
        
        this.installState = checkpoint.state;
    }

    async syncState() {
        if (this.isShuttingDown) {
            console.log('[OllamaService] Service is shutting down, skipping state sync');
            return this.installState;
        }
        
        try {
            const isInstalled = await this.isInstalled();
            const isRunning = await this.isServiceRunning();
            const models = isRunning && !this.isShuttingDown ? await this.getInstalledModels() : [];
            const loadedModels = isRunning && !this.isShuttingDown ? await this.getLoadedModels() : [];

            this.installState.isInstalled = isInstalled;
            this.installState.isRunning = isRunning;
            this.installState.lastSync = Date.now();

            const previousLoadedModels = this._lastLoadedModels || [];
            const loadedChanged = loadedModels.length !== previousLoadedModels.length || 
                               !loadedModels.every(m => previousLoadedModels.includes(m));
            
            if (loadedChanged) {
                console.log(`[OllamaService] Loaded models changed: ${loadedModels.join(', ')}`);
                this._lastLoadedModels = loadedModels;

                // Ollama evicts idle models; an unloaded model is cold again.
                for (const modelName of this.warmedModels) {
                    if (!loadedModels.includes(modelName)) {
                        this.warmedModels.delete(modelName);
                        console.log(`[OllamaService] Model ${modelName} unloaded from memory, removing warmed state`);
                    }
                }
            }

            if (isRunning && models.length > 0) {
                for (const model of models) {
                    try {
                        const isLoaded = loadedModels.includes(model.name);
                        // Only "installed" is persisted; "loaded" is tracked in memory.
                        await ollamaModelRepository.updateInstallStatus(model.name, true, false);

                        if (!this.modelLoadStatus) {
                            this.modelLoadStatus = new Map();
                        }
                        this.modelLoadStatus.set(model.name, isLoaded);
                    } catch (dbError) {
                        console.warn(`[OllamaService] Failed to update DB for model ${model.name}:`, dbError);
                    }
                }

                // Forget models Ollama no longer has. Guarded by models.length > 0
                // on purpose: getInstalledModels() returns [] on a failed request
                // too, so pruning on [] would wipe the table whenever Ollama is
                // briefly unreachable.
                try {
                    const pruned = ollamaModelRepository.pruneMissingModels(models.map(m => m.name));
                    if (pruned.changes > 0) {
                        console.log(`[OllamaService] Removed ${pruned.changes} stale model row(s) from DB`);
                    }
                } catch (dbError) {
                    console.warn('[OllamaService] Failed to prune stale models from DB:', dbError);
                }
            }

            if (this._lastState?.isRunning !== isRunning ||
                this._lastState?.isInstalled !== isInstalled ||
                loadedChanged) {
                this.emit('state-changed', {
                    installed: isInstalled,
                    running: isRunning,
                    models: models.length,
                    loadedModels: loadedModels
                });
            }
            
            this._lastState = { isInstalled, isRunning, modelsCount: models.length };
            return { isInstalled, isRunning, models };
            
        } catch (error) {
            console.error('[OllamaService] State sync failed:', error);
            return { 
                isInstalled: this.installState.isInstalled || false,
                isRunning: false,
                models: []
            };
        }
    }

    startPeriodicSync() {
        if (this._syncInterval) return;

        this._syncInterval = setInterval(() => {
            this.syncState();
        }, 30000);
    }

    stopPeriodicSync() {
        if (this._syncInterval) {
            clearInterval(this._syncInterval);
            this._syncInterval = null;
        }
    }

    async warmUpModel(modelName, forceRefresh = false) {
        if (!modelName?.trim()) {
            console.warn(`[OllamaService] Invalid model name for warm-up`);
            return false;
        }

        if (!forceRefresh && this.warmedModels.has(modelName)) {
            console.log(`[OllamaService] Model ${modelName} already warmed up, skipping`);
            return true;
        }

        if (this.warmingModels.has(modelName)) {
            console.log(`[OllamaService] Model ${modelName} is already warming up, joining existing operation`);
            return await this.warmingModels.get(modelName);
        }

        const lastAttempt = this.lastWarmUpAttempt.get(modelName);
        const now = Date.now();
        if (lastAttempt && (now - lastAttempt) < 5000) { // 5 second cooldown
            console.log(`[OllamaService] Rate limiting warm-up for ${modelName}, try again in ${5 - Math.floor((now - lastAttempt) / 1000)}s`);
            return false;
        }

        const warmingPromise = this._performWarmUp(modelName);
        this.warmingModels.set(modelName, warmingPromise);
        this.lastWarmUpAttempt.set(modelName, now);

        try {
            const result = await warmingPromise;
            
            if (result) {
                this.warmedModels.add(modelName);
                console.log(`[OllamaService] Model ${modelName} successfully warmed up`);
            }
            
            return result;
        } finally {
            this.warmingModels.delete(modelName);
        }
    }

    async _performWarmUp(modelName) {
        console.log(`[OllamaService] Starting warm-up for model: ${modelName}`);
        
        try {
            const response = await this.makeRequest('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // A cold model load can take longer than an API call.
                timeout: this.warmupTimeout,
                body: JSON.stringify({
                    model: modelName,
                    messages: [{ role: 'user', content: 'Hi' }],
                    stream: false,
                    // Loads the model with the context length every later request uses.
                    options: { num_predict: 1, temperature: 0, num_ctx: NUM_CTX },
                }),
            });
            // Without this a 404/500 would count as warmed.
            if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            return true;
        } catch (error) {
            // A missing model is not pulled here: that is a multi-GB download the user starts in Settings.
            console.error(`[OllamaService] Failed to warm up model ${modelName}:`, error.message);
            return false;
        }
    }

    async autoWarmUpSelectedModel() {
        try {
            const modelStateService = global.modelStateService;
            if (!modelStateService) {
                console.log('[OllamaService] ModelStateService not available for auto warm-up');
                return false;
            }

            const selectedModels = await modelStateService.getSelectedModels();
            const llmModelId = selectedModels.llm;

            const provider = modelStateService.getProviderForModel('llm', llmModelId);
            if (provider !== 'ollama') {
                console.log('[OllamaService] Selected LLM is not Ollama, skipping warm-up');
                return false;
            }

            const isRunning = await this.isServiceRunning();
            if (!isRunning) {
                console.log('[OllamaService] Ollama service not running, clearing warm-up cache');
                this._clearWarmUpCache();
                return false;
            }

            console.log(`[OllamaService] Auto-warming up selected model: ${llmModelId} (will auto-install if needed)`);
            const result = await this.warmUpModel(llmModelId);

            if (result) {
                this.emit('model-warmed-up', { model: llmModelId });
            }
            
            return result;
            
        } catch (error) {
            console.error('[OllamaService] Auto warm-up failed:', error);
            return false;
        }
    }

    _clearWarmUpCache() {
        this.warmedModels.clear();
        this.warmingModels.clear();
        this.lastWarmUpAttempt.clear();
        console.log('[OllamaService] Warm-up cache cleared');
    }

    async getWarmUpStatus() {
        const loadedModels = await this.getLoadedModels();
        
        return {
            warmedModels: Array.from(this.warmedModels),
            warmingModels: Array.from(this.warmingModels.keys()),
            loadedModels: loadedModels,
            lastAttempts: Object.fromEntries(this.lastWarmUpAttempt)
        };
    }

    async shutdown(force = false) {
        console.log(`[OllamaService] Shutdown initiated (force: ${force})`);

        this.isShuttingDown = true;
        
        if (!force && this.warmingModels.size > 0) {
            const warmingList = Array.from(this.warmingModels.keys());
            console.log(`[OllamaService] Waiting for ${warmingList.length} models to finish warming: ${warmingList.join(', ')}`);
            
            const warmingPromises = Array.from(this.warmingModels.values());
            try {
                const results = await Promise.allSettled(warmingPromises);
                const completed = results.filter(r => r.status === 'fulfilled').length;
                console.log(`[OllamaService] ${completed}/${results.length} warming operations completed`);
            } catch (error) {
                console.log('[OllamaService] Error waiting for warm-up completion, proceeding with shutdown');
            }
        }

        this._clearWarmUpCache();
        this.stopPeriodicSync();

        const isRunning = await this.isServiceRunning();
        if (!isRunning) {
            console.log('[OllamaService] Service not running, nothing to shutdown');
            return true;
        }

        const platform = this.getPlatform();
        
        try {
            switch(platform) {
                case 'darwin':
                    return await this.shutdownMacOS(force);
                case 'win32':
                    return await this.shutdownWindows(force);
                case 'linux':
                    return await this.shutdownLinux(force);
                default:
                    console.warn(`[OllamaService] Unsupported platform for shutdown: ${platform}`);
                    return false;
            }
        } catch (error) {
            console.error(`[OllamaService] Error during shutdown:`, error);
            return false;
        }
    }

    async shutdownMacOS(force) {
        try {
            console.log('[OllamaService] Killing ollama server process...');
            try {
                await spawnAsync('pkill', ['-f', 'ollama serve']);
            } catch (e) {
                // Process might not be running
            }

            console.log('[OllamaService] Quitting Ollama.app...');
            try {
                await spawnAsync('osascript', ['-e', 'tell application "Ollama" to quit']);
            } catch (e) {
                console.log('[OllamaService] Ollama.app might not be running');
            }

            await new Promise(resolve => setTimeout(resolve, 2000));

            if (force || await this.isServiceRunning()) {
                console.log('[OllamaService] Force killing any remaining ollama processes...');
                try {
                    await spawnAsync('pkill', ['-9', '-f', 'ollama']);
                } catch (e) {
                    // Process might not exist
                }
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
            const stillRunning = await this.isServiceRunning();
            if (stillRunning) {
                console.warn('[OllamaService] Warning: Ollama may still be running');
                return false;
            }
            
            console.log('[OllamaService] Ollama shutdown complete');
            return true;
        } catch (error) {
            console.error('[OllamaService] Shutdown error:', error);
            return false;
        }
    }

    async shutdownWindows(force) {
        try {
            await spawnAsync('taskkill', ['/IM', 'ollama.exe', '/T']);
            console.log('[OllamaService] Ollama process terminated on Windows');
            return true;
        } catch (error) {
            console.log('[OllamaService] Standard termination failed, trying force kill');
            try {
                await spawnAsync('taskkill', ['/IM', 'ollama.exe', '/F', '/T']);
                return true;
            } catch (killError) {
                console.error('[OllamaService] Failed to force kill Ollama on Windows:', killError);
                return false;
            }
        }
    }

    async shutdownLinux(force) {
        try {
            await spawnAsync('pkill', ['-f', this.getOllamaCliPath()]);
            console.log('[OllamaService] Ollama process terminated on Linux');
            return true;
        } catch (error) {
            if (force) {
                await spawnAsync('pkill', ['-9', '-f', this.getOllamaCliPath()]).catch(() => {});
            }
            console.error('[OllamaService] Failed to shutdown Ollama on Linux:', error);
            return false;
        }
    }

    async getAllModelsWithStatus() {
        const installedModels = await this.getInstalledModels();

        const loadedModels = await this.getLoadedModels();
        
        const models = [];
        for (const model of installedModels) {
            const isWarmingUp = this.warmingModels.has(model.name);
            const isWarmedUp = this.warmedModels.has(model.name);
            const isLoaded = loadedModels.includes(model.name);
            
            models.push({
                name: model.name,
                displayName: model.name,
                size: model.size || 'Unknown',
                description: `Ollama model: ${model.name}`,
                installed: true,
                installing: this.installationProgress.has(model.name),
                progress: this.getInstallProgress(model.name),
                warmedUp: isWarmedUp,
                isWarmingUp,
                isLoaded,
                status: isWarmingUp ? 'warming' : (isLoaded ? 'loaded' : (isWarmedUp ? 'ready' : 'cold'))
            });
        }

        // Models still being pulled aren't in /api/tags yet.
        for (const [modelName, progress] of this.installationProgress) {
            if (!models.find(m => m.name === modelName)) {
                models.push({
                    name: modelName,
                    displayName: modelName,
                    size: 'Unknown',
                    description: `Ollama model: ${modelName}`,
                    installed: false,
                    installing: true,
                    progress: progress
                });
            }
        }
        
        return models;
    }

    async handleGetStatus() {
        try {
            const installed = await this.isInstalled();
            if (!installed) {
                return { success: true, installed: false, running: false, models: [] };
            }

            const running = await this.isServiceRunning();
            if (!running) {
                return { success: true, installed: true, running: false, models: [] };
            }

            const models = await this.getAllModelsWithStatus();
            return { success: true, installed: true, running: true, models };
        } catch (error) {
            console.error('[OllamaService] Error getting status:', error);
            return { success: false, error: error.message, installed: false, running: false, models: [] };
        }
    }

    async handleInstall() {
        try {
            const onProgress = (data) => {
                this.emit('install-progress', data);
            };

            await this.autoInstall(onProgress);

            onProgress({ stage: 'verifying', message: 'Verifying installation...', progress: 0 });
            const verifyResult = await this.verifyInstallation();
            if (!verifyResult.success) {
                throw new Error(`Installation verification failed: ${verifyResult.error}`);
            }
            onProgress({ stage: 'verifying', message: 'Installation verified.', progress: 100 });

            if (!await this.isServiceRunning()) {
                onProgress({ stage: 'starting', message: 'Starting Ollama service...', progress: 0 });
                await this.startService();
                onProgress({ stage: 'starting', message: 'Ollama service started.', progress: 100 });
            }
            
            this.installState.isInstalled = true;
            this.emit('installation-complete');
            return { success: true };
        } catch (error) {
            console.error('[OllamaService] Failed to install:', error);
            await this.rollbackToLastCheckpoint();
            this.emit('error', {
                errorType: 'installation-failed',
                error: error.message
            });
            return { success: false, error: error.message };
        }
    }

    async handleStartService() {
        try {
            if (!await this.isServiceRunning()) {
                console.log('[OllamaService] Starting Ollama service...');
                await this.startService();
            }
            this.emit('install-complete', { success: true });
            return { success: true };
        } catch (error) {
            console.error('[OllamaService] Failed to start service:', error);
            this.emit('install-complete', { success: false, error: error.message });
            return { success: false, error: error.message };
        }
    }

    async handleEnsureReady() {
        try {
            if (await this.isInstalled() && !await this.isServiceRunning()) {
                console.log('[OllamaService] Ollama installed but not running, starting service...');
                await this.startService();
            }
            return { success: true };
        } catch (error) {
            console.error('[OllamaService] Failed to ensure ready:', error);
            return { success: false, error: error.message };
        }
    }

    async handleGetModels() {
        try {
            const models = await this.getAllModelsWithStatus();
            return { success: true, models };
        } catch (error) {
            console.error('[OllamaService] Failed to get models:', error);
            return { success: false, error: error.message };
        }
    }

    async handleGetModelSuggestions() {
        try {
            const suggestions = await this.getModelSuggestions();
            return { success: true, suggestions };
        } catch (error) {
            console.error('[OllamaService] Failed to get model suggestions:', error);
            return { success: false, error: error.message };
        }
    }

    async handlePullModel(modelName) {
        try {
            console.log(`[OllamaService] Starting model pull: ${modelName}`);

            await ollamaModelRepository.updateInstallStatus(modelName, false, true);

            await this.pullModel(modelName);

            await ollamaModelRepository.updateInstallStatus(modelName, true, false);

            console.log(`[OllamaService] Model ${modelName} pull successful`);
            return { success: true };
        } catch (error) {
            console.error('[OllamaService] Failed to pull model:', error);
            await ollamaModelRepository.updateInstallStatus(modelName, false, false);
            this.emit('error', {
                errorType: 'model-pull-failed',
                model: modelName, 
                error: error.message 
            });
            return { success: false, error: error.message };
        }
    }

    async handleIsModelInstalled(modelName) {
        try {
            const installed = await this.isModelInstalled(modelName);
            return { success: true, installed };
        } catch (error) {
            console.error('[OllamaService] Failed to check model installation:', error);
            return { success: false, error: error.message };
        }
    }

    async handleWarmUpModel(modelName) {
        try {
            const success = await this.warmUpModel(modelName);
            return { success };
        } catch (error) {
            console.error('[OllamaService] Failed to warm up model:', error);
            return { success: false, error: error.message };
        }
    }

    async handleAutoWarmUp() {
        try {
            const success = await this.autoWarmUpSelectedModel();
            return { success };
        } catch (error) {
            console.error('[OllamaService] Failed to auto warm-up:', error);
            return { success: false, error: error.message };
        }
    }

    async handleGetWarmUpStatus() {
        try {
            const status = await this.getWarmUpStatus();
            return { success: true, status };
        } catch (error) {
            console.error('[OllamaService] Failed to get warm-up status:', error);
            return { success: false, error: error.message };
        }
    }

    async handleShutdown(force = false) {
        try {
            console.log(`[OllamaService] Manual shutdown requested (force: ${force})`);
            const success = await this.shutdown(force);

            if (success) {
                // Reset before syncState(), which is a no-op while shutting down.
                this.isShuttingDown = false;
                await this.syncState();
            }
            
            return { success };
        } catch (error) {
            console.error('[OllamaService] Failed to shutdown Ollama:', error);
            return { success: false, error: error.message };
        }
    }

    async verifyInstallation() {
        try {
            console.log('[OllamaService] Verifying installation...');

            const isInstalled = await this.isInstalled();
            if (!isInstalled) {
                return { success: false, error: 'Ollama binary not found' };
            }

            try {
                const { stdout } = await spawnAsync(this.getOllamaCliPath(), ['--version']);
                console.log('[OllamaService] Ollama version:', stdout.trim());
            } catch (error) {
                return { success: false, error: 'Ollama CLI not responding' };
            }

            const platform = this.getPlatform();
            if (platform === 'darwin') {
                try {
                    await fs.access('/Applications/Ollama.app/Contents/MacOS/Ollama');
                } catch (error) {
                    return { success: false, error: 'Ollama.app executable not found' };
                }
            }
            
            console.log('[OllamaService] Installation verified successfully');
            return { success: true };
            
        } catch (error) {
            console.error('[OllamaService] Verification failed:', error);
            return { success: false, error: error.message };
        }
    }
}

const ollamaService = new OllamaService();
module.exports = ollamaService;