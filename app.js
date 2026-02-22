const toggle = document.getElementById('model-toggle');
const labelBase = document.getElementById('label-base');
const labelChat = document.getElementById('label-chat');
const modelDescription = document.getElementById('model-description');
const baseView = document.getElementById('base-view');
const chatView = document.getElementById('chat-view');

const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const progressBar = document.getElementById('progress-bar');
const tempSlider = document.getElementById('temperature-slider');
const tempVal = document.getElementById('temp-val');

// Base view elements
const basePromptInput = document.getElementById('base-prompt-input');
const baseGenerateBtn = document.getElementById('base-generate-btn');
const basePlaceholder = document.getElementById('base-placeholder');
const baseTextContent = document.getElementById('base-text-content');
const basePromptEcho = document.getElementById('base-prompt-echo');
const baseGeneratedText = document.getElementById('base-generated-text');
const baseHistoryContainer = document.getElementById('base-history-container');

// Chat view elements
const chatMessagesList = document.getElementById('chat-messages-list');
const chatGenerateBtn = document.getElementById('chat-generate-btn');
const chatAddUserBtn = document.getElementById('chat-add-user-btn');

// ── Message state ──────────────────────────────────────────────────────────────
let chatMessages = [
    { role: 'system', content: 'You are a helpful and intelligent assistant.' },
    { role: 'user', content: '' },
];

// ── Render the message list ────────────────────────────────────────────────────
function renderMessages() {
    chatMessagesList.innerHTML = '';
    chatMessages.forEach((msg, idx) => {
        const card = document.createElement('div');
        card.className = `msg-card msg-card--${msg.role}`;

        const header = document.createElement('div');
        header.className = 'msg-card__header';

        const roleWrap = document.createElement('div');
        roleWrap.className = 'msg-card__role';

        const dot = document.createElement('span');
        dot.className = 'msg-card__role-dot';
        roleWrap.appendChild(dot);

        const roleLabel = document.createElement('span');
        roleLabel.textContent = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
        roleWrap.appendChild(roleLabel);
        header.appendChild(roleWrap);

        // Show delete on every message except system (0) and the first user message (1).
        // Deleting removes that message and everything after it.
        if (idx > 1) {
            const del = document.createElement('button');
            del.className = 'msg-card__delete';
            del.title = 'Delete this and all following messages';
            del.textContent = '×';
            del.addEventListener('click', () => {
                chatMessages.splice(idx); // remove from idx to end
                renderMessages();
            });
            header.appendChild(del);
        }

        card.appendChild(header);

        const textarea = document.createElement('textarea');
        textarea.value = msg.content;
        textarea.rows = Math.max(2, Math.ceil(msg.content.length / 80));
        textarea.placeholder = msg.role === 'system'
            ? 'Describe how the assistant should behave…'
            : msg.role === 'user'
                ? 'Type your message…'
                : '';

        // All messages are editable — system, user, and assistant alike.
        // This lets users modify the conversation history and see how context affects the response.

        textarea.addEventListener('input', () => {
            chatMessages[idx].content = textarea.value;
            // Auto-grow
            textarea.style.height = 'auto';
            textarea.style.height = textarea.scrollHeight + 'px';
        });

        // Auto-size on render
        setTimeout(() => {
            textarea.style.height = 'auto';
            textarea.style.height = textarea.scrollHeight + 'px';
        }, 0);

        card.appendChild(textarea);
        chatMessagesList.appendChild(card);
    });

    chatMessagesList.scrollTop = chatMessagesList.scrollHeight;
    updateAddBtnState();
}

function updateAddBtnState() {
    // Can only add a user message if the last message is an assistant (or it's the first user turn with content)
    const last = chatMessages[chatMessages.length - 1];
    chatAddUserBtn.disabled = last.role === 'user';
}

// ── Add user message button ────────────────────────────────────────────────────
chatAddUserBtn.addEventListener('click', () => {
    chatMessages.push({ role: 'user', content: '' });
    renderMessages();
    // Focus the new textarea
    const cards = chatMessagesList.querySelectorAll('.msg-card');
    const lastCard = cards[cards.length - 1];
    if (lastCard) lastCard.querySelector('textarea').focus();
});

// ── Model toggle ───────────────────────────────────────────────────────────────
let isChatModel = false;
toggle.checked = false;

let worker = null;

