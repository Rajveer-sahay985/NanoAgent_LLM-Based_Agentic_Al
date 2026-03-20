const log = document.getElementById("log");
const runBtn = document.getElementById("run");
const stopBtn = document.getElementById("stop");
let keepRunning = false;
let actionHistory = [];
let agentMemory = [];

function write(msg, type = "") {
    if (document.querySelector('.empty-state')) log.innerHTML = '';
    const wrapper = document.createElement("div"); wrapper.className = "msg-wrapper";
    const div = document.createElement("div");
    if (type === "result-card") { div.innerHTML = msg; div.className = "msg msg-card"; }
    else {
        div.textContent = msg;
        if (type === "user") div.className = "msg msg-user";
        else if (type === "ai") div.className = "msg msg-ai";
        else if (type === "error") div.className = "msg msg-err";
        else if (type === "debug") div.className = "msg-debug";
        else div.className = "msg";
    }
    wrapper.appendChild(div); log.appendChild(wrapper); log.scrollTop = log.scrollHeight;
}

async function clearOverlays() {
    try {
        let allTabs = await chrome.tabs.query({ currentWindow: true });
        for (let t of allTabs) {
            try {
                await chrome.scripting.executeScript({
                    target: { tabId: t.id },
                    func: () => document.querySelectorAll(".nano-overlay").forEach(el => el.remove())
                });
            } catch (e) { }
        }
    } catch (e) { }
}

