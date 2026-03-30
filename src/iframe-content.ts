// Content script for stream.proxer.me iframe

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const FRAME_HASH_BUTTON_CLASS = 'proxer-save-framehash-btn';
const DEFAULT_SKIP_DURATION = 85;
const DEFAULT_MATCH_THRESHOLD = 10;
const DEFAULT_SCAN_INTERVAL_MS = 1000 / 30; // 30 FPS
const DEFAULT_MATCH_DEBOUNCE_MS = 3000;
const MAX_CONSECUTIVE_CAPTURE_FAILURES = 30;
const GLOBAL_SKIPFRAME_SETTINGS_KEY = 'globalSkipframeSettings';

/** Returns true when the iframe host is one of the supported stream players. */
function iIsSupportedIframeHost(): boolean {
    return window.location.hostname === 'stream.proxer.me' || window.location.hostname === 'stream-service.proxer.me';
}

/** Logs key iframe context fields that help diagnose provider-specific init and parsing issues. */
function iLogIframeContext(): void {
    console.log('[Proxer Skip] [IFRAME] Context:', {
        host: window.location.hostname,
        path: window.location.pathname,
        search: window.location.search
    });
}

/** Resolves the preferred video element for supported players, using id-first fallback logic. */
function iGetPlayerVideoElement(): HTMLVideoElement | null {
    const preferred = document.querySelector('#player');
    if (preferred instanceof HTMLVideoElement) {
        return preferred;
    }

    const fallback = document.querySelector('video');
    return fallback instanceof HTMLVideoElement ? fallback : null;
}

/** Resolves the current-time controls node used as insertion anchor for the save button. */
function iGetCurrentTimeControlAnchor(): Element | null {
    return document.querySelector('.plyr__time.plyr__time--current')
        || document.querySelector('.plyr__controls__item.plyr__time--current.plyr__time');
}

/** Loads and initializes persisted episode and series data used by both skip strategies. */
async function iLoadData() {
    console.log('[Proxer Skip] [IFRAME] Loading data...');
    let data = await chrome.storage.local.get(['episodes', 'seriesProfiles']);
    if (!data.episodes) {
        console.log('[Proxer Skip] [IFRAME] No data in storage, initializing empty...');
        const initialData = {
            episodes: {
                "75169-8": {
                    "skipTime": 51,
                    "skipDuration": 85
                }
            },
            seriesProfiles: {}
        };
        await chrome.storage.local.set(initialData);
        data = initialData;
        console.log('[Proxer Skip] [IFRAME] Storage initialized:', data);
    } else {
        console.log('[Proxer Skip] [IFRAME] Data loaded from storage:', data);
    }
    return {
        episodes: data.episodes || {},
        seriesProfiles: data.seriesProfiles || {}
    };
}

/** Resolves the current episode key so all skip and hash data can be scoped correctly. */
function iGetEpisodeKey() {
    console.log('[Proxer Skip] [IFRAME] Parsing episode key from iframe...');
    iLogIframeContext();
    const urlParams = new URLSearchParams(window.location.search);
    const ref = urlParams.get('ref');
    console.log('[Proxer Skip] [IFRAME] Ref parameter:', ref);

    if (ref) {
        // Ref format: /watch/series-id/episode-number/...
        const parts = ref.split('/');
        if (parts.length >= 4) {
            const seriesId = parts[2];
            const episodeNumber = parts[3];
            const key = `${seriesId}-${episodeNumber}`;
            console.log('[Proxer Skip] [IFRAME] Episode key:', key);
            return key;
        }
    }
    console.log('[Proxer Skip] [IFRAME] Unable to parse episode key from ref');

    if (window.location.search.includes('&ep=')) {
        const urlParams = new URLSearchParams(window.location.search);
        const ep = urlParams.get('ep');
        if (ep) {
            console.log('[Proxer Skip] [IFRAME] Episode key from URL parameter:', ep);
            return ep;
        }
    }
    return null;
}

