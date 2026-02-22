import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';

env.allowLocalModels = false;

// Detect WebGPU support once at startup so we can inform the UI
const HAS_WEBGPU = !!navigator.gpu;

// Smart model cache: return instantly if already resident in memory.
// Before loading a NEW model, dispose all others to free the WebAssembly /
// WebGPU heap — browsers can't hold multiple large models simultaneously.
const modelCache = new Map(); // model_id → pipeline instance

async function getModel(model_id, dtype, progress_callback = null) {
    // Fast path — model already resident in memory
    if (modelCache.has(model_id)) return modelCache.get(model_id);

    // Free all other loaded models before allocating a new one
    for (const [id, instance] of modelCache.entries()) {
        console.log(`Disposing ${id} to free memory before loading ${model_id}`);
        try { await instance.dispose(); } catch (_) { }
        modelCache.delete(id);
    }

    const device = HAS_WEBGPU ? 'webgpu' : 'wasm';
    console.log(`Loading ${model_id} on device: ${device}, dtype: ${dtype}`);

    const instance = await pipeline('text-generation', model_id, {
        device,
        dtype,
        progress_callback,
    });
    modelCache.set(model_id, instance);
    return instance;
}

// SmolLM2 — HuggingFace's browser-first model family.
// -ONNX suffix = public repos, no HuggingFace auth required.
// Identical architecture, same training data. Only difference: Instruct is RLHF-tuned.
const CHAT_MODEL = { id: 'onnx-community/SmolLM2-360M-Instruct-ONNX', dtype: 'q4' };
const BASE_MODEL = { id: 'onnx-community/SmolLM2-360M-ONNX', dtype: 'q4' };

self.addEventListener('message', async (event) => {
    const data = event.data;

    // Announce WebGPU availability to the UI on first message
    if (data.action === 'load') {
        self.postMessage({ status: 'device', device: HAS_WEBGPU ? 'webgpu' : 'wasm' });
    }

    // Resolve the model config from the payload
    const model = data.modelType === 'chat' ? CHAT_MODEL : BASE_MODEL;
    const { id: model_id, dtype } = model;

    if (data.action === 'load') {
        // Already resident — signal ready immediately
        if (modelCache.has(model_id)) {
            self.postMessage({ status: 'ready', cached: true });
            return;
        }

        try {
            self.postMessage({ status: 'progress', progress: 0 });
            await getModel(model_id, dtype, x => {
                if (x.status === 'progress' && x.progress) {
                    self.postMessage({ status: 'progress', progress: x.progress, file: x.file });
                }
            });
            self.postMessage({ status: 'ready' });
        } catch (err) {
            self.postMessage({ status: 'error', message: err.message });
        }
    }
    else if (data.action === 'generate') {
        self.postMessage({ status: 'start' });

        try {
            const generator = await getModel(model_id, dtype);

            if (data.modelType === 'chat') {
                // Format messages using the tokenizer's chat template
                const formattedPrompt = generator.tokenizer.apply_chat_template(data.messages, {
                    tokenize: false,
                    add_generation_prompt: true,
                });

                const result = await generator(formattedPrompt, {
                    max_new_tokens: 200,
                    do_sample: true,
                    temperature: data.temperature || 0.7,
                    return_full_text: false,
                });

                const assistantReply = (() => {
                    let raw = (result[0].generated_text || '').trim();
                    // Strip any echoed conversation prefix the model may emit
                    const idx = raw.lastIndexOf('\nassistant');
                    if (idx !== -1) return raw.slice(idx + '\nassistant'.length).trim();
                    const idx2 = raw.lastIndexOf('assistant');
                    if (idx2 !== -1) return raw.slice(idx2 + 'assistant'.length).trim();
                    return raw;
                })();
                self.postMessage({ status: 'complete', assistantReply });

            } else {
                // Base model: stream token by token
                const input = data.text;
                let generatedSoFar = '';

                const result = await generator(input, {
                    max_new_tokens: 200,
                    temperature: data.temperature || 0.7,
                    repetition_penalty: 1.1,
                    return_full_text: false,
                    callback_function: function (beams) {
                        const currentTokens = beams[0].output_token_ids;
                        let decoded = generator.tokenizer.decode(currentTokens, { skip_special_tokens: true });
                        if (decoded.startsWith(data.text)) {
                            decoded = decoded.slice(data.text.length).replace(/^\s+/, '');
                        }
                        if (decoded.length > generatedSoFar.length) {
                            const chunk = decoded.slice(generatedSoFar.length);
                            self.postMessage({ status: 'update', chunk });
                            generatedSoFar = decoded;
                        }
                    }
                });

                let finalOutput = result[0].generated_text || generatedSoFar;
                if (finalOutput.startsWith(data.text)) {
                    finalOutput = finalOutput.slice(data.text.length).replace(/^\s+/, '');
                }
                self.postMessage({ status: 'complete', fullText: finalOutput });
            }

        } catch (err) {
            self.postMessage({ status: 'error', message: err.message });
        }
    }
});
