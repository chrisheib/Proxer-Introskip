
function getEpisodeKey() {
    const path = window.location.pathname.split('/');
    console.log('[Proxer Skip] Current pathname:', window.location.pathname);
    // URL: https://proxer.me/watch/75169/8/engsub#top
    // Extract anime ID and episode number from URL path
    // URL format: /watch/{id}/{episode}/...
    if (path.length >= 4) {
        const id = path[2];
        const episode = path[3];
        const key = `${id}-${episode}`;
        console.log('[Proxer Skip] Episode key:', key);
        return key;
    }
    console.log('[Proxer Skip] Unable to parse episode key from URL');
    return null;
}

type SyncState = {
    blueStreamCode: string | null;
};

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

function syncStreamIframeParams(episodeKey: string, state: SyncState) {
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

        syncStreamIframeParams(episodeKey, state);

        const observer = new MutationObserver((mutations) => {
            for (let i = 0; i < mutations.length; i += 1) {
                const mutation = mutations[i];

                if (mutation.type === 'attributes' && mutation.attributeName === 'src' && mutation.target instanceof HTMLIFrameElement) {
                    syncStreamIframeParams(episodeKey, state);
                    return;
                }

                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    syncStreamIframeParams(episodeKey, state);
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

    const state: SyncState = { blueStreamCode: null };
    state.blueStreamCode = getBlueStreamCodeFromInlineScripts();
    if (state.blueStreamCode) {
        console.log('[Proxer Skip] Initial blue stream code from inline scripts:', state.blueStreamCode);
    }
    observeWStreamIframe(episodeKey, state);

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