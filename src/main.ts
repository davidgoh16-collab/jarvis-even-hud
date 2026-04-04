import { 
    EvenAppBridge, 
    CreateStartUpPageContainer, 
    TextContainerUpgrade, 
    TextContainerProperty, 
    waitForEvenAppBridge,
    BridgeEvent,
    OsEventTypeList
} from "@evenrealities/even_hub_sdk";
import type { EvenHubEvent } from "@evenrealities/even_hub_sdk";

let bridge: EvenAppBridge;
let socket: WebSocket | null = null;
let currentModel = localStorage.getItem('openclaw_model') || "openai/claude-3-5-sonnet";
let isRecording = false;
let isAutoScrollEnabled = true;
let audioChunks: Uint8Array[] = [];
let loadingInterval: any = null;
let GEMINI_API_KEY = "";

// UI Elements
const gatewayInput = document.getElementById('gateway-url') as HTMLInputElement;
const modelSelector = document.getElementById('model-selector') as HTMLSelectElement;
const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement;
const disconnectBtn = document.getElementById('disconnect-btn') as HTMLButtonElement;
const chatHistory = document.getElementById('chat-history') as HTMLDivElement;
const g2SimulatorText = document.getElementById('g2-text') as HTMLDivElement;

// HUD Elements
const arcReactor = document.getElementById('arc-reactor') as HTMLDivElement;
const reactorText = document.getElementById('reactor-text') as HTMLDivElement;
const hudStatusText = document.getElementById('status-text') as HTMLDivElement;
const glassesSync = document.getElementById('glasses-sync') as HTMLDivElement;
const mobileTrigger = document.getElementById('mobile-trigger') as HTMLDivElement;

// Initialization
async function init() {
    console.log("Initializing OpenClaw Assistant...");
    
    // Load API Key from runtime config or build env
    try {
        const res = await fetch('/config.json');
        if (res.ok) {
            const config = await res.json();
            if (config.GEMINI_API_KEY) {
                GEMINI_API_KEY = config.GEMINI_API_KEY;
            }
        }
    } catch (e) {
        console.warn("Failed to load config.json, checking environment variables.");
    }

    if (!GEMINI_API_KEY && (import.meta as any).env?.VITE_GEMINI_API_KEY) {
        GEMINI_API_KEY = (import.meta as any).env.VITE_GEMINI_API_KEY;
    }

    // Load saved settings
    const savedGateway = localStorage.getItem('openclaw_gateway');
    const defaultGateway = "wss://davids-mac-mini.taild84156.ts.net";

    // Override old HTTP/WS defaults with the new secure WSS default
    if (savedGateway && !savedGateway.startsWith('wss://') && (savedGateway.includes('192.168.') || savedGateway.includes('100.') || savedGateway.includes('127.0.0.1'))) {
        gatewayInput.value = defaultGateway;
        localStorage.setItem('openclaw_gateway', defaultGateway);
    } else if (savedGateway) {
        gatewayInput.value = savedGateway;
    } else {
        gatewayInput.value = defaultGateway;
    }

    const savedModel = localStorage.getItem('openclaw_model');
    if (savedModel) {
        currentModel = savedModel;
        modelSelector.value = currentModel;
    }
    
    // Auto-connect to gateway
    connectToGateway();

    try {
        bridge = await waitForEvenAppBridge();
        console.log("Even Hub Bridge connected");
        glassesSync.innerText = "GLASSES CONNECTED";
        glassesSync.className = "glasses-sync connected";
        
        // Setup initial glasses UI
        setupGlassesUI();

        // Listen for glasses events
        window.addEventListener(BridgeEvent.EvenHubEvent, (e: any) => {
            const event = e.detail as EvenHubEvent;
            console.log("Glasses Event:", event);

            // Audio incoming from glasses microphone
            if (event.audioEvent && isRecording) {
                audioChunks.push(event.audioEvent.audioPcm);
            }

            // Check for click/double click on both the text container and system-level hardware (Ring / Touchpad)
            let isTapEvent = false;
            
            if (event.textEvent) {
                const type = OsEventTypeList.fromJson(event.textEvent.eventType);
                if (type === OsEventTypeList.CLICK_EVENT || type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
                    isTapEvent = true;
                }
            }
            
            if (event.sysEvent) {
                const type = OsEventTypeList.fromJson(event.sysEvent.eventType);
                // Even OS might send single clicks as something else, just to be extremely safe, we allow any raw '0' or '1' if it somehow mapped weirdly.
                // @ts-ignore: TS doesn't know eventType can be raw string in some firmware versions
                if (type === OsEventTypeList.CLICK_EVENT || type === OsEventTypeList.DOUBLE_CLICK_EVENT || event.sysEvent.eventType === 0 || event.sysEvent.eventType === 'CLICK' || event.sysEvent.eventType === 'CLICK_EVENT') {
                    isTapEvent = true;
                } else if (type === OsEventTypeList.SCROLL_TOP_EVENT) { // Swipe up / backward
                    isAutoScrollEnabled = false;
                    updateStatus("Auto-scroll paused");
                } else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) { // Swipe down / forward
                    isAutoScrollEnabled = true;
                    updateStatus("Auto-scroll following");
                }
            }
            
            if (isTapEvent) {
                if (socket?.readyState === WebSocket.OPEN) {
                    toggleRecording();
                } else {
                    updateGlasses("Please connect gateway first");
                }
            }
        });

    } catch (e) {
        console.warn("Even Hub Bridge not found - running in simulator mode", e);
    }

    // Event Listeners
    connectBtn.onclick = connectToGateway;
    disconnectBtn.onclick = disconnectFromGateway;
    mobileTrigger.onclick = toggleRecording;
    modelSelector.onchange = () => {
        currentModel = modelSelector.value;
        localStorage.setItem('openclaw_model', currentModel);
        updateStatus("Model changed to " + currentModel);
        
        if (currentModel === "jarvis") {
            connectToGateway();
        }
    };

    // No browser speech setup needed as we use the glasses mic
}