/** Waits for the iframe video element so frame capture and seeking can start safely. */
function iWaitForPlayer(): Promise<HTMLVideoElement> {
    console.log('[Proxer Skip] [IFRAME] Waiting for Plyr player...');
    return new Promise((resolve) => {
        let attempts = 0;
        const check = () => {
            attempts += 1;
            const video = iGetPlayerVideoElement();
            if (video) {
                console.log('[Proxer Skip] [IFRAME] Plyr player found and ready');
                resolve(video);
            } else {
                if (attempts % 20 === 0) {
                    console.log('[Proxer Skip] [IFRAME] Waiting for player video element...', {
                        attempts,
                        host: window.location.hostname
                    });
                }
                setTimeout(check, 100);
            }
        };
        check();
    });
}

/** Derives the series identifier from the episode key for cross-episode hash reuse. */
function iGetSeriesId(episodeKey: string | null): string | null {
    if (!episodeKey || !episodeKey.includes('-')) {
        return null;
    }

    return episodeKey.split('-')[0];
}

/** Returns the storage key used for one series' skipframe data. */
function iGetSeriesSkipframesStorageKey(seriesId: string): string {
    return `seriesSkipframes:${seriesId}`;
}

/** Provides a shared async delay helper for spacing multi-frame hash captures. */
function iSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reuses a hidden canvas used as the single frame-processing surface for hashing. */
function iGetOrCreateHashCanvas(): HTMLCanvasElement {
    const existing = document.getElementById('proxer-framehash-canvas');
    if (existing) {
        return existing as HTMLCanvasElement;
    }

    const canvas = document.createElement('canvas');
    canvas.id = 'proxer-framehash-canvas';
    canvas.width = 9;
    canvas.height = 8;
    canvas.style.display = 'none';
    document.body.appendChild(canvas);
    return canvas;
}

/** Converts tiny frame pixels into a deterministic dHash bitstring for similarity matching. */
function iComputeDHashFromImageData(imageData: ImageData, width: number, height: number): string {
    const bytes = imageData.data;
    const luminance = new Array(width * height);

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const idx = (y * width + x) * 4;
            const r = bytes[idx];
            const g = bytes[idx + 1];
            const b = bytes[idx + 2];
            luminance[y * width + x] = (r * 299 + g * 587 + b * 114) / 1000;
        }
    }

    let bits = '';
    for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) {
            const left = luminance[y * width + x];
            const right = luminance[y * width + x + 1];
            bits += right > left ? '1' : '0';
        }
    }
    return bits;
}

/** Captures the current video frame and returns its perceptual hash marker. */
function iCaptureCurrentFrameHash(video: HTMLVideoElement): Result<string> {
    if (!video || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
        return { ok: false, error: 'Video frame is not ready for hashing' };
    }

    const canvas = iGetOrCreateHashCanvas();
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
        return { ok: false, error: 'Unable to initialize 2D canvas context' };
    }

    canvas.width = 9;
    canvas.height = 8;
    ctx.drawImage(video, 0, 0, 9, 8);
    const imageData = ctx.getImageData(0, 0, 9, 8);
    return { ok: true, value: iComputeDHashFromImageData(imageData, 9, 8) };
}

/** Captures a small frame thumbnail used for popup hover previews. */
function iCaptureCurrentFrameThumbnail(video: HTMLVideoElement): Result<string> {
    if (!video || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
        return { ok: false, error: 'Video frame is not ready for thumbnail capture' };
    }

    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 96;
    thumbCanvas.height = 54;

    const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true });
    if (!thumbCtx) {
        return { ok: false, error: 'Unable to initialize thumbnail canvas context' };
    }

    thumbCtx.drawImage(video, 0, 0, thumbCanvas.width, thumbCanvas.height);
    return { ok: true, value: thumbCanvas.toDataURL('image/jpeg', 0.7) };
}

/** Computes hash similarity as Hamming distance for threshold-based jump decisions. */
function iHammingDistance(a: string | null | undefined, b: string | null | undefined): number {
    if (!a || !b || a.length !== b.length) {
        return Number.POSITIVE_INFINITY;
    }

    let distance = 0;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) {
            distance += 1;
        }
    }

    return distance;
}

