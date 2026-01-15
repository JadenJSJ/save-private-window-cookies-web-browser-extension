// Restore page script - handles file import in a dedicated tab
// Uses shared utilities from utils.js (loaded before this script)

const dropZone = document.getElementById('drop_zone');
const fileInput = document.getElementById('file_input');
const statusEl = document.getElementById('status');

// Click to browse
dropZone.addEventListener('click', () => {
    fileInput.click();
});

// Drag and drop handling
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');

    const file = e.dataTransfer.files[0];
    if (file) {
        processFile(file);
    }
});

// File input change
fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) {
        processFile(file);
    }
});

// Cancel button
document.getElementById('cancel_btn').addEventListener('click', () => {
    window.close();
});

function showStatus(message, type) {
    statusEl.className = 'status ' + type;
    statusEl.textContent = message;
}

async function processFile(file) {
    if (!file || file.size === 0) {
        showStatus('No file selected', 'error');
        return;
    }

    if (!file.name.endsWith('.json')) {
        showStatus('Please select a JSON file', 'error');
        return;
    }

    showStatus('Processing...', 'loading');

    try {
        const text = await file.text();
        const data = JSON.parse(text);

        // Handle both v1 (cookies only) and v2/v3 (full data) formats
        let cookies = [];
        let webStorage = {};

        if (data.version === 2 || data.version === 3) {
            cookies = data.cookies || [];
            webStorage = data.webStorage || {};
        } else if (Array.isArray(data)) {
            // v1 format: just an array of cookies
            cookies = data;
        } else if (data.cookies || data.webStorage) {
            // Unversioned but has the right structure
            cookies = data.cookies || [];
            webStorage = data.webStorage || {};
        } else {
            throw new Error('Unrecognized backup file format');
        }

        console.log(`Restoring: ${cookies.length} cookies, ${Object.keys(webStorage).length} origins`);

        // Convert cookies if needed (use isFirefox and cookie_store from utils.js)
        for (const cookie of cookies) {
            if (cookie.storeId === (isFirefox ? '1' : 'firefox-private')) {
                cookie.storeId = cookie_store;
            }

            if (isFirefox) {
                if (cookie.sameSite === 'unspecified') {
                    cookie.sameSite = 'no_restriction';
                }
                if (cookie.firstPartyDomain === undefined) {
                    cookie.firstPartyDomain = '';
                }
                if (cookie.partitionKey === undefined) {
                    cookie.partitionKey = null;
                }
            } else {
                if (!cookie.secure && cookie.sameSite === 'no_restriction') {
                    cookie.sameSite = 'unspecified';
                }
                if (cookie.firstPartyDomain !== undefined) {
                    delete cookie.firstPartyDomain;
                }
                if (cookie.partitionKey !== undefined) {
                    delete cookie.partitionKey;
                }
            }
        }

        // Save to storage
        await chrome.storage.local.set({
            cookies: cookies,
            webStorage: webStorage,
            last_saved: Date.now()
        });

        // Notify background to restore to any open private windows
        try {
            await chrome.runtime.sendMessage({ action: 'restoreAfterImport' });
        } catch (e) {
            // Background might not be ready, that's ok
            console.log('Could not notify background:', e);
        }

        const originCount = Object.keys(webStorage).length;
        showStatus(`✅ Restored ${cookies.length} cookies and ${originCount} origins!`, 'success');

        // Auto-close after 2 seconds
        setTimeout(() => {
            window.close();
        }, 2000);

    } catch (e) {
        console.error('Failed to restore from backup:', e);
        showStatus('❌ ' + e.message, 'error');
    }
}
