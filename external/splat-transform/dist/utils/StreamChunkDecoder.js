export class StreamChunkDecoder {
    constructor(reader) {
        this.currentIndex = 0;
        this.reader = reader;
    }
    setDecoders(decoders) {
        this.decoders = decoders;
        this.decodedTotals = new Uint32Array(decoders.length);
        const [totals, itemSize] = decoders[this.currentIndex].init();
        this.currentTotals = totals;
        this.currentItemSize = itemSize;
    }
    flush() {
        const { reader, decoders, decodedTotals, currentIndex, currentTotals, currentItemSize } = this;
        const stage = decoders[currentIndex];
        const decoded = decodedTotals[currentIndex];
        const counts = Math.min(currentTotals - decoded, (reader.remaining / currentItemSize) | 0);
        const buf = reader.read(counts * currentItemSize);
        stage.decode(decoded, counts, buf);
        decodedTotals[currentIndex] += counts;
        if (decodedTotals[currentIndex] === currentTotals) {
            this.currentIndex++;
            if (this.currentIndex < decoders.length) {
                const [totals, itemSize] = decoders[this.currentIndex].init();
                this.currentTotals = totals;
                this.currentItemSize = itemSize;
                this.flush();
            }
        }
    }
}