/** Persists per-episode time-based skip configuration as compatibility fallback behavior. */
async function iSaveSkipTime(episodeKey: string, timeSeconds: string | number): Promise<void> {
    const data = await chrome.storage.local.get(['episodes']);
    const episodes = data.episodes || {};
    episodes[episodeKey] = {
        ...(episodes[episodeKey] || {}),
        skipTime: Number.parseInt(String(timeSeconds), 10),
        skipDuration: (episodes[episodeKey] && episodes[episodeKey].skipDuration) || DEFAULT_SKIP_DURATION
    };
    await chrome.storage.local.set({ episodes });
}

/** Persists and deduplicates series-level frame hash markers used for future episode detection. */
async function iSaveSeriesFrameHashes(seriesId: string, markers: Array<{ hash: string; thumbnail?: string }>) {
    const skipframesStorageKey = iGetSeriesSkipframesStorageKey(seriesId);
    const data = await chrome.storage.local.get([skipframesStorageKey]);
    const seriesSkipframes = data[skipframesStorageKey] || {};
    const existingHashes = Array.isArray(seriesSkipframes.frameHashes) ? seriesSkipframes.frameHashes : [];
    const existingEntries = Array.isArray(seriesSkipframes.frameHashEntries) ? seriesSkipframes.frameHashEntries : [];
    const dedupMap: Record<string, { hash: string; thumbnail: string }> = {};

    for (const entry of existingEntries) {
        if (entry && entry.hash) {
            dedupMap[entry.hash] = {
                hash: entry.hash,
                thumbnail: typeof entry.thumbnail === 'string' ? entry.thumbnail : ''
            };
        }
    }

    for (const hash of existingHashes) {
        if (hash && !dedupMap[hash]) {
            dedupMap[hash] = { hash, thumbnail: '' };
        }
    }

    for (const marker of markers) {
        if (!marker || !marker.hash) {
            continue;
        }

        const current = dedupMap[marker.hash];
        dedupMap[marker.hash] = {
            hash: marker.hash,
            thumbnail: marker.thumbnail || (current ? current.thumbnail : '') || ''
        };
    }

    const frameHashEntries = [];
    for (const key of Object.keys(dedupMap)) {
        frameHashEntries.push(dedupMap[key]);
    }
    const frameHashes = [];
    for (const entry of frameHashEntries) {
        frameHashes.push(entry.hash);
    }

    await chrome.storage.local.set({
        [skipframesStorageKey]: {
            frameHashes,
            frameHashEntries
        }
    });

    return {
        frameHashes,
        frameHashEntries
    };
}

/** Loads global skipframe matching settings used across all series. */
async function iGetGlobalSkipframeSettings() {
    const data = await chrome.storage.local.get([GLOBAL_SKIPFRAME_SETTINGS_KEY]);
    const raw = data[GLOBAL_SKIPFRAME_SETTINGS_KEY] || {};

    const threshold = Number.isFinite(raw.threshold) && raw.threshold >= 0
        ? raw.threshold
        : DEFAULT_MATCH_THRESHOLD;
    const skipDuration = Number.isFinite(raw.skipDuration) && raw.skipDuration >= 0
        ? raw.skipDuration
        : DEFAULT_SKIP_DURATION;
    const refreshMs = Number.isFinite(raw.refreshMs) && raw.refreshMs >= 10
        ? raw.refreshMs
        : DEFAULT_SCAN_INTERVAL_MS;

    return {
        threshold,
        skipDuration,
        refreshMs
    };
}

/** Shows a short-lived toast at the old top-right Set Skip Time button position. */
function iShowSaveToast(video: HTMLVideoElement, message: string): void {
    const container = video.parentElement || document.body;
    container.style.position = 'relative';

    const existingToast = container.querySelector('#proxer-save-toast');
    if (existingToast) {
        existingToast.remove();
    }

    const toast = document.createElement('div');
    toast.id = 'proxer-save-toast';
    toast.textContent = message;
    toast.style.cssText = `
    position: absolute;
    top: 10px;
    right: 10px;
    z-index: 1000;
    background: rgba(0, 0, 0, 0.78);
    color: white;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 4px;
    padding: 5px 10px;
    font-size: 12px;
    opacity: 0;
    transition: opacity 150ms ease;
  `;

    container.appendChild(toast);
    requestAnimationFrame(() => {
        toast.style.opacity = '1';
    });

    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => {
            toast.remove();
        }, 180);
    }, 1800);
}

