export function toWslPathArgument(value: string): string {
    return value.replace(/^([A-Za-z]):[\\/](.*)$/, (_match, drive: string, rest: string) =>
        `/mnt/${drive.toLowerCase()}/${rest.replace(/\\/g, '/')}`);
}

export function fromWslPathArgument(value: string): string {
    return value.replace(/^\/mnt\/([A-Za-z])\/(.*)$/, (_match, drive: string, rest: string) =>
        `${drive.toUpperCase()}:\\${rest.replace(/\//g, '\\')}`);
}

export function convertWindowsPathsInCommand(command: string): string {
    return command
        .replace(/(["'])([A-Za-z]):[\\/]([^"']*)\1/g, (_match, quote: string, drive: string, rest: string) =>
            `${quote}/mnt/${drive.toLowerCase()}/${rest.replace(/\\/g, '/')}${quote}`)
        .replace(/(^|[\s=])([A-Za-z]):[\\/]([^\s;&|]*)/g, (_match, prefix: string, drive: string, rest: string) =>
            `${prefix}/mnt/${drive.toLowerCase()}/${rest.replace(/\\/g, '/')}`);
}