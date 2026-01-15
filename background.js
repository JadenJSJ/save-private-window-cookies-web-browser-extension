// Background service worker for the browser extension
// Uses shared utilities from utils.js

// For Chrome MV3, import utils (Firefox loads it via manifest)
// For Chrome MV3, import utils (Firefox loads it via manifest)
if (typeof defaultSettings === 'undefined') {
	try {
		importScripts('utils.js');
	} catch (e) {
		console.error('Failed to load utils.js:', e);
	}
}

var was_private_window_open = false;

// ============ Cookie Functions ============

async function save_cookies(changeInfo) {
	const settings = await chrome.storage.local.get(defaultSettings);

	if (!settings.extension_enabled) {
		return;
	}

	const privateOpen = await is_private_window_open();
	if (privateOpen && changeInfo.cookie.storeId === cookie_store) {
		let details = { storeId: cookie_store };

		if (isFirefox) {
			details.firstPartyDomain = null;
			details.partitionKey = {};
		}

		const cookies = await chrome.cookies.getAll(details);
		await chrome.storage.local.set({ cookies: cookies });

		// Also save web storage when auto-save is enabled
		if (settings.auto_save) {
			saveWebStorage(settings);
		}
	}
}

async function saveWebStorage(settings) {
	const tabs = await getPrivateTabs();
	const webStorage = {};
	const includeCache = settings.save_cacheAPI;
	const cacheSizeLimit = settings.cache_size_limit_mb || 50;

	// Group tabs by origin
	const originTabs = {};
	for (const tab of tabs) {
		const origin = getOriginFromUrl(tab.url);
		if (origin && !originTabs[origin]) {
			originTabs[origin] = tab;
		}
	}

	// Collect storage from all origins in parallel
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
				// Tab might not have content script loaded
			}
			return null;
		})
	);

	// Merge results
	for (const result of results) {
		if (result.status === 'fulfilled' && result.value) {
			webStorage[result.value.origin] = result.value.data;
		}
	}

	if (Object.keys(webStorage).length > 0) {
		const existing = await chrome.storage.local.get('webStorage');
		const merged = { ...existing.webStorage, ...webStorage };
		await chrome.storage.local.set({ webStorage: merged });
	}
}

async function restoreWebStorage() {
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
						clearFirst: false,
						includeCache: includeCache
					});
				} catch (e) {
					// Tab might not have content script loaded
				}
			}
		})
	);
}

// ============ Auto-save Listener Management ============

async function save_cookies_listener() {
	const settings = await chrome.storage.local.get(defaultSettings);

	if (!settings.extension_enabled) {
		if (chrome.cookies.onChanged.hasListener(save_cookies)) {
			chrome.cookies.onChanged.removeListener(save_cookies);
		}
		return;
	}

	if (await is_private_window_open()) {
		if (settings.auto_save) {
			if (!chrome.cookies.onChanged.hasListener(save_cookies)) {
				chrome.cookies.onChanged.addListener(save_cookies);
			}
		} else {
			if (chrome.cookies.onChanged.hasListener(save_cookies)) {
				chrome.cookies.onChanged.removeListener(save_cookies);
			}
		}
	}
}

// ============ Tab Navigation Listener for Web Storage ============

// Track pending restores to prevent duplicates
const pendingRestores = new Map();

// Cleanup stale entries periodically (every 30 seconds)
setInterval(() => {
	const now = Date.now();
	for (const [key, timestamp] of pendingRestores.entries()) {
		// Remove entries older than 30 seconds
		if (now - timestamp > 30000) {
			pendingRestores.delete(key);
		}
	}
}, 30000);

async function onTabUpdated(tabId, changeInfo, tab) {
	if (!tab.incognito || changeInfo.status !== 'complete') {
		return;
	}

	const settings = await chrome.storage.local.get(defaultSettings);

	if (!settings.extension_enabled) {
		return;
	}

	const origin = getOriginFromUrl(tab.url);
	if (!origin) return;

	// Prevent duplicate restores for same tab/origin
	const restoreKey = `${tabId}-${origin}`;
	if (pendingRestores.has(restoreKey)) return;
	pendingRestores.set(restoreKey, Date.now()); // Store timestamp for cleanup

	const stored = await chrome.storage.local.get(['webStorage', 'save_cacheAPI']);
	const webStorage = stored.webStorage || {};

	if (!webStorage[origin]) {
		pendingRestores.delete(restoreKey);
		return;
	}

	const maxRetries = 3;
	const retryDelay = 500;

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			// Check if tab still exists and has same URL
			const currentTab = await chrome.tabs.get(tabId).catch(() => null);
			if (!currentTab || getOriginFromUrl(currentTab.url) !== origin) {
				break; // Tab navigated away, abort
			}

			await chrome.tabs.sendMessage(tabId, {
				action: 'setStorageData',
				data: webStorage[origin],
				clearFirst: false,
				includeCache: stored.save_cacheAPI || false
			});
			break; // Success
		} catch (e) {
			if (attempt < maxRetries - 1) {
				await new Promise(r => setTimeout(r, retryDelay));
			}
		}
	}

	pendingRestores.delete(restoreKey);
}

