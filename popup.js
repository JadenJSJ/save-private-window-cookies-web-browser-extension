// Popup script for the browser extension
// Uses shared utilities from utils.js (loaded before this script)

var objectURL, downloadID;

// ============ Cookie Functions ============

async function save_cookies_only() {
    let details = { storeId: cookie_store };

    if (isFirefox) {
        details.firstPartyDomain = null;
        details.partitionKey = {};
    }

    const cookies = await chrome.cookies.getAll(details);
    await chrome.storage.local.set({ cookies: cookies });
    return cookies;
}

// ============ Web Storage Functions ============

async function collectWebStorageFromTabs(settings) {
    const tabs = await getPrivateTabs();
    const webStorage = {};
    const includeCache = settings.save_cacheAPI;
    const cacheSizeLimit = settings.cache_size_limit_mb || 50;

    // Group tabs by origin to avoid duplicate collection
    const originTabs = {};
    for (const tab of tabs) {
        const origin = getOriginFromUrl(tab.url);
        if (origin && !originTabs[origin]) {
            originTabs[origin] = tab;
        }
    }

    // Parallel collection from all origins
    const originEntries = Object.entries(originTabs);
    const results = await Promise.allSettled(
        originEntries.map(async ([origin, tab]) => {
            try {
                const response = await chrome.tabs.sendMessage(tab.id, {
                    action: 'getStorageData',
                    includeCache: includeCache,
                    cacheSizeLimit: cacheSizeLimit
                });

                if (response && response.origin) {
                    const storageData = {};

                    if (settings.save_localStorage && response.localStorage && Object.keys(response.localStorage).length > 0) {
                        storageData.localStorage = response.localStorage;
                    }

                    if (settings.save_indexedDB && response.indexedDB && response.indexedDB.length > 0) {
                        storageData.indexedDB = response.indexedDB;
                    }

                    if (settings.save_cacheAPI && response.cacheStorage && response.cacheStorage.length > 0) {
                        storageData.cacheStorage = response.cacheStorage;
                    }

                    if (Object.keys(storageData).length > 0) {
                        return { origin, data: storageData };
                    }
                }
            } catch (e) {
                console.log('Could not collect from tab:', tab.url, e);
            }
            return null;
        })
    );

    // Build webStorage from results
    for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
            webStorage[result.value.origin] = result.value.data;
        }
    }

    return webStorage;
}

async function restoreWebStorageToTabs(clearFirst = true) {
    const stored = await chrome.storage.local.get(['webStorage', 'save_cacheAPI']);
    const webStorage = stored.webStorage || {};
    const includeCache = stored.save_cacheAPI || false;

    const tabs = await getPrivateTabs();

    // Parallel restoration
    await Promise.allSettled(
        tabs.map(async (tab) => {
            const origin = getOriginFromUrl(tab.url);
            if (origin && webStorage[origin]) {
                try {
                    await chrome.tabs.sendMessage(tab.id, {
                        action: 'setStorageData',
                        data: webStorage[origin],
                        clearFirst: clearFirst,
                        includeCache: includeCache
                    });
                } catch (e) {
                    console.log('Could not restore to tab:', tab.url, e);
                }
            }
        })
    );
}

async function clearWebStorageFromTabs() {
    const stored = await chrome.storage.local.get('save_cacheAPI');
    const includeCache = stored.save_cacheAPI || false;

    const tabs = await getPrivateTabs();

    // Parallel clearing
    await Promise.allSettled(
        tabs.map(async (tab) => {
            try {
                await chrome.tabs.sendMessage(tab.id, {
                    action: 'clearStorageData',
                    includeCache: includeCache
                });
            } catch (e) {
                console.log('Could not clear tab:', tab.url, e);
            }
        })
    );
}

// ============ Save All Data ============

async function saveAllData() {
    const settings = await chrome.storage.local.get(defaultSettings);

    if (!settings.extension_enabled) {
        return;
    }

    // Save cookies
    await save_cookies_only();

    // Save web storage from all private tabs
    const webStorage = await collectWebStorageFromTabs(settings);
    await chrome.storage.local.set({
        webStorage: webStorage,
        last_saved: Date.now()
    });

    update_storage_stats();
    update_last_saved();
}

async function restoreAllData() {
    const settings = await chrome.storage.local.get(defaultSettings);

    if (!settings.extension_enabled) {
        return;
    }

    // Restore cookies (uses parallel ops from utils.js)
    restore_cookies();

    // Restore web storage to tabs
    await restoreWebStorageToTabs(false);
}

// ============ UI Updates ============