function DOMScanner(showOverlays) {
    document.querySelectorAll(".nano-overlay").forEach(el => el.remove());
    function getUniqueSelector(el) {
        if (el.id) return '#' + el.id;
        let path = []; let current = el;
        while (current && current.nodeType === Node.ELEMENT_NODE) {
            let selector = current.nodeName.toLowerCase();
            if (current.parentElement) {
                let siblings = Array.from(current.parentElement.children);
                if (siblings.length > 1) selector += ':nth-child(' + (siblings.indexOf(current) + 1) + ')';
            }
            path.unshift(selector); current = current.parentElement;
        }
        return path.join(' > ');
    }

    // 🛡️ V7.57: NOISE DETECTOR — checks if element is inside a sidebar, footer, or nav noise zone
    function isNoiseContainer(el) {
        let parent = el;
        for (let i = 0; i < 5 && parent; i++) {
            const role = (parent.getAttribute('role') || '').toLowerCase();
            const ariaLabel = (parent.getAttribute('aria-label') || '').toLowerCase();
            const tag = parent.tagName;
            const id = (parent.id || '').toLowerCase();
            const cls = (parent.className || '').toString().toLowerCase();

            // Skip sidebar navigation, footers, cookie banners
            if (role === 'navigation' && parent !== el) return true;
            if (role === 'complementary') return true;
            if (tag === 'FOOTER' || tag === 'ASIDE') return true;
            if (id.includes('sidebar') || id.includes('side-nav') || id.includes('cookie') || id.includes('consent')) return true;
            if (cls.includes('sidebar') || cls.includes('side-nav') || cls.includes('cookie-banner') || cls.includes('footer')) return true;
            if (ariaLabel.includes('sidebar') || ariaLabel.includes('cookie')) return true;

            parent = parent.parentElement;
        }
        return false;
    }

    const targets = document.querySelectorAll("input, button, a[href], textarea, select, [role='button'], [role='checkbox'], label, span, p, strong, b, h1, h2, h3, h4, h5, h6, div, pre, code, td, [contenteditable='true'], video, audio");

    const visibleTargets = Array.from(targets).filter(el => {
        if (el.tagName === "CANVAS" || el.tagName === "SVG" || el.tagName === "PATH") return false;

        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 10 && rect.height > 10 &&
            rect.top >= 0 && rect.top <= window.innerHeight &&
            rect.left >= 0 && rect.left <= window.innerWidth &&
            style.visibility !== 'hidden' && style.opacity !== '0' && style.display !== 'none';
    });

    const meaningfulElements = visibleTargets.filter(el => {
        if (el.tagName === "INPUT" && (el.className || "").includes("name-input")) return false;
        if (el.id && el.id.includes("name-box")) return false;

        const tag = el.tagName;
        const isInput = ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(tag) || el.isContentEditable;
        const isLink = tag === "A" && el.href;
        const isInteractive = el.getAttribute("role") === "button" || window.getComputedStyle(el).cursor === "pointer";
        const text = (el.innerText || "").trim();
        const isPrice = /[\$₹£€]/.test(text) && text.length > 0 && text.length < 40;
        const isLeafText = el.childElementCount === 0 && text.length > 0 && text.length < 80;

        // Always include spreadsheet formula bars
        if (el.id && el.id.toLowerCase().includes("formula-bar")) return true;
        if (el.id && el.id.toLowerCase().includes("formulabar")) return true;
        if ((el.getAttribute('aria-label') || "").toLowerCase().includes("formula bar")) return true;

        // 🛡️ Reject oversized containers (full-page divs)
        const rect = el.getBoundingClientRect();
        if (rect.width > window.innerWidth * 0.8 || rect.height > window.innerHeight * 0.8) {
            if (!el.isContentEditable) return false;
        }

        // 🛡️ Skip empty decorative elements
        if (!isInput && !isLink && text.length === 0) return false;

        // 🛡️ Skip sidebar/footer/nav noise (but NEVER skip inputs or main content)
        if (!isInput && isNoiseContainer(el)) return false;

        return isInput || isLink || isInteractive || isPrice || isLeafText;
    });

    // 🔥 DEDUPLICATION — collapse elements at same grid position
    const uniqueElements = [];
    const seenCoordinates = new Set();
    for (let el of meaningfulElements) {
        const rect = el.getBoundingClientRect();
        const gridKey = `${Math.round(rect.top / 10)}-${Math.round(rect.left / 10)}`;
        if (!seenCoordinates.has(gridKey)) {
            seenCoordinates.add(gridKey);
            uniqueElements.push(el);
        }
    }

    // 🔥 PRIORITY SCORING — rank by actionability, then cap at 50
    const scored = uniqueElements.map(el => {
        let priority = 0;
        const tag = el.tagName;
        if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || el.isContentEditable) priority = 100;
        else if (tag === "BUTTON" || el.getAttribute("role") === "button" || tag === "VIDEO") priority = 90;
        else if (tag === "A" && el.href) priority = 80;
        else if (window.getComputedStyle(el).cursor === "pointer") priority = 75;
        else if (/[\$₹£€]/.test((el.innerText || "").trim())) priority = 70;
        else priority = 50;
        return { el, priority };
    });

    scored.sort((a, b) => b.priority - a.priority);
    const finalElements = scored.slice(0, 50);

    return finalElements.map((item, index) => {
        const el = item.el;
        let text = "";
        if (el.tagName === "A" && el.getAttribute("aria-label")) {
            text = el.getAttribute("aria-label");
        } else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) {
            text = el.value || el.placeholder || el.innerText || "Rich Text Field";
        } else {
            text = (el.innerText || "").trim();
        }

        text = text.substring(0, 40).replace(/\n/g, " ");
        let fullHref = el.href || "";
        let displayHref = fullHref.length > 60 ? fullHref.substring(0, 60) + "..." : fullHref;

        if (showOverlays) {
            const rect = el.getBoundingClientRect();
            const div = document.createElement("div"); div.className = "nano-overlay";
            div.style.position = "fixed"; div.style.left = rect.left + "px"; div.style.top = rect.top + "px";
            div.style.width = rect.width + "px"; div.style.height = rect.height + "px";
            div.style.border = "2px solid #06b6d4"; div.style.borderRadius = "4px"; div.style.zIndex = "999999"; div.style.pointerEvents = "none";
            const badge = document.createElement("div"); badge.innerText = index;
            badge.style.position = "absolute"; badge.style.top = "-18px"; badge.style.left = "-2px";
            badge.style.background = "#06b6d4"; badge.style.color = "#0f172a"; badge.style.fontWeight = "bold"; badge.style.fontSize = "11px"; badge.style.padding = "2px 6px"; badge.style.borderRadius = "4px";
            div.appendChild(badge); document.body.appendChild(div);
        }
        return { index: index, tag: el.tagName, text: text || "[No Text]", href: displayHref, fullHref: fullHref, sel: getUniqueSelector(el) };
    });
}