function cycleModel(direction: 1 | -1) {
    const options = Array.from(modelSelector.options);
    let currentIndex = options.findIndex(opt => opt.value === modelSelector.value);
    if (currentIndex === -1) currentIndex = 0;
    
    currentIndex += direction;
    if (currentIndex >= options.length) currentIndex = 0;
    if (currentIndex < 0) currentIndex = options.length - 1;
    
    const opt = options[currentIndex] as HTMLOptionElement;
    if (opt) {
        modelSelector.value = opt.value;
        modelSelector.dispatchEvent(new Event('change'));
        updateGlasses("Model:\n" + opt.text);
    }
}



async function toggleRecording() {
    if (isRecording) {
        await stopRecording();
    } else {
        await startRecording();
    }
}

async function startRecording() {
    isRecording = true;
    audioChunks = [];
    
    arcReactor.className = "arc-reactor listening";
    updateGlasses("Listening...");
    
    if (bridge) {
        await bridge.audioControl(true);
    }
}

async function stopRecording() {
    isRecording = false;
    arcReactor.className = "arc-reactor";
    
    if (bridge) {
        await bridge.audioControl(false);
    }
    
    if (audioChunks.length > 0) {
        updateGlasses("Transcribing...");
        const pcm = combineChunks(audioChunks);
        const wav = encodeWAV(pcm);
        const base64Wav = uint8ToBase64(wav);
        await transcribeAudio(base64Wav);
    } else {
        updateGlasses("Ready");
    }
}

async function transcribeAudio(base64Wav: string) {
    try {
        updateGlasses("Processing..."); // Set to Processing state with spinner

        if (!GEMINI_API_KEY) {
            throw new Error("GEMINI_API_KEY is not configured.");
        }

        // Use Gemini 1.5 Flash for stable and less hallucinatory STT performance
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: "Transcribe the following audio accurately. Reply ONLY with the exact transcription text. Do not add any conversational filler, context, or music descriptions. If the audio is silent, contains only static/noise, or has no discernible human speech, you must return exactly: NO_VOICE" },
                            { inlineData: { mimeType: "audio/wav", data: base64Wav } }
                        ]
                    }]
                })
            }
        );
        const data = await response.json();
        if (data.error) throw new Error(data.error.message);

        const transcript = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
        if (!transcript || transcript === "NO_VOICE") {
            updateGlasses("Ready\n(no voice detected)");
            setTimeout(() => { if (!isRecording) updateGlasses("Ready"); }, 3000);
        } else {
            sendText(transcript);
        }
    } catch (e: any) {
        console.error("Transcription error:", e);
        updateGlasses("Error: STT failed\n" + e.message);
        addHistoryItem("System", "STT Error: " + e.message);
    }
}



// Helper functions for WAV conversion
function encodeWAV(pcmBytes: Uint8Array): Uint8Array {
    const sampleRate = 16000;
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = pcmBytes.length;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    function writeString(offset: number, str: string) {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
    }

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    const bufferBytes = new Uint8Array(buffer);
    bufferBytes.set(pcmBytes, 44);
    return bufferBytes;
}

function uint8ToBase64(u8Array: Uint8Array): string {
    let binary = '';
    const len = u8Array.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(u8Array[i] || 0);
    }
    return window.btoa(binary);
}

function combineChunks(chunks: Uint8Array[]): Uint8Array {
    let totalLength = 0;
    for (const chunk of chunks) totalLength += chunk.length;
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
}

