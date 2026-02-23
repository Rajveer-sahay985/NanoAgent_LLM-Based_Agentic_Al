const log = document.getElementById("log");
const runBtn = document.getElementById("run");
const stopBtn = document.getElementById("stop");
let keepRunning = false;
let actionHistory = [];
let agentMemory = []; // New persistent memory array!

function write(msg, type = "") {
    const div = document.createElement("div");
    if (type === "result-card") div.innerHTML = msg; 
    else div.textContent = msg;
    if (type) div.className = type;
    div.style.padding = "2px 0";
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
}

// --- 1. VISUAL SCANNER ---
function DOMScanner(showOverlays) {
    document.querySelectorAll(".nano-overlay").forEach(el => el.remove());

    function getUniqueSelector(el) {
        if (el.id) return '#' + el.id;
        let path = [];
        let current = el;
        while (current && current.nodeType === Node.ELEMENT_NODE) {
            let selector = current.nodeName.toLowerCase();
            if (current.parentElement) {
                let siblings = Array.from(current.parentElement.children);
                if (siblings.length > 1) {
                    let index = siblings.indexOf(current) + 1;
                    selector += ':nth-child(' + index + ')';
                }
            }
            path.unshift(selector);
            current = current.parentElement;
        }
        return path.join(' > ');
    }

    const targets = document.querySelectorAll("input, button, a[href], textarea, select, [role='button'], [role='checkbox'], label, span, div.a-section");
    const visibleTargets = Array.from(targets).filter(el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top <= window.innerHeight && style.visibility !== 'hidden';
    });

    const meaningfulElements = visibleTargets.filter(el => {
        return (el.tagName === "INPUT") || 
               (el.innerText && el.innerText.length > 2) || 
               (el.getAttribute("aria-label")) ||
               (window.getComputedStyle(el).cursor === 'pointer');
    });

    return meaningfulElements.slice(0, 60).map((el, index) => {
        let text = (el.innerText || "").substring(0, 50).replace(/\n/g, " ").trim();
        let placeholder = (el.placeholder || "").substring(0, 30);
        let label = (el.getAttribute("aria-label") || "").substring(0, 30);
        
        if (showOverlays) {
            const rect = el.getBoundingClientRect();
            const div = document.createElement("div");
            div.className = "nano-overlay";
            div.style.position = "fixed";
            div.style.left = rect.left + "px";
            div.style.top = rect.top + "px";
            div.style.width = rect.width + "px";
            div.style.height = rect.height + "px";
            div.style.border = "2px solid #ff0000"; 
            div.style.zIndex = "999999";
            div.style.pointerEvents = "none";
            
            const badge = document.createElement("div");
            badge.innerText = index;
            badge.style.position = "absolute";
            badge.style.top = "-15px";
            badge.style.left = "0";
            badge.style.background = "red";
            badge.style.color = "white";
            badge.style.fontSize = "10px";
            badge.style.padding = "1px 4px";
            div.appendChild(badge);
            document.body.appendChild(div);
        }
        return { index: index, tag: el.tagName, text: text || placeholder || label || "[No Text]", sel: getUniqueSelector(el) };
    });
}

// --- 2. EXTRACTOR ---
function extractResults() {
    const items = [];
    const elements = document.querySelectorAll('*');
    elements.forEach(el => {
        const text = el.innerText || "";
        if ((text.includes('₹') || text.includes('$') || text.includes('Rs')) && text.length < 100 && text.length > 5) {
            let card = el.parentElement;
            while (card && card.innerText.length < 300) { card = card.parentElement; }
            if (card && !items.includes(card.innerText)) {
                items.push(card.innerText.split('\n')[0] + " - " + text);
            }
        }
    });
    return [...new Set(items)].slice(0, 5);
}

