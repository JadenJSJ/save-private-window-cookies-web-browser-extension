var isFirefox = navigator.userAgent.indexOf('Firefox') !== -1;
var cookie_store = isFirefox ? 'firefox-private' : '1';
var file_input = document.querySelector('#file_input');
var objectURL, downloadID;

// Default settings
const defaultSettings = {
    extension_enabled: true,
    auto_save: false,
    save_localStorage: true,
    save_indexedDB: true,
    save_cacheAPI: false
};

// ============ Utility Functions ============

async function is_private_window_open() {
    let private_window_open = false;

    await chrome.windows.getAll().then((windowInfoArray) => {
        for (let windowInfo of windowInfoArray) {
            if (windowInfo['incognito']) {
                private_window_open = true;
                break;
            }
        }
    });

    return private_window_open;
}

async function getPrivateTabs() {
    const tabs = [];
    const windows = await chrome.windows.getAll({ populate: true });

    for (const window of windows) {
        if (window.incognito) {
            for (const tab of window.tabs) {
                if (tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))) {
                    tabs.push(tab);
                }
            }
        }
    }

    return tabs;
}

function getOriginFromUrl(url) {
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

// ============ Cookie Functions ============

async function save_cookies_only() {
    let details = { 'storeId': cookie_store };

    if (isFirefox) {
        details['firstPartyDomain'] = null;
        details['partitionKey'] = {};
    }

    const cookies = await chrome.cookies.getAll(details);
    await chrome.storage.local.set({ 'cookies': cookies });
    return cookies;
}

function restore_cookies() {
    chrome.storage.local.get('cookies').then((res) => {
        if (res['cookies']) {
            for (let cookie of res['cookies']) {
                try {
                    const domain = cookie['domain'].charAt(0) == '.' ? cookie['domain'].substr(1) : cookie['domain'];
                    cookie['url'] = (cookie['secure'] ? 'https://' : 'http://') + domain + cookie['path'];
                    delete cookie['hostOnly'];
                    delete cookie['session'];

                    // Handle __Host- prefixed cookies
                    if (cookie['name'].startsWith('__Host-')) {
                        delete cookie['domain'];
                        cookie['secure'] = true;
                        cookie['path'] = '/';
                    }

                    // Handle __Secure- prefixed cookies
                    if (cookie['name'].startsWith('__Secure-')) {
                        cookie['secure'] = true;
                    }

                    chrome.cookies.set(cookie).catch(() => { });
                } catch (e) {
                    // Skip problematic cookies
                }
            }
        }
    });
}

async function clear_private_cookies() {
    if (isFirefox) {
        await chrome.browsingData.removeCookies({ 'cookieStoreId': cookie_store });
    } else {
        const cookies = await chrome.cookies.getAll({ 'storeId': cookie_store });
        for (let cookie of cookies) {
            await chrome.cookies.remove({
                'storeId': cookie_store,
                'url': (cookie['secure'] ? 'https://' : 'http://') + (cookie['domain'].charAt(0) == '.' ? cookie['domain'].substr(1) : cookie['domain']) + cookie['path'],
                'name': cookie['name']
            });
        }
    }
}

// ============ Web Storage Functions ============

async function collectWebStorageFromTabs(settings) {
    const tabs = await getPrivateTabs();
    const webStorage = {};
    const includeCache = settings.save_cacheAPI;

    // Group tabs by origin to avoid duplicate collection
    const originTabs = {};
    for (const tab of tabs) {
        const origin = getOriginFromUrl(tab.url);
        if (origin && !originTabs[origin]) {
            originTabs[origin] = tab;
        }
    }

    for (const [origin, tab] of Object.entries(originTabs)) {
        try {
            const response = await chrome.tabs.sendMessage(tab.id, {
                action: 'getStorageData',
                includeCache: includeCache
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
                    webStorage[origin] = storageData;
                }
            }
        } catch (e) {
            // Tab might not have content script loaded yet
            console.log('Could not collect from tab:', tab.url, e);
        }
    }

    return webStorage;
}

async function restoreWebStorageToTabs(clearFirst = true) {
    const stored = await chrome.storage.local.get(['webStorage', 'save_cacheAPI']);
    const webStorage = stored.webStorage || {};
    const includeCache = stored.save_cacheAPI || false;

    const tabs = await getPrivateTabs();

    for (const tab of tabs) {
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
    }
}

async function clearWebStorageFromTabs() {
    const stored = await chrome.storage.local.get('save_cacheAPI');
    const includeCache = stored.save_cacheAPI || false;

    const tabs = await getPrivateTabs();

    for (const tab of tabs) {
        try {
            await chrome.tabs.sendMessage(tab.id, {
                action: 'clearStorageData',
                includeCache: includeCache
            });
        } catch (e) {
            console.log('Could not clear tab:', tab.url, e);
        }
    }
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
        'webStorage': webStorage,
        'last_saved': Date.now()
    });

    update_storage_stats();
    update_last_saved();
}

async function restoreAllData() {
    const settings = await chrome.storage.local.get(defaultSettings);

    if (!settings.extension_enabled) {
        return;
    }

    // Restore cookies
    restore_cookies();

    // Restore web storage to tabs
    await restoreWebStorageToTabs(false);
}

// ============ UI Updates ============

