export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
export interface ChatCompletionOptions {
    messages: ChatMessage[];
    model?: string;
    temperature?: number;
    maxTokens?: number;
    responseFormat?: {
        type: 'json_object' | 'text';
    };
}
export declare function getOpenAIStatus(): {
    circuitOpen: boolean;
    queueLength: number;
    recentRequests: number;
    cooldownRemainingMs: number;
};
export declare function chatCompletion(options: ChatCompletionOptions): Promise<string>;
export declare function _resetForTesting(): void;
export declare function chatCompletionJSON<T>(options: ChatCompletionOptions): Promise<T>;
//# sourceMappingURL=openai.d.ts.map