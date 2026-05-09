export class Logger {
    prefix = '';
    silent = false;
    format(msg) {
        return this.prefix ? `${this.prefix} ${msg}` : msg;
    }
    info(msg, force = false) {
        if (this.silent && !force) {
            return;
        }
        console.log(this.format(msg));
    }
    warn(msg, force = false) {
        if (this.silent && !force) {
            return;
        }
        console.warn(this.format(msg));
    }
    error(msg, force = false) {
        if (this.silent && !force) {
            return;
        }
        console.error(this.format(msg));
    }
    time(label) {
        if (this.silent) {
            return;
        }
        console.time(this.format(label));
    }
    timeEnd(label) {
        if (this.silent) {
            return;
        }
        console.timeEnd(this.format(label));
    }
}
export const logger = new Logger();
