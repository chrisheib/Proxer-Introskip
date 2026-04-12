
/** Parses a watch-page pathname into the extension's episode key format. */
function parseEpisodeKeyFromPathname(pathname: string): string | null {
    const path = pathname.split('/');
    if (path.length < 4 || path[1] !== 'watch') {
        console.warn('[Proxer Skip] Unable to convert pathname to episode key:', pathname);
        return null;
    }

    const seriesId = path[2];
    const episodeNumber = path[3];
    if (!seriesId || !episodeNumber) {
        console.warn('[Proxer Skip] Missing series or episode when converting pathname:', pathname);
        return null;
    }

    return `${seriesId}-${episodeNumber}`;
}

function getEpisodeKey() {
    console.log('[Proxer Skip] Current pathname:', window.location.pathname);
    const key = parseEpisodeKeyFromPathname(window.location.pathname);
    if (key) {
        console.log('[Proxer Skip] Episode key:', key);
        return key;
    }

    console.log('[Proxer Skip] Unable to parse episode key from URL');
    return null;
}

type SyncState = {
    blueStreamCode: string | null;
    hasTriggeredAutoNext: boolean;
};

const C_GLOBAL_SKIPFRAME_SETTINGS_KEY = 'globalSkipframeSettings';
const C_AUTO_NEXT_SIGNAL_KEY = 'autoNextEpisodeSignal';
const C_AUTO_NEXT_SIGNAL_TTL_MS = 15000;
const C_PENDING_PLAYER_LAUNCH_KEY = 'pendingPlayerLaunch';
const C_PENDING_PLAYER_LAUNCH_TTL_MS = 20000;

type AutoNextSignal = {
    episodeKey?: string;
    createdAt?: number;
    expiresAt?: number;
    autoStart?: boolean;
    restoreFullscreen?: boolean;
};

type ContentPendingPlayerLaunch = {
    episodeKey?: string;
    createdAt?: number;
    expiresAt?: number;
    source?: 'auto-next';
    shouldEnterFullscreen?: boolean;
};

/** Reads auto-next setting from global skipframe settings; defaults to enabled. */
async function isAutoNextEpisodeEnabled(): Promise<boolean> {
    const data = await chrome.storage.local.get([C_GLOBAL_SKIPFRAME_SETTINGS_KEY]);
    const raw = data[C_GLOBAL_SKIPFRAME_SETTINGS_KEY] || {};
    return typeof raw.autoNextEpisode === 'boolean' ? raw.autoNextEpisode : true;
}

/** Finds the episode navigation link matching the visible "Nächste >" label. */
function getNextEpisodeLink(): HTMLAnchorElement | null {
    const links = document.querySelectorAll('a');
    for (let i = 0; i < links.length; i += 1) {
        const link = links[i] as HTMLAnchorElement;
        const text = (link.textContent || '').trim();
        if (text === 'Nächste >') {
            return link;
        }
    }

    return null;
}

/** Parses a watch-page URL into the extension's episode key format. */
function parseEpisodeKeyFromWatchUrl(urlLike: string): string | null {
    try {
        const url = new URL(urlLike, window.location.href);
        return parseEpisodeKeyFromPathname(url.pathname);
    } catch (error) {
        console.warn('[Proxer Skip] Unable to convert URL to episode key:', urlLike, error);
        return null;
    }
}

/** Stores a one-shot marker so the destination iframe can auto-start after auto-next. */
async function setPendingPlayerLaunch(episodeKey: string, shouldEnterFullscreen: boolean): Promise<void> {
    const now = Date.now();
    const pendingLaunch: ContentPendingPlayerLaunch = {
        episodeKey,
        createdAt: now,
        expiresAt: now + C_PENDING_PLAYER_LAUNCH_TTL_MS,
        source: 'auto-next',
        shouldEnterFullscreen
    };

    await chrome.storage.local.set({
        [C_PENDING_PLAYER_LAUNCH_KEY]: pendingLaunch
    });
}

