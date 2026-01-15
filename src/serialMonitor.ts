/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';

const DEFAULT_BAUD_RATE = 921600;
const RECONNECT_INTERVAL_MS = 100;

/**
 * Manages a serial port monitor that displays output in VS Code's Output panel
 */
export class SerialMonitor {
    private static instance: SerialMonitor | null = null;
    private outputChannel: vscode.OutputChannel;
    private serialPort: SerialPort | null = null;
    private parser: ReadlineParser | null = null;
    private portPath: string = '';
    private baudRate: number = DEFAULT_BAUD_RATE;
    private isRunning: boolean = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private statusBarItem: vscode.StatusBarItem;

    private constructor() {
        this.outputChannel = vscode.window.createOutputChannel('nanoFramework Serial Monitor');
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = 'vscode-nanoframework.stopSerialMonitor';
    }

    /**
     * Gets the singleton instance of the SerialMonitor
     */
    public static getInstance(): SerialMonitor {
        if (!SerialMonitor.instance) {
            SerialMonitor.instance = new SerialMonitor();
        }
        return SerialMonitor.instance;
    }

    /**
     * Starts the serial monitor on the specified port
     * @param portPath The serial port path (e.g., COM3 or /dev/ttyUSB0)
     * @param baudRate The baud rate
     */
    public async start(portPath: string, baudRate: number): Promise<void> {
        // Stop any existing monitor
        await this.stop();

        this.portPath = portPath;
        this.baudRate = baudRate;
        this.isRunning = true;

        console.log(`SerialMonitor.start() called with portPath=${portPath}, baudRate=${baudRate}`);

        this.outputChannel.clear();
        this.outputChannel.appendLine(`=== nanoFramework Serial Monitor ===`);
        this.outputChannel.appendLine(`Port: ${portPath}`);
        this.outputChannel.appendLine(`Baud Rate: ${baudRate}`);
        this.outputChannel.appendLine(`Started at: ${new Date().toLocaleTimeString()}`);
        this.outputChannel.appendLine(`-----------------------------------`);
        this.outputChannel.appendLine('');
        this.outputChannel.show(true);

        this.updateStatusBar('connecting');
        await this.connect();
    }

    /**
     * Stops the serial monitor
     */
    public async stop(): Promise<void> {
        this.isRunning = false;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.serialPort) {
            // Remove all event listeners to prevent callbacks during close
            this.serialPort.removeAllListeners();
            
            if (this.serialPort.isOpen) {
                try {
                    // Flush any pending data before closing
                    await new Promise<void>((resolve) => {
                        this.serialPort!.flush((err) => {
                            if (err) {
                                console.error('Error flushing serial port:', err);
                            }
                            resolve();
                        });
                    });

                    // Close the port
                    await new Promise<void>((resolve) => {
                        this.serialPort!.close((err) => {
                            if (err) {
                                console.error('Error closing serial port:', err);
                            }
                            resolve();
                        });
                    });
                } catch (error) {
                    console.error('Error stopping serial monitor:', error);
                }
            }

            // Ensure reference is cleared
            this.serialPort = null;
        }

        this.parser = null;
        this.statusBarItem.hide();

        const stoppedPort = this.portPath;
        this.portPath = '';
        
