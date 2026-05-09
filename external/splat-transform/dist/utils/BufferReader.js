export class BufferReader {
    head = 0;
    tail = 0;
    buffer;
    view;
    get remaining() {
        return this.tail - this.head;
    }
    constructor(buffer = new Uint8Array()) {
        this.buffer = buffer;
        this.view = new DataView(this.buffer.buffer);
    }
    grow(required) {
        const newCap = Math.max(required, this.buffer.length * 2);
        const next = new Uint8Array(newCap);
        next.set(this.buffer.subarray(this.head, this.tail), 0);
        this.tail -= this.head;
        this.head = 0;
        this.buffer = next;
        this.view = new DataView(next.buffer);
    }
    compact() {
        if (this.head === 0) {
            return;
        }
        this.buffer.copyWithin(0, this.head, this.tail);
        this.tail -= this.head;
        this.head = 0;
    }
    write(chunk) {
        const remaining = this.tail - this.head;
        const required = remaining + chunk.length;
        if (this.buffer.length < required) {
            this.grow(required);
        }
        else if (this.head > 0 && this.buffer.length - this.tail < chunk.length) {
            this.compact();
        }
        this.buffer.set(chunk, this.tail);
        this.tail += chunk.length;
    }
    read(counts) {
        const head = this.head;
        const tail = this.head = head + counts;
        return this.buffer.subarray(head, tail);
    }
}