/** Consumes a short-lived iframe completion signal and opens next episode when available. */
async function maybeFollowNextEpisodeFromStorageSignal(episodeKey: string, state: SyncState): Promise<void> {
    if (state.hasTriggeredAutoNext) {
        return;
    }

    const data = await chrome.storage.local.get([C_AUTO_NEXT_SIGNAL_KEY]);
    const signal = (data[C_AUTO_NEXT_SIGNAL_KEY] || {}) as AutoNextSignal;
    if (signal.episodeKey !== episodeKey) {
        return;
    }

    console.debug('[Proxer Skip] Auto-next signal payload for current episode:', signal);

    if (!Number.isFinite(signal.createdAt) || !Number.isFinite(signal.expiresAt)) {
        await chrome.storage.local.remove(C_AUTO_NEXT_SIGNAL_KEY);
        return;
    }

    if (Date.now() > Number(signal.expiresAt) || Date.now() - Number(signal.createdAt) > C_AUTO_NEXT_SIGNAL_TTL_MS) {
        await chrome.storage.local.remove(C_AUTO_NEXT_SIGNAL_KEY);
        return;
    }

    const autoNextEnabled = await isAutoNextEpisodeEnabled();
    if (!autoNextEnabled) {
        console.log('[Proxer Skip] Auto-next disabled; ignoring completion signal');
        return;
    }

    const nextLink = getNextEpisodeLink();
    if (!nextLink) {
        console.log('[Proxer Skip] Completion signal found, but no next-episode link available');
        return;
    }

    const shouldAutoStart = signal.autoStart === true;
    if (shouldAutoStart) {
        const nextEpisodeKey = parseEpisodeKeyFromWatchUrl(nextLink.href);
        if (nextEpisodeKey) {
            await setPendingPlayerLaunch(nextEpisodeKey, signal.restoreFullscreen === true);
            console.log('[Proxer Skip] Stored pending player launch marker for', nextEpisodeKey);
        } else {
            console.log('[Proxer Skip] Could not derive next episode key for pending player launch');
        }
    } else {
        console.debug('[Proxer Skip] Auto-next signal does not request autostart for next episode');
    }

    await chrome.storage.local.remove(C_AUTO_NEXT_SIGNAL_KEY);
    state.hasTriggeredAutoNext = true;
    console.log('[Proxer Skip] Completion signal found; opening next episode:', nextLink.href);
    nextLink.click();
}

/** Reads inline page scripts and extracts code for stream type ps-test (blue mirror). */
function getBlueStreamCodeFromInlineScripts(): string | null {
    const scripts = document.querySelectorAll('script:not([src])');

    for (let i = 0; i < scripts.length; i += 1) {
        const text = scripts[i].textContent || '';
        if (!text.includes('var streams') || !text.includes('ps-test')) {
            continue;
        }

        // Template format observed on host page:
        // var streams = [{...},{...}];
        const streamsLiteralMatch = text.match(/var\s+streams\s*=\s*(\[[\s\S]*?\]);/);
        if (!streamsLiteralMatch || !streamsLiteralMatch[1]) {
            continue;
        }

        try {
            const parsed = JSON.parse(streamsLiteralMatch[1]) as Array<{ type?: string; code?: string }>;
            if (!Array.isArray(parsed) || parsed.length === 0) {
                continue;
            }

            const blue = parsed.find((stream) => stream && stream.type === 'ps-test' && typeof stream.code === 'string' && stream.code.length > 0);
            if (blue && blue.code) {
                return blue.code;
            }
        } catch (_error) {
            // If parsing fails for one script block, continue trying others.
        }
    }

    return null;
}

async function syncStreamIframeParams(episodeKey: string, state: SyncState) {
    const container = document.querySelector('.wStream');
    if (!container) {
        return;
    }

    const iframe = container.querySelector('iframe');
    if (!iframe) {
        return;
    }

    const src = iframe.getAttribute('src') || iframe.src || '';
    if (!src) {
        return;
    }

    try {
        const iframeUrl = new URL(src, window.location.href);
        const isSupportedHost = iframeUrl.hostname === 'stream-service.proxer.me' || iframeUrl.hostname === 'stream.proxer.me';
        if (!isSupportedHost || !iframeUrl.pathname.startsWith('/embed-')) {
            return;
        }

        if (!state.blueStreamCode) {
            const codeFromScripts = getBlueStreamCodeFromInlineScripts();
            if (codeFromScripts) {
                state.blueStreamCode = codeFromScripts;
                console.log('[Proxer Skip] Captured blue stream code from inline scripts:', codeFromScripts);
            }
        }

        let changed = false;

        if (iframeUrl.searchParams.get('ep') !== episodeKey) {
            iframeUrl.searchParams.set('ep', episodeKey);
            changed = true;
        }

        if (iframeUrl.hostname === 'stream.proxer.me' && state.blueStreamCode && iframeUrl.searchParams.get('bsid') !== state.blueStreamCode) {
            iframeUrl.searchParams.set('bsid', state.blueStreamCode);
            changed = true;
        }

        if (!changed) {
            return;
        }

        iframe.src = iframeUrl.toString();
        console.log('[Proxer Skip] Synced iframe params:', {
            episodeKey,
            blueStreamCode: state.blueStreamCode,
            host: iframeUrl.hostname
        });
    } catch (error) {
        console.warn('[Proxer Skip] Failed to sync iframe params:', error);
    }
}

