document.addEventListener('DOMContentLoaded', async () => {
    const list = document.getElementById('episodes-list');
    if (!list) {
        return;
    }

    const data = await chrome.storage.local.get('episodes');
    const episodes = (data.episodes || {}) as Record<string, { skipTime?: number }>;

    for (const [key, value] of Object.entries(episodes)) {
        const li = document.createElement('li');
        li.append(`${key}: `);

        const input = document.createElement('input');
        input.type = 'number';
        input.value = String(value.skipTime ?? 90);
        input.addEventListener('change', async () => {
            await updateSkip(key, input.value);
        });

        li.appendChild(input);
        list.appendChild(li);
    }

    // Auto-select mirror toggle
    const toggle = document.getElementById('auto-mirror-toggle') as HTMLInputElement | null;
    if (toggle) {
        const mirrorSetting = await chrome.storage.local.get('autoSelectMirror');
        // Default to true when the key is absent
        toggle.checked = mirrorSetting.autoSelectMirror !== false;
        toggle.addEventListener('change', async () => {
            await chrome.storage.local.set({ autoSelectMirror: toggle.checked });
        });
    }

    await renderActiveSeriesFrameHashes();
});

async function updateSkip(key: string, time: string) {
    const data = await chrome.storage.local.get(['episodes']);
    const episodes = (data.episodes || {}) as Record<string, { skipTime?: number }>;
    episodes[key] = {
        ...(episodes[key] || {}),
        skipTime: Number.parseInt(time, 10)
    };
    await chrome.storage.local.set({ episodes });
}

function parseSeriesIdFromPath(pathname: string) {
    const match = pathname.match(/^\/watch\/([^/]+)/);
    return match ? match[1] : null;
}

async function getActiveSeriesId() {
    if (!chrome.tabs || !chrome.tabs.query) {
        return null;
    }

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs && tabs[0];
    if (!activeTab || !activeTab.url) {
        return null;
    }

    try {
        const url = new URL(activeTab.url);
        if (url.hostname !== 'proxer.me') {
            return null;
        }

        return parseSeriesIdFromPath(url.pathname);
    } catch (_error) {
        return null;
    }
}

async function removeSeriesFrameHash(seriesId: string, hashToRemove: string) {
    const data = await chrome.storage.local.get(['seriesProfiles']);
    const seriesProfiles = (data.seriesProfiles || {}) as Record<string, { frameHashes?: string[] }>;
    const profile = seriesProfiles[seriesId] || {};
    const hashes = Array.isArray(profile.frameHashes) ? profile.frameHashes : [];

    seriesProfiles[seriesId] = {
        ...profile,
        frameHashes: hashes.filter((hash) => hash !== hashToRemove)
    };

    await chrome.storage.local.set({ seriesProfiles });
}

async function renderActiveSeriesFrameHashes() {
    const context = document.getElementById('framehash-context');
    const hashList = document.getElementById('framehash-list');
    if (!context || !hashList) {
        return;
    }

    hashList.innerHTML = '';
    const seriesId = await getActiveSeriesId();

    if (!seriesId) {
        context.textContent = 'Open a /watch/<seriesID> page to manage frame hashes.';
        return;
    }

    context.textContent = `Series ${seriesId}`;

    const data = await chrome.storage.local.get(['seriesProfiles']);
    const seriesProfiles = (data.seriesProfiles || {}) as Record<string, { frameHashes?: string[] }>;
    const profile = seriesProfiles[seriesId] || {};
    const hashes = Array.isArray(profile.frameHashes) ? profile.frameHashes : [];

    if (!hashes.length) {
        const empty = document.createElement('li');
        empty.textContent = 'No saved frame hashes for this series.';
        hashList.appendChild(empty);
        return;
    }

    for (let i = 0; i < hashes.length; i += 1) {
        const hash = hashes[i];
        const item = document.createElement('li');
        item.className = 'framehash-item';

        const value = document.createElement('span');
        value.className = 'framehash-value';
        value.title = hash;
        value.textContent = hash;

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'remove-hash-btn';
        removeButton.textContent = 'Remove';
        removeButton.addEventListener('click', async () => {
            removeButton.disabled = true;
            await removeSeriesFrameHash(seriesId, hash);
            await renderActiveSeriesFrameHashes();
        });

        item.appendChild(value);
        item.appendChild(removeButton);
        hashList.appendChild(item);
    }
}
