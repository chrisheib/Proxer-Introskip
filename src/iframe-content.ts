// Content script for stream.proxer.me iframe

const FRAME_HASH_BUTTON_CLASS = 'proxer-save-framehash-btn';
const DEFAULT_SKIP_TIME = 90;
const DEFAULT_SKIP_DURATION = 85;
const DEFAULT_MATCH_THRESHOLD = 8;
const DEFAULT_SCAN_INTERVAL_MS = 1000 / 30; // 30 FPS
const DEFAULT_FRAME_GAP_MS = 800;

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
        const check = () => {
            const video = document.querySelector('video');
            if (video) {
                console.log('[Proxer Skip] [IFRAME] Plyr player found and ready');
                resolve(video);
            } else {
                setTimeout(check, 100);
            }
        };
        check();
    });
}

/** Derives the series identifier from the episode key for cross-episode hash reuse. */
function iGetSeriesId(episodeKey) {
    if (!episodeKey || !episodeKey.includes('-')) {
        return null;
    }

    return episodeKey.split('-')[0];
}

/** Provides a shared async delay helper for spacing multi-frame hash captures. */
function iSleep(ms) {
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
function iComputeDHashFromImageData(imageData, width, height) {
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
function iCaptureCurrentFrameHash(video) {
    if (!video || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
        throw new Error('Video frame is not ready for hashing');
    }

    const canvas = iGetOrCreateHashCanvas();
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
        throw new Error('Unable to initialize 2D canvas context');
    }

    canvas.width = 9;
    canvas.height = 8;
    ctx.drawImage(video, 0, 0, 9, 8);
    const imageData = ctx.getImageData(0, 0, 9, 8);
    return iComputeDHashFromImageData(imageData, 9, 8);
}

/** Captures a small frame thumbnail used for popup hover previews. */
function iCaptureCurrentFrameThumbnail(video) {
    if (!video || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
        throw new Error('Video frame is not ready for thumbnail capture');
    }

    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 96;
    thumbCanvas.height = 54;

    const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true });
    if (!thumbCtx) {
        throw new Error('Unable to initialize thumbnail canvas context');
    }

    thumbCtx.drawImage(video, 0, 0, thumbCanvas.width, thumbCanvas.height);
    return thumbCanvas.toDataURL('image/jpeg', 0.7);
}