async function setupGlassesUI() {
    if (!bridge) return;

    const textNode = new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        borderWidth: 0,
        borderColor: 5,
        paddingLength: 4,
        containerID: 1,
        containerName: "main_text",
        content: "\n\n   J.A.R.V.I.S.\n\n     Online",
        isEventCapture: 1,
    });

    const page = new CreateStartUpPageContainer();
    page.containerTotalNum = 1;
    page.textObject = [textNode];

    try {
        const res = await bridge.createStartUpPageContainer(page);
        console.log("createStartUpPageContainer result:", res);
        if (res !== 0) {
            // createStartUpPage already called once — use rebuild instead
            console.log("Falling back to rebuildPageContainer...");
            const { RebuildPageContainer } = await import("@evenrealities/even_hub_sdk");
            const rebuild = new RebuildPageContainer();
            rebuild.containerTotalNum = 1;
            rebuild.textObject = [textNode];
            await bridge.rebuildPageContainer(rebuild);
        }
    } catch(err: any) {
        console.error("SDK error:", err.message);
    }
}

let glassesAnimInterval: any = null;

function updateGlasses(text: string) {
    if (loadingInterval) {
        clearInterval(loadingInterval);
        loadingInterval = null;
    }
    if (glassesAnimInterval) {
        clearInterval(glassesAnimInterval);
        glassesAnimInterval = null;
    }

    if (text === "Thinking..." || text === "Processing...") {
        arcReactor.className = "arc-reactor thinking";
        hudStatusText.className = "status-msg thinking";
        hudStatusText.innerText = text.toUpperCase();
        startGlassesSpinner(text.replace("...", ""));
        return;
    } else if (text === "Listening...") {
        arcReactor.className = "arc-reactor listening";
        hudStatusText.className = "status-msg";
        hudStatusText.innerText = "LISTENING";
        setGlassesText(">> LISTENING <<\n\nSpeak now...");
        return;
    } else {
        arcReactor.className = isRecording ? "arc-reactor listening" : "arc-reactor";
        hudStatusText.className = "status-msg";
    }

    // Maximize screen real estate: removed the strict 120-char truncation.
    // The G2 can handle approx 600 chars in its scroll buffer/wrap.
    const maxChars = 1200;
    const truncated = text.length > maxChars ? text.substring(0, maxChars - 3) + "..." : text;
    setGlassesText(truncated);
    
    // Update phone status text with a bit more length too
    hudStatusText.innerText = text.length > 100 ? text.substring(0, 97) + "..." : text;
}

// Animated spinner using text frames on the glasses
function startGlassesSpinner(verb: string) {
    let frame = 0;
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    setGlassesText("J.A.R.V.I.S.\n\nSTILL "+ verb.toUpperCase() +" " + frames[0]!);
    glassesAnimInterval = setInterval(() => {
        frame = (frame + 1) % frames.length;
        setGlassesText("J.A.R.V.I.S.\n\n"+ verb.toUpperCase() +" " + frames[frame]!);
    }, 150);
}

function setGlassesText(text: string) {
    console.log("G2 Update:", text);
    g2SimulatorText.innerText = text;
    
    if (bridge) {
        const upgrade = new TextContainerUpgrade();
        upgrade.containerID = 1;
        upgrade.containerName = "main_text";
        upgrade.content = text;
        if (isAutoScrollEnabled) {
            upgrade.contentOffset = 9999; // Force scroll to end
        }
        bridge.textContainerUpgrade(upgrade);
    }
}

