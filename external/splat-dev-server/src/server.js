import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';


function createApp(address, port, publicPath) {
    const app = express();
    const rootDir = path.resolve(publicPath);
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');

        if (req.method === 'OPTIONS') {
            return res.sendStatus(204);
        }

        return next();
    });

    app.get(/lod-meta.json$/, async (req, res, next) => {
        const file = path.join(rootDir, req.path);
        try {
            const content = JSON.parse(await fs.readFile(file, 'utf-8'));
            const dirname = path.dirname(req.path);
            content.files = content.files.map(f => `http://${address}:${port}${dirname}/${f}`)
            res.header('Cache-Control', 'no-cache');
            return res.json(content);
        } catch {
            return next();
        }
    });
    app.use(express.static(rootDir, {
        setHeaders: res => {
            res.header('Cache-Control', 'no-cache');
        }
    }));
    return app;
}

export function start(address, port, publicPath) {
    const app = createApp(address, port, publicPath);
    app.listen(port, address, () => {
        console.log('\n========================================');
        console.log('Splat dev server started');
        console.log(`Host: ${address}:${port}`);
        console.log(`Root: ${publicPath}`);
        console.log(`Base URL: http://${address}:${port}`);
        console.log('========================================\n');
    });
}
