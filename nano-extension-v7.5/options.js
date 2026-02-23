const status = document.getElementById("status");
document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.sync.get(['apiKey', 'model'], (items) => {
        if (items.apiKey) document.getElementById('apiKey').value = items.apiKey;
        if (items.model) {
            const select = document.getElementById('model');
            const option = document.createElement("option");
            option.value = items.model;
            option.text = items.model;
            option.selected = true;
            select.add(option);
        }
    });
});
document.getElementById('fetchModels').addEventListener('click', async () => {
    const apiKey = document.getElementById('apiKey').value;
    if (!apiKey) { alert("Enter API Key"); return; }
    status.textContent = "Fetching...";
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const data = await response.json();
        const select = document.getElementById('model');
        select.innerHTML = "";
        data.models.filter(m => m.supportedGenerationMethods?.includes("generateContent")).forEach(m => {
            const option = document.createElement("option");
            option.value = m.name.replace("models/", ""); 
            option.text = m.displayName;
            select.appendChild(option);
        });
        status.textContent = "Models loaded.";
    } catch (e) { status.textContent = "Error: " + e.message; }
});
document.getElementById('save').addEventListener('click', () => {
    const apiKey = document.getElementById('apiKey').value;
    const model = document.getElementById('model').value;
    chrome.storage.sync.set({ apiKey, model }, () => {
        status.textContent = "Saved!";
        setTimeout(() => status.textContent = "", 2000);
    });
});