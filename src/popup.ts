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
});

async function updateSkip(key: string, time: string) {
    const data = await chrome.storage.local.get(['episodes']);
    const episodes = (data.episodes || {}) as Record<string, { skipTime?: number }>;
    episodes[key] = {
        ...(episodes[key] || {}),
        skipTime: Number.parseInt(time, 10)
    };
    await chrome.storage.local.set({ episodes });
}