// 💥 V7.57 EXPLICIT ERROR HANDLING UPDATE 💥
async function callLLM(goal, domElements, apiKey, modelName, history, memory, url, temperature, provider, baseUrl, tabsListString) {
    const visibleElementsString = JSON.stringify(domElements.map(e => `${e.index}: <${e.tag}> ${e.text} ${e.href ? '(URL: ' + e.href + ')' : ''}`));

    const prompt = `YOU ARE A STRICT, SEQUENTIAL BROWSER AGENT.
USER GOAL: "${goal}"
CURRENT URL: "${url}"
AVAILABLE TABS: ${tabsListString}
RECENT ACTIONS: ${history.slice(-32).join(" | ")}
SAVED MEMORY: ${memory.join(" | ")}

VISIBLE ELEMENTS:
${visibleElementsString}

STEP 0 — CLASSIFY THE TASK (do this silently before choosing an action):
- NAVIGATION TASK: The user ONLY wants to GO somewhere or SEARCH. Goal is met when the target is VISIBLE. Do NOT click into results.
- EXTRACTION TASK: The user wants you to FIND and REPORT info. Goal is met ONLY AFTER you use extract_info on EVERY required target. If you found what you need on the CURRENT page, you MUST 'navigate' or 'switch_tab' to find the rest! Do NOT extract the same thing twice.
- ACTION TASK: The user wants you to DO something (e.g., click, type, pause, open multiple things). Goal is met ONLY when EVERY requested action is physically completed. If the prompt has multiple steps (e.g. "open tabs AND do X"), it is a complex ACTION TASK.

CRITICAL DIRECTIVES:
1. STRICT MULTI-STEP RULE: If the request has multiple items (e.g., "get 3 titles"), DO NOT declare "is_goal_met: true" until EVERY SINGLE item is in SAVED MEMORY!
2. ADAPTIVE INTELLIGENCE: If a search yields "no matches found" or an error, pivot your strategy (e.g., try different search terms, or navigate directly via URL).
3. SPREADSHEET GOD-MODE: If on a spreadsheet page AND fully loaded, use "inject_data" action for input. Target_index 0. Use normal actions elsewhere.
4. THE TAB RULE: Never say goal met just because a tab opened, UNLESS opening the tab was the *only* instruction given.
5. EFFICIENT URLS: You may use direct handles if you know them (e.g., youtube.com/@markiplier/videos). If unknown, navigate to the site and search.
6. ONE ACTION PER TURN: Never extract and navigate in the same step.
7. TAB MANAGEMENT: 'new_tab' opens tabs silently in the BACKGROUND. IMPORTANT: You MUST read the 'AVAILABLE TABS' array to find the exact Tab Number of the page you want, then use 'switch_tab' to make it [ACTIVE]. Do NOT guess tab numbers!
8. NO BLIND EXTRACTIONS: You can ONLY extract information from the currently [ACTIVE] tab. If the active tab is an internal page or lacks the data, you MUST switch tabs first. Do NOT hallucinate data!
9. MEDIA PLAYBACK: To pause or play a video or audio file, explicitly click the media player itself or its play/pause button. Do not search for a text input to pause.
10. AVOID REPEATS: Once an item appears in SAVED MEMORY, you MUST NOT extract it again. Your next step must be to find the next item.
11. SHORT REASONING: Keep under 15 words. Start with "[NAVIGATION]", "[EXTRACTION]", or "[ACTION]".

RESPONSE FORMAT MUST BE EXACT JSON:
{
  "reasoning": "[TASK_TYPE] Brief 10-word summary",
  "is_goal_met": true/false,
  "action": "click" | "type" | "scroll" | "finish" | "new_tab" | "navigate" | "extract_info" | "switch_tab" | "inject_data",
  "target_index": number (DOM index or Tab Number),
  "value": "RAW TEXT ONLY. To open a specific element's link in a new tab, use 'new_tab' action with its target_index."
}`;

    let retries = 3;
    while (retries > 0) {
        try {
            if (provider === "openai") {
                const endpoint = baseUrl || "https://api.openai.com/v1/chat/completions";
                const response = await fetch(endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
                    body: JSON.stringify({
                        model: modelName,
                        messages: [{ role: "user", content: prompt }],
                        temperature: temperature,
                        response_format: { type: "json_object" }
                    })
                });

                // 💥 V7.57: TRUTH TELLER ERROR CATCHER 💥
                if (!response.ok) {
                    if (response.status === 404) throw new Error(`HTTP 404 (Not Found): The Model or Endpoint does not exist. (Did you send an OpenRouter model to Gemini?)`);
                    if (response.status === 402) throw new Error(`HTTP 402 (Payment Required): You have run out of credits on this provider (e.g. OpenRouter). Please top up your balance.`);
                    if (response.status === 401) throw new Error(`HTTP 401 (Unauthorized): Invalid API Key.`);
                    throw new Error(`HTTP ${response.status}: Server error or bad request.`);
                }

                const data = await response.json();
                if (data.error) throw new Error(data.error.message);

                let contentText = data.choices[0].message.content;
                if (contentText.startsWith("\`\`\`")) {
                    contentText = contentText.replace(/^\`\`\`(json)?\n/, "").replace(/\n\`\`\`$/, "");
                }
                return JSON.parse(contentText);
            } else {
                let fullModelName = modelName.startsWith("models/") ? modelName : `models/${modelName}`;
                const apiUrl = `https://generativelanguage.googleapis.com/v1beta/${fullModelName}:generateContent?key=${apiKey}`;
                const response = await fetch(apiUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: { responseMimeType: "application/json", temperature: temperature }
                    })
                });

                // 💥 V7.57: TRUTH TELLER ERROR CATCHER 💥
                if (!response.ok) {
                    let exactErrorMsg = `HTTP ${response.status}: Server error or bad request.`;
                    try {
                        const errorData = await response.json();
                        if (errorData && errorData.error && errorData.error.message) {
                            exactErrorMsg = `HTTP ${response.status}: ${errorData.error.message}`;
                        }
                    } catch (e) { }

                    if (response.status === 404) throw new Error(`HTTP 404 (Not Found): Model '${modelName}' not found. (Did you select Gemini but enter an OpenRouter model?)`);
                    if (response.status === 401) throw new Error(`HTTP 401 (Unauthorized): Invalid API Key.`);

                    throw new Error(exactErrorMsg);
                }

                const data = await response.json();
                if (data.error) throw new Error(data.error.message);
                return JSON.parse(data.candidates[0].content.parts[0].text);
            }
        } catch (error) {
            retries--;
            if (retries === 0) throw error;
            // Only retry on network drop or 500s. Do not retry 404/401s to save time.
            if (error.message.includes("404") || error.message.includes("401")) throw error;
            console.log("API Error caught. Retrying...", error);
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
}

