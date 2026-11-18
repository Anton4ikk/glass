const { Anthropic } = require("@anthropic-ai/sdk")

class AnthropicProvider {
    static async validateApiKey(key) {
        if (!key || typeof key !== 'string' || !key.startsWith('sk-ant-')) {
            return { success: false, error: 'Invalid Anthropic API key format.' };
        }

        try {
            const response = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": key,
                    "anthropic-version": "2023-06-01",
                },
                body: JSON.stringify({
                    model: "claude-3-haiku-20240307",
                    max_tokens: 1,
                    messages: [{ role: "user", content: "Hi" }],
                }),
            });

            if (response.ok || response.status === 400) { // 400 is a valid response for a bad request, not a bad key
                return { success: true };
            } else {
                const errorData = await response.json().catch(() => ({}));
                return { success: false, error: errorData.error?.message || `Validation failed with status: ${response.status}` };
            }
        } catch (error) {
            console.error(`[AnthropicProvider] Network error during key validation:`, error);
            return { success: false, error: 'A network error occurred during validation.' };
        }
    }
}

/**
 * Anthropic has no real-time STT; this returns a no-op session.
 * @returns {Promise<object>} STT session placeholder
 */
async function createSTT({ apiKey, language = "en", callbacks = {}, ...config }) {
  console.warn("[Anthropic] STT not natively supported. Consider using OpenAI or Gemini for STT.")

  return {
    sendRealtimeInput: async (audioData) => {
      console.warn("[Anthropic] STT sendRealtimeInput called but not implemented")
    },
    close: async () => {
      console.log("[Anthropic] STT session closed")
    },
  }
}

/**
 * Creates an Anthropic LLM instance
 * @param {object} opts - Configuration options
 * @param {string} opts.apiKey - Anthropic API key
 * @param {string} [opts.model='claude-3-5-sonnet-20241022'] - Model name
 * @param {number} [opts.temperature=0.7] - Temperature
 * @param {number} [opts.maxTokens=4096] - Max tokens
 * @returns {object} LLM instance
 */
function createLLM({ apiKey, model = "claude-3-5-sonnet-20241022", temperature = 0.7, maxTokens = 4096, ...config }) {
  const client = new Anthropic({ apiKey })

  return {
    generateContent: async (parts) => {
      const messages = []
      let systemPrompt = ""
      const userContent = []

      for (const part of parts) {
        if (typeof part === "string") {
          if (systemPrompt === "" && part.includes("You are")) {
            systemPrompt = part
          } else {
            userContent.push({ type: "text", text: part })
          }
        } else if (part.inlineData) {
          userContent.push({
            type: "image",
            source: {
              type: "base64",
              media_type: part.inlineData.mimeType,
              data: part.inlineData.data,
            },
          })
        }
      }

      if (userContent.length > 0) {
        messages.push({ role: "user", content: userContent })
      }

      try {
        const response = await client.messages.create({
          model: model,
          max_tokens: maxTokens,
          temperature: temperature,
          system: systemPrompt || undefined,
          messages: messages,
        })

        return {
          response: {
            text: () => response.content[0].text,
          },
          raw: response,
        }
      } catch (error) {
        console.error("Anthropic API error:", error)
        throw error
      }
    },

    // For compatibility with chat-style interfaces
    chat: async (messages) => {
      let systemPrompt = ""
      const anthropicMessages = []

      for (const msg of messages) {
        if (msg.role === "system") {
          systemPrompt = msg.content
        } else {
          let content
          if (Array.isArray(msg.content)) {
            content = []
            for (const part of msg.content) {
              if (typeof part === "string") {
                content.push({ type: "text", text: part })
              } else if (part.type === "text") {
                content.push({ type: "text", text: part.text })
              } else if (part.type === "image_url" && part.image_url) {
                const imageUrl = part.image_url.url
                const [mimeInfo, base64Data] = imageUrl.split(",")

                const mimeType = mimeInfo.match(/data:([^;]+)/)?.[1] || "image/jpeg"

                content.push({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: mimeType,
                    data: base64Data,
                  },
                })
              }
            }
          } else {
            content = [{ type: "text", text: msg.content }]
          }

          anthropicMessages.push({
            role: msg.role === "user" ? "user" : "assistant",
            content: content,
          })
        }
      }

      const response = await client.messages.create({
        model: model,
        max_tokens: maxTokens,
        temperature: temperature,
        system: systemPrompt || undefined,
        messages: anthropicMessages,
      })

      return {
        content: response.content[0].text,
        raw: response,
      }
    },
  }
}

/**
 * Creates an Anthropic streaming LLM instance
 * @param {object} opts - Configuration options
 * @param {string} opts.apiKey - Anthropic API key
 * @param {string} [opts.model='claude-3-5-sonnet-20241022'] - Model name
 * @param {number} [opts.temperature=0.7] - Temperature
 * @param {number} [opts.maxTokens=4096] - Max tokens
 * @returns {object} Streaming LLM instance
 */
function createStreamingLLM({
  apiKey,
  model = "claude-3-5-sonnet-20241022",
  temperature = 0.7,
  maxTokens = 4096,
  ...config
}) {
  const client = new Anthropic({ apiKey })

  return {
    streamChat: async (messages) => {
      console.log("[Anthropic Provider] Starting streaming request")

      let systemPrompt = ""
      const anthropicMessages = []

      for (const msg of messages) {
        if (msg.role === "system") {
          systemPrompt = msg.content
        } else {
          let content
          if (Array.isArray(msg.content)) {
            content = []
            for (const part of msg.content) {
              if (typeof part === "string") {
                content.push({ type: "text", text: part })
              } else if (part.type === "text") {
                content.push({ type: "text", text: part.text })
              } else if (part.type === "image_url" && part.image_url) {
                const imageUrl = part.image_url.url
                const [mimeInfo, base64Data] = imageUrl.split(",")

                const mimeType = mimeInfo.match(/data:([^;]+)/)?.[1] || "image/jpeg"

                console.log(`[Anthropic] Processing image with MIME type: ${mimeType}`)

                content.push({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: mimeType,
                    data: base64Data,
                  },
                })
              }
            }
          } else {
            content = [{ type: "text", text: msg.content }]
          }

          anthropicMessages.push({
            role: msg.role === "user" ? "user" : "assistant",
            content: content,
          })
        }
      }

      // Re-emit Anthropic's stream as OpenAI-style SSE, which the callers parse.
      const stream = new ReadableStream({
        async start(controller) {
          try {
            console.log("[Anthropic Provider] Processing messages:", anthropicMessages.length, "messages")

            let chunkCount = 0
            let totalContent = ""

            const stream = await client.messages.create({
              model: model,
              max_tokens: maxTokens,
              temperature: temperature,
              system: systemPrompt || undefined,
              messages: anthropicMessages,
              stream: true,
            })

            for await (const chunk of stream) {
              if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
                chunkCount++
                const chunkText = chunk.delta.text || ""
                totalContent += chunkText

                const data = JSON.stringify({
                  choices: [
                    {
                      delta: {
                        content: chunkText,
                      },
                    },
                  ],
                })
                controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`))
              }
            }

            console.log(
              `[Anthropic Provider] Streamed ${chunkCount} chunks, total length: ${totalContent.length} chars`,
            )

            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
            controller.close()
            console.log("[Anthropic Provider] Streaming completed successfully")
          } catch (error) {
            console.error("[Anthropic Provider] Streaming error:", error)
            controller.error(error)
          }
        },
      })

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      })
    },
  }
}

module.exports = {
    AnthropicProvider,
    createSTT,
    createLLM,
    createStreamingLLM
};
