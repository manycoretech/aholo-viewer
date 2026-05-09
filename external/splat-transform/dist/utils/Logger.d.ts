export declare class Logger {
    prefix: string;
    silent: boolean;
    private format;
    info(msg: string, force?: boolean): void;
    warn(msg: string, force?: boolean): void;
    error(msg: string, force?: boolean): void;
    time(label: string): void;
    timeEnd(label: string): void;
}
export declare const logger: Logger;
