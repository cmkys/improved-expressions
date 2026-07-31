/**
 * Custom OpenAI-compatible classifier endpoint for Expressions Plus.
 *
 * Sends the conversation snippet + sprite option list to any OpenAI-compatible
 * /chat/completions endpoint (URL + API key). Fully decoupled from the main
 * generation API, so classification never blocks or interferes with chat
 * generation and can run on a cheap/fast model.
 */

/**
 * Returns the endpoint URL exactly as the user typed it (trailing slashes trimmed).
 * No path is appended — enter the full /chat/completions URL yourself.
 * @param {string} url
 * @returns {string}
 */
function buildChatCompletionsUrl(url) {
    return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * Sends a classification request to a custom OpenAI-compatible endpoint.
 * Non-streaming: we only need one short line back.
 *
 * @param {object} config
 * @param {string} config.url - Full /chat/completions URL
 * @param {string} config.key - API key (sent as Bearer). May be empty for local servers.
 * @param {string} config.model - Model name
 * @param {boolean} [config.useProxy=false] - Route through SillyTavern's CORS proxy
 * @param {string} systemPrompt - The selection instruction (already has {{labels}} substituted)
 * @param {string} userPrompt - The conversation snippet to classify
 * @returns {Promise<string>} The raw text content of the model's reply
 * @throws {Error} On misconfiguration or non-OK responses
 */
export async function classifyViaCustomEndpoint({ url, key, model, useProxy = false }, systemPrompt, userPrompt) {
    let endpoint = buildChatCompletionsUrl(url);

    if (!endpoint) {
        throw new Error('Classifier URL is not set. Add it in Expressions Plus settings.');
    }
    if (!model) {
        throw new Error('Classifier model is not set. Add it in Expressions Plus settings.');
    }

    // Route through SillyTavern's CORS proxy (requires enableCorsProxy: true
    // in config.yaml). Needed when the provider doesn't send CORS headers.
    if (useProxy) {
        endpoint = `/proxy/${endpoint}`;
    }

    const headers = { 'Content-Type': 'application/json' };
    if (key) {
        headers['Authorization'] = `Bearer ${key}`;
    }

    const body = JSON.stringify({
        model: model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 512,
        stream: false,
        // Reasoning models (GLM, etc.) think before answering; without this
        // they can burn the whole token budget on reasoning and return empty
        // content. Z.ai's documented switch — other providers ignore unknown fields.
        thinking: { type: 'disabled' },
    });

    let response;
    try {
        console.info('[expressions-plus] Classifier POST →', endpoint);
        response = await fetch(endpoint, { method: 'POST', headers, body });
    } catch (err) {
        throw new Error(`Could not reach ${endpoint}: ${err.message}`);
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        if (response.status === 401) {
            throw new Error('Classifier returned 401 Unauthorized. Check the API key.');
        }
        throw new Error(`Classifier request failed (${response.status}): ${errorText.slice(0, 200)}`);
    }

    const data = await response.json().catch(() => null);
    const message = data?.choices?.[0]?.message;
    let content = message?.content;

    // Fallback for reasoning models that ignore the thinking-disable flag:
    // the answer (or at least the sprite name) lives in reasoning_content.
    if ((!content || !String(content).trim()) && message?.reasoning_content) {
        content = message.reasoning_content;
    }

    if (!content || !String(content).trim()) {
        const finishReason = data?.choices?.[0]?.finish_reason;
        throw new Error(`Classifier returned an empty response${finishReason ? ` (finish_reason: ${finishReason})` : ''}.`);
    }

    return String(content);
}

/**
 * Tests a custom endpoint configuration by sending a trivial request.
 * @param {{url: string, key: string, model: string, useProxy?: boolean}} config
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function testCustomEndpoint({ url, key, model, useProxy = false }) {
    try {
        const result = await classifyViaCustomEndpoint(
            { url, key, model, useProxy },
            'Reply with exactly one word: ok',
            'ping',
        );
        return { success: true, message: `Connected. Model replied: "${result.trim().slice(0, 60)}"` };
    } catch (error) {
        return { success: false, message: error.message };
    }
}
