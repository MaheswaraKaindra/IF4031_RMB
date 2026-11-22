export interface BoundedJsonLimits {
    maxBytes: number;
    maxDepth: number;
}

export type BoundedParseResult =
    | { ok: true; value: unknown }
    | { ok: false; code: 'payload_too_large' | 'invalid_utf8' | 'max_depth_exceeded' | 'malformed_json'; reason: string };

/**
 * Computes maximum JSON container nesting depth iteratively without recursing or allocating AST nodes,
 * protecting the Node.js event loop and 512Mi pod memory from deeply nested or malformed streams.
 */
export function measureJsonDepth(text: string, maxDepth: number): { ok: true; depth: number } | { ok: false; depth: number } {
    let depth = 0;
    let peak = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === 92 /* \ */) {
                escaped = true;
            } else if (ch === 34 /* " */) {
                inString = false;
            }
            continue;
        }
        if (ch === 34 /* " */) {
            inString = true;
        } else if (ch === 123 /* { */ || ch === 91 /* [ */) {
            depth += 1;
            if (depth > peak) peak = depth;
            if (depth > maxDepth) return { ok: false, depth };
        } else if (ch === 125 /* } */ || ch === 93 /* ] */) {
            depth = Math.max(0, depth - 1);
        }
    }
    return { ok: true, depth: peak };
}

export function parseBoundedRawJson(raw: Buffer, limits: BoundedJsonLimits): BoundedParseResult {
    if (raw.byteLength > limits.maxBytes) {
        return {
            ok: false,
            code: 'payload_too_large',
            reason: `payload_too_large: ${raw.byteLength} bytes exceeds limit ${limits.maxBytes}`,
        };
    }

    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
        return {
            ok: false,
            code: 'invalid_utf8',
            reason: 'invalid_utf8: raw byte stream is not valid UTF-8',
        };
    }

    const depthCheck = measureJsonDepth(text, limits.maxDepth);
    if (!depthCheck.ok) {
        return {
            ok: false,
            code: 'max_depth_exceeded',
            reason: `max_depth_exceeded: JSON depth exceeded limit ${limits.maxDepth}`,
        };
    }

    try {
        const value = JSON.parse(text) as unknown;
        return { ok: true, value };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            ok: false,
            code: 'malformed_json',
            reason: `malformed_json: ${msg}`,
        };
    }
}
