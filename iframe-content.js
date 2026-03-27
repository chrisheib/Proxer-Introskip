// Content script for stream.proxer.me iframe

async function loadData() {
    console.log('[Proxer Skip] [IFRAME] Loading data...');
    let data = await chrome.storage.local.get('episodes');
    if (!data.episodes) {
        console.log('[Proxer Skip] [IFRAME] No data in storage, initializing empty...');
        const initialData = {
            episodes: {
                "75169-8": {
                    "skipTime": 51,
                    "skipDuration": 90
                }
            }
        };
        await chrome.storage.local.set(initialData);
        data = initialData;
        console.log('[Proxer Skip] [IFRAME] Storage initialized:', data);
    } else {
        console.log('[Proxer Skip] [IFRAME] Data loaded from storage:', data);
    }
    return data.episodes || {};
}

function getEpisodeKey() {
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

function waitForPlayer() {
    console.log('[Proxer Skip] [IFRAME] Waiting for Plyr player...');
    return new Promise((resolve) => {
        const check = () => {
            const player = document.querySelector('video');
            if (player) {
                console.log('[Proxer Skip] [IFRAME] Plyr player found and ready');
                resolve(player);
            } else {
                setTimeout(check, 100);
            }
        };
        check();
    });
}

function addSkipButton(player) {
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
    button.onclick = () => {
        console.log('[Proxer Skip] [IFRAME] Skip button clicked');
        const time = prompt('Enter skip time in seconds (e.g., 90 for opening):');
        if (time && !isNaN(time)) {
            const episodeKey = getEpisodeKey();
            console.log('[Proxer Skip] [IFRAME] Saving skip time for', episodeKey, ':', time);
            chrome.storage.local.get(['episodes'], (data) => {
                const episodes = data.episodes || {};
                episodes[episodeKey] = { skipTime: parseInt(time), skipDuration: 90 };
                chrome.storage.local.set({ episodes });
                console.log('[Proxer Skip] [IFRAME] Skip time saved');
                alert('Skip time saved!');
                button.remove();
            });
        } else {
            console.log('[Proxer Skip] [IFRAME] Invalid time entered:', time);
        }
    };
    const container = player.elements.container;
    container.style.position = 'relative';
    container.appendChild(button);
    console.log('[Proxer Skip] [IFRAME] Skip button added');
}

(async () => {
    console.log('[Proxer Skip] [IFRAME] Content script started');
    // console.log('[Proxer Skip] [IFRAME] Full HTML:', document.documentElement.outerHTML);
    const player = await waitForPlayer();
    const episodeKey = getEpisodeKey();
    if (!episodeKey) {
        console.log('[Proxer Skip] [IFRAME] No episode key, exiting');
        return;
    }

    const episodes = await loadData();
    const episodeData = episodes[episodeKey];
    const skipTime = episodeData ? episodeData.skipTime : 90;
    const skipDuration = episodeData ? episodeData.skipDuration : 90;
    console.log('[Proxer Skip] [IFRAME] Skip time for', episodeKey, ':', skipTime);

    let skipped = false;
    player.ontimeupdate = () => {
        if (player.currentTime >= skipTime && player.currentTime < skipTime + 5 && !skipped) {
            // console.log('[Proxer Skip] [IFRAME] Prompting to skip at', player.currentTime);
            console.log('[Proxer Skip] [IFRAME] skip, setting time to', skipTime + skipDuration);
            player.currentTime = skipTime + skipDuration;
            skipped = true;
            // if (confirm('Skip opening?')) {
            //     console.log('[Proxer Skip] [IFRAME] User confirmed skip, setting time to', skipTime);
            // } else {
            //     console.log('[Proxer Skip] [IFRAME] User declined skip');
            // }
        }
    };

    if (!episodeData) {
        console.log('[Proxer Skip] [IFRAME] No data for episode, adding button');
        addSkipButton(player);
    } else {
        console.log('[Proxer Skip] [IFRAME] Data exists, skipping button');
    }
})();
