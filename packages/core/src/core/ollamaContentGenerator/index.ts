/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../contentGenerator.js';
import { AuthType } from '../contentGenerator.js';

// Import types from @google/genai directly
import { GenerateContentResponse } from '@google/genai';
import type {
  GenerateContentParameters,
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  FinishReason,
  Part,
} from '@google/genai';

// Define a type for Ollama tools format
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface OllamaToolFunction {
  name: string;
  description?: string;
  parameters: JsonObject; // Parameters can be complex JSON schema
}

export interface OllamaTool {
  type: string;
  function: OllamaToolFunction;
}

export interface OllamaGenerateRequest {
  model: string;
  messages: OllamaMessage[];
  stream?: boolean;
  tools?: OllamaTool[]; // Ollama tools format
  options?: {
    // Sampling parameters
    num_predict?: number;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    repeat_penalty?: number;
    seed?: number;
  };
}

export interface OllamaMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface OllamaToolCall {
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface OllamaGenerateResponse {
  model: string;
  created_at: string;
  message: {
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export interface OllamaEmbeddingResponse {
  model: string;
  embeddings: number[][];
}

export class OllamaContentGenerator implements ContentGenerator {
  private readonly config: ContentGeneratorConfig;

  constructor(config: ContentGeneratorConfig) {
    if (config.authType !== AuthType.USE_OLLAMA) {
      throw new Error(
        `Invalid authType for OllamaContentGenerator: ${config.authType}`,
      );
    }
    this.config = config;
  }

  async generateContent(
    request: GenerateContentParameters,
    _userPromptId: string,
  ): Promise<GenerateContentResponse> {
    const baseUrl = this.config.baseUrl || 'http://localhost:11434';
    const url = `${baseUrl}/api/chat`;

    // Transform the request to Ollama format
    const ollamaRequest = this.transformToOllamaRequest(request);

    console.log('[Ollama Debug] Request URL:', url);
    console.log(
      '[Ollama Debug] Request payload:',
      JSON.stringify(ollamaRequest, null, 2),
    );

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(ollamaRequest),
      });

      console.log('[Ollama Debug] Response status:', response.status);
      console.log('[Ollama Debug] Response status text:', response.statusText);

      if (!response.ok) {
        const responseBody = await response.text();
        console.log('[Ollama Debug] Response body:', responseBody);
        throw new Error(
          `Ollama API request failed: ${response.status} ${response.statusText}. Body: ${responseBody}`,
        );
      }

      const result: OllamaGenerateResponse = await response.json();
      console.log(
        '[Ollama Debug] Response data:',
        JSON.stringify(result, null, 2),
      );

      if (!result.message?.content) {
        throw new Error('No response text received from Ollama');
      }

      // Transform the response to Google GenAI format
      return this.transformToGenAIResponse(result);
    } catch (error) {
      console.error('Error generating content with Ollama', error);
      throw error;
    }
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const baseUrl = this.config.baseUrl || 'http://localhost:11434';
    const url = `${baseUrl}/api/chat`;

    // Transform the request to Ollama format with streaming enabled
    const ollamaRequest = this.transformToOllamaRequest(request);
    ollamaRequest.stream = true;

    console.log('[Ollama Debug Stream] Request URL:', url);
    console.log(
      '[Ollama Debug Stream] Request payload:',
      JSON.stringify(ollamaRequest, null, 2),
    );

    // Create a simple async generator function
    const generator = async function* (
      self: OllamaContentGenerator,
    ): AsyncGenerator<GenerateContentResponse> {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(ollamaRequest),
        });

        console.log('[Ollama Debug Stream] Response status:', response.status);
        console.log(
          '[Ollama Debug Stream] Response status text:',
          response.statusText,
        );

        if (!response.ok) {
          const responseBody = await response.text();
          console.log('[Ollama Debug Stream] Response body:', responseBody);
          throw new Error(
            `Ollama API request failed: ${response.status} ${response.statusText}. Body: ${responseBody}`,
          );
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('Could not get response reader');
        }

        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Process each complete JSON line
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep incomplete line in buffer

