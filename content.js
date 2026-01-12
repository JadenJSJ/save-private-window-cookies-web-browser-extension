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

    // Get all Cache API data
    async function getCacheData() {
        const caches_data = [];

        try {
            if ('caches' in window) {
                const cacheNames = await caches.keys();

                for (const cacheName of cacheNames) {
                    const cache = await caches.open(cacheName);
                    const requests = await cache.keys();
                    const entries = [];

                    for (const request of requests) {
                        const response = await cache.match(request);
                        if (response) {
                            // Serialize the response
                            const headers = {};
                            response.headers.forEach((value, key) => {
                                headers[key] = value;
                            });

                            let body = null;
                            try {
                                // Try to get body as text (works for most web content)
                                body = await response.clone().text();
                            } catch (e) {
                                // If text fails, try as base64
                                try {
                                    const buffer = await response.clone().arrayBuffer();
                                    body = btoa(String.fromCharCode(...new Uint8Array(buffer)));
                                } catch (e2) {
                                    console.error('Failed to serialize response body:', e2);
                                }
                            }

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

                    caches_data.push({
                        name: cacheName,
                        entries: entries
                    });
                }
            }
        } catch (e) {
            console.error('Failed to read Cache API:', e);
        }

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

                // Only include cache if requested
                if (message.includeCache) {
                    data.cacheStorage = await getCacheData();
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
    // Use reliable browser events instead of method interception

    let autoSaveEnabled = false;

    // Immediately save current storage data
    async function saveCurrentStorage() {
        if (!autoSaveEnabled) return;

        try {
            const settings = await chrome.storage.local.get(['save_localStorage', 'save_indexedDB', 'save_cacheAPI']);

            const data = {
                origin: window.location.origin,
                localStorage: settings.save_localStorage !== false ? getLocalStorage() : null,
                indexedDB: settings.save_indexedDB !== false ? await getIndexedDBData() : null
            };

            if (settings.save_cacheAPI) {
                data.cacheStorage = await getCacheData();
            }

            // Send to background for saving
            await chrome.runtime.sendMessage({
                action: 'saveOriginData',
                data: data
            });
        } catch (e) {
            // Extension context might be invalidated
            console.log('Auto-save failed:', e);
        }
    }

    // Save when page visibility changes (user switches to another tab)
    function onVisibilityChange() {
        if (document.visibilityState === 'hidden' && autoSaveEnabled) {
            saveCurrentStorage();
        }
    }

    // Save before page unloads (user navigates away or closes tab)
    function onBeforeUnload() {
        if (autoSaveEnabled) {
            // Use sendMessage - it's async but the browser usually allows it
            saveCurrentStorage();
        }
    }

    // Save when page finishes loading (to capture initial state)
    function onPageLoad() {
        if (autoSaveEnabled && document.readyState === 'complete') {
            // Small delay to let the page finish initializing storage
            setTimeout(saveCurrentStorage, 1000);
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
            setTimeout(saveCurrentStorage, 2000);
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
