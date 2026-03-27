document.addEventListener('DOMContentLoaded', async () => {
    const list = document.getElementById('episodes-list');
    const data = await chrome.storage.local.get('episodes');
    const episodes = data.episodes || {};

    for (const [key, value] of Object.entries(episodes)) {
        const li = document.createElement('li');
        li.innerHTML = `
      ${key}: <input type="number" value="${value.skipTime}" onchange="updateSkip('${key}', this.value)">
    `;
        list.appendChild(li);
    }
});

function updateSkip(key, time) {
    chrome.storage.local.get(['episodes'], (data) => {
        const episodes = data.episodes || {};
        episodes[key] = { skipTime: parseInt(time) };
        chrome.storage.local.set({ episodes });
    });
}