/** Adds the manual skip-time setup button for episodes without existing timing data. */
function iAddSkipButton(video: HTMLVideoElement, episodeKey: string): void {
    console.log('[Proxer Skip] [IFRAME] Adding skip button');
    const button = document.createElement('button');
    button.textContent = 'Set Skip Time';
    button.style.cssText = `
    position: absolute;
    top: 10px;
    right: 10px;
    z-index: 1000;
    background: rgba(0,0,0,0.7);
    color: white;
    border: none;
    padding: 5px 10px;
    cursor: pointer;
    border-radius: 4px;
  `;
    button.onclick = async () => {
        console.log('[Proxer Skip] [IFRAME] Skip button clicked');
        const time = prompt('Enter skip time in seconds (e.g., 90 for opening):');
        if (time && !isNaN(Number(time))) {
            console.log('[Proxer Skip] [IFRAME] Saving skip time for', episodeKey, ':', time);
            try {
                await iSaveSkipTime(episodeKey, time);
                console.log('[Proxer Skip] [IFRAME] Skip time saved');
                alert('Skip time saved!');
                button.remove();
            } catch (error) {
                console.error('[Proxer Skip] [IFRAME] Failed to save skip time:', error);
                alert('Failed to save skip time. See console for details.');
            }
        } else {
            console.log('[Proxer Skip] [IFRAME] Invalid time entered:', time);
        }
    };

    const container = video.parentElement || document.body;
    container.style.position = 'relative';
    container.appendChild(button);
    console.log('[Proxer Skip] [IFRAME] Skip button added');
}

/** Injects the control-bar framehash button that records marker hashes from the live frame. */
function iInjectFrameHashButton(video: HTMLVideoElement, seriesId: string): void {
    const insertButton = () => {
        const controls = document.querySelector('.plyr__controls');
        const currentTime = iGetCurrentTimeControlAnchor();

        if (!controls || !currentTime) {
            return false;
        }

        if (controls.querySelector(`.${FRAME_HASH_BUTTON_CLASS}`)) {
            return true;
        }

        const button = document.createElement('button');
        button.type = 'button';
        button.className = `plyr__control ${FRAME_HASH_BUTTON_CLASS}`;
        button.textContent = 'Save Skipframe';
        button.title = 'Save skipframe hashes for auto-skip detection';
        button.style.marginLeft = '8px';
        button.style.height = '32px';
        button.style.padding = '0px 5px';

        button.addEventListener('click', async () => {
            button.disabled = true;
            const previousText = button.textContent;
            button.textContent = 'Saving...';

            try {
                const hashResult = iCaptureCurrentFrameHash(video);
                const thumbResult = iCaptureCurrentFrameThumbnail(video);
                if (hashResult.ok === false) {
                    throw new Error(hashResult.error);
                }
                if (thumbResult.ok === false) {
                    throw new Error(thumbResult.error);
                }
                const profile = await iSaveSeriesFrameHashes(seriesId, [
                    { hash: hashResult.value, thumbnail: thumbResult.value }
                ]);
                console.log('[Proxer Skip] [IFRAME] Saved frame hash list for series', seriesId, profile);
                iShowSaveToast(video, `Saved skipframe (${profile.frameHashes.length} total)`);
            } catch (error) {
                console.error('[Proxer Skip] [IFRAME] Failed to save frame hashes:', error);
                alert('Failed to capture frame hashes. Canvas may be blocked by cross-origin media.');
            } finally {
                button.disabled = false;
                button.textContent = previousText;
            }
        });

        currentTime.insertAdjacentElement('afterend', button);
        console.log('[Proxer Skip] [IFRAME] Save Framehash button inserted after current time element');
        return true;
    };

    if (insertButton()) {
        return;
    }

    let attempts = 0;
    const intervalId = setInterval(() => {
        attempts += 1;
        if (insertButton() || attempts > 100) {
            clearInterval(intervalId);
        }
    }, 100);
}

