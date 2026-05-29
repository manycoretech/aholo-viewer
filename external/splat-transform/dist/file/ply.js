import { SH_C0, SH_MAPS, NUM_F_REST_TO_SH_DEGREE } from '../constant.js';
import { BufferReader, StreamChunkDecoder, mortonSort } from '../utils/index.js';
const F_REST_REGEX = /^f_rest_([0-9]{1,2})$/;
function createEmptyBlock(properties, shDegree) {
    const result = {
        f_rest: new Array(SH_MAPS[shDegree]),
    };
    for (const name of Object.keys(properties)) {
        if (F_REST_REGEX.test(name)) {
            continue;
        }
        result[name] = 0;
    }
    return result;
}
const FIELD_BYTES = {
    char: 1,
    uchar: 1,
    short: 2,
    ushort: 2,
    int: 4,
    uint: 4,
    float: 4,
    double: 8,
};
function createParseFn(properties, littleEndian, shDegree) {
    function createPropertyParse(type) {
        switch (type) {
            case 'char':
                return 'data.getInt8(offset)';
            case 'uchar':
                return 'data.getUint8(offset)';
            case 'short':
                return `data.getInt16(offset, ${littleEndian})`;
            case 'ushort':
                return `data.getUint16(offset, ${littleEndian})`;
            case 'int':
                return `data.getInt32(offset, ${littleEndian})`;
            case 'uint':
                return `data.getUint32(offset, ${littleEndian})`;
            case 'float':
                return `data.getFloat32(offset, ${littleEndian})`;
            case 'double':
                return `data.getFloat64(offset, ${littleEndian})`;
        }
    }
    let itemSize = 0;
    const parserSrc = [];
    const shLen = SH_MAPS[shDegree] / 3;
    for (const [propertyName, propertyType] of Object.entries(properties)) {
        const fRestMatch = propertyName.match(F_REST_REGEX);
        if (fRestMatch) {
            let fRestIndex = parseInt(fRestMatch[1], 10);
            fRestIndex = (fRestIndex % shLen) * 3 + Math.floor(fRestIndex / shLen);
            parserSrc.push(`item.f_rest[${fRestIndex}] = ${createPropertyParse(propertyType)};`);
        }
        else {
            parserSrc.push(`item.${propertyName} = ${createPropertyParse(propertyType)};`);
        }
        parserSrc.push(`offset += ${FIELD_BYTES[propertyType]};`);
        itemSize += FIELD_BYTES[propertyType];
    }
    return [itemSize, new Function('data', 'offset', 'item', parserSrc.join('\n'))];
}
const HeaderTerminator = 'end_header\n';
export class PlyFile {
    constructor() {
        this.littleEndian = true;
        this.comments = [];
        this.elements = {};
        this.isSuperSplatCompressed = false;
        this.counts = 0;
        this.shDegree = 0;
    }
    initHeader(header) {
        let curElement;
        const lines = header.trim().split('\n').map(v => v.trim()).filter(v => !!v);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (i === 0) {
                if (line !== 'ply') {
                    throw new Error('Invalid PLY header');
                }
                continue;
            }
            const fields = line.split(' ');
            switch (fields[0]) {
                case 'format':
                    if (fields[1] === 'binary_little_endian') {
                        this.littleEndian = true;
                    }
                    else if (fields[1] === 'binary_big_endian') {
                        this.littleEndian = false;
                    }
                    else {
                        throw new Error(`Unsupported PLY format: ${fields[1]}`);
                    }
                    if (fields[2] !== '1.0') {
                        throw new Error(`Unsupported PLY version: ${fields[2]}`);
                    }
                    break;
                case 'comment':
                    this.comments.push(line.slice('comment '.length));
                    break;
                case 'element': {
                    const name = fields[1];
                    curElement = this.elements[name] = {
                        name,
                        count: parseInt(fields[2], 10),
                        properties: {},
                    };
                    break;
                }
                case 'property':
                    if (!curElement) {
                        throw new Error('Property must be inside an element');
                    }
                    if (!FIELD_BYTES[fields[1]]) {
                        throw new Error(`Unsupported property type '${fields[1]}'`);
                    }
                    curElement.properties[fields[2]] = fields[1];
                    break;
                case 'end_header':
                    break;
                default:
                    console.warn(`Skipping unsupported PLY keyword: ${fields[0]}`);
                    break;
            }
        }
        const { elements } = this;
        const isSuperSplatCompressed = this.isSuperSplatCompressed = !!elements.chunk;
        this.counts = elements.vertex?.count ?? 0;
        const shElement = isSuperSplatCompressed ? elements.sh : elements.vertex;
        if (shElement) {
            const { properties } = shElement;
            let num_f_rest = 0;
            while (properties[`f_rest_${num_f_rest}`]) {
                num_f_rest += 1;
            }
            const shDegree = NUM_F_REST_TO_SH_DEGREE[num_f_rest];
            if (shDegree === undefined) {
                throw new Error(`Unsupported number of SH coefficients: ${num_f_rest}`);
            }
            this.shDegree = shDegree;
        }
        // check invalid
        for (const name in elements) {
            const { properties } = elements[name];
            if (isSuperSplatCompressed) {
                if (name === 'chunk') {
                    const { min_x, min_y, min_z, max_x, max_y, max_z, min_scale_x, min_scale_y, min_scale_z, max_scale_x, max_scale_y, max_scale_z, min_r, min_g, min_b, max_r, max_g, max_b, } = properties;
                    if (!min_x || !min_y || !min_z ||
                        !max_x || !max_y || !max_z ||
                        !min_scale_x || !min_scale_y || !min_scale_z ||
                        !max_scale_x || !max_scale_y || !max_scale_z ||
                        !min_r || !min_g || !min_b ||
                        !max_r || !max_g || !max_b) {
                        throw new Error('Missing Compressed PLY chunk properties');
                    }
                }
                else if (name === 'vertex') {
                    const { packed_position, packed_rotation, packed_scale, packed_color } = properties;
                    if (!packed_position || !packed_rotation || !packed_scale || !packed_color) {
                        throw new Error('Missing Compressed PLY vertex properties');
                    }
                }
            }
            else {
                if (name === 'vertex') {
                    const { x, y, z, scale_0, scale_1, scale_2, rot_0, rot_1, rot_2, rot_3, f_dc_0, f_dc_1, f_dc_2, opacity, } = properties;
                    if (!x || !y || !z ||
                        !scale_0 || !scale_1 || !scale_2 ||
                        !rot_0 || !rot_1 || !rot_2 || !rot_3 ||
                        !f_dc_0 || !f_dc_1 || !f_dc_2 || !opacity) {
                        throw new Error('Missing PLY vertex properties');
                    }
                }
            }
        }
    }
    async read(stream, _contentLength, data) {
        const setFn = data.set.bind(data);
        const setShFn = data.setShN.bind(data);
        let headerParsed = false;
        let header = '';
        const reader = new BufferReader();
        const decoder = new StreamChunkDecoder(reader);
        let BlockOffset = 0;
        const chunks = [];
        const single = {
            x: 0, y: 0, z: 0,
            sx: 0, sy: 0, sz: 0,
            qx: 0, qy: 0, qz: 0, qw: 0,
            r: 0, g: 0, b: 0, a: 0,
            shN: [],
        };
        const initDecoder = () => {
            const { elements, littleEndian, isSuperSplatCompressed, shDegree } = this;
            const chunkDecoders = [];
            for (const name in elements) {
                const { count, properties } = elements[name];
                const block = createEmptyBlock(properties, shDegree);
                const [itemSize, parseFn] = createParseFn(properties, littleEndian, shDegree);
                let fn = () => { };
                if (isSuperSplatCompressed) {
                    if (name === 'chunk') {
                        fn = (i, item) => {
                            chunks[(i - BlockOffset)] = { ...item };
                        };
                    }
                    else if (name === 'sh') {
                        fn = (i, item) => {
                            setShFn(i, item.f_rest.map(v => (v * 8) / 255 - 4));
                        };
                    }
                    else if (name === 'vertex') {
                        fn = (i, item) => {
                            const chunk = chunks[(i - BlockOffset) >>> 8];
                            if (!chunk) {
                                throw new Error('Missing PLY chunk');
                            }
                            const { min_x, min_y, min_z, max_x, max_y, max_z, min_scale_x, min_scale_y, min_scale_z, max_scale_x, max_scale_y, max_scale_z, min_r, min_g, min_b, max_r, max_g, max_b, } = chunk;
                            const { packed_position, packed_rotation, packed_scale, packed_color } = item;
                            single.x = (((packed_position >>> 21) & 2047) / 2047) * (max_x - min_x) + min_x;
                            single.y = (((packed_position >>> 11) & 1023) / 1023) * (max_y - min_y) + min_y;
                            single.z = ((packed_position & 2047) / 2047) * (max_z - min_z) + min_z;
                            const r0 = (((packed_rotation >>> 20) & 1023) / 1023 - 0.5) * Math.SQRT2;
                            const r1 = (((packed_rotation >>> 10) & 1023) / 1023 - 0.5) * Math.SQRT2;
                            const r2 = ((packed_rotation & 1023) / 1023 - 0.5) * Math.SQRT2;
                            const rr = Math.sqrt(Math.max(0, 1.0 - r0 * r0 - r1 * r1 - r2 * r2));
                            const rOrder = packed_rotation >>> 30;
                            single.qx = rOrder === 0 ? r0 : rOrder === 1 ? rr : r1;
                            single.qy = rOrder <= 1 ? r1 : rOrder === 2 ? rr : r2;
                            single.qz = rOrder <= 2 ? r2 : rr;
                            single.qw = rOrder === 0 ? rr : r0;
                            single.sx = Math.exp((((packed_scale >>> 21) & 2047) / 2047) * (max_scale_x - min_scale_x) + min_scale_x);
                            single.sy = Math.exp((((packed_scale >>> 11) & 1023) / 1023) * (max_scale_y - min_scale_y) + min_scale_y);
                            single.sz = Math.exp(((packed_scale & 2047) / 2047) * (max_scale_z - min_scale_z) + min_scale_z);
                            single.r = (((packed_color >>> 24) & 255) / 255) * (max_r - min_r) + min_r;
                            single.g = (((packed_color >>> 16) & 255) / 255) * (max_g - min_g) + min_g;
                            single.b = (((packed_color >>> 8) & 255) / 255) * (max_b - min_b) + min_b;
                            single.a = (packed_color & 255) / 255;
                            setFn(i, single);
                        };
                    }
                }
                else if (name === 'vertex') {
                    fn = (i, item) => {
                        single.x = item.x;
                        single.y = item.y;
                        single.z = item.z;
                        single.sx = Math.exp(item.scale_0);
                        single.sy = Math.exp(item.scale_1);
                        single.sz = Math.exp(item.scale_2);
                        single.qx = item.rot_1;
                        single.qy = item.rot_2;
                        single.qz = item.rot_3;
                        single.qw = item.rot_0;
                        single.r = item.f_dc_0 * SH_C0 + 0.5;
                        single.g = item.f_dc_1 * SH_C0 + 0.5;
                        single.b = item.f_dc_2 * SH_C0 + 0.5;
                        single.a = 1.0 / (1.0 + Math.exp(-item.opacity));
                        setFn(i, single);
                        setShFn(i, item.f_rest);
                    };
                }
                chunkDecoders.push({
                    init: () => [count, itemSize],
                    decode: (offset, counts, buffer) => {
                        offset += BlockOffset;
                        const dataview = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
                        for (let i = 0; i < counts; i++) {
                            parseFn(dataview, i * itemSize, block);
                            fn(offset + i, block);
                        }
                    },
                });
            }
            decoder.setDecoders(chunkDecoders);
        };
        const textDecoder = new TextDecoder();
        const source = stream.getReader();
        while (true) {
            const { done, value } = await source.read();
            if (done) {
                break;
            }
            reader.write(value);
            if (!headerParsed) {
                const HeaderReadBlockSize = 4096;
                const counts = (reader.remaining / HeaderReadBlockSize) | 0;
                for (let i = 0; i < counts; i++) {
                    const chunk = reader.read(HeaderReadBlockSize);
                    header += textDecoder.decode(chunk, { stream: true });
                    const idx = header.indexOf(HeaderTerminator);
                    if (idx >= 0) {
                        header = header.slice(0, idx + HeaderTerminator.length);
                        reader.head -= HeaderReadBlockSize - (new TextEncoder().encode(header).length % HeaderReadBlockSize);
                        this.initHeader(header);
                        initDecoder();
                        BlockOffset = await data.initBlock(this.counts, this.shDegree);
                        headerParsed = true;
                        break;
                    }
                }
                if (!headerParsed) {
                    continue;
                }
            }
            decoder.flush();
        }
        data.finishBlock();
    }
    async write(stream, data, indices = mortonSort(data)) {
        const writer = stream.getWriter();
        const counts = data.counts;
        const shDegree = data.shDegree;
        const shCounts = SH_MAPS[shDegree];
        const shCoeffs = shCounts / 3;
        const header = [
            'ply',
            'format binary_little_endian 1.0',
            `comment Generated by EGS`,
            `element vertex ${counts}`,
            'property float x',
            'property float y',
            'property float z',
            'property float scale_0',
            'property float scale_1',
            'property float scale_2',
            'property float rot_1',
            'property float rot_2',
            'property float rot_3',
            'property float rot_0',
            'property float f_dc_0',
            'property float f_dc_1',
            'property float f_dc_2',
            'property float opacity',
            new Array(shCounts).fill(0).map((_, i) => `property float f_rest_${i}`),
            'end_header',
            '',
        ].flat().join('\n');
        writer.write(new TextEncoder().encode(header));
        const ItemSize = 14 + shCounts;
        const chunkSize = 1024;
        const chunkCounts = Math.ceil(counts / chunkSize);
        const single = {
            x: 0, y: 0, z: 0,
            sx: 0, sy: 0, sz: 0,
            qx: 0, qy: 0, qz: 0, qw: 0,
            r: 0, g: 0, b: 0, a: 0,
            shN: new Array(shCounts),
        };
        const shN = single.shN;
        for (let i = 0; i < chunkCounts; i++) {
            if (writer.desiredSize <= 0) {
                await writer.ready;
            }
            const currentChunkSize = Math.min(chunkSize, counts - i * chunkSize);
            const chunk = new Float32Array(currentChunkSize * ItemSize);
            const offset = i * chunkSize;
            for (let j = 0; j < currentChunkSize; j++) {
                const idx = indices[offset + j];
                data.get(idx, single);
                data.getShN(idx, shN);
                const o = j * ItemSize;
                chunk[o + 0] = single.x;
                chunk[o + 1] = single.y;
                chunk[o + 2] = single.z;
                chunk[o + 3] = Math.log(single.sx);
                chunk[o + 4] = Math.log(single.sy);
                chunk[o + 5] = Math.log(single.sz);
                chunk[o + 6] = single.qx;
                chunk[o + 7] = single.qy;
                chunk[o + 8] = single.qz;
                chunk[o + 9] = single.qw;
                chunk[o + 10] = (single.r - 0.5) / SH_C0;
                chunk[o + 11] = (single.g - 0.5) / SH_C0;
                chunk[o + 12] = (single.b - 0.5) / SH_C0;
                chunk[o + 13] = single.a === 0 ? -100 : -Math.log(1 / single.a - 1);
                for (let k = 0; k < shCounts; k++) {
                    chunk[o + 14 + k] = shN[(k % shCoeffs) * 3 + ((k / shCoeffs) | 0)];
                }
            }
            writer.write(new Uint8Array(chunk.buffer));
            await Promise.resolve();
        }
        await writer.close();
    }
}
