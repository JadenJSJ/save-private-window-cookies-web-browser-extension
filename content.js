// Content script for accessing per-origin storage
// This runs in the context of each web page

(function () {
    'use strict';

    // Get all localStorage data
    function getLocalStorage() {
        const data = {};
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                data[key] = localStorage.getItem(key);
            }
        } catch (e) {
            console.error('Failed to read localStorage:', e);
        }
        return data;
    }

    // Set localStorage data
    function setLocalStorage(data) {
        try {
            for (const [key, value] of Object.entries(data)) {
                localStorage.setItem(key, value);
            }
        } catch (e) {
            console.error('Failed to write localStorage:', e);
        }
    }

    // Clear localStorage
    function clearLocalStorage() {
        try {
            localStorage.clear();
        } catch (e) {
            console.error('Failed to clear localStorage:', e);
        }
    }

    // Get all IndexedDB databases and their data
    async function getIndexedDBData() {
        const databases = [];

        try {
            // Get list of databases (modern browsers)
            if (indexedDB.databases) {
                const dbList = await indexedDB.databases();

                for (const dbInfo of dbList) {
                    const dbData = await extractDatabaseData(dbInfo.name, dbInfo.version);
                    if (dbData) {
                        databases.push(dbData);
                    }
                }
            }
        } catch (e) {
            console.error('Failed to enumerate IndexedDB databases:', e);
        }

        return databases;
    }

    // Extract all data from a single database
    function extractDatabaseData(dbName, dbVersion) {
        return new Promise((resolve) => {
            try {
                const request = indexedDB.open(dbName);

                request.onerror = () => {
                    console.error('Failed to open database:', dbName);
                    resolve(null);
                };

                request.onsuccess = async (event) => {
                    const db = event.target.result;
                    const dbData = {
                        name: dbName,
                        version: db.version,
                        objectStores: []
                    };

                    const storeNames = Array.from(db.objectStoreNames);

                    for (const storeName of storeNames) {
                        try {
                            const storeData = await extractObjectStoreData(db, storeName);
                            dbData.objectStores.push(storeData);
                        } catch (e) {
                            console.error('Failed to extract store:', storeName, e);
                        }
                    }

                    db.close();
                    resolve(dbData);
                };
            } catch (e) {
                console.error('Failed to extract database:', dbName, e);
                resolve(null);
            }
        });
    }

    // Extract all data from an object store
    function extractObjectStoreData(db, storeName) {
        return new Promise((resolve, reject) => {
            try {
                const transaction = db.transaction(storeName, 'readonly');
                const store = transaction.objectStore(storeName);

                const storeData = {
                    name: storeName,
                    keyPath: store.keyPath,
                    autoIncrement: store.autoIncrement,
                    indexes: [],
                    data: []
                };

                // Get index definitions
                for (const indexName of store.indexNames) {
                    const index = store.index(indexName);
                    storeData.indexes.push({
                        name: index.name,
                        keyPath: index.keyPath,
                        unique: index.unique,
                        multiEntry: index.multiEntry
                    });
                }

                // Get all records
                const request = store.getAll();
                const keyRequest = store.getAllKeys();

                let records = null;
                let keys = null;

                request.onsuccess = () => {
                    records = request.result;
                    if (keys !== null) {
                        storeData.data = records.map((record, i) => ({ key: keys[i], value: record }));
                        resolve(storeData);
                    }
                };

                keyRequest.onsuccess = () => {
                    keys = keyRequest.result;
                    if (records !== null) {
                        storeData.data = records.map((record, i) => ({ key: keys[i], value: record }));
                        resolve(storeData);
                    }
                };

                request.onerror = () => reject(request.error);
                keyRequest.onerror = () => reject(keyRequest.error);
            } catch (e) {
                reject(e);
            }
        });
    }

    // Restore IndexedDB data
    async function setIndexedDBData(databases) {
        for (const dbData of databases) {
            try {
                await restoreDatabase(dbData);
            } catch (e) {
                console.error('Failed to restore database:', dbData.name, e);
            }
        }
    }

    // Restore a single database
    function restoreDatabase(dbData) {
        return new Promise((resolve, reject) => {
            // First, delete the existing database
            const deleteRequest = indexedDB.deleteDatabase(dbData.name);

            deleteRequest.onsuccess = () => {
                // Create the database with the correct version
                const request = indexedDB.open(dbData.name, dbData.version);

                request.onupgradeneeded = (event) => {
                    const db = event.target.result;

                    // Create object stores
                    for (const storeData of dbData.objectStores) {
                        const storeOptions = {};
                        if (storeData.keyPath !== null) {
                            storeOptions.keyPath = storeData.keyPath;
                        }
                        storeOptions.autoIncrement = storeData.autoIncrement;

                        const store = db.createObjectStore(storeData.name, storeOptions);

                        // Create indexes
                        for (const indexData of storeData.indexes) {
                            store.createIndex(indexData.name, indexData.keyPath, {
                                unique: indexData.unique,
                                multiEntry: indexData.multiEntry
                            });
                        }
                    }
                };

                request.onsuccess = async (event) => {
                    const db = event.target.result;

                    // Populate data
                    for (const storeData of dbData.objectStores) {
                        if (storeData.data.length > 0) {
                            try {
                                await populateObjectStore(db, storeData);
                            } catch (e) {
                                console.error('Failed to populate store:', storeData.name, e);
                            }
                        }
                    }

                    db.close();
                    resolve();
                };

                request.onerror = () => reject(request.error);
            };

            deleteRequest.onerror = () => reject(deleteRequest.error);
        });
    }

    // Populate an object store with data
    function populateObjectStore(db, storeData) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeData.name, 'readwrite');
            const store = transaction.objectStore(storeData.name);

            for (const record of storeData.data) {
                if (storeData.keyPath === null) {
                    store.put(record.value, record.key);
                } else {
                    store.put(record.value);
                }
            }

            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    }

    // Clear all IndexedDB databases
    async function clearIndexedDB() {
        try {
            if (indexedDB.databases) {
                const dbList = await indexedDB.databases();
                for (const dbInfo of dbList) {
                    indexedDB.deleteDatabase(dbInfo.name);
                }
            }
        } catch (e) {
            console.error('Failed to clear IndexedDB:', e);
        }
    }

    // Get all Cache API data with size limit
    async function getCacheData(maxSizeMB = 50) {
        const MB = 1024 * 1024;
        const maxBytes = maxSizeMB * MB;
        const MAX_SINGLE_ENTRY_MB = 5; // Skip individual entries larger than 5MB
        const caches_data = [];
        let totalSize = 0;

        // Memory-safe chunked Base64 encoding
        function arrayBufferToBase64(buffer) {
            const bytes = new Uint8Array(buffer);
            const chunkSize = 65536; // Process in 64KB chunks
            let binary = '';

            for (let i = 0; i < bytes.length; i += chunkSize) {
                const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
                binary += String.fromCharCode.apply(null, chunk);
            }

            return btoa(binary);
        }

        try {
            if ('caches' in window) {
                const cacheNames = await caches.keys();

                for (const cacheName of cacheNames) {
                    // Stop if we've exceeded the limit
                    if (totalSize >= maxBytes) {
                        console.warn(`Cache size limit reached (${maxSizeMB} MB), stopping cache collection`);
                        break;
                    }

                    const cache = await caches.open(cacheName);
                    const requests = await cache.keys();
                    const entries = [];
                    let cacheSize = 0;

                    for (const request of requests) {
                        // Check if we've exceeded the total limit
                        if (totalSize + cacheSize >= maxBytes) {
                            console.warn(`Cache size limit reached during ${cacheName}, skipping remaining entries`);
                            break;
                        }

                        const response = await cache.match(request);
                        if (response) {
                            // Estimate response size before processing
                            const contentLength = response.headers.get('content-length');
                            const estimatedSize = contentLength ? parseInt(contentLength) : 0;

                            // Skip large individual responses
                            if (estimatedSize > MAX_SINGLE_ENTRY_MB * MB) {
                                console.log(`Skipping large cache entry: ${request.url} (${(estimatedSize / MB).toFixed(1)} MB)`);
                                continue;
                            }

                            // Serialize the response
                            const headers = {};
                            response.headers.forEach((value, key) => {
                                headers[key] = value;
                            });

                            let body = null;
                            let bodySize = 0;
                            try {
                                // Try to get body as text (works for most web content)
                                body = await response.clone().text();
                                bodySize = body.length;

                                // Double-check size after getting actual content
                                if (bodySize > MAX_SINGLE_ENTRY_MB * MB) {
                                    console.log(`Skipping large text response: ${request.url} (${(bodySize / MB).toFixed(1)} MB)`);
                                    continue;
                                }
                            } catch (e) {
                                // If text fails, try as base64 with chunked encoding
                                try {
                                    const buffer = await response.clone().arrayBuffer();

                                    // Skip if too large
                                    if (buffer.byteLength > MAX_SINGLE_ENTRY_MB * MB) {
                                        console.log(`Skipping large binary response: ${request.url} (${(buffer.byteLength / MB).toFixed(1)} MB)`);
                                        continue;
                                    }

                                    body = arrayBufferToBase64(buffer);
                                    bodySize = body.length;
                                } catch (e2) {
                                    console.error('Failed to serialize response body:', e2);
                                    continue;
                                }
                            }

                            cacheSize += bodySize;
                            entries.push({
                                url: request.url,
                                response: {
                                    status: response.status,
                                    statusText: response.statusText,
                                    headers: headers,
                                    body: body,
                                    type: response.type
                                }
                            });
                        }
                    }

                    if (entries.length > 0) {
                        caches_data.push({
                            name: cacheName,
                            entries: entries,
                            sizeMB: (cacheSize / MB).toFixed(2)
                        });
                        totalSize += cacheSize;
                    }
                }
            }
        } catch (e) {
            console.error('Failed to read Cache API:', e);
        }

        console.log(`Cache collection complete: ${caches_data.length} caches, ${(totalSize / MB).toFixed(2)} MB total`);
        return caches_data;
    }

    // Restore Cache API data
    async function setCacheData(caches_data) {
        try {
            if ('caches' in window) {
                for (const cacheData of caches_data) {
                    const cache = await caches.open(cacheData.name);

                    for (const entry of cacheData.entries) {
                        try {
                            const response = new Response(entry.response.body, {
                                status: entry.response.status,
                                statusText: entry.response.statusText,
                                headers: entry.response.headers
                            });

                            await cache.put(entry.url, response);
                        } catch (e) {
                            console.error('Failed to restore cache entry:', entry.url, e);
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Failed to restore Cache API:', e);
        }
    }

    // Clear all caches
    async function clearCacheStorage() {
        try {
            if ('caches' in window) {
                const cacheNames = await caches.keys();
                for (const cacheName of cacheNames) {
                    await caches.delete(cacheName);
                }
            }
        } catch (e) {
            console.error('Failed to clear Cache API:', e);
        }
    }

    // Message handler
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'getStorageData') {
            // Collect all storage data for this origin
            (async () => {
                const data = {
                    origin: window.location.origin,
                    localStorage: getLocalStorage(),
                    indexedDB: await getIndexedDBData()
                };

                // Only include cache if requested, with user's size limit
                if (message.includeCache) {
                    const cacheSizeLimit = message.cacheSizeLimit || 50;
                    data.cacheStorage = await getCacheData(cacheSizeLimit);
                }

                sendResponse(data);
            })();

            return true; // Keep channel open for async response
        }

        if (message.action === 'setStorageData') {
            // Restore storage data for this origin
            (async () => {
                const data = message.data;

                if (message.clearFirst) {
                    clearLocalStorage();
                    await clearIndexedDB();
                    if (message.includeCache) {
                        await clearCacheStorage();
                    }
                }

                if (data.localStorage) {
                    setLocalStorage(data.localStorage);
                }

                if (data.indexedDB) {
                    await setIndexedDBData(data.indexedDB);
                }

                if (message.includeCache && data.cacheStorage) {
                    await setCacheData(data.cacheStorage);
                }

                sendResponse({ success: true });
            })();

            return true;
        }

        if (message.action === 'clearStorageData') {
            (async () => {
                clearLocalStorage();
                await clearIndexedDB();
                if (message.includeCache) {
                    await clearCacheStorage();
                }
                sendResponse({ success: true });
            })();

            return true;
        }

        if (message.action === 'startAutoSaveListeners') {
            startAutoSaveListeners();
            sendResponse({ success: true });
        }

        if (message.action === 'stopAutoSaveListeners') {
            stopAutoSaveListeners();
            sendResponse({ success: true });
        }
    });

    // ========== Auto-save Detection ==========
    // Use reliable browser events with debouncing to prevent CPU spikes

    let autoSaveEnabled = false;
    let saveDebounceTimer = null;
    let lastSaveTime = 0;
    const SAVE_DEBOUNCE_MS = 5000; // Minimum 5 seconds between saves

    // Immediately save current storage data
    async function saveCurrentStorage() {
        if (!autoSaveEnabled) return;

        try {
            const settings = await chrome.storage.local.get(['save_localStorage', 'save_indexedDB', 'save_cacheAPI', 'cache_size_limit_mb']);

            const data = {
                origin: window.location.origin,
                localStorage: settings.save_localStorage !== false ? getLocalStorage() : null,
                indexedDB: settings.save_indexedDB !== false ? await getIndexedDBData() : null
            };

            if (settings.save_cacheAPI) {
                const cacheSizeLimit = settings.cache_size_limit_mb || 50;
                data.cacheStorage = await getCacheData(cacheSizeLimit);
            }

            // Send to background for saving
            await chrome.runtime.sendMessage({
                action: 'saveOriginData',
                data: data
            });

            lastSaveTime = Date.now();
        } catch (e) {
            // Extension context might be invalidated
            console.log('Auto-save failed:', e);
        }
    }

    // Debounced save function to prevent rapid-fire saves
    function debouncedSave() {
        const now = Date.now();
        const timeSinceLastSave = now - lastSaveTime;

        // Clear any existing timer
        if (saveDebounceTimer) {
            clearTimeout(saveDebounceTimer);
            saveDebounceTimer = null;
        }

        // If it's been long enough since last save, schedule a save
        if (timeSinceLastSave >= SAVE_DEBOUNCE_MS) {
            // Schedule save after a short delay to batch rapid events
            saveDebounceTimer = setTimeout(saveCurrentStorage, 1000);
        } else {
            // Schedule save for when the debounce period ends
            const timeUntilNextSave = SAVE_DEBOUNCE_MS - timeSinceLastSave;
            saveDebounceTimer = setTimeout(saveCurrentStorage, timeUntilNextSave);
        }
    }

    // Save when page visibility changes (user switches to another tab)
    function onVisibilityChange() {
        if (document.visibilityState === 'hidden' && autoSaveEnabled) {
            debouncedSave();
        }
    }

    // Save before page unloads (user navigates away or closes tab)
    function onBeforeUnload() {
        if (autoSaveEnabled) {
            // Use immediate save for unload events (browser may not wait for setTimeout)
            saveCurrentStorage();
        }
    }

    // Save when page finishes loading (to capture initial state)
    function onPageLoad() {
        if (autoSaveEnabled && document.readyState === 'complete') {
            // Longer delay to let the page finish initializing storage
            setTimeout(debouncedSave, 3000);
        }
    }

    function startAutoSaveListeners() {
        if (autoSaveEnabled) return; // Already enabled
        autoSaveEnabled = true;

        document.addEventListener('visibilitychange', onVisibilityChange);
        window.addEventListener('beforeunload', onBeforeUnload);
        window.addEventListener('pagehide', onBeforeUnload);

        // If page is already loaded, save after a delay
        if (document.readyState === 'complete') {
            setTimeout(debouncedSave, 3000);
        } else {
            window.addEventListener('load', onPageLoad);
        }
    }

    function stopAutoSaveListeners() {
        autoSaveEnabled = false;
        document.removeEventListener('visibilitychange', onVisibilityChange);
        window.removeEventListener('beforeunload', onBeforeUnload);
        window.removeEventListener('pagehide', onBeforeUnload);
        window.removeEventListener('load', onPageLoad);
    }

    // Check if auto-save should be enabled on load
    chrome.storage.local.get(['auto_save', 'extension_enabled']).then((settings) => {
        if (settings.auto_save && settings.extension_enabled) {
            startAutoSaveListeners();
        }
    }).catch(() => {
        // Extension context might not be available
    });

    // Listen for settings changes
    chrome.storage.onChanged.addListener((changes) => {
        if (changes.auto_save || changes.extension_enabled) {
            chrome.storage.local.get(['auto_save', 'extension_enabled']).then((settings) => {
                if (settings.auto_save && settings.extension_enabled) {
                    startAutoSaveListeners();
                } else {
                    stopAutoSaveListeners();
                }
            }).catch(() => { });
        }
    });
})();