/** Computes hash similarity as Hamming distance for threshold-based jump decisions. */
function iHammingDistance(a, b) {
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
async function iSaveSkipTime(episodeKey, timeSeconds) {
    const data = await chrome.storage.local.get(['episodes']);
    const episodes = data.episodes || {};
    episodes[episodeKey] = {
        ...(episodes[episodeKey] || {}),
        skipTime: Number.parseInt(timeSeconds, 10),
        skipDuration: (episodes[episodeKey] && episodes[episodeKey].skipDuration) || DEFAULT_SKIP_DURATION
    };
    await chrome.storage.local.set({ episodes });
}

/** Persists and deduplicates series-level frame hash markers used for future episode detection. */
async function iSaveSeriesFrameHashes(seriesId, markers) {
    const data = await chrome.storage.local.get(['seriesProfiles']);
    const seriesProfiles = data.seriesProfiles || {};
    const existing = seriesProfiles[seriesId] || {};
    const existingHashes = Array.isArray(existing.frameHashes) ? existing.frameHashes : [];
    const existingEntries = Array.isArray(existing.frameHashEntries) ? existing.frameHashEntries : [];
    const dedupMap = {};

    for (let i = 0; i < existingEntries.length; i += 1) {
        const entry = existingEntries[i];
        if (entry && entry.hash) {
            dedupMap[entry.hash] = {
                hash: entry.hash,
                thumbnail: typeof entry.thumbnail === 'string' ? entry.thumbnail : ''
            };
        }
    }

    for (let i = 0; i < existingHashes.length; i += 1) {
        const hash = existingHashes[i];
        if (hash && !dedupMap[hash]) {
            dedupMap[hash] = { hash, thumbnail: '' };
        }
    }

    for (let i = 0; i < markers.length; i += 1) {
        const marker = markers[i];
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
    const dedupKeys = Object.keys(dedupMap);
    for (let i = 0; i < dedupKeys.length; i += 1) {
        frameHashEntries.push(dedupMap[dedupKeys[i]]);
    }
    const frameHashes = [];
    for (let i = 0; i < frameHashEntries.length; i += 1) {
        frameHashes.push(frameHashEntries[i].hash);
    }

    seriesProfiles[seriesId] = {
        ...existing,
        frameHashes,
        frameHashEntries,
        frameGapMs: existing.frameGapMs || DEFAULT_FRAME_GAP_MS,
        threshold: existing.threshold || DEFAULT_MATCH_THRESHOLD,
        skipDuration: existing.skipDuration || DEFAULT_SKIP_DURATION
    };

    await chrome.storage.local.set({ seriesProfiles });
    return seriesProfiles[seriesId];
}

/** Shows a short-lived toast at the old top-right Set Skip Time button position. */
function iShowSaveToast(video, message) {
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
function iAddSkipButton(video, episodeKey) {
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
function iInjectFrameHashButton(video, seriesId) {
    const insertButton = () => {
        const controls = document.querySelector('.plyr__controls');
        const currentTime = document.querySelector('.plyr__time.plyr__time--current');

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

        button.addEventListener('click', async () => {
            button.disabled = true;
            const previousText = button.textContent;
            button.textContent = 'Saving...';

            try {
                const firstHash = iCaptureCurrentFrameHash(video);
                const firstThumbnail = iCaptureCurrentFrameThumbnail(video);
                await iSleep(DEFAULT_FRAME_GAP_MS);
                const secondHash = iCaptureCurrentFrameHash(video);
                const secondThumbnail = iCaptureCurrentFrameThumbnail(video);
                const profile = await iSaveSeriesFrameHashes(seriesId, [
                    { hash: firstHash, thumbnail: firstThumbnail },
                    { hash: secondHash, thumbnail: secondThumbnail }
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
function iStartFrameHashMatching(video, seriesId, fallbackSkipDuration) {
    chrome.storage.local.get(['seriesProfiles'], (data) => {
        const seriesProfiles = data.seriesProfiles || {};
        const profile = seriesProfiles[seriesId];
        const hashes = profile && Array.isArray(profile.frameHashes) ? profile.frameHashes : [];

        if (!hashes.length) {
            console.log('[Proxer Skip] [IFRAME] No frame hashes configured for series', seriesId);
            return;
        }

        const threshold = profile.threshold || DEFAULT_MATCH_THRESHOLD;
        const skipDuration = profile.skipDuration || fallbackSkipDuration || DEFAULT_SKIP_DURATION;

        let hasJumped = false;
        console.log('[Proxer Skip] [IFRAME] Starting frame hash matching with profile:', {
            seriesId,
            threshold,
            skipDuration,
            hashCount: hashes.length
        });
        const intervalId = setInterval(() => {
            if (hasJumped || video.ended || video.paused) {
                return;
            }

            const now = video.currentTime;

            let currentHash;
            try {
                currentHash = iCaptureCurrentFrameHash(video);
            } catch (error) {
                console.warn('[Proxer Skip] [IFRAME] Frame hash capture unavailable:', error);
                // clearInterval(intervalId);
                return;
            }
            // console.log('[Proxer Skip] [IFRAME] Captured current frame hash at', now, ':', currentHash);

            for (let i = 0; i < hashes.length; i += 1) {
                const distance = iHammingDistance(currentHash, hashes[i]);
                if (distance <= threshold) {
                    const jumpTarget = now + skipDuration;
                    console.log('[Proxer Skip] [IFRAME] Frame hash matched; jumping to', jumpTarget, 'distance', distance);
                    video.currentTime = jumpTarget;
                    hasJumped = true;
                    clearInterval(intervalId);
                    return;
                }
            }
        }, DEFAULT_SCAN_INTERVAL_MS);
    });
}

(async () => {
    console.log('[Proxer Skip] [IFRAME] Content script started');
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
    const skipTime = episodeData ? episodeData.skipTime : DEFAULT_SKIP_TIME;
    const skipDuration = episodeData ? episodeData.skipDuration : DEFAULT_SKIP_DURATION;
    console.log('[Proxer Skip] [IFRAME] Skip time for', episodeKey, ':', skipTime);

    iInjectFrameHashButton(video, seriesId);
    iStartFrameHashMatching(video, seriesId, skipDuration);

    // let skipped = false;
    // video.ontimeupdate = () => {
    //     if (video.currentTime >= skipTime && video.currentTime < skipTime + 5 && !skipped) {
    //         // console.log('[Proxer Skip] [IFRAME] Prompting to skip at', player.currentTime);
    //         console.log('[Proxer Skip] [IFRAME] skip, setting time to', skipTime + skipDuration);
    //         video.currentTime = skipTime + skipDuration;
    //         skipped = true;
    //         // if (confirm('Skip opening?')) {
    //         //     console.log('[Proxer Skip] [IFRAME] User confirmed skip, setting time to', skipTime);
    //         // } else {
    //         //     console.log('[Proxer Skip] [IFRAME] User declined skip');
    //         // }
    //     }
    // };

    if (!episodeData) {
        console.log('[Proxer Skip] [IFRAME] No data for episode; Set Skip Time button is hidden');
        // iAddSkipButton(video, episodeKey);
    } else {
        console.log('[Proxer Skip] [IFRAME] Data exists, skipping button');
    }
})();