/** Watches the short-lived completion signal so auto-next works even without iframe src mutations. */
function observeAutoNextSignal(episodeKey: string, state: SyncState): void {
    const checkSignal = () => {
        void maybeFollowNextEpisodeFromStorageSignal(episodeKey, state);
    };

    checkSignal();

    const intervalId = setInterval(() => {
        if (state.hasTriggeredAutoNext) {
            clearInterval(intervalId);
            return;
        }

        checkSignal();
    }, 1000);

    const onStorageChange = (changes: { [key: string]: any }, areaName: string) => {
        if (areaName !== 'local') {
            return;
        }

        if (!changes[C_AUTO_NEXT_SIGNAL_KEY]) {
            return;
        }

        checkSignal();
    };

    chrome.storage.onChanged.addListener(onStorageChange);
    window.addEventListener('beforeunload', () => {
        clearInterval(intervalId);
        chrome.storage.onChanged.removeListener(onStorageChange);
    });
}

function observeWStreamIframe(episodeKey: string, state: SyncState) {
    const tryAttach = (attempt: number) => {
        const container = document.querySelector('.wStream');
        if (!container) {
            if (attempt < 40) {
                setTimeout(() => {
                    tryAttach(attempt + 1);
                }, 250);
            }
            return;
        }

        void syncStreamIframeParams(episodeKey, state);

        const observer = new MutationObserver((mutations) => {
            for (let i = 0; i < mutations.length; i += 1) {
                const mutation = mutations[i];

                if (mutation.type === 'attributes' && mutation.attributeName === 'src' && mutation.target instanceof HTMLIFrameElement) {
                    void syncStreamIframeParams(episodeKey, state);
                    return;
                }

                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    void syncStreamIframeParams(episodeKey, state);
                    return;
                }
            }
        });

        observer.observe(container, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['src']
        });
    };

    tryAttach(0);
}

(async () => {
    console.log('[Proxer Skip] Content script started');
    const episodeKey = getEpisodeKey();
    if (!episodeKey) {
        console.log('[Proxer Skip] No episode key, exiting');
        return;
    }

    const state: SyncState = { blueStreamCode: null, hasTriggeredAutoNext: false };
    state.blueStreamCode = getBlueStreamCodeFromInlineScripts();
    if (state.blueStreamCode) {
        console.log('[Proxer Skip] Initial blue stream code from inline scripts:', state.blueStreamCode);
    }
    observeWStreamIframe(episodeKey, state);
    observeAutoNextSignal(episodeKey, state);

    // 2 seconds after load, auto-select the Proxer-Stream mirror if present and not active.
    setTimeout(async () => {
        const setting = await chrome.storage.local.get('autoSelectMirror');
        if (setting.autoSelectMirror === false) {
            console.log('[Proxer Skip] Auto-select mirror disabled, skipping');
            return;
        }
        const mirror = document.querySelector<HTMLAnchorElement>('#mirror_proxer-stream');
        if (mirror && !mirror.classList.contains('active')) {
            console.log('[Proxer Skip] Proxer-Stream mirror not active, clicking it');
            // Prevent the `javascript:void(0)` href from being followed (blocked by CSP).
            // The capturing listener runs before bubble-phase handlers, so preventDefault()
            // stops the navigation while the page's changeMirror handler still fires.
            const suppressHref = (e: Event) => {
                e.preventDefault();
                mirror.removeEventListener('click', suppressHref, true);
            };
            mirror.addEventListener('click', suppressHref, true);
            mirror.click();
        }
    }, 1000);

})();