            for (const line of lines) {
              if (line.trim() === '') continue;

              try {
                const chunk: OllamaGenerateResponse = JSON.parse(line);

                if (chunk.message?.content || chunk.message?.tool_calls) {
                  // Yield incremental response
                  yield self.transformToGenAIResponse(chunk);
                }

                if (chunk.done) {
                  // Final response
                  yield self.transformToGenAIResponse(chunk);
                  break;
                }
              } catch (_) {
                console.warn('Failed to parse Ollama stream chunk', line);
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      } catch (error) {
        console.error('Error streaming content from Ollama', error);
        throw error;
      }
    }.bind(this);

    return generator(this);
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    // Ollama doesn't have a direct countTokens API, so we'll estimate
    // Using a common approximation: 1 token ≈ 4 characters
    let content = '';
    if (request.contents) {
      // Handle both single content and array of contents
      const contents = Array.isArray(request.contents)
        ? request.contents
        : [request.contents];
      for (const c of contents) {
        if (c && typeof c === 'object' && 'parts' in c) {
          const parts = Array.isArray(c.parts) ? c.parts : [];
          for (const p of parts) {
            if (
              p &&
              typeof p === 'object' &&
              'text' in p &&
              typeof p.text === 'string'
            ) {
              content += p.text + ' ';
            }
          }
        }
      }
    }
    const estimatedTokens = Math.ceil(content.length / 4);