async function update_warning() {
    let private_enabled = await chrome.extension.isAllowedIncognitoAccess();
    let access_enabled = await chrome.permissions.contains({ 'origins': ['<all_urls>'] });
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
    const access_enabled = await chrome.permissions.contains({ 'origins': ['<all_urls>'] });
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

    // Calculate cookies size
    if (stored.cookies) {
        totalBytes += new TextEncoder().encode(JSON.stringify(stored.cookies)).length;
    }

    // Calculate web storage size
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
        await chrome.storage.local.set({ 'extension_enabled': enabled });
        update_button_states();

        // Notify background script
        chrome.runtime.sendMessage({ action: 'extensionToggled', enabled: enabled });
    }
});

// Reconciliation handlers
document.querySelector('#reconcile_save').addEventListener('click', async () => {
    hideReconcileModal();
    await chrome.storage.local.set({ 'extension_enabled': true });
    await saveAllData();
    update_button_states();
    chrome.runtime.sendMessage({ action: 'extensionToggled', enabled: true });
});

document.querySelector('#reconcile_restore').addEventListener('click', async () => {
    hideReconcileModal();
    await chrome.storage.local.set({ 'extension_enabled': true });
    await clear_private_cookies();
    await clearWebStorageFromTabs();
    await restoreAllData();
    update_button_states();
    chrome.runtime.sendMessage({ action: 'extensionToggled', enabled: true });
});

document.querySelector('#reconcile_skip').addEventListener('click', async () => {
    hideReconcileModal();
    await chrome.storage.local.set({ 'extension_enabled': true });
    update_button_states();
    chrome.runtime.sendMessage({ action: 'extensionToggled', enabled: true });
});

document.querySelector('#reconcile_cancel').addEventListener('click', () => {
    hideReconcileModal();
    document.querySelector('#extension_enabled').checked = false;
});

// Auto-save toggle
document.querySelector('#auto_save').addEventListener('change', async (event) => {
    await chrome.storage.local.set({ 'auto_save': event.target.checked });

    if (event.target.checked) {
        await saveAllData();
    }

    update_button_states();
    chrome.runtime.sendMessage({ action: 'settingsChanged' });
});

// Storage type toggles
['save_localStorage', 'save_indexedDB', 'save_cacheAPI'].forEach(id => {
    document.querySelector('#' + id).addEventListener('change', async (event) => {
        await chrome.storage.local.set({ [event.target.id]: event.target.checked });
    });
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

    objectURL = URL.createObjectURL(new Blob([JSON.stringify(backupData, null, 2)], { 'type': 'application/json' }));

    chrome.downloads.download({
        'url': objectURL,
        'filename': 'private-window-data.json',
        'saveAs': true
    }).then((id) => {
        downloadID = id;
    });
});

chrome.downloads.onChanged.addListener((download) => {
    if (download['id'] == downloadID && download['state'] && download['state']['current'] != 'in_progress') {
        downloadID = undefined;
        URL.revokeObjectURL(objectURL);
        objectURL = undefined;
    }
});

// Restore from file
document.querySelector('#restore').addEventListener('click', () => {
    file_input.click();
});

file_input.addEventListener('change', async () => {
    const file = file_input.files[0];

    if (!file || file.size === 0) {
        return;
    }

    const text = await new Blob([file], { 'type': 'application/json' }).text();
    const data = JSON.parse(text);

    // Handle both v1 (cookies only) and v2 (full data) formats
    let cookies = [];
    let webStorage = {};

    if (data.version === 2) {
        cookies = data.cookies || [];
        webStorage = data.webStorage || {};
    } else if (Array.isArray(data)) {
        // v1 format: just an array of cookies
        cookies = data;
    }

    // Convert cookies if needed
    for (let cookie of cookies) {
        if (cookie['storeId'] == (isFirefox ? '1' : 'firefox-private')) {
            cookie['storeId'] = cookie_store;
        }

        if (isFirefox) {
            if (cookie['sameSite'] == 'unspecified') {
                cookie['sameSite'] = 'no_restriction';
            }
            if (cookie['firstPartyDomain'] === undefined) {
                cookie['firstPartyDomain'] = '';
            }
            if (cookie['partitionKey'] === undefined) {
                cookie['partitionKey'] = null;
            }
        } else {
            if (!cookie['secure'] && cookie['sameSite'] == 'no_restriction') {
                cookie['sameSite'] = 'unspecified';
            }
            if (cookie['firstPartyDomain'] !== undefined) {
                delete cookie['firstPartyDomain'];
            }
            if (cookie['partitionKey'] !== undefined) {
                delete cookie['partitionKey'];
            }
        }
    }

    await chrome.storage.local.set({ 'cookies': cookies, 'webStorage': webStorage });
    file_input.value = '';

    update_storage_stats();

    if (await is_private_window_open()) {
        await clear_private_cookies();
        await clearWebStorageFromTabs();
        restore_cookies();
        await restoreWebStorageToTabs(false);
    }
});

// Listen for window changes
chrome.windows.onCreated.addListener((window) => {
    if (window.incognito) {
        update_button_states();
    }
});

chrome.windows.onRemoved.addListener(() => {
    update_button_states();
});

chrome.permissions.onAdded.addListener(() => {
    update_warning();
});

chrome.permissions.onRemoved.addListener(() => {
    update_warning();
});

chrome.storage.onChanged.addListener((changes) => {
    if (changes['cookies'] || changes['webStorage']) {
        update_storage_stats();
    }
    if (changes['last_saved']) {
        update_last_saved();
    }
});