function setupWorker() {
    if (worker) worker.terminate();
    worker = new Worker('worker.js?v=3', { type: 'module' });

    worker.addEventListener('message', (e) => {
        const data = e.data;
        switch (data.status) {
            case 'device':
                loadingText.innerText = `Loading Model… using ${data.device === 'webgpu' ? '⚡ WebGPU' : 'WASM'}`;
                break;
            case 'progress':
                if (data.progress) {
                    progressBar.style.width = `${Math.round(data.progress)}%`;
                    loadingText.innerText = `Downloading Model Files… ${Math.round(data.progress)}%`;
                }
                break;
            case 'ready':
                // Worker signals cached models instantly — skip the overlay flash
                loadingOverlay.classList.add('hidden');
                progressBar.style.width = '100%';
                setUIDisabled(false);
                break;
            case 'start':
                if (!isChatModel) {
                    baseGeneratedText.innerText = '';
                    baseGeneratedText.classList.add('streaming');
                } else {
                    chatGenerateBtn.textContent = 'Generating…';
                }
                break;
            case 'update':
                if (!isChatModel) {
                    baseGeneratedText.innerText += data.chunk;
                    scrollBaseToBottom();
                }
                break;
            case 'complete':
                if (isChatModel) {
                    chatGenerateBtn.textContent = 'Generate';
                    if (data.assistantReply !== undefined) {
                        chatMessages.push({ role: 'assistant', content: data.assistantReply });
                        renderMessages();
                    }
                } else {
                    if (data.fullText && baseGeneratedText.innerText === '') {
                        baseGeneratedText.innerText = data.fullText;
                    }
                    baseGeneratedText.classList.remove('streaming');
                    basePromptInput.focus();
                }
                setUIDisabled(false);
                break;
            case 'error':
                alert(`Error: ${data.message}`);
                loadingOverlay.classList.add('hidden');
                chatGenerateBtn.textContent = 'Generate';
                setUIDisabled(false);
                if (!isChatModel) {
                    baseGeneratedText.innerText = 'Error generating response.';
                    baseGeneratedText.classList.remove('streaming');
                }
                break;
        }
    });
}

tempSlider.addEventListener('input', (e) => { tempVal.innerText = e.target.value; });

toggle.addEventListener('change', (e) => {
    isChatModel = e.target.checked;
    updateView();
    setupWorker();
    loadModel();
});

function updateView() {
    if (isChatModel) {
        labelChat.classList.add('active');
        labelBase.classList.remove('active');
        chatView.classList.remove('hidden');
        baseView.classList.add('hidden');
        modelDescription.innerHTML = `<strong>Chat Model (RLHF):</strong> Tuned to act as a helpful assistant. It answers questions, follows instructions, and maintains a conversational tone.`;
        renderMessages();
    } else {
        labelBase.classList.add('active');
        labelChat.classList.remove('active');
        baseView.classList.remove('hidden');
        chatView.classList.add('hidden');
        modelDescription.innerHTML = `<strong>Base Model (Pre-trained):</strong> Optimized only for predicting the next word. It tends to complete text rather than answer questions directly.`;
    }
}

function loadModel() {
    loadingOverlay.classList.remove('hidden');
    loadingText.innerText = 'Loading Model… (This may take a minute the first time)';
    progressBar.style.width = '0%';
    setUIDisabled(true);
    worker.postMessage({ action: 'load', modelType: isChatModel ? 'chat' : 'base' });
}

function setUIDisabled(disabled) {
    baseGenerateBtn.disabled = disabled;
    basePromptInput.disabled = disabled;
    chatGenerateBtn.disabled = disabled;
    chatAddUserBtn.disabled = disabled;
    chatMessagesList.querySelectorAll('textarea').forEach(t => t.disabled = disabled);
}

// ── Init ───────────────────────────────────────────────────────────────────────
updateView();
setupWorker();
loadModel();

// ── Base Model ─────────────────────────────────────────────────────────────────
baseGenerateBtn.addEventListener('click', generateBaseText);
basePromptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generateBaseText(); }
});

function generateBaseText() {
    const text = basePromptInput.value;
    if (!text.trim()) return;

    basePlaceholder.classList.add('hidden');
    baseTextContent.classList.remove('hidden');
    basePromptEcho.innerText = text;
    baseGeneratedText.innerText = '';

    setUIDisabled(true);
    worker.postMessage({ action: 'generate', modelType: 'base', text, temperature: parseFloat(tempSlider.value) });
}

function scrollBaseToBottom() {
    baseHistoryContainer.scrollTop = baseHistoryContainer.scrollHeight;
}

// ── Chat Model ─────────────────────────────────────────────────────────────────
chatGenerateBtn.addEventListener('click', generateChat);

function generateChat() {
    // Ensure at least one non-empty user message
    const lastUser = [...chatMessages].reverse().find(m => m.role === 'user');
    if (!lastUser || !lastUser.content.trim()) return;

    // Only send messages up to and including the last user message
    // (strip any trailing assistant messages to avoid confusion)
    let msgs = [...chatMessages];
    while (msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs.pop();

    setUIDisabled(true);
    worker.postMessage({
        action: 'generate',
        modelType: 'chat',
        messages: msgs,
        temperature: parseFloat(tempSlider.value)
    });
}