    return {
      totalTokens: estimatedTokens,
    };
  }

  async embedContent(
    request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    const baseUrl = this.config.baseUrl || 'http://localhost:11434';
    const url = `${baseUrl}/api/embeddings`;

    // Prepare the embedding request
    let prompt = '';
    if (request.contents) {
      // Handle both single content and array of contents
      const contents = Array.isArray(request.contents)
        ? request.contents
        : [request.contents];
      for (const content of contents) {
        if (content && typeof content === 'object' && 'parts' in content) {
          const parts = Array.isArray(content.parts) ? content.parts : [];
          for (const part of parts) {
            if (
              part &&
              typeof part === 'object' &&
              'text' in part &&
              typeof part.text === 'string'
            ) {
              prompt += part.text + ' ';
            }
          }
        }
      }
    }

    const embeddingRequest = {
      model: this.config.model,
      prompt: prompt.trim(),
    };

    console.log('[Ollama Debug Embed] Request URL:', url);
    console.log(
      '[Ollama Debug Embed] Request payload:',
      JSON.stringify(embeddingRequest, null, 2),
    );

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(embeddingRequest),
      });

      console.log('[Ollama Debug Embed] Response status:', response.status);
      console.log(
        '[Ollama Debug Embed] Response status text:',
        response.statusText,
      );

      if (!response.ok) {
        const responseBody = await response.text();
        console.log('[Ollama Debug Embed] Response body:', responseBody);
        throw new Error(
          `Ollama embeddings API request failed: ${response.status} ${response.statusText}. Body: ${responseBody}`,
        );
      }

      const result: OllamaEmbeddingResponse = await response.json();
      console.log(
        '[Ollama Debug Embed] Response data:',
        JSON.stringify(result, null, 2),
      );

      return {
        embeddings: [
          {
            values: result.embeddings[0] || [],
          },
        ],
      };
    } catch (error) {
      console.error('Error generating embeddings with Ollama', error);
      throw error;
    }
  }

  useSummarizedThinking(): boolean {
    // Ollama models typically don't need summarized thinking
    return false;
  }

  private transformToOllamaRequest(
    request: GenerateContentParameters,
  ): OllamaGenerateRequest {
    const messages: OllamaMessage[] = [];

    // Convert GenerateContentParameters to Ollama messages
    if (request.contents) {
      // Handle both single content and array of contents
      const contents = Array.isArray(request.contents)
        ? request.contents
        : [request.contents];
      for (const content of contents) {
        // Check if content is actually a Content object with role and parts
        if (
          typeof content === 'object' &&
          content &&
          'role' in content &&
          'parts' in content
        ) {
          const role =
            content.role === 'model'
              ? 'assistant'
              : content.role === 'user'
                ? 'user'
                : 'user'; // default to user

          let textContent = '';

          if (content.parts) {
            // Handle both single part and array of parts
            const parts = Array.isArray(content.parts)
              ? content.parts
              : [content.parts];
            for (const part of parts) {
              if (
                part &&
                typeof part === 'object' &&
                'text' in part &&
                typeof part.text === 'string'
              ) {
                textContent += part.text + ' ';
              }
            }
          }

          if (textContent.trim()) {
            messages.push({
              role,
              content: textContent.trim(),
            });
          }
        }
      }
    }

    const ollamaRequest: OllamaGenerateRequest = {
      model: this.config.model,
      messages,
      stream: false,
    };

    // Handle tools if they are provided in the request
    // Use type assertion to access potentially non-existent tools property
    const requestWithTools = request as GenerateContentParameters & {
      tools?: unknown[];
    };
    if (
      requestWithTools.tools &&
      Array.isArray(requestWithTools.tools) &&
      requestWithTools.tools.length > 0
    ) {
      // Convert Google GenAI tools to Ollama format
      ollamaRequest.tools = requestWithTools.tools
        .map((tool: unknown) => {
          // The tool should have functionDeclarations in Google GenAI format
          if (
            tool &&
            typeof tool === 'object' &&
            'functionDeclarations' in tool &&
            Array.isArray(tool.functionDeclarations) &&
            tool.functionDeclarations.length > 0
          ) {
            const func = tool.functionDeclarations[0];
            if (func && typeof func === 'object' && 'name' in func) {
              return {
                type: 'function',
                function: {
                  name: func.name as string,
                  description:
                    'description' in func
                      ? (func.description as string) || ''
                      : '',
                  parameters:
                    'parameters' in func
                      ? (func.parameters as JsonObject) || {}
                      : {},
                },
              };
            }
          }
          return { type: '', function: { name: '', parameters: {} } }; // Return empty object if no function declarations
        })
        .filter((tool: unknown) => {
          if (
            tool &&
            typeof tool === 'object' &&
            'type' in tool &&
            'function' in tool &&
            tool.function &&
            typeof tool.function === 'object' &&
            'name' in tool.function
          ) {
            return tool.type !== '' && tool.function.name !== '';
          }
          return false;
        }); // Filter out empty tools
    }

    // Add sampling parameters from config
    if (this.config.samplingParams) {
      ollamaRequest.options = {
        temperature: this.config.samplingParams.temperature,
        top_p: this.config.samplingParams.top_p,
        top_k: this.config.samplingParams.top_k,
        repeat_penalty: this.config.samplingParams.repetition_penalty,
        num_predict: this.config.samplingParams.max_tokens,
      };
    }

    return ollamaRequest;
  }

  private transformToGenAIResponse(
    response: OllamaGenerateResponse,
  ): GenerateContentResponse {
    const genAIResponse = new GenerateContentResponse();

    // Prepare the content parts - text and potentially function calls
    const parts: Part[] = response.message.content
      ? [
          {
            text: response.message.content,
          },
        ]
      : [];

    // Handle tool calls if present in the response
    if (response.message.tool_calls && response.message.tool_calls.length > 0) {
      for (const toolCall of response.message.tool_calls) {
        // Add function call to parts - using the correct Part type structure
        const functionCallPart: Record<string, unknown> = {
          functionCall: {
            name: toolCall.function.name,
            args: JSON.parse(toolCall.function.arguments || '{}') as JsonObject,
          },
        };
        parts.push(functionCallPart as Part);
      }
    }

    genAIResponse.candidates = [
      {
        content: {
          role: 'model',
          parts,
        },
        finishReason: response.done
          ? ('STOP' as FinishReason)
          : ('LENGTH' as FinishReason),
        index: 0,
      },
    ];

    genAIResponse.usageMetadata = {
      promptTokenCount: response.prompt_eval_count || 0,
      candidatesTokenCount: response.eval_count || 0,
      totalTokenCount:
        (response.prompt_eval_count || 0) + (response.eval_count || 0),
    };

    return genAIResponse;
  }
}
