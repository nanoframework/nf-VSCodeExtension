/*---------------------------------------------------------------------------------------------
 *  Copyright (c) .NET Foundation and Contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

/**
 * Log level enumeration
 */
export enum LogLevel {
    None = 0,
    Error = 1,
    Warning = 2,
    Info = 3,
    Debug = 4,
    Verbose = 5
}

/**
 * Logger class for debug adapter
 * Provides structured logging with support for file and console output
 */
export class Logger {
    private static _instance: Logger | null = null;
    private _logLevel: LogLevel = LogLevel.Info;
    private _logFile: fs.WriteStream | null = null;
    private _logToConsole: boolean = true;

    private constructor() {}

    /**
     * Get the singleton logger instance
     */
    public static get instance(): Logger {
        if (!Logger._instance) {
            Logger._instance = new Logger();
        }
        return Logger._instance;
    }

    /**
     * Initialize the logger
     * @param logLevel Minimum log level to output
     * @param logFilePath Optional path to log file
     * @param logToConsole Whether to also log to console
     */
    public initialize(logLevel: LogLevel, logFilePath?: string, logToConsole: boolean = true): void {
        this._logLevel = logLevel;
        this._logToConsole = logToConsole;

        if (logFilePath) {
            try {
                // Ensure directory exists
                const dir = path.dirname(logFilePath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                this._logFile = fs.createWriteStream(logFilePath, { flags: 'a' });
            } catch (error) {
                console.error(`Failed to create log file: ${error}`);
            }
        }
    }

    /**
     * Close the log file
     */
    public close(): void {
        if (this._logFile) {
            this._logFile.close();
            this._logFile = null;
        }
    }

    /**
     * Log an error message
     */
    public error(message: string, ...args: unknown[]): void {
        this.log(LogLevel.Error, 'ERROR', message, ...args);
    }

    /**
     * Log a warning message
     */
    public warning(message: string, ...args: unknown[]): void {
        this.log(LogLevel.Warning, 'WARN', message, ...args);
    }

    /**
     * Log an info message
     */
    public info(message: string, ...args: unknown[]): void {
        this.log(LogLevel.Info, 'INFO', message, ...args);
    }

    /**
     * Log a debug message
     */
    public debug(message: string, ...args: unknown[]): void {
        this.log(LogLevel.Debug, 'DEBUG', message, ...args);
    }

    /**
     * Log a verbose message
     */
    public verbose(message: string, ...args: unknown[]): void {
        this.log(LogLevel.Verbose, 'VERBOSE', message, ...args);
    }

    /**
     * Log a message at the specified level
     */
    private log(level: LogLevel, levelName: string, message: string, ...args: unknown[]): void {
        if (level > this._logLevel) {
            return;
        }

        const timestamp = new Date().toISOString();
        const formattedMessage = this.formatMessage(message, ...args);
        const logLine = `[${timestamp}] [${levelName}] ${formattedMessage}`;

        if (this._logToConsole) {
            switch (level) {
                case LogLevel.Error:
                    console.error(logLine);
                    break;
                case LogLevel.Warning:
                    console.warn(logLine);
                    break;
                default:
                    console.log(logLine);
                    break;
            }
        }

        if (this._logFile) {
            this._logFile.write(logLine + '\n');
        }
    }

    /**
     * Format a message with optional arguments
     */
    private formatMessage(message: string, ...args: unknown[]): string {
        if (args.length === 0) {
            return message;
        }

        // Simple placeholder replacement
        let result = message;
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            const placeholder = `{${i}}`;
            const value = typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
            result = result.replace(placeholder, value);
        }
        return result;
    }
}

/**
 * Convenience function to get the logger instance
 */
export function getLogger(): Logger {
    return Logger.instance;
}
