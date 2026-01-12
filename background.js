var isFirefox = navigator.userAgent.indexOf('Firefox') !== -1;
var cookie_store = isFirefox ? 'firefox-private' : '1';
var was_private_window_open = false;

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

async function save_cookies(changeInfo) {
	const settings = await chrome.storage.local.get(defaultSettings);

	if (!settings.extension_enabled) {
		return;
	}

	if (await is_private_window_open() && changeInfo.cookie['storeId'] == cookie_store) {
		let details = { 'storeId': cookie_store };

		if (isFirefox) {
			details['firstPartyDomain'] = null;
			details['partitionKey'] = {};
		}

		chrome.cookies.getAll(details).then((cookies) => {
			chrome.storage.local.set({ 'cookies': cookies });
		});

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

	// Group tabs by origin
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
			// Tab might not have content script loaded
		}
	}

	if (Object.keys(webStorage).length > 0) {
		// Merge with existing storage
		const existing = await chrome.storage.local.get('webStorage');
		const merged = { ...existing.webStorage, ...webStorage };
		await chrome.storage.local.set({ 'webStorage': merged });
	}
}

function restore_cookies() {
	chrome.storage.local.get('cookies').then((res) => {
		if (res['cookies']) {
			for (let cookie of res['cookies']) {
				try {
					// Build the URL for the cookie
					const domain = cookie['domain'].charAt(0) == '.' ? cookie['domain'].substr(1) : cookie['domain'];
					cookie['url'] = (cookie['secure'] ? 'https://' : 'http://') + domain + cookie['path'];

					// Remove unsupported properties
					delete cookie['hostOnly'];
					delete cookie['session'];

					// Handle __Host- prefixed cookies (must not have domain, must have secure and path=/)
					if (cookie['name'].startsWith('__Host-')) {
						delete cookie['domain'];
						cookie['secure'] = true;
						cookie['path'] = '/';
					}

					// Handle __Secure- prefixed cookies (must have secure)
					if (cookie['name'].startsWith('__Secure-')) {
						cookie['secure'] = true;
					}

					chrome.cookies.set(cookie).catch(() => {
						// Silently ignore individual cookie failures
					});
				} catch (e) {
					// Skip cookies that can't be processed
				}
			}
		}
	});
}

async function restoreWebStorage() {
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
					clearFirst: false,
					includeCache: includeCache
				});
			} catch (e) {
				// Tab might not have content script loaded
			}
		}
	}
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

async function onTabUpdated(tabId, changeInfo, tab) {
	if (!tab.incognito || changeInfo.status !== 'complete') {
		return;
	}

	const settings = await chrome.storage.local.get(defaultSettings);

	if (!settings.extension_enabled) {
		return;
	}

	// When a tab finishes loading, restore its web storage if we have data for it
	const origin = getOriginFromUrl(tab.url);
	if (!origin) return;

	const stored = await chrome.storage.local.get(['webStorage', 'save_cacheAPI']);
	const webStorage = stored.webStorage || {};

	if (webStorage[origin]) {
		try {
			await chrome.tabs.sendMessage(tabId, {
				action: 'setStorageData',
				data: webStorage[origin],
				clearFirst: false,
				includeCache: stored.save_cacheAPI || false
			});
		} catch (e) {
			// Content script not ready yet, retry after a delay
			setTimeout(async () => {
				try {
					await chrome.tabs.sendMessage(tabId, {
						action: 'setStorageData',
						data: webStorage[origin],
						clearFirst: false,
						includeCache: stored.save_cacheAPI || false
					});
				} catch (e2) {
					// Still failed, give up
				}
			}, 500);
		}
	}
}

// ============ Event Listeners ============

chrome.runtime.onInstalled.addListener(() => {
	chrome.storage.local.get(defaultSettings).then((options) => {
		chrome.storage.local.set(options);
	});
});

chrome.storage.onChanged.addListener((changes) => {
	if (changes['auto_save'] || changes['extension_enabled']) {
		save_cookies_listener();
	}
});

chrome.windows.onCreated.addListener(async (window) => {
	const settings = await chrome.storage.local.get(defaultSettings);

	if (!settings.extension_enabled) {
		return;
	}

	const private = await chrome.extension.isAllowedIncognitoAccess();

	if (private && window['incognito'] && !was_private_window_open) {
		restore_cookies();
		// Web storage will be restored per-tab via the tabs.onUpdated listener
		save_cookies_listener();
		was_private_window_open = true;
	}
});

chrome.windows.onRemoved.addListener(async () => {
	if (!await is_private_window_open()) {
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
				let details = { 'storeId': cookie_store };
				if (isFirefox) {
					details['firstPartyDomain'] = null;
					details['partitionKey'] = {};
				}
				const cookies = await chrome.cookies.getAll(details);
				await chrome.storage.local.set({ 'cookies': cookies });
			} catch (e) {
				// Cookie store might not be available (e.g., no incognito window)
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
					'webStorage': webStorage,
					'last_saved': Date.now()
				});
			} else {
				// Still update last_saved for cookies-only saves
				await chrome.storage.local.set({ 'last_saved': Date.now() });
			}

			sendResponse({ success: true });
		})();

		return true; // Keep channel open for async response
	}
});