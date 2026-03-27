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

    await initGlobalSkipframeSettingsInputs();

    await renderActiveSeriesFrameHashes();
});

type SeriesFrameHashEntry = {
    hash: string;
    thumbnail?: string;
};

type SeriesSkipframesData = {
    frameHashes?: string[];
    frameHashEntries?: SeriesFrameHashEntry[];
};

type GlobalSkipframeSettings = {
    threshold: number;
    skipDuration: number;
    refreshMs: number;
};

const POPUP_GLOBAL_SKIPFRAME_SETTINGS_KEY = 'globalSkipframeSettings';
const POPUP_DEFAULT_MATCH_THRESHOLD = 10;
const POPUP_DEFAULT_SKIP_DURATION = 85;
const POPUP_DEFAULT_REFRESH_MS = 1000 / 30;

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

function getSeriesSkipframesStorageKey(seriesId: string) {
    return `seriesSkipframes:${seriesId}`;
}

async function getGlobalSkipframeSettings(): Promise<GlobalSkipframeSettings> {
    const data = await chrome.storage.local.get([POPUP_GLOBAL_SKIPFRAME_SETTINGS_KEY]);
    const raw = data[POPUP_GLOBAL_SKIPFRAME_SETTINGS_KEY] || {};

    const threshold = Number.isFinite(raw.threshold) && raw.threshold >= 0
        ? raw.threshold
        : POPUP_DEFAULT_MATCH_THRESHOLD;
    const skipDuration = Number.isFinite(raw.skipDuration) && raw.skipDuration >= 0
        ? raw.skipDuration
        : POPUP_DEFAULT_SKIP_DURATION;
    const refreshMs = Number.isFinite(raw.refreshMs) && raw.refreshMs >= 10
        ? raw.refreshMs
        : POPUP_DEFAULT_REFRESH_MS;

    return {
        threshold,
        skipDuration,
        refreshMs
    };
}

async function setGlobalSkipframeSettings(settings: GlobalSkipframeSettings) {
    await chrome.storage.local.set({
        [POPUP_GLOBAL_SKIPFRAME_SETTINGS_KEY]: settings
    });
}

async function initGlobalSkipframeSettingsInputs() {
    const thresholdInput = document.getElementById('global-threshold-input') as HTMLInputElement | null;
    const durationInput = document.getElementById('global-duration-input') as HTMLInputElement | null;
    const refreshInput = document.getElementById('global-refresh-input') as HTMLInputElement | null;
    if (!thresholdInput || !durationInput || !refreshInput) {
        return;
    }

    const settings = await getGlobalSkipframeSettings();
    thresholdInput.value = String(settings.threshold);
    durationInput.value = String(settings.skipDuration);
    refreshInput.value = String(Math.round(settings.refreshMs));

    const persistSettings = async () => {
        const threshold = Math.max(0, Number.parseInt(thresholdInput.value, 10) || POPUP_DEFAULT_MATCH_THRESHOLD);
        const skipDuration = Math.max(0, Number.parseInt(durationInput.value, 10) || POPUP_DEFAULT_SKIP_DURATION);
        const refreshMs = Math.max(10, Number.parseInt(refreshInput.value, 10) || Math.round(POPUP_DEFAULT_REFRESH_MS));

        thresholdInput.value = String(threshold);
        durationInput.value = String(skipDuration);
        refreshInput.value = String(refreshMs);

        await setGlobalSkipframeSettings({ threshold, skipDuration, refreshMs });
    };

    thresholdInput.addEventListener('change', persistSettings);
    durationInput.addEventListener('change', persistSettings);
    refreshInput.addEventListener('change', persistSettings);
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
    const skipframesStorageKey = getSeriesSkipframesStorageKey(seriesId);
    const data = await chrome.storage.local.get([skipframesStorageKey]);
    const seriesSkipframes = (data[skipframesStorageKey] || {}) as SeriesSkipframesData;
    const hashes = Array.isArray(seriesSkipframes.frameHashes) ? seriesSkipframes.frameHashes : [];
    const entries = getFrameHashEntries(seriesSkipframes);

    await chrome.storage.local.set({
        [skipframesStorageKey]: {
            frameHashes: hashes.filter((hash) => hash !== hashToRemove),
            frameHashEntries: entries.filter((entry) => entry.hash !== hashToRemove)
        }
    });
}

function getFrameHashEntries(seriesSkipframes: SeriesSkipframesData): SeriesFrameHashEntry[] {
    const result: SeriesFrameHashEntry[] = [];
    const seen = new Set<string>();

    const rawEntries = Array.isArray(seriesSkipframes.frameHashEntries) ? seriesSkipframes.frameHashEntries : [];
    for (let i = 0; i < rawEntries.length; i += 1) {
        const entry = rawEntries[i];
        if (!entry || typeof entry.hash !== 'string' || seen.has(entry.hash)) {
            continue;
        }

        seen.add(entry.hash);
        result.push({
            hash: entry.hash,
            thumbnail: typeof entry.thumbnail === 'string' ? entry.thumbnail : ''
        });
    }

    const legacyHashes = Array.isArray(seriesSkipframes.frameHashes) ? seriesSkipframes.frameHashes : [];
    for (let i = 0; i < legacyHashes.length; i += 1) {
        const hash = legacyHashes[i];
        if (!hash || seen.has(hash)) {
            continue;
        }

        seen.add(hash);
        result.push({ hash, thumbnail: '' });
    }

    return result;
}

function showFrameHashPreview(thumbnail: string, event: MouseEvent) {
    const preview = document.getElementById('framehash-preview');
    const image = document.getElementById('framehash-preview-image') as HTMLImageElement | null;
    if (!preview || !image) {
        return;
    }

    image.src = thumbnail;
    preview.style.display = 'block';

    const offset = 10;
    preview.style.left = `${event.clientX + offset}px`;
    preview.style.top = `${event.clientY + offset}px`;
}

function hideFrameHashPreview() {
    const preview = document.getElementById('framehash-preview');
    if (!preview) {
        return;
    }

    preview.style.display = 'none';
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

    const skipframesStorageKey = getSeriesSkipframesStorageKey(seriesId);
    const data = await chrome.storage.local.get([skipframesStorageKey]);
    const seriesSkipframes = (data[skipframesStorageKey] || {}) as SeriesSkipframesData;
    const entries = getFrameHashEntries(seriesSkipframes);

    if (!entries.length) {
        const empty = document.createElement('li');
        empty.textContent = 'No saved frame hashes for this series.';
        hashList.appendChild(empty);
        return;
    }

    for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        const hash = entry.hash;
        const frameLabel = `Frame ${i + 1}`;
        const item = document.createElement('li');
        item.className = 'framehash-item';

        const value = document.createElement('span');
        value.className = 'framehash-value';
        value.title = frameLabel;
        value.textContent = frameLabel;
        if (entry.thumbnail) {
            value.addEventListener('mouseenter', (event) => {
                showFrameHashPreview(entry.thumbnail || '', event as MouseEvent);
            });
            value.addEventListener('mousemove', (event) => {
                showFrameHashPreview(entry.thumbnail || '', event as MouseEvent);
            });
            value.addEventListener('mouseleave', () => {
                hideFrameHashPreview();
            });
        }

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'remove-hash-btn';
        removeButton.textContent = 'Remove';
        removeButton.addEventListener('click', async () => {
            removeButton.disabled = true;
            hideFrameHashPreview();
            await removeSeriesFrameHash(seriesId, hash);
            await renderActiveSeriesFrameHashes();
        });

        item.appendChild(value);
        item.appendChild(removeButton);
        hashList.appendChild(item);
    }
}
