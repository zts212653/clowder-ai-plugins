export function parseToolArguments(raw) {
    if (typeof raw !== 'string' || raw.trim().length === 0) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch  {
        return {
            raw
        };
    }
}
export function extractTextContent(content) {
    if (typeof content === 'string') {
        const trimmed = content.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (!Array.isArray(content)) return null;
    const text = content.map((item)=>{
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        const block = item;
        if (typeof block.text === 'string') return block.text;
        if (typeof block.content === 'string') return block.content;
        return '';
    }).filter(Boolean).join('\n').trim();
    return text.length > 0 ? text : null;
}
export function extractThinkingContent(message) {
    const candidates = [
        message.thinking,
        message.reasoning,
        message.reasoning_content,
        message.thought
    ];
    for (const candidate of candidates){
        const text = extractTextContent(candidate);
        if (text) return text;
    }
    if (Array.isArray(message.content)) {
        const thinkText = message.content.map((item)=>{
            if (!item || typeof item !== 'object') return '';
            const block = item;
            if (typeof block.think === 'string') return block.think;
            if (typeof block.reasoning === 'string') return block.reasoning;
            if (block.type === 'thinking' && typeof block.text === 'string') return block.text;
            return '';
        }).filter(Boolean).join('\n').trim();
        if (thinkText) return thinkText;
    }
    return null;
}
export function parseUsage(candidate) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const stats = candidate;
    const usage = {
        ...typeof stats.total_tokens === 'number' ? {
            totalTokens: stats.total_tokens
        } : {},
        ...typeof stats.input_tokens === 'number' ? {
            inputTokens: stats.input_tokens
        } : {},
        ...typeof stats.output_tokens === 'number' ? {
            outputTokens: stats.output_tokens
        } : {},
        ...typeof stats.cached_input_tokens === 'number' ? {
            cacheReadTokens: stats.cached_input_tokens
        } : {},
        ...typeof stats.last_turn_input_tokens === 'number' ? {
            lastTurnInputTokens: stats.last_turn_input_tokens
        } : {},
        ...typeof stats.context_window === 'number' ? {
            contextWindowSize: stats.context_window
        } : {},
        ...typeof stats.context_used_tokens === 'number' ? {
            contextUsedTokens: stats.context_used_tokens
        } : {}
    };
    return Object.keys(usage).length > 0 ? usage : null;
}
export function readSessionIdFromMessage(message) {
    const values = [
        message.session_id,
        message.sessionId
    ];
    for (const value of values){
        if (typeof value === 'string' && value.trim().length > 0) return value;
    }
    return undefined;
}
function readToolCall(call) {
    if (!call || typeof call !== 'object' || !('function' in call)) return [];
    const fn = call.function;
    if (!fn || typeof fn !== 'object' || !('name' in fn) || typeof fn.name !== 'string' || !fn.name) return [];
    return [
        {
            name: fn.name,
            input: parseToolArguments('arguments' in fn ? fn.arguments : undefined)
        }
    ];
}
export function normalizeKimiEvent(raw) {
    if (!raw || typeof raw !== 'object') return {
        kind: 'ignored'
    };
    if ('line' in raw && typeof raw.line === 'string') {
        const sessionId = /To resume this session:\s*kimi\s+-r\s+([a-z0-9-]+)/i.exec(raw.line)?.[1];
        return sessionId ? {
            kind: 'resume',
            sessionId
        } : {
            kind: 'ignored'
        };
    }
    const message = raw;
    if (message.role === 'meta') {
        const sessionId = message.type === 'session.resume_hint' ? readSessionIdFromMessage(message) : undefined;
        return sessionId ? {
            kind: 'resume',
            sessionId
        } : {
            kind: 'ignored'
        };
    }
    if (message.role !== 'assistant') return {
        kind: 'ignored'
    };
    const tools = (Array.isArray(message.tool_calls) ? message.tool_calls : []).flatMap(readToolCall);
    const sessionId = readSessionIdFromMessage(message);
    const text = extractTextContent(message.content);
    const thinking = extractThinkingContent(message);
    const usage = parseUsage(message.usage) ?? parseUsage(message.stats);
    return {
        kind: 'assistant',
        ...sessionId ? {
            sessionId
        } : {},
        ...text ? {
            text
        } : {},
        ...thinking ? {
            thinking
        } : {},
        ...usage ? {
            usage
        } : {},
        tools
    };
}
