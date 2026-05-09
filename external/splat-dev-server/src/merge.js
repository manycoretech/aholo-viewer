import path from 'node:path';
import fs from 'node:fs/promises';

function mergeBounds(bounds) {
    if (!bounds || bounds.length === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
    const min = [
        Math.min(...bounds.map(b => b.min[0])),
        Math.min(...bounds.map(b => b.min[1])),
        Math.min(...bounds.map(b => b.min[2]))
    ];

    const max = [
        Math.max(...bounds.map(b => b.max[0])),
        Math.max(...bounds.map(b => b.max[1])),
        Math.max(...bounds.map(b => b.max[2]))
    ];
    return { min, max };
}


export async function merge(input, output) {
    try {
        await fs.stat(output);
    } catch {
        await fs.mkdir(output, { recursive: true });
    }
    const meta = {
        magicCode: 0x262834,
        type: 'lod-splat',
        version: '1.0',
        counts: 0,
        shDegree: 0,
        levels: 5,
        forwardBox: { min: [0, 0, 0], max: [0, 0, 0] },
        files: [],
        permanentFiles: [],
        tree: [],
    };
    const inputMetaList = input.map(i => ({
        basedir: path.dirname(i),
        file: i,
        output: []
    }));
    let index = 0;
    for (const inputMeta of inputMetaList) {
        const data = JSON.parse(await fs.readFile(inputMeta.file, 'utf-8'));
        meta.counts += data.counts;
        meta.shDegree = Math.max(meta.shDegree, data.shDegree);
        meta.forwardBox = mergeBounds([meta.forwardBox, data.forwardBox]);
        const copyTasks = [];
        for (const file of data.files) {
            const name = `chunk_${index}${path.extname(file)}`;
            inputMeta.output.push(index);
            meta.files.push(name);
            index++;
            const i = path.join(inputMeta.basedir, file);
            const o = path.join(path.join(output, name));
            console.log(`${i} -> ${o}`);
            copyTasks.push(fs.copyFile(i, o));
        }
        for (const permanentFile of data.permanentFiles) {
            meta.permanentFiles.push(inputMeta.output[permanentFile]);
        }
        for (const node of data.tree) {
            meta.tree.push({
                bound: node.bound,
                lods: node.lods.map(l => ({
                    ...l,
                    file: inputMeta.output[l.file]
                }))
            });
        }
        await Promise.all(copyTasks);
    }
    await fs.writeFile(path.join(output, 'lod-meta.json'), JSON.stringify(meta), 'utf-8');
}