        if (stoppedPort) {
            this.outputChannel.appendLine('');
            this.outputChannel.appendLine(`--- Serial Monitor stopped at ${new Date().toLocaleTimeString()} ---`);
            // Give the OS time to release the port
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    /**
     * Returns whether the monitor is currently running
     */
    public isActive(): boolean {
        return this.isRunning;
    }

    /**
     * Gets the current port being monitored
     */
    public getCurrentPort(): string {
        return this.portPath;
    }

    /**
     * Connects to the serial port
     */
    private async connect(): Promise<void> {
        if (!this.isRunning) {
            return;
        }

        // Validate port path before attempting connection
        if (!this.portPath) {
            console.log('Connect called but no port path set, aborting');
            return;
        }

        try {
            console.log(`SerialMonitor.connect() creating port with baudRate=${this.baudRate}`);
            
            this.serialPort = new SerialPort({
                path: this.portPath,
                baudRate: this.baudRate,
                dataBits: 8,
                stopBits: 1,
                parity: 'none',
                autoOpen: false,
                hupcl: true,
            });

            // Log the configured settings
            console.log(`SerialPort created with configured baudRate=${this.baudRate}, path=${this.portPath}`);

            // Set up event handlers before opening
            this.serialPort.on('error', (err) => {
                this.handleError(err);
            });

            this.serialPort.on('close', () => {
                this.handleDisconnect();
            });

            // Open the port
            await new Promise<void>((resolve, reject) => {
                this.serialPort!.open((err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });

            // Log configured port settings after opening
            console.log(`SerialPort opened with configured baudRate=${this.baudRate}`);
            this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Port opened with baud rate: ${this.baudRate}`);

            // Handle raw data directly to show all characters including non-printable ones
            this.serialPort.on('data', (data: Buffer) => {
                this.handleRawData(data);
            });

            this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Connected to ${this.portPath}`);
            this.updateStatusBar('connected');

        } catch (error) {
            this.handleError(error as Error);
        }
    }

    /**
     * Handles incoming raw data from the serial port, displaying all characters
     * Non-printable characters are shown as <HEX> codes
     */
    private handleRawData(data: Buffer): void {
        let output = '';
        for (const byte of data) {
            // Check if it's a printable ASCII character (space to tilde) or common whitespace
            if (byte >= 32 && byte <= 126) {
                // Printable ASCII
                output += String.fromCharCode(byte);
            } else if (byte === 10) {
                // Line feed - output the accumulated line
                if (output.length > 0) {
                    const timestamp = new Date().toLocaleTimeString();
                    this.outputChannel.appendLine(`[${timestamp}] ${output}`);
                    output = '';
                }
            } else if (byte === 13) {
                // Carriage return - ignore (will be handled with LF)
            } else if (byte === 9) {
                // Tab
                output += '\t';
            } else {
                // Non-printable character - show as hex
                output += `<0x${byte.toString(16).padStart(2, '0').toUpperCase()}>`;
            }
        }
        // Output any remaining data (partial line without newline)
        if (output.length > 0) {
            const timestamp = new Date().toLocaleTimeString();
            this.outputChannel.append(`[${timestamp}] ${output}`);
        }
    }

    /**
     * Handles serial port errors
     */
    private handleError(error: Error): void {
        const timestamp = new Date().toLocaleTimeString();
        this.outputChannel.appendLine(`[${timestamp}] ERROR: ${error.message}`);
        this.updateStatusBar('error');

        if (this.isRunning) {
            this.scheduleReconnect();
        }
    }

    /**
     * Handles serial port disconnection
     */
    private handleDisconnect(): void {
        if (!this.isRunning) {
            return;
        }

        const timestamp = new Date().toLocaleTimeString();
        this.outputChannel.appendLine(`[${timestamp}] Device disconnected`);
        this.updateStatusBar('disconnected');

        this.serialPort = null;
        this.parser = null;

        this.scheduleReconnect();
    }

    /**
     * Schedules a reconnection attempt
     */
    private scheduleReconnect(): void {
        // Don't schedule if not running, no port path, or already scheduled
        if (!this.isRunning || !this.portPath || this.reconnectTimer) {
            return;
        }

        this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Attempting to reconnect in ${RECONNECT_INTERVAL_MS / 1000} seconds...`);

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            if (this.isRunning && this.portPath) {
                await this.connect();
            }
        }, RECONNECT_INTERVAL_MS);
    }

    /**
     * Updates the status bar item
     */
    private updateStatusBar(status: 'connecting' | 'connected' | 'disconnected' | 'error'): void {
        switch (status) {
            case 'connecting':
                this.statusBarItem.text = `$(sync~spin) Serial: ${this.portPath}`;
                this.statusBarItem.tooltip = 'Connecting... Click to stop';
                this.statusBarItem.backgroundColor = undefined;
                break;
            case 'connected':
                this.statusBarItem.text = `$(plug) Serial: ${this.portPath}`;
                this.statusBarItem.tooltip = `Connected at ${this.baudRate} baud. Click to stop`;
                this.statusBarItem.backgroundColor = undefined;
                break;
            case 'disconnected':
                this.statusBarItem.text = `$(debug-disconnect) Serial: ${this.portPath}`;
                this.statusBarItem.tooltip = 'Disconnected - Attempting to reconnect. Click to stop';
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                break;
            case 'error':
                this.statusBarItem.text = `$(error) Serial: ${this.portPath}`;
                this.statusBarItem.tooltip = 'Error - Click to stop';
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                break;
        }
        this.statusBarItem.show();
    }

    /**
     * Disposes of resources and resets the singleton
     */
    public async dispose(): Promise<void> {
        await this.stop();
        this.outputChannel.dispose();
        this.statusBarItem.dispose();
        SerialMonitor.instance = null;
    }

    /**
     * Resets the singleton instance (useful for cleanup)
     */
    public static async reset(): Promise<void> {
        if (SerialMonitor.instance) {
            await SerialMonitor.instance.dispose();
        }
    }
}

/**
 * Common baud rates for serial communication
 */
export const COMMON_BAUD_RATES = [
    921600,
    460800,
    230400,
    115200,
    57600,
    38400,
    19200,
    9600
];

/**
 * Prompts the user to select a baud rate
 * @returns The selected baud rate or undefined if cancelled
 */
export async function chooseBaudRate(): Promise<number | undefined> {
    const items = COMMON_BAUD_RATES.map(rate => ({
        label: rate.toString(),
        description: rate === DEFAULT_BAUD_RATE ? '(default)' : undefined
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select baud rate',
        title: 'Serial Monitor Baud Rate'
    });

    if (selected) {
        return parseInt(selected.label, 10);
    }
    return undefined;
}
