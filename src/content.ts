
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

function syncBlueIframeEpisodeKey(episodeKey: string) {
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
        if (iframeUrl.hostname !== 'stream-service.proxer.me' || !iframeUrl.pathname.startsWith('/embed-')) {
            return;
        }

        if (iframeUrl.searchParams.get('ep') === episodeKey) {
            return;
        }

        iframeUrl.searchParams.set('ep', episodeKey);
        iframe.src = iframeUrl.toString();
        console.log('[Proxer Skip] Synced blue iframe ep key:', episodeKey);
    } catch (error) {
        console.warn('[Proxer Skip] Failed to sync blue iframe ep key:', error);
    }
}

function observeWStreamIframe(episodeKey: string) {
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

        syncBlueIframeEpisodeKey(episodeKey);

        const observer = new MutationObserver((mutations) => {
            for (let i = 0; i < mutations.length; i += 1) {
                const mutation = mutations[i];

                if (mutation.type === 'attributes' && mutation.attributeName === 'src' && mutation.target instanceof HTMLIFrameElement) {
                    syncBlueIframeEpisodeKey(episodeKey);
                    return;
                }

                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    syncBlueIframeEpisodeKey(episodeKey);
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

    observeWStreamIframe(episodeKey);

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