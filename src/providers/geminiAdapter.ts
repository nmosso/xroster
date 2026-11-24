import type { LlmCompletion, LlmRequest, ProviderAdapter } from './providerRouter';

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

/** Superficie mínima del SDK oficial `@google/genai` usada por xRoster (inyectable en tests). */
export interface GeminiClientLike {
    models: {
        generateContent(params: {
            model: string;
            contents: string;
            config?: { systemInstruction?: string; maxOutputTokens?: number };
        }): Promise<{
            text?: string | undefined;
            usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number } | undefined;
        }>;
    };
}

export interface GeminiAdapterOptions {
    apiKey?: string;
    model?: string;
    client?: GeminiClientLike;
}

export class GeminiAdapter implements ProviderAdapter {
    readonly provider = 'gemini' as const;
    readonly model: string;
    private client: GeminiClientLike | undefined;

    constructor(private readonly opts: GeminiAdapterOptions) {
        this.model = opts.model || DEFAULT_GEMINI_MODEL;
        this.client = opts.client;
    }

    private async getClient(): Promise<GeminiClientLike> {
        if (!this.client) {
            const { GoogleGenAI } = await import('@google/genai');
            this.client = new GoogleGenAI({ apiKey: this.opts.apiKey ?? '' }) as unknown as GeminiClientLike;
        }
        return this.client;
    }

    async complete(req: LlmRequest): Promise<LlmCompletion> {
        const client = await this.getClient();
        const config: { systemInstruction?: string; maxOutputTokens?: number } = {};
        if (req.system) config.systemInstruction = req.system;
        if (req.maxOutputTokens) config.maxOutputTokens = req.maxOutputTokens;
        const res = await client.models.generateContent({
            model: this.model,
            contents: req.prompt,
            ...(Object.keys(config).length > 0 ? { config } : {})
        });
        const u = res.usageMetadata ?? {};
        return {
            text: res.text ?? '',
            inputTokens: u.promptTokenCount ?? 0,
            outputTokens: u.candidatesTokenCount ?? 0,
            cachedTokens: u.cachedContentTokenCount ?? 0
        };
    }
}