// Clean up pending restores when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
	// Remove all entries for this tab
	for (const key of pendingRestores.keys()) {
		if (key.startsWith(`${tabId}-`)) {
			pendingRestores.delete(key);
		}
	}
});

// ============ Event Listeners ============

chrome.runtime.onInstalled.addListener(async () => {
	const options = await chrome.storage.local.get(defaultSettings);
	await chrome.storage.local.set(options);
});

chrome.storage.onChanged.addListener((changes) => {
	if (changes.auto_save || changes.extension_enabled) {
		save_cookies_listener();
	}
});

chrome.windows.onCreated.addListener(async (window) => {
	invalidatePrivateWindowCache(); // Invalidate cache on window changes

	const settings = await chrome.storage.local.get(defaultSettings);

	if (!settings.extension_enabled) {
		return;
	}

	const privateAccess = await chrome.extension.isAllowedIncognitoAccess();

	if (privateAccess && window.incognito && !was_private_window_open) {
		await restore_cookies();
		// Web storage will be restored per-tab via the tabs.onUpdated listener
		save_cookies_listener();
		was_private_window_open = true;
	}
});

chrome.windows.onRemoved.addListener(async () => {
	invalidatePrivateWindowCache(); // Invalidate cache on window changes

	if (!await is_private_window_open(true)) { // Force refresh
		if (chrome.cookies.onChanged.hasListener(save_cookies)) {
			chrome.cookies.onChanged.removeListener(save_cookies);
		}

		was_private_window_open = false;
	}
});

// Listen for tab updates to restore web storage
chrome.tabs.onUpdated.addListener(onTabUpdated);

// Listen for messages from popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message.action === 'extensionToggled') {
		save_cookies_listener();
	}

	if (message.action === 'settingsChanged') {
		save_cookies_listener();
	}

	// Handle direct storage data from content scripts (auto-save)
	if (message.action === 'saveOriginData') {
		(async () => {
			const settings = await chrome.storage.local.get(defaultSettings);

			if (!settings.extension_enabled || !settings.auto_save) {
				sendResponse({ success: false, reason: 'disabled' });
				return;
			}

			const data = message.data;
			if (!data || !data.origin) {
				sendResponse({ success: false, reason: 'invalid data' });
				return;
			}

			// Also save cookies (content script can't access these)
			try {
				let details = { storeId: cookie_store };
				if (isFirefox) {
					details.firstPartyDomain = null;
					details.partitionKey = {};
				}
				const cookies = await chrome.cookies.getAll(details);
				await chrome.storage.local.set({ cookies: cookies });
			} catch (e) {
				// Cookie store might not be available
			}

			// Get existing web storage and merge
			const existing = await chrome.storage.local.get('webStorage');
			const webStorage = existing.webStorage || {};

			// Build storage data for this origin
			const originData = {};

			if (data.localStorage && Object.keys(data.localStorage).length > 0) {
				originData.localStorage = data.localStorage;
			}

			if (data.indexedDB && data.indexedDB.length > 0) {
				originData.indexedDB = data.indexedDB;
			}

			if (data.cacheStorage && data.cacheStorage.length > 0) {
				originData.cacheStorage = data.cacheStorage;
			}

			// Only save if there's data
			if (Object.keys(originData).length > 0) {
				webStorage[data.origin] = originData;
				await chrome.storage.local.set({
					webStorage: webStorage,
					last_saved: Date.now()
				});
			} else {
				// Still update last_saved for cookies-only saves
				await chrome.storage.local.set({ last_saved: Date.now() });
			}

			sendResponse({ success: true });
		})();

		return true; // Keep channel open for async response
	}

	// Handle restore after import from restore.html page
	if (message.action === 'restoreAfterImport') {
		(async () => {
			try {
				// Check if private window is open
				if (await is_private_window_open(true)) {
					// Restore cookies
					restore_cookies();

					// Restore web storage to all private tabs
					const tabs = await getPrivateTabs();
					const stored = await chrome.storage.local.get(['webStorage', 'save_cacheAPI']);
					const webStorage = stored.webStorage || {};

					// Parallel restoration
					await Promise.allSettled(
						tabs.map(async (tab) => {
							const origin = getOriginFromUrl(tab.url);
							if (origin && webStorage[origin]) {
								try {
									await chrome.tabs.sendMessage(tab.id, {
										action: 'setStorageData',
										data: webStorage[origin],
										clearFirst: true,
										includeCache: stored.save_cacheAPI || false
									});
								} catch (e) {
									// Tab might not have content script
								}
							}
						})
					);
				}
				sendResponse({ success: true });
			} catch (e) {
				console.error('Failed to restore after import:', e);
				sendResponse({ success: false, error: e.message });
			}
		})();

		return true; // Keep channel open for async response
	}
});