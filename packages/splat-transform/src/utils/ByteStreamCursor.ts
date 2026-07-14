export class ByteStreamCursor {
    private reader: ReadableStreamDefaultReader<Uint8Array>;
    private chunk: Uint8Array | undefined;
    private chunkOffset = 0;

    constructor(stream: ReadableStream<Uint8Array>) {
        this.reader = stream.getReader();
    }

    cancel(reason?: unknown) {
        this.chunk = undefined;
        this.chunkOffset = 0;
        return this.reader.cancel(reason);
    }

    private async ensureChunk() {
        while (!this.chunk || this.chunkOffset >= this.chunk.byteLength) {
            const { done, value } = await this.reader.read();
            if (done || !value) {
                return false;
            }
            this.chunk = value;
            this.chunkOffset = 0;
        }
        return true;
    }

    private advance(byteLength: number) {
        this.chunkOffset += byteLength;
        if (this.chunkOffset === this.chunk!.byteLength) {
            this.chunk = undefined;
            this.chunkOffset = 0;
        }
    }

    async readInto(target: Uint8Array, offset = 0, byteLength = target.byteLength - offset) {
        if (
            !Number.isSafeInteger(offset) ||
            !Number.isSafeInteger(byteLength) ||
            offset < 0 ||
            byteLength < 0 ||
            offset + byteLength > target.byteLength
        ) {
            throw new RangeError('Invalid stream read range');
        }

        const end = offset + byteLength;
        while (offset < end) {
            if (!(await this.ensureChunk())) {
                throw new Error('Stream ended unexpectedly');
            }
            const copyLength = Math.min(end - offset, this.chunk!.byteLength - this.chunkOffset);
            target.set(this.chunk!.subarray(this.chunkOffset, this.chunkOffset + copyLength), offset);
            this.advance(copyLength);
            offset += copyLength;
        }
    }

    async readChunks(byteLength: number, onChunk: (chunk: Uint8Array) => void | Promise<void>) {
        let remaining = byteLength;
        while (remaining > 0) {
            if (!(await this.ensureChunk())) {
                throw new Error('Stream ended unexpectedly');
            }
            const chunkLength = Math.min(remaining, this.chunk!.byteLength - this.chunkOffset);
            const chunk = this.chunk!.subarray(this.chunkOffset, this.chunkOffset + chunkLength);
            this.advance(chunkLength);
            remaining -= chunkLength;
            await onChunk(chunk);
        }
    }

    async skip(byteLength: number) {
        await this.readChunks(byteLength, () => {});
    }

    async readUntil(delimiter: Uint8Array) {
        if (delimiter.byteLength === 0) {
            throw new RangeError('Stream delimiter must not be empty');
        }

        const prefix = new Uint32Array(delimiter.byteLength);
        for (let i = 1, matched = 0; i < delimiter.byteLength; i++) {
            while (matched > 0 && delimiter[i] !== delimiter[matched]) {
                matched = prefix[matched - 1];
            }
            if (delimiter[i] === delimiter[matched]) {
                matched++;
            }
            prefix[i] = matched;
        }

        const chunks: Uint8Array[] = [];
        let byteLength = 0;
        let matched = 0;
        while (await this.ensureChunk()) {
            const source = this.chunk!;
            const start = this.chunkOffset;
            let end = start;
            for (; end < source.byteLength; end++) {
                const value = source[end];
                while (matched > 0 && value !== delimiter[matched]) {
                    matched = prefix[matched - 1];
                }
                if (value === delimiter[matched]) {
                    matched++;
                }
                if (matched === delimiter.byteLength) {
                    end++;
                    const chunk = source.subarray(start, end);
                    this.advance(chunk.byteLength);
                    if (chunks.length === 0) {
                        return chunk;
                    }
                    chunks.push(chunk);
                    byteLength += chunk.byteLength;
                    const result = new Uint8Array(byteLength);
                    let offset = 0;
                    for (const part of chunks) {
                        result.set(part, offset);
                        offset += part.byteLength;
                    }
                    return result;
                }
            }

            const chunk = source.subarray(start, end);
            chunks.push(chunk);
            byteLength += chunk.byteLength;
            this.advance(chunk.byteLength);
        }

        throw new Error('Stream ended unexpectedly');
    }

    async readExact(byteLength: number) {
        if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
            throw new RangeError(`Invalid stream read length: ${byteLength}`);
        }
        if (byteLength === 0) {
            return new Uint8Array(0);
        }
        if (!(await this.ensureChunk())) {
            throw new Error('Stream ended unexpectedly');
        }

        const available = this.chunk!.byteLength - this.chunkOffset;
        if (byteLength <= available) {
            const result = this.chunk!.subarray(this.chunkOffset, this.chunkOffset + byteLength);
            this.advance(byteLength);
            return result;
        }

        const result = new Uint8Array(byteLength);
        await this.readInto(result);
        return result;
    }

    async readUint32(littleEndian: boolean) {
        const buffer = await this.readExact(4);
        return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0, littleEndian);
    }
}