async function update_warning() {
    const private_enabled = await chrome.extension.isAllowedIncognitoAccess();
    const access_enabled = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    let warning_html = '';

    if (!private_enabled && !access_enabled) {
        warning_html = '<strong>⚠️ Permissions Required</strong>Enable the extension in private windows and grant the "Access data for all websites" permission.';
    } else if (!private_enabled) {
        warning_html = '<strong>⚠️ Enable in Private Windows</strong>Enable the extension in private windows for this to work.';
    } else if (!access_enabled) {
        warning_html = '<strong>⚠️ Permission Required</strong>Grant the "Access data for all websites" permission.';
    }

    const warningEl = document.querySelector('#warning');
    if (warning_html) {
        warningEl.innerHTML = warning_html;
        warningEl.style.display = 'block';
    } else {
        warningEl.style.display = 'none';
    }

    update_button_states();
}

async function update_button_states() {
    const private_enabled = await chrome.extension.isAllowedIncognitoAccess();
    const access_enabled = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    const settings = await chrome.storage.local.get(defaultSettings);
    const private_window_open = await is_private_window_open();

    const canOperate = private_enabled && access_enabled && settings.extension_enabled;

    document.querySelector('#save').disabled = !canOperate || settings.auto_save || !private_window_open;
    document.querySelector('#restore_now').disabled = !canOperate || !private_window_open;
    document.querySelector('#auto_save').disabled = !canOperate;

    // Update status
    const statusDot = document.querySelector('#status_dot');
    const statusText = document.querySelector('#status_text');

    if (!settings.extension_enabled) {
        statusDot.classList.remove('active');
        statusText.textContent = 'Extension disabled';
    } else if (!private_window_open) {
        statusDot.classList.remove('active');
        statusText.textContent = 'No private window open';
    } else if (settings.auto_save) {
        statusDot.classList.add('active');
        statusText.textContent = 'Auto-saving enabled';
    } else {
        statusDot.classList.add('active');
        statusText.textContent = 'Private window active';
    }
}

async function update_storage_stats() {
    const stored = await chrome.storage.local.get(['cookies', 'webStorage']);

    let totalBytes = 0;
    let originCount = 0;

    // Calculate sizes (this is lightweight since we're just measuring what's already in memory)
    if (stored.cookies) {
        totalBytes += new TextEncoder().encode(JSON.stringify(stored.cookies)).length;
    }

    if (stored.webStorage) {
        totalBytes += new TextEncoder().encode(JSON.stringify(stored.webStorage)).length;
        originCount = Object.keys(stored.webStorage).length;
    }

    document.querySelector('#total_size').textContent = parseFloat((totalBytes / 1024).toFixed(2));
    document.querySelector('#origin_count').textContent = originCount;

    const hasData = totalBytes > 0;
    document.querySelector('#delete').disabled = !hasData;
    document.querySelector('#backup').disabled = !hasData;
}

// Debounced version of update_storage_stats for rapid changes
const debouncedUpdateStorageStats = debounce(update_storage_stats, 500);

