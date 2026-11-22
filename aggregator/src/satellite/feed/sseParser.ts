export interface SseFrame {
    id: string | undefined;
    event: string;
    data: string;
}

/** Incremental Server-Sent Events parser: tolerates chunk boundaries anywhere, CRLF/CR/LF, comments and multi-line data. */
export class SseParser {
    private readonly decoder = new TextDecoder('utf-8');
    private pending = '';
    private id: string | undefined;
    private event = '';
    private data: string[] = [];

    push(chunk: Uint8Array): SseFrame[] {
        this.pending += this.decoder.decode(chunk, { stream: true });
        const frames: SseFrame[] = [];
        let start = 0;
        for (let i = 0; i < this.pending.length; i++) {
            const c = this.pending[i];
            if (c !== '\n' && c !== '\r') continue;
            if (c === '\r' && i === this.pending.length - 1) break;
            const line = this.pending.slice(start, i);
            if (c === '\r' && this.pending[i + 1] === '\n') i++;
            start = i + 1;
            const frame = this.line(line);
            if (frame) frames.push(frame);
        }
        this.pending = this.pending.slice(start);
        return frames;
    }

    private line(line: string): SseFrame | null {
        if (line === '') {
            if (this.data.length === 0 && this.event === '') {
                this.id = undefined;
                return null;
            }
            const frame: SseFrame = { id: this.id, event: this.event || 'message', data: this.data.join('\n') };
            this.id = undefined;
            this.event = '';
            this.data = [];
            return frame;
        }
        if (line.startsWith(':')) return null;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'id') this.id = value;
        else if (field === 'event') this.event = value;
        else if (field === 'data') this.data.push(value);
        return null;
    }
}