/** Runs the bounded hash scan loop that auto-jumps when a saved marker is detected. */
function iStartFrameHashMatching(video: HTMLVideoElement, seriesId: string): void {
    const skipframesStorageKey = iGetSeriesSkipframesStorageKey(seriesId);
    chrome.storage.local.get([skipframesStorageKey], async (data: { [key: string]: any }) => {
        const seriesSkipframes = data[skipframesStorageKey] || {};
        const hashes = Array.isArray(seriesSkipframes.frameHashes) ? seriesSkipframes.frameHashes : [];

        if (!hashes.length) {
            console.log('[Proxer Skip] [IFRAME] No frame hashes configured for series', seriesId);
            return;
        }

        const settings = await iGetGlobalSkipframeSettings();
        const threshold = settings.threshold;
        const skipDuration = settings.skipDuration;
        const refreshMs = settings.refreshMs;

        let debounceUntilMs = 0;
        let consecutiveCaptureFailures = 0;
        console.log('[Proxer Skip] [IFRAME] Starting frame hash matching with profile:', {
            seriesId,
            threshold,
            skipDuration,
            refreshMs,
            hashCount: hashes.length,
            debounceMs: DEFAULT_MATCH_DEBOUNCE_MS
        });

        const intervalId = setInterval(() => {
            if (video.ended || video.paused) {
                return;
            }

            if (video.readyState < 2) {
                return;
            }

            if (Date.now() < debounceUntilMs) {
                return;
            }

            const now = video.currentTime;

            const hashResult = iCaptureCurrentFrameHash(video);
            if (hashResult.ok === false) {
                consecutiveCaptureFailures += 1;
                if (consecutiveCaptureFailures === 1 || consecutiveCaptureFailures % 10 === 0) {
                    console.warn('[Proxer Skip] [IFRAME] Frame hash capture unavailable:', {
                        error: hashResult.error,
                        consecutiveCaptureFailures
                    });
                }

                if (consecutiveCaptureFailures >= MAX_CONSECUTIVE_CAPTURE_FAILURES) {
                    console.warn('[Proxer Skip] [IFRAME] Stopping frame hash matching after repeated capture failures');
                    clearInterval(intervalId);
                }
                return;
            }

            consecutiveCaptureFailures = 0;
            const currentHash = hashResult.value;
            // console.log('[Proxer Skip] [IFRAME] Captured current frame hash at', now, ':', currentHash);

            for (const hash of hashes) {
                const distance = iHammingDistance(currentHash, hash);
                if (distance <= threshold) {
                    const jumpTarget = now + skipDuration;
                    console.log('[Proxer Skip] [IFRAME] Frame hash matched; jumping to', jumpTarget, 'distance', distance);
                    video.currentTime = jumpTarget;
                    debounceUntilMs = Date.now() + DEFAULT_MATCH_DEBOUNCE_MS;
                    return;
                }
            }
        }, refreshMs);
    });
}

(async () => {
    console.log('[Proxer Skip] [IFRAME] Content script started');
    if (!iIsSupportedIframeHost()) {
        console.log('[Proxer Skip] [IFRAME] Unsupported host, exiting early:', window.location.hostname);
        return;
    }

    // console.log('[Proxer Skip] [IFRAME] Full HTML:', document.documentElement.outerHTML);
    const video = await iWaitForPlayer();
    const episodeKey = iGetEpisodeKey();
    if (!episodeKey) {
        console.log('[Proxer Skip] [IFRAME] No episode key, exiting');
        return;
    }

    const seriesId = iGetSeriesId(episodeKey);
    if (!seriesId) {
        console.log('[Proxer Skip] [IFRAME] No series id, exiting');
        return;
    }

    const data = await iLoadData();
    const episodes = data.episodes;
    const episodeData = episodes[episodeKey];
    console.log('[Proxer Skip] [IFRAME] Episode data available:', Boolean(episodeData));

    iInjectFrameHashButton(video, seriesId);
    iStartFrameHashMatching(video, seriesId);

    if (!episodeData) {
        console.log('[Proxer Skip] [IFRAME] No data for episode; Set Skip Time button is hidden');
        // iAddSkipButton(video, episodeKey);
    } else {
        console.log('[Proxer Skip] [IFRAME] Data exists, skipping button');
    }
})();