async function connectToGateway() {
    const url = gatewayInput.value.trim();
    if (!url) return alert("Please enter Gateway URL");

    localStorage.setItem('openclaw_gateway', url);
    updateStatus("Connecting...", "yellow");

    try {
        socket = new WebSocket(url);

        socket.onopen = () => {
            updateStatus("Authenticating...", "yellow");
        };

        socket.onmessage = (event) => {
            const data = JSON.parse(event.data);
            console.log("WS Data:", data);

            if (data.event === "connect.challenge") {
                const connectId = Math.random().toString(36).substring(2, 15);
                const connectReq = {
                    type: "req",
                    id: connectId,
                    method: "connect",
                    params: {
                        minProtocol: 3,
                        maxProtocol: 3,
                        client: {
                            id: "openclaw-control-ui",
                            version: "1.0.0",
                            platform: "web",
                            mode: "webchat"
                        },
                        role: "operator",
                        scopes: ["operator.read", "operator.write", "operator.admin"],
                        auth: { token: "glasses" }
                    }
                };
                socket?.send(JSON.stringify(connectReq));
            } else if (data.type === "res" && !data.ok) {
                // If the gateway rejects our chat request (e.g. invalid schema, model down)
                console.error("Gateway rejected request:", data);
                updateStatus("Gateway Error", "red");
                updateGlasses("Error: " + (data.error?.message || data.error || "Request failed"));
            } else if (data.type === "res" && data.ok) {
                if (data.id?.startsWith("stt-")) {
                    const transcript = data.payload?.transcript || data.payload?.text || "";
                    if (transcript) {
                        sendText(transcript);
                    } else {
                        updateGlasses("No voice detected");
                    }
                } else if (data.id?.startsWith("msg-")) {
                    // Handle non-streaming response directly in the result
                    const p = data.payload;
                    const text = p?.message?.content?.[0]?.text || p?.message || p?.text || "";
                    if (text && !text.toLowerCase().includes("heartbeat")) {
                        addHistoryItem("AI", text);
                        updateGlasses(text);
                    }
                } else if (data.payload?.type === "hello-ok") {
                    updateStatus("ONLINE", "green");
                    connectBtn.disabled = true;
                    disconnectBtn.disabled = false;
                    updateGlasses("Connected to J.A.R.V.I.S.");
                }
            } else if (data.type === "event" && data.event === "chat") {
                const p = data.payload;
                // FLEXIBLE PARSING: Handle both structural content and raw strings
                let text = "";
                if (typeof p?.message === 'string') {
                    text = p.message;
                } else if (p?.message?.content) {
                    if (Array.isArray(p.message.content)) {
                        text = p.message.content.map((c: any) => c.text || "").join("");
                    } else {
                        text = p.message.content;
                    }
                } else if (p?.text) {
                    text = p.text;
                }

                // Filter out heartbeat pings and metadata-only packets
                const lowerText = text.toLowerCase();
                if (lowerText.includes("heartbeat") || lowerText === "ok" || lowerText === "connected") return;

                if (text) {
                    // ANY text arrivals from the gateway should clear the 'Thinking' spinner
                    if (glassesAnimInterval && !isRecording) {
                        clearInterval(glassesAnimInterval);
                        glassesAnimInterval = null;
                    }
                    
                    if (p?.state === "delta") {
                        updateGlasses(text);
                    } else {
                        // For 'final' or non-streaming events, show the text and log it
                        addHistoryItem("AI", text);
                        updateGlasses(text);
                    }
                } else if (p?.state === "error") {
                    if (glassesAnimInterval) { clearInterval(glassesAnimInterval); glassesAnimInterval = null; }
                    updateStatus("AI Error: " + (p.errorMessage || "Unknown"), "red");
                    updateGlasses("Error: " + (p.errorMessage || "Check logs"));
                }
            }
        };

        socket.onclose = (e) => {
            updateStatus("OFFLINE", "red");
            connectBtn.disabled = false;
            disconnectBtn.disabled = true;
            updateGlasses("Disconnected");
        };

        socket.onerror = (err) => {
            console.error("WS Error:", err);
            updateStatus("Connection Error", "red");
        };

    } catch (e) {
        console.error("Connect failed", e);
        updateStatus("Failed to connect", "red");
    }
}

function disconnectFromGateway() {
    socket?.close();
}

function sendText(text: string) {
    addHistoryItem("You", text);
    updateGlasses("Thinking...");

    if (!socket || socket.readyState !== WebSocket.OPEN) {
        updateStatus("J.A.R.V.I.S. not connected", "red");
        updateGlasses("Error: Not connected");
        return;
    }

    isAutoScrollEnabled = true; // Reset auto-scroll for new command
    
    const reqId = "msg-" + Math.random().toString(36).substring(2, 10);
    const msg = {
        type: "req",
        id: reqId,
        method: "chat.send",
        params: {
            sessionKey: "main",
            message: text,
            model: currentModel,
            idempotencyKey: reqId
        }
    };
    console.log("Sending chat request for:", currentModel, msg);
    socket.send(JSON.stringify(msg));

    // Watchdog: If nothing arrives in 30 seconds, fallback to Ready
    setTimeout(() => {
        if (glassesAnimInterval && !isRecording) {
            clearInterval(glassesAnimInterval);
            glassesAnimInterval = null;
            updateGlasses("READY (Timeout)");
        }
    }, 30000);
}



function updateStatus(text: string, color: string = "") {
    hudStatusText.innerText = text;
    hudStatusText.style.color = color === "green" ? "#32d74b" : color === "red" ? "#ff3b30" : "";
}

function addHistoryItem(sender: string, text: string) {
    const item = document.createElement('div');
    item.className = 'history-item ' + (sender === "You" ? "user" : "ai");
    item.innerText = text;
    chatHistory.prepend(item); 
}

/** Clip text to fit the Even G2 display (approx 200 chars max readable) */
function truncateForGlasses(text: string, maxLen = 200): string {
    if (!text) return text;
    return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
}

init();