// --- 3. BRAIN (WITH MEMORY) ---
async function callGemini(goal, domElements, apiKey, modelName, history, memory, url) {
    let fullModelName = modelName.startsWith("models/") ? modelName : `models/${modelName}`;
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/${fullModelName}:generateContent?key=${apiKey}`;

    const prompt = `YOU ARE A HIGHLY CAPABLE BROWSER AGENT.
USER GOAL: "${goal}"
CURRENT URL: "${url}"
PAST ACTIONS: ${history.join(" | ")}
SAVED MEMORY: ${memory.join(" | ")}

VISIBLE ELEMENTS ON PAGE:
${JSON.stringify(domElements.map(e => `${e.index}: <${e.tag}> ${e.text}`)) }

CRITICAL INSTRUCTIONS:
1. NO LOOPS: Read PAST ACTIONS. If you already opened a site and searched, DO NOT do it again.
2. URLs: For "new_tab" or "navigate", you MUST provide a full URL with https:// (e.g. "https://www.google.com").
3. MULTI-SITE RESEARCH: If comparing items across sites: Go to Site A -> Search -> Use "extract_info" to save the price to SAVED MEMORY -> Go to Site B -> Search -> Use "extract_info" -> Finish.
4. TO SAVE DATA: Action "extract_info" MUST include the target_index of the element containing the price/data.
5. If the data you need is in SAVED MEMORY, use "finish" to stop and present it.

RESPONSE FORMAT MUST BE VALID JSON:
{
  "reasoning": "Explain step-by-step logic",
  "action": "click" | "type" | "scroll" | "finish" | "new_tab" | "navigate" | "extract_info",
  "target_index": number (or null),
  "value": "string (URL, typed text, or null)"
}`;

    const response = await fetch(apiUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    return JSON.parse(data.candidates[0].content.parts[0].text); 
}

// --- 4. SECURE LOOP ---
runBtn.onclick = async () => {
    keepRunning = true;
    actionHistory = [];
    agentMemory = []; // Reset memory on new run
    runBtn.style.display = "none";
    stopBtn.style.display = "block";
    log.innerHTML = "";
    
    // --- SECURITY LOCK ---
    write("🔒 Verifying Authorization...", "debug");
    try {
        const authRes = await fetch("http://localhost:3000/api/auth-status");
        const authData = await authRes.json();
        if (!authData.authenticated) {
            write("❌ ACCESS DENIED. Log in at http://localhost:3000/login", "error");
            runBtn.style.display = "block"; stopBtn.style.display = "none"; return;
        }
    } catch (err) {
        write("❌ CONNECTION FAILED. Web Portal offline.", "error");
        runBtn.style.display = "block"; stopBtn.style.display = "none"; return;
    }
    
    const goal = document.getElementById("prompt").value;
    const showBoxes = document.getElementById("show-boxes").checked;
    
    const { apiKey, model } = await chrome.storage.sync.get(['apiKey', 'model']);
    if (!apiKey) {
        write("❌ No API Key found. Go to Options.", "error");
        runBtn.style.display = "block"; stopBtn.style.display = "none"; return;
    }
    
    const selectedModel = model || "gemini-1.5-flash";
    
    write(`🎯 Goal: "${goal}"`, "user");

    for (let step = 1; step <= 20; step++) {
        if (!keepRunning) break;
        write(`\n🔄 Step ${step}...`, "debug");

        try {
            let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            const scanResults = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: DOMScanner, args: [showBoxes] });
            const elements = scanResults[0].result;
            
            const plan = await callGemini(goal, elements, apiKey, selectedModel, actionHistory, agentMemory, tab.url);
            write(`🤖 ${plan.reasoning}`, "ai");
            actionHistory.push(`Step ${step}: ${plan.action} ${plan.value ? `"${plan.value}"` : ""} on index ${plan.target_index || "N/A"}`);

            if (plan.action === "finish") {
                write("✅ Goal Reached. Final extraction...", "ai");
                if (agentMemory.length > 0) {
                    write("--- MEMORIZED DATA ---", "ai");
                    agentMemory.forEach(m => write(m, "result-card"));
                }
                const extraction = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractResults });
                const results = extraction[0].result;
                if (results && results.length > 0) results.forEach(r => write(r, "result-card"));
                break;
            }

            if (plan.action === "new_tab" || plan.action === "navigate") {
                let targetUrl = plan.value || "";
                if (targetUrl && !targetUrl.startsWith("http")) targetUrl = "https://" + targetUrl; // FIX URL BUG
                
                if (plan.action === "new_tab") {
                    write(`🌐 Opening New Tab: ${targetUrl}`, "debug");
                    await chrome.tabs.create({ url: targetUrl });
                } else {
                    write(`🌐 Navigating to: ${targetUrl}`, "debug");
                    await chrome.tabs.update(tab.id, { url: targetUrl });
                }
                await new Promise(r => setTimeout(r, 4500)); // Wait for page load
                continue;
            }

            if (plan.action === "scroll") {
                write("⬇️ Scrolling...", "debug");
                await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.scrollBy({ top: 700, behavior: 'smooth' }) });
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }

            if (plan.action === "extract_info" || plan.action === "extract") {
                let foundText = plan.value || "";
                if (typeof plan.target_index === "number") {
                    const target = elements.find(e => e.index === plan.target_index);
                    if (target) foundText = target.text;
                }
                if (foundText) {
                    write(`🧠 Memorized: [${foundText}]`, "ai");
                    agentMemory.push(foundText);
                    actionHistory.push(`Successfully saved memory: ${foundText}`);
                } else {
                    write(`⚠️ Failed to extract info.`, "debug");
                }
                continue;
            }

            // Click or Type logic
            if (typeof plan.target_index === "number") {
                const target = elements.find(e => e.index === plan.target_index);
                if (target) {
                    write(`🔧 ${plan.action.toUpperCase()} -> [${target.text}]`, "debug");
                    const safeValue = plan.value || ""; 
                    
                    await chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        func: (sel, action, value) => {
                            const el = document.querySelector(sel);
                            if (!el) return;
                            el.focus();
                            
                            if (action === "type") {
                                let nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
                                let nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
                                if (el.tagName === 'INPUT' && nativeInputValueSetter) nativeInputValueSetter.call(el, value);
                                else if (el.tagName === 'TEXTAREA' && nativeTextAreaValueSetter) nativeTextAreaValueSetter.call(el, value);
                                else el.value = value;
                                
                                el.dispatchEvent(new Event('input', { bubbles: true }));
                                el.dispatchEvent(new Event('change', { bubbles: true }));
                                el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
                                const form = el.closest('form');
                                if (form) setTimeout(() => form.submit(), 300);
                            } else {
                                el.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true, view: window}));
                                el.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, cancelable: true, view: window}));
                                el.click();
                            }
                        },
                        args: [target.sel, plan.action, safeValue]
                    });
                    await new Promise(r => setTimeout(r, 4000));
                } else {
                     write("⚠️ Target missing. Scrolling to find it...", "debug");
                     await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.scrollBy({ top: 500, behavior: 'smooth' }) });
                }
            } else {
                 write(`⚠️ LLM forgot target_index for action: ${plan.action}`, "debug");
            }
        } catch (err) {
            write("❌ Error: " + err.message, "error");
            break; 
        }
    }

    stopBtn.style.display = "none";
    runBtn.style.display = "block";
    write("👋 Agent stopped.");
};

stopBtn.onclick = () => { keepRunning = false; write("🛑 Stopping..."); };