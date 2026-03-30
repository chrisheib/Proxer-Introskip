
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

(async () => {
    console.log('[Proxer Skip] Content script started');
    const episodeKey = getEpisodeKey();
    if (!episodeKey) {
        console.log('[Proxer Skip] No episode key, exiting');
        return;
    }

    const iframe = document.querySelector('iframe');
    if (iframe) {
        if (iframe.src.includes('https://stream-service.proxer.me/embed')) {
            try {
                const iframeUrl = new URL(iframe.src);
                iframeUrl.searchParams.set('ep', episodeKey);
                iframe.src = iframeUrl.toString();
                console.log('[Proxer Skip] Iframe found, passing episode key:', episodeKey);
            } catch (error) {
                console.warn('[Proxer Skip] Failed to append ep to iframe URL:', error);
            }
        }
    }

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