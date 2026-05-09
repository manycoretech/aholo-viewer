import fs from 'node:fs';
import { createSHRotateFn, fastDeleteSplat, Matrix3, Matrix4, Quaternion, Vector3 } from '../utils/index.js';
import { BaseTask } from './BaseTask.js';
async function createSplatModify(path, counts) {
    if (!path) {
        return undefined;
    }
    const { isRowMatrix = true, transform, deletedIndices: deletedIndicesBitMap = [], indicesTransform = [], } = JSON.parse(fs.readFileSync(path, 'utf-8'));
    const used = new Uint8Array(counts);
    let usedCounts = 0;
    const deletedIndices = [];
    for (let i = 0; i < deletedIndicesBitMap.length; i++) {
        const v = deletedIndicesBitMap[i];
        for (let j = 0; j < 8; j++) {
            if (v & (1 << j)) {
                const idx = i * 8 + j;
                deletedIndices.push(idx);
                used[idx] = 1;
                usedCounts++;
            }
        }
    }
    const groupIndices = [];
    const groupTransforms = [];
    const modelMatrix = new Matrix4(transform, isRowMatrix);
    const transforms = indicesTransform.map(v => new Matrix4(v.transform, isRowMatrix).multiply(modelMatrix));
    for (let i = 0; i < transforms.length; i++) {
        const { indices } = indicesTransform[i];
        for (let j = 0; j < indices.length; j++) {
            used[indices[j]] = 1;
        }
        usedCounts += indices.length;
        const matrix = transforms[i];
        if (matrix.equals(Matrix4.ONE)) {
            continue;
        }
        const scale = new Vector3(1, 1, 1);
        const quat = new Quaternion(0, 0, 0, 1);
        matrix.decompose(new Vector3(1, 1, 1), quat, scale);
        groupIndices.push(indices);
        groupTransforms.push({
            isScale: !scale.equals(Vector3.ONE),
            isRotate: !quat.equals(Quaternion.ONE),
            matrix,
            scale,
            quat,
            shRotateFn: createSHRotateFn(new Matrix3().setFromMatrix4(new Matrix4().compose(new Vector3(0, 0, 0), quat, new Vector3(1, 1, 1)))),
        });
    }
    if (!modelMatrix.equals(Matrix4.ONE)) {
        const indices = new Array(counts - usedCounts);
        for (let i = 0; i < used.length; i++) {
            if (used[i]) {
                continue;
            }
            indices.push(i);
        }
        const matrix = modelMatrix;
        const scale = new Vector3(1, 1, 1);
        const quat = new Quaternion(0, 0, 0, 1);
        matrix.decompose(new Vector3(1, 1, 1), quat, scale);
        groupIndices.unshift(indices);
        groupTransforms.unshift({
            isScale: !scale.equals(Vector3.ONE),
            isRotate: !quat.equals(Quaternion.ONE),
            matrix,
            scale,
            quat,
            shRotateFn: createSHRotateFn(new Matrix3().setFromMatrix4(new Matrix4().compose(new Vector3(0, 0, 0), quat, new Vector3(1, 1, 1)))),
        });
    }
    return {
        deletedIndices,
        groupIndices,
        groupTransforms,
    };
}
export class ModifyTask extends BaseTask {
    async exec(config, { logger, resources }) {
        const { input, modifyPaths = [], output } = config;
        const splat = resources.get(input);
        logger.info(`loaded -> "${input}"`);
        const modifies = await Promise.all(modifyPaths.map((p, i) => createSplatModify(p, splat.blockContentCounts[i])));
        const tempVec = new Vector3(0, 0, 0);
        const tempQuat = new Quaternion(0, 0, 0, 1);
        const single = {
            x: 0, y: 0, z: 0,
            sx: 0, sy: 0, sz: 0,
            qx: 0, qy: 0, qz: 0, qw: 0,
            r: 0, g: 0, b: 0, a: 0,
            shN: new Array(splat.shCounts),
        };
        const shN = single.shN;
        const shCoeffs = new Array(splat.shCounts / 3).fill(0);
        const deletedTotalIndices = [];
        for (let i = 0; i < modifies.length; i++) {
            const modify = modifies[i];
            if (!modify) {
                logger.info(`modify[${i}] is null, skip`);
                continue;
            }
            const offset = splat.blockOffsets[i];
            const { deletedIndices, groupIndices, groupTransforms } = modify;
            logger.info(`modify[${i}] offset=${offset} groups=${groupIndices.length} delete=${deletedIndices.length}`);
            for (let j = 0; j < groupIndices.length; j++) {
                const indices = groupIndices[j];
                const { isScale, isRotate, matrix, scale, quat, shRotateFn } = groupTransforms[j];
                logger.info(`group[${i}:${j}] size=${indices.length} scale=${isScale} rotate=${isRotate}`);
                for (let k = 0; k < indices.length; k++) {
                    const idx = offset + indices[k];
                    splat.get(idx, single);
                    tempVec.set(single.x, single.y, single.z).applyMatrix4(matrix);
                    single.x = tempVec.x;
                    single.y = tempVec.y;
                    single.z = tempVec.z;
                    if (isScale) {
                        tempVec.set(single.sx, single.sy, single.sz).mul(scale);
                        single.sx = tempVec.x;
                        single.sy = tempVec.y;
                        single.sz = tempVec.z;
                    }
                    if (isRotate) {
                        tempQuat.set(single.qx, single.qy, single.qz, single.qw).premultiply(quat);
                        single.qx = tempQuat.x;
                        single.qy = tempQuat.y;
                        single.qz = tempQuat.z;
                        single.qw = tempQuat.w;
                    }
                    splat.set(idx, single);
                    if (isRotate) {
                        splat.getShN(idx, shN);
                        for (let m = 0; m < 3; m++) {
                            for (let n = 0; n < shCoeffs.length; n++) {
                                shCoeffs[n] = shN[n * 3 + m];
                            }
                            shRotateFn(shCoeffs);
                            for (let n = 0; n < shCoeffs.length; n++) {
                                shN[n * 3 + m] = shCoeffs[n];
                            }
                        }
                        splat.setShN(idx, shN);
                    }
                }
            }
            for (let j = 0; j < deletedIndices.length; j++) {
                deletedTotalIndices.push(offset + deletedIndices[j]);
            }
        }
        if (deletedTotalIndices.length > 0) {
            fastDeleteSplat(splat, deletedTotalIndices);
            logger.info(`delete ${deletedTotalIndices.length} splat`);
        }
        resources.set(output, splat);
        logger.info(`stored -> key="${output}"`);
    }
}