function update_last_saved() {
    chrome.storage.local.get('last_saved').then((res) => {
        const lastSavedEl = document.querySelector('#last_saved');

        if (!res.last_saved) {
            lastSavedEl.textContent = 'Never saved in current session';
            lastSavedEl.classList.remove('recent');
            return;
        }

        const now = Date.now();
        const diff = now - res.last_saved;
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        let timeStr;
        if (seconds < 10) {
            timeStr = 'Just now';
            lastSavedEl.classList.add('recent');
        } else if (seconds < 60) {
            timeStr = `${seconds} seconds ago`;
            lastSavedEl.classList.add('recent');
        } else if (minutes < 60) {
            timeStr = `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
            lastSavedEl.classList.remove('recent');
        } else if (hours < 24) {
            timeStr = `${hours} hour${hours > 1 ? 's' : ''} ago`;
            lastSavedEl.classList.remove('recent');
        } else {
            timeStr = `${days} day${days > 1 ? 's' : ''} ago`;
            lastSavedEl.classList.remove('recent');
        }

        lastSavedEl.textContent = `Last saved: ${timeStr}`;
    });
}

// Update last saved display every 10 seconds
setInterval(update_last_saved, 10000);

// ============ Reconciliation Modal ============

function showReconcileModal() {
    document.querySelector('#reconcile_modal').classList.add('active');
}

function hideReconcileModal() {
    document.querySelector('#reconcile_modal').classList.remove('active');
}

// ============ Event Listeners ============

document.addEventListener('DOMContentLoaded', async () => {
    // Load settings
    const settings = await chrome.storage.local.get(defaultSettings);

    document.querySelector('#extension_enabled').checked = settings.extension_enabled;
    document.querySelector('#auto_save').checked = settings.auto_save;
    document.querySelector('#save_localStorage').checked = settings.save_localStorage;
    document.querySelector('#save_indexedDB').checked = settings.save_indexedDB;
    document.querySelector('#save_cacheAPI').checked = settings.save_cacheAPI;
    document.querySelector('#cache_size_limit').value = settings.cache_size_limit_mb || 50;

    // Show cache warning/limit if Cache API is enabled
    if (settings.save_cacheAPI) {
        document.querySelector('#cache_warning').style.display = 'block';
        document.querySelector('#cache_limit_section').style.display = 'block';
    }

    update_warning();
    update_storage_stats();
    update_last_saved();
});

// Extension enabled toggle
document.querySelector('#extension_enabled').addEventListener('change', async (event) => {
    const enabled = event.target.checked;

    if (enabled && await is_private_window_open()) {
        // Show reconciliation modal
        showReconcileModal();
    } else {
        await chrome.storage.local.set({ extension_enabled: enabled });
        update_button_states();

        // Notify background script
        chrome.runtime.sendMessage({ action: 'extensionToggled', enabled: enabled });
    }
});

// Reconciliation handlers
document.querySelector('#reconcile_save').addEventListener('click', async () => {
    hideReconcileModal();
    await chrome.storage.local.set({ extension_enabled: true });
    await saveAllData();
    update_button_states();
    chrome.runtime.sendMessage({ action: 'extensionToggled', enabled: true });
});

document.querySelector('#reconcile_restore').addEventListener('click', async () => {
    hideReconcileModal();
    await chrome.storage.local.set({ extension_enabled: true });
    await clear_private_cookies();
    await clearWebStorageFromTabs();
    await restoreAllData();
    update_button_states();
    chrome.runtime.sendMessage({ action: 'extensionToggled', enabled: true });
});

document.querySelector('#reconcile_skip').addEventListener('click', async () => {
    hideReconcileModal();
    await chrome.storage.local.set({ extension_enabled: true });
    update_button_states();
    chrome.runtime.sendMessage({ action: 'extensionToggled', enabled: true });
});

document.querySelector('#reconcile_cancel').addEventListener('click', () => {
    hideReconcileModal();
    document.querySelector('#extension_enabled').checked = false;
});

// Auto-save toggle
document.querySelector('#auto_save').addEventListener('change', async (event) => {
    await chrome.storage.local.set({ auto_save: event.target.checked });

    if (event.target.checked) {
        await saveAllData();
    }

    update_button_states();
    chrome.runtime.sendMessage({ action: 'settingsChanged' });
});

// Storage type toggles (localStorage and IndexedDB)
['save_localStorage', 'save_indexedDB'].forEach(id => {
    document.querySelector('#' + id).addEventListener('change', async (event) => {
        await chrome.storage.local.set({ [event.target.id]: event.target.checked });
    });
});

// Cache API toggle with warning modal
document.querySelector('#save_cacheAPI').addEventListener('change', async (event) => {
    const isEnabled = event.target.checked;

    if (isEnabled) {
        // Show warning modal instead of browser confirm
        document.querySelector('#cache_warning_modal').classList.add('active');
        // Don't enable yet - wait for modal confirmation
        event.target.checked = false;
    } else {
        await chrome.storage.local.set({ save_cacheAPI: false });
        document.querySelector('#cache_warning').style.display = 'none';
        document.querySelector('#cache_limit_section').style.display = 'none';
    }
});

// Cache warning modal handlers
document.querySelector('#cache_warning_confirm').addEventListener('click', async () => {
    document.querySelector('#cache_warning_modal').classList.remove('active');
    document.querySelector('#save_cacheAPI').checked = true;
    await chrome.storage.local.set({ save_cacheAPI: true });
    document.querySelector('#cache_warning').style.display = 'block';
    document.querySelector('#cache_limit_section').style.display = 'block';
});

document.querySelector('#cache_warning_cancel').addEventListener('click', () => {
    document.querySelector('#cache_warning_modal').classList.remove('active');
    document.querySelector('#save_cacheAPI').checked = false;
});

// Cache size limit change handler
document.querySelector('#cache_size_limit').addEventListener('change', async (event) => {
    const limit = Math.max(1, Math.min(500, parseInt(event.target.value) || 50));
    event.target.value = limit;
    await chrome.storage.local.set({ cache_size_limit_mb: limit });
});

// Save button
document.querySelector('#save').addEventListener('click', async () => {
    await saveAllData();
});

// Restore Now button
document.querySelector('#restore_now').addEventListener('click', async () => {
    await restoreAllData();
});

// Delete button
document.querySelector('#delete').addEventListener('click', async () => {
    await chrome.storage.local.remove(['cookies', 'webStorage']);
    update_storage_stats();

    if (await is_private_window_open()) {
        await clear_private_cookies();
        await clearWebStorageFromTabs();
    }
});

// Backup button
document.querySelector('#backup').addEventListener('click', async () => {
    const stored = await chrome.storage.local.get(['cookies', 'webStorage']);

    const backupData = {
        version: 2,
        timestamp: new Date().toISOString(),
        cookies: stored.cookies || [],
        webStorage: stored.webStorage || {}
    };

    objectURL = URL.createObjectURL(new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' }));

    chrome.downloads.download({
        url: objectURL,
        filename: 'private-window-data.json',
        saveAs: true
    }).then((id) => {
        downloadID = id;
    });
});

chrome.downloads.onChanged.addListener((download) => {
    if (download.id === downloadID && download.state && download.state.current !== 'in_progress') {
        downloadID = undefined;
        URL.revokeObjectURL(objectURL);
        objectURL = undefined;
    }
});

// Restore from file - open dedicated restore page to avoid popup auto-close
document.querySelector('#restore').addEventListener('click', () => {
    // Open restore page in a new tab (popup closes when file picker opens)
    chrome.tabs.create({ url: chrome.runtime.getURL('restore.html') });
});

// Listen for window changes
chrome.windows.onCreated.addListener((window) => {
    if (window.incognito) {
        invalidatePrivateWindowCache(); // Invalidate cache
        update_button_states();
    }
});

chrome.windows.onRemoved.addListener(() => {
    invalidatePrivateWindowCache(); // Invalidate cache
    update_button_states();
});

chrome.permissions.onAdded.addListener(() => {
    update_warning();
});

chrome.permissions.onRemoved.addListener(() => {
    update_warning();
});

// Debounced storage change listener for better performance
chrome.storage.onChanged.addListener((changes) => {
    if (changes.cookies || changes.webStorage) {
        debouncedUpdateStorageStats(); // Debounced to prevent rapid-fire updates
    }
    if (changes.last_saved) {
        update_last_saved();
    }
});

// Toast notification helper
function showToast(message, isError = false) {
    const toast = document.querySelector('#toast');
    toast.textContent = message;
    toast.style.background = isError ? 'var(--accent)' : 'var(--success)';
    toast.style.color = 'white';
    toast.style.display = 'block';
    setTimeout(() => {
        toast.style.display = 'none';
    }, 3000);
}

// Nuclear clear button - show modal
document.querySelector('#nuclear_clear').addEventListener('click', () => {
    document.querySelector('#nuclear_modal').classList.add('active');
});

// Nuclear modal cancel
document.querySelector('#nuclear_cancel').addEventListener('click', () => {
    document.querySelector('#nuclear_modal').classList.remove('active');
});

// Nuclear modal confirm
document.querySelector('#nuclear_confirm').addEventListener('click', async () => {
    document.querySelector('#nuclear_modal').classList.remove('active');

    try {
        // Clear everything from chrome.storage.local
        await chrome.storage.local.clear();

        // Reset to default settings
        await chrome.storage.local.set(defaultSettings);

        // Clear private window data if open
        if (await is_private_window_open()) {
            await clear_private_cookies();
            await clearWebStorageFromTabs();
        }

        // Update UI
        update_storage_stats();
        update_button_states();
        update_last_saved();

        // Reset checkboxes to defaults
        document.querySelector('#extension_enabled').checked = defaultSettings.extension_enabled;
        document.querySelector('#auto_save').checked = defaultSettings.auto_save;
        document.querySelector('#save_localStorage').checked = defaultSettings.save_localStorage;
        document.querySelector('#save_indexedDB').checked = defaultSettings.save_indexedDB;
        document.querySelector('#save_cacheAPI').checked = defaultSettings.save_cacheAPI;
        document.querySelector('#cache_size_limit').value = defaultSettings.cache_size_limit_mb;

        // Hide cache warning/limit section
        document.querySelector('#cache_warning').style.display = 'none';
        document.querySelector('#cache_limit_section').style.display = 'none';

        showToast('✅ All extension data cleared!');
    } catch (e) {
        console.error('Failed to clear extension data:', e);
        showToast('❌ Failed to clear some data', true);
    }
});