runBtn.onclick = async () => {
    keepRunning = true; actionHistory = []; agentMemory = [];
    let lastActionKey = "";
    let loopCounter = 0;
    runBtn.style.display = "none"; stopBtn.style.display = "block"; log.innerHTML = "";

    write("Verifying Authorization...", "debug");
    try {
        const authRes = await fetch("http://localhost:3000/api/auth-status");
        await authRes.json();
    } catch (err) {
        // Backend offline -> no problem, extension is standalone now!
        console.log("Local WhatsApp bridge is offline. Continuing in standalone mode.");
    }

    const goal = document.getElementById("prompt").value;
    const showBoxes = document.getElementById("show-boxes").checked;

    const { apiKey, plannerModel, navigatorModel, model, temperature, apiProvider, baseUrl } = await chrome.storage.sync.get(['apiKey', 'plannerModel', 'navigatorModel', 'model', 'temperature', 'apiProvider', 'baseUrl']);

    if (!apiKey) {
        write("No API Key found. Click Settings.", "error");
        runBtn.style.display = "block"; stopBtn.style.display = "none"; return;
    }

    const selectedProvider = apiProvider || "gemini";
    const defaultModel = selectedProvider === "gemini" ? "gemini-1.5-flash" : "meta-llama/llama-3.3-70b-instruct:free";
    const selectedPlanner = plannerModel || model || defaultModel;
    const selectedNavigator = navigatorModel || model || defaultModel;
    const selectedTemp = temperature !== undefined ? parseFloat(temperature) : 0.7;

    write(`Using Provider: ${selectedProvider.toUpperCase()}`, "debug");
    write(`[PLANNER] ${selectedPlanner}`, "debug");
    write(`[NAVIGATOR] ${selectedNavigator}`, "debug");
    write(goal, "user");

    let recentActionKeys = [];
    for (let step = 1; step <= 25; step++) {
        if (!keepRunning) break;
        write(`[Step ${step}] Analyzing DOM...`, "debug");

        try {
            let allTabs = await chrome.tabs.query({ currentWindow: true });
            let tabsListStr = allTabs.map((t, i) => `Tab ${i}${t.active ? " [ACTIVE]" : ""}: ${t.title ? t.title.substring(0, 25) : "Loading"} - ${t.url.substring(0, 45)}...`).join(" | ");

            let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            let elements = [];

            // 🛡️ V7.57: Detect restricted browser pages where scripting is blocked
            const isRestrictedPage = /^(chrome|edge|vivaldi|brave|opera|about|chrome-extension):\/\//.test(tab.url || "");

            if (isRestrictedPage) {
                write(`[!] Internal browser page detected. Skipping DOM scan.`, "debug");
                elements = [{ index: 0, tag: "INFO", text: "[BROWSER INTERNAL PAGE - No DOM available. Use 'navigate' or 'new_tab' to go to a website URL.]", href: "" }];
            } else {
                try {
                    const scanResults = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: DOMScanner, args: [showBoxes] });
                    if (scanResults && scanResults[0] && scanResults[0].result) {
                        elements = scanResults[0].result;
                    } else {
                        elements = [];
                    }
                } catch (scanErr) {
                    if (scanErr.message.includes("frame with id 0") || scanErr.message.includes("Cannot access contents")) {
                        write("[!] Website crashed or timed out. Injecting recovery sequence...", "error");
                        elements = [{ index: 0, tag: "ERROR", text: "[PAGE FAILED TO LOAD. SERVER DEAD. NAVIGATE AWAY IMMEDIATELY.]", href: "" }];
                        actionHistory.push("[CRITICAL ERROR]: The last URL you navigated to is broken. You MUST abandon this site and 'navigate' somewhere else.");
                    } else {
                        // 🛡️ Catch-all: Don't kill the loop on unexpected scan errors
                        write(`[!] DOM scan failed: ${scanErr.message}. Continuing with no elements.`, "debug");
                        elements = [{ index: 0, tag: "INFO", text: "[DOM SCAN FAILED - Use 'navigate' or 'new_tab' to go to a website URL.]", href: "" }];
                    }
                }
            }

            // 🔥 V7.57: Dual-Brain Routing — Planner for Step 1, Navigator for execution
            const activeModel = (step === 1) ? selectedPlanner : selectedNavigator;
            const activeRole = (step === 1) ? "PLANNER" : "NAVIGATOR";
            write(`${activeRole} -> ${activeModel}`, "debug");

            const plan = await callLLM(goal, elements, apiKey, activeModel, actionHistory, agentMemory, tab.url, selectedTemp, selectedProvider, baseUrl, tabsListStr);
            write(plan.reasoning, "ai");

            if (plan.is_goal_met === true || plan.action === "finish") {
                write(`[DONE] Agent confirms task is complete: ${plan.value || ""}`, "debug");
                if (agentMemory.length > 0) {
                    agentMemory.forEach(m => write(m, "result-card"));

                    // 📱 V7.57: Send extraction data to WhatsApp
                    try {
                        const waRes = await fetch("http://localhost:3000/api/whatsapp-send", {
                            method: "POST",
                            headers: { "Content-Type": "application/json; charset=utf-8" },
                            body: JSON.stringify({
                                message: `*NanoAgent Extraction*\n\n${agentMemory.map(m => m.replace('[SAVE] ', '- ')).join('\n')}\n\n_Task: ${goal}_`
                            })
                        });
                        const waData = await waRes.json();
                        if (waData.sent) write("[WHATSAPP] Extraction sent!", "debug");
                        else if (waData.error) write(`[WHATSAPP] Error: ${waData.error}`, "debug");
                    } catch (e) {
                        write("[WHATSAPP] Delivery skipped.", "debug");
                    }
                }
                break;
            }

            let safePlanValue = plan.value;
            if (typeof safePlanValue === 'object' && safePlanValue !== null) { safePlanValue = JSON.stringify(safePlanValue); }

            let actionContext = tab.url ? tab.url.split('?')[0].split('#')[0] : tab.id;
            if (plan.action === "new_tab" || plan.action === "navigate" || plan.action === "switch_tab") actionContext = "nav";
            const currentActionKey = `${plan.action}-${actionContext}-${plan.action === "new_tab" || plan.action === "navigate" ? safePlanValue : plan.target_index}`;

            recentActionKeys.push(currentActionKey);
            if (recentActionKeys.length > 8) recentActionKeys.shift();

            const occurrences = recentActionKeys.filter(k => k === currentActionKey && plan.action !== "scroll" && plan.action !== "switch_tab").length;

            if (occurrences >= 3) {
                write(`[!] Loop Trap Detected. Forcing reroute...`, "error");
                let trapMsg = `[SYSTEM FATAL BLOCK]: You are caught in a loop trying to ${plan.action} on index ${plan.target_index}. THIS IS A TRAP. Pick a new target or change your action.`;
                if (plan.action === "new_tab") trapMsg = `[SYSTEM FATAL BLOCK]: You are endlessly spawning background tabs! STOP. You MUST use 'switch_tab' (using the Tab Number from AVAILABLE TABS) to move your vision to the tabs you just created before you do anything else!`;
                actionHistory.push(trapMsg);
                await new Promise(r => setTimeout(r, 3000));
                continue;
            }
            lastActionKey = currentActionKey;

            actionHistory.push(`Step ${step}: ${plan.action} ${safePlanValue ? `"${safePlanValue}"` : ""} on index ${plan.target_index || "N/A"}`);

            if (plan.action === "switch_tab" && typeof plan.target_index === "number") {
                let targetTab = allTabs[plan.target_index];
                if (targetTab) {
                    write(`[TAB] Switching to Tab ${plan.target_index}...`, "debug");
                    await chrome.tabs.update(targetTab.id, { active: true });
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
            else if (plan.action === "new_tab" || plan.action === "navigate") {
                let targetUrl = safePlanValue || "";

                // 🚀 V7.57 NEW: Natively open grabbed DOM Elements in New Tabs (Priority over hallucinated text)
                if (typeof plan.target_index === "number") {
                    const targetEl = elements.find(e => e.index === plan.target_index);
                    if (targetEl && targetEl.fullHref && targetEl.fullHref !== "" && !targetEl.fullHref.startsWith("javascript:")) {
                        targetUrl = targetEl.fullHref;
                        write(`[NATIVE] Extracted URL from element ${plan.target_index} (${targetUrl.substring(0, 40)}...)`, "debug");
                    }
                }

                // Clear LLM hallucinations for empty links
                if (targetUrl === plan.action || targetUrl === "null" || targetUrl === "undefined") {
                    targetUrl = "";
                }

                if (targetUrl.includes("openweather.org") && !targetUrl.includes("openweathermap.org")) {
                    targetUrl = targetUrl.replace("openweather.org", "openweathermap.org");
                }

                if (targetUrl.startsWith("javascript:")) {
                    actionHistory.push(`[SYSTEM BLOCK] Cannot open a javascript: link in a new tab. If this is a button, try using the 'click' action instead!`);
                    write("[WAIT] Error Cooldown (3s)...", "debug");
                    await new Promise(r => setTimeout(r, 3000));
                    continue;
                }

                if (!targetUrl || targetUrl.trim() === "") {
                    actionHistory.push(`[SYSTEM BLOCK] Empty or invalid URL provided. You must provide a valid URL in 'value' OR a target_index that contains an href link.`);
                    write("[WAIT] Error Cooldown (3s)...", "debug");
                    await new Promise(r => setTimeout(r, 3000));
                    continue;
                }
                if (!targetUrl.startsWith("http") && !targetUrl.startsWith("chrome://")) targetUrl = "https://" + targetUrl;

                if (plan.action === "new_tab") {
                    write(`Opening Background Tab: ${targetUrl}`, "debug");
                    // 🚀 V7.57 NEW: Open new tabs in background so the agent doesn't lose its context!
                    await chrome.tabs.create({ url: targetUrl, active: false });
                }
                else {
                    write(`Navigating to: ${targetUrl}`, "debug");
                    await chrome.tabs.update(tab.id, { url: targetUrl });
                    write("[WAIT] Waiting for page to hydrate...", "debug");
                    await new Promise(r => setTimeout(r, 4000));
                }
            }
            else if (plan.action === "scroll") {
                write("Scrolling page content...", "debug");
                await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.scrollBy({ top: 700, behavior: 'smooth' }) });
                await new Promise(r => setTimeout(r, 2000));
            }
            else if (plan.action === "extract_info" || plan.action === "extract") {
                let foundText = "";

                if (typeof plan.target_index === "number") {
                    const el = elements.find(e => e.index === plan.target_index);
                    if (el && el.text !== "[No Text]") foundText = el.text;
                }

                if (!foundText && safePlanValue && safePlanValue.length > 3 && safePlanValue !== "[No Text]" && !safePlanValue.includes("[latest_")) {
                    foundText = safePlanValue;
                }

                if (foundText) {
                    // 🛡️ V7.57: Block duplicate extractions at the CODE level
                    const isDuplicate = agentMemory.some(m => m.includes(foundText));
                    if (isDuplicate) {
                        write(`[!] Duplicate extraction blocked: [${foundText}]`, "debug");
                        actionHistory.push(`[SYSTEM OVERRIDE] You already have "${foundText}" in SAVED MEMORY. Do NOT extract it again! Navigate to the NEXT target NOW.`);
                    } else {
                        write(`Memorized: [${foundText}]`, "ai");
                        agentMemory.push("[SAVE] " + foundText);
                        actionHistory.push(`[SYSTEM] Successfully saved "${foundText}". ${agentMemory.length} item(s) in memory. If more items are needed, NAVIGATE to the next target now!`);
                    }
                } else {
                    write(`[!] Extraction failed. Invalid target or empty value.`, "error");
                    actionHistory.push(`[SYSTEM BLOCK] Extraction failed. You MUST provide a valid 'value' string. Do not extract '[No Text]'.`);
                }
            }

            else if (plan.action === "inject_data") {
                write(`Executing [CHEAT CODE: FOCUS + PASTE] into active cell...`, "debug");
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    world: "MAIN",
                    func: (val) => {
                        let centerX = window.innerWidth / 2;
                        let centerY = window.innerHeight / 2;
                        let canvas = document.elementFromPoint(centerX, centerY);

                        if (canvas) {
                            canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: centerX, clientY: centerY }));
                            canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: centerX, clientY: centerY }));
                        }

                        setTimeout(() => {
                            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, composed: true }));

                            setTimeout(() => {
                                document.execCommand('insertText', false, val);

                                setTimeout(() => {
                                    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, composed: true }));
                                }, 200);
                            }, 200);
                        }, 200);
                    },
                    args: [safePlanValue || ""]
                });
                await new Promise(r => setTimeout(r, 3000));
            }

            else if (typeof plan.target_index === "number") {
                const target = elements.find(e => e.index === plan.target_index);
                if (target) {
                    if (target.tag === "INFO" || target.tag === "ERROR") {
                        actionHistory.push(`[SYSTEM BLOCK] You CANNOT interact (click/type) with a system message! You must use 'navigate' to visit a real URL first.`);
                        write(`[!] Attempted to interact with system message. Blocked.`, "error");
                        await new Promise(r => setTimeout(r, 3000));
                        continue;
                    }
                    write(`Executing [${plan.action.toUpperCase()}] on [${target.text.substring(0, 20)}]`, "debug");

                    await chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        world: "MAIN",
                        func: async (sel, action, value, elementHref) => {
                            const el = document.querySelector(sel);
                            if (!el) {
                                console.error("[NanoAgent] Element not found for selector:", sel);
                                return;
                            }
                            let tEl = el.closest('button, a, [role="button"], input, [contenteditable="true"]') || el;
                            tEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
                            tEl.focus();

                            if (action === "type") {
                                const delay = (ms) => new Promise(r => setTimeout(r, ms));
                                let nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
                                let nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;

                                if (tEl.isContentEditable) {
                                    tEl.focus();
                                    document.execCommand('selectAll', false, null);
                                    document.execCommand('delete', false, null);
                                    for (let i = 0; i < value.length; i++) {
                                        document.execCommand('insertText', false, value[i]);
                                        await delay(30);
                                    }
                                } else {
                                    const setter = tEl.tagName === 'TEXTAREA' ? nativeTextAreaValueSetter : nativeInputValueSetter;
                                    // Clear field first
                                    if (setter) { setter.call(tEl, ''); } else { tEl.value = ''; }
                                    tEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));

                                    // Type character by character
                                    for (let i = 0; i < value.length; i++) {
                                        const partial = value.substring(0, i + 1);
                                        if (setter) { setter.call(tEl, partial); } else { tEl.value = partial; }
                                        tEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                                        await delay(30);
                                    }
                                }

                                tEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                            } else {
                                const originalOpen = window.open;
                                window.open = function (url) { window.location.href = url; return window; };
                                const evtOpts = { bubbles: true, composed: true, cancelable: true, view: window };
                                tEl.dispatchEvent(new PointerEvent('pointerover', evtOpts));
                                tEl.dispatchEvent(new PointerEvent('pointerenter', evtOpts));
                                tEl.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ buttons: 1 }, evtOpts)));
                                tEl.dispatchEvent(new PointerEvent('pointerup', evtOpts));
                                tEl.dispatchEvent(new MouseEvent('mousedown', Object.assign({ buttons: 1 }, evtOpts)));
                                tEl.dispatchEvent(new MouseEvent('mouseup', evtOpts));

                                // Aggressive Click: Click both the exact element and its actionable parent
                                el.click();
                                if (tEl !== el) tEl.click();

                                // SPA Fallback (e.g. YouTube): Ensure we hit the main anchor if nested
                                const anchor = el.closest('a#thumbnail') || el.closest('a.yt-simple-endpoint') || el.closest('a');
                                if (anchor && anchor !== el && anchor !== tEl) {
                                    anchor.click();
                                }
                                setTimeout(() => { window.open = originalOpen; }, 1000);

                                // Ironclad Action Fallback: Force URL navigation if standard click injection fails SPAs
                                if (elementHref) {
                                    setTimeout(() => { if (!window.location.href.includes(elementHref)) window.location.href = elementHref; }, 800);
                                } else if (tEl.tagName === 'A' && tEl.href) {
                                    setTimeout(() => { if (!window.location.href.includes(tEl.href)) window.location.href = tEl.href; }, 800);
                                }
                            }
                        },
                        args: [target.sel || "", plan.action || "", safePlanValue || "", target.fullHref || ""]
                    });
                    await new Promise(r => setTimeout(r, 3000));
                }
            }

            write("[WAIT] API Cooldown (3s)...", "debug");
            await new Promise(r => setTimeout(r, 3000));

        } catch (err) {
            // 💥 V7.57: EXPLICIT ERROR ROUTING 💥
            write(`System Error: ${err.message}`, "error");
            if (err.message.includes("QUOTA_EXCEEDED") || err.message.includes("429")) {
                write("[WAIT] API Quota hit. Pausing for 10s...", "error");
                for (let w = 0; w < 10; w++) {
                    if (!keepRunning) break;
                    await new Promise(r => setTimeout(r, 1000));
                }
                if (keepRunning) { step--; continue; } else { break; }
            } else { break; }
        }
    }
    keepRunning = false;
    stopBtn.style.display = "none"; runBtn.style.display = "block"; write("Agent Disengaged.", "debug");
    clearOverlays();
};

stopBtn.onclick = () => {
    keepRunning = false;
    write("[STOP] Aborting Mission. Shutting down loops...", "error");
    clearOverlays();
};

// 📱 V7.57: WhatsApp Remote Control Poller
setInterval(async () => {
    if (keepRunning) return; // Do not interrupt an active agent

    try {
        const res = await fetch("http://localhost:3000/api/whatsapp-poll");
        const data = await res.json();

        if (data && data.task) {
            write(`[WHATSAPP] Remote task received!`, "debug");
            // Populate the prompt box
            document.getElementById("prompt").value = data.task;
            // Auto-trigger the execution
            runBtn.click();
        }
    } catch (e) {
        // Silently ignore HTTP errors if backend is offline
    }
}, 3000);