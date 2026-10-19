import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** Locate the platform executable, or use an explicitly supplied local build. */
export function resolveExecutable(): string {
    if (process.env.SPLAT_TRANSFORM_EXECUTABLE) return path.resolve(process.env.SPLAT_TRANSFORM_EXECUTABLE);
    const suffix = process.platform === 'win32' ? '-msvc' : process.platform === 'linux' ? '-gnu' : '';
    const packageName = '@manycore/aholo-splat-transform-' + process.platform + '-' + process.arch + suffix;
    const filename = process.platform === 'win32' ? 'splat-transform.exe' : 'splat-transform';
    try {
        return require.resolve(packageName + '/' + filename);
    } catch (cause) {
        throw new Error(
            'Missing executable for ' +
                process.platform +
                '/' +
                process.arch +
                '. Install ' +
                packageName +
                ' with optional dependencies enabled, or set SPLAT_TRANSFORM_EXECUTABLE to a CMake build.',
            { cause },
        );
    }
}

export class PipelineError extends Error {
    constructor(
        message: string,
        readonly exitCode: number,
        readonly signal: NodeJS.Signals | null = null,
    ) {
        super(message);
        this.name = 'PipelineError';
    }
}

export interface RunOptions {
    /** Working directory used to resolve paths in the pipeline. */
    cwd?: string;
    /** Cancel the child process. */
    signal?: AbortSignal;
}

interface ExecuteOptions extends RunOptions {
    input?: string;
    stdin?: 'ignore' | 'inherit';
    capture?: boolean;
}

export function execute(args: string[], options: ExecuteOptions = {}): Promise<string> {
    const executable = resolveExecutable();
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
            cwd: options.cwd,
            signal: options.signal,
            stdio: [
                options.input === undefined ? (options.stdin ?? 'ignore') : 'pipe',
                options.capture ? 'pipe' : 'inherit',
                'inherit',
            ],
            windowsHide: true,
        });
        let stdout = '';
        const interrupt = () => child.kill('SIGINT');
        const terminate = () => child.kill('SIGTERM');
        process.on('SIGINT', interrupt);
        process.on('SIGTERM', terminate);
        const clean = () => {
            process.off('SIGINT', interrupt);
            process.off('SIGTERM', terminate);
        };
        child.stdout?.setEncoding('utf8').on('data', chunk => {
            stdout += chunk;
        });
        child.once('error', error => {
            clean();
            error.message = error.message.replaceAll(executable, () => executable.split(path.sep).join('/'));
            reject(error);
        });
        child.once('close', (code, signal) => {
            clean();
            if (code === 0) resolve(stdout);
            else
                reject(
                    new PipelineError(
                        'splat-transform exited with ' + (signal ?? code),
                        code ?? (signal === 'SIGINT' ? 130 : 143),
                        signal,
                    ),
                );
        });
        child.stdin?.on('error', error => {
            // Native failures may close stdin early; close reports their exit code.
            if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
                child.kill();
                reject(error);
            }
        });
        child.stdin?.end(options.input);
    });
}
