import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.16.1';

env.allowLocalModels = false;

class PipelineSingleton {
    static instance = null;
    static currentModel = null;

    static async getInstance(progress_callback = null, model_id) {
        if (this.currentModel !== model_id) {
            if (this.instance) {
                console.log("Disposing old model to free memory...");
                await this.instance.dispose();
                this.instance = null;
            }
        }

        if (this.instance === null) {
            this.currentModel = model_id;
            this.instance = await pipeline('text-generation', model_id, {
                quantized: true,
                progress_callback,
            });
        }
        return this.instance;
    }
}

self.addEventListener('message', async (event) => {
    const data = event.data;
    const model_id = data.modelType === 'chat' ? 'Xenova/Qwen1.5-0.5B-Chat' : 'Xenova/Qwen1.5-0.5B';

    if (data.action === 'load') {
        try {
            self.postMessage({ status: 'progress', progress: 0 });
            await PipelineSingleton.getInstance(x => {
                if (x.status === 'progress' && x.progress) {
                    self.postMessage({ status: 'progress', progress: x.progress, file: x.file });
                }
            }, model_id);
            self.postMessage({ status: 'ready' });
        } catch (err) {
            self.postMessage({ status: 'error', message: err.message });
        }
    }
    else if (data.action === 'generate') {
        self.postMessage({ status: 'start' });

        try {
            const generator = await PipelineSingleton.getInstance(null, model_id);

            if (data.modelType === 'chat') {
                // Format the messages array using the tokenizer's chat template
                // (exactly as the model was trained to expect)
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
                    // This small model tends to echo the full conversation before the answer.
                    // Strip everything up to and including the last 'assistant' keyword.
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
                let generatedSoFar = "";

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
