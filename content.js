// Content script for proxer.me

async function loadData() {
    console.log('[Proxer Skip] Loading data...');
    let data = await chrome.storage.local.get('episodes');
    if (!data.episodes) {
        console.log('[Proxer Skip] No local data, loading from data.json...');
        // Load initial data from data.json
        const response = await fetch(chrome.runtime.getURL('data.json'));
        const initialData = await response.json();
        await chrome.storage.local.set(initialData);
        data = initialData;
        console.log('[Proxer Skip] Initial data loaded:', data);
    } else {
        console.log('[Proxer Skip] Data loaded from storage:', data);
    }
    return data.episodes || {};
}

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

function waitForPlayer() {
    console.log('[Proxer Skip] Waiting for Plyr player...');
    return new Promise((resolve) => {
        const check = () => {
            const playerElement = document.querySelector('#player');
            const player = playerElement?.plyr;
            if (player && player.ready) {
                console.log('[Proxer Skip] Plyr player found and ready');
                resolve(player);
            } else {
                setTimeout(check, 100);
            }
        };
        check();
    });
}

function addSkipButton(player) {
    console.log('[Proxer Skip] Adding skip button');
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
  `;
    button.onclick = () => {
        console.log('[Proxer Skip] Skip button clicked');
        const time = prompt('Enter skip time in seconds (e.g., 90 for opening):');
        if (time && !isNaN(time)) {
            const episodeKey = getEpisodeKey();
            console.log('[Proxer Skip] Saving skip time for', episodeKey, ':', time);
            chrome.storage.local.get(['episodes'], (data) => {
                const episodes = data.episodes || {};
                episodes[episodeKey] = { skipTime: parseInt(time) };
                chrome.storage.local.set({ episodes });
                console.log('[Proxer Skip] Skip time saved');
                alert('Skip time saved!');
                button.remove(); // Remove button after setting
            });
        } else {
            console.log('[Proxer Skip] Invalid time entered:', time);
        }
    };
    // Append to player's container
    const container = player.elements.container;
    container.style.position = 'relative';
    container.appendChild(button);
    console.log('[Proxer Skip] Skip button added');
}

(async () => {
    console.log('[Proxer Skip] Content script started');
    // const player = await waitForPlayer();
    const episodeKey = getEpisodeKey();
    if (!episodeKey) {
        console.log('[Proxer Skip] No episode key, exiting');
        return;
    }

    let iframe = document.querySelector('iframe');
    if (iframe) {
        if (iframe.src.includes('https://stream-service.proxer.me/embed')) {
            iframe.src += '&ep=' + episodeKey; // Pass episode key
            console.log('[Proxer Skip] Iframe found, passing episode key:', episodeKey);
        }
    }

    // const episodes = await loadData();
    // const episodeData = episodes[episodeKey];
    // const skipTime = episodeData ? episodeData.skipTime : 90; // Default to 90s
    // console.log('[Proxer Skip] Skip time for', episodeKey, ':', skipTime);

    // let prompted = false;
    // player.on('timeupdate', () => {
    //     console.log('[Proxer Skip] Time update:', player.currentTime);
    //     if (player.currentTime >= skipTime && player.currentTime < skipTime + 5 && !prompted) {
    //         console.log('[Proxer Skip] Prompting to skip at', player.currentTime);
    //         prompted = true;
    //         if (confirm('Skip opening?')) {
    //             console.log('[Proxer Skip] User confirmed skip, setting time to', skipTime);
    //             player.currentTime = skipTime;
    //         } else {
    //             console.log('[Proxer Skip] User declined skip');
    //         }
    //     }
    // });

    // // If no data for this episode, add button to set it
    // if (!episodeData) {
    //     console.log('[Proxer Skip] No data for episode, adding button');
    //     addSkipButton(player);
    // } else {
    //     console.log('[Proxer Skip] Data exists, skipping button');
    // }
})();