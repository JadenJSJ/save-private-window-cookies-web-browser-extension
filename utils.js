// Shared utilities for the browser extension
// This module exports common functions and constants used across multiple scripts

var isFirefox = navigator.userAgent.indexOf('Firefox') !== -1;
var cookie_store = isFirefox ? 'firefox-private' : '1';

// Default settings
const defaultSettings = {
    extension_enabled: true,
    auto_save: false,
    save_localStorage: true,
    save_indexedDB: true,
    save_cacheAPI: false,
    cache_size_limit_mb: 50
};

// ============ Cached State ============
// Cache private window state to avoid repeated API calls
let _cachedPrivateWindowOpen = null;
let _cacheTimestamp = 0;
const CACHE_TTL_MS = 1000; // Cache validity: 1 second

/**
 * Check if any private window is currently open.
 * Uses caching to avoid repeated API calls.
 * @param {boolean} forceRefresh - Force a fresh API call
 * @returns {Promise<boolean>}
 */
async function is_private_window_open(forceRefresh = false) {
    const now = Date.now();

    // Return cached value if still valid
    if (!forceRefresh && _cachedPrivateWindowOpen !== null && (now - _cacheTimestamp) < CACHE_TTL_MS) {
        return _cachedPrivateWindowOpen;
    }

    const windows = await chrome.windows.getAll();
    _cachedPrivateWindowOpen = windows.some(w => w.incognito);
    _cacheTimestamp = now;

    return _cachedPrivateWindowOpen;
}

/**
 * Invalidate the private window cache.
 * Call this when windows are created or removed.
 */
function invalidatePrivateWindowCache() {
    _cachedPrivateWindowOpen = null;
    _cacheTimestamp = 0;
}

/**
 * Get all tabs in private windows that have http/https URLs.
 * @returns {Promise<chrome.tabs.Tab[]>}
 */
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

/**
 * Extract origin from a URL string.
 * @param {string} url 
 * @returns {string|null}
 */
function getOriginFromUrl(url) {
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

/**
 * Restore cookies from storage to the private cookie store.
 * Uses Promise.allSettled for parallel restoration.
 * @returns {Promise<void>}
 */
async function restore_cookies() {
    const res = await chrome.storage.local.get('cookies');
    if (!res.cookies || res.cookies.length === 0) return;

    const cookiePromises = res.cookies.map(originalCookie => {
        try {
            // Clone cookie to avoid mutating stored data
            const cookie = { ...originalCookie };

            // Build the URL for the cookie
            const domain = cookie.domain.charAt(0) === '.' ? cookie.domain.substr(1) : cookie.domain;
            cookie.url = (cookie.secure ? 'https://' : 'http://') + domain + cookie.path;

            // Remove unsupported properties
            delete cookie.hostOnly;
            delete cookie.session;

            // Handle __Host- prefixed cookies (must not have domain, must have secure and path=/)
            if (cookie.name.startsWith('__Host-')) {
                delete cookie.domain;
                cookie.secure = true;
                cookie.path = '/';
            }

            // Handle __Secure- prefixed cookies (must have secure)
            if (cookie.name.startsWith('__Secure-')) {
                cookie.secure = true;
            }

            return chrome.cookies.set(cookie);
        } catch (e) {
            return Promise.resolve(); // Skip cookies that can't be processed
        }
    });

    // Parallel restoration with error handling
    await Promise.allSettled(cookiePromises);
}

/**
 * Clear all private cookies.
 * Uses parallel operations for better performance.
 * @returns {Promise<void>}
 */
async function clear_private_cookies() {
    if (isFirefox) {
        await chrome.browsingData.removeCookies({ cookieStoreId: cookie_store });
    } else {
        const cookies = await chrome.cookies.getAll({ storeId: cookie_store });

        // Parallel deletion
        await Promise.allSettled(cookies.map(cookie =>
            chrome.cookies.remove({
                storeId: cookie_store,
                url: (cookie.secure ? 'https://' : 'http://') +
                    (cookie.domain.charAt(0) === '.' ? cookie.domain.substr(1) : cookie.domain) +
                    cookie.path,
                name: cookie.name
            })
        ));
    }
}

/**
 * Create a debounced version of a function.
 * @param {Function} fn - Function to debounce
 * @param {number} delay - Delay in milliseconds
 * @returns {Function}
 */
function debounce(fn, delay) {
    let timer = null;
    return function (...args) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            fn.apply(this, args);
            timer = null;
        }, delay);
    };
}

// Export for use in other scripts (handled differently in extensions)
// In browser extensions, this file is loaded before other scripts in manifest
