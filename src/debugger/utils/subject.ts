/*---------------------------------------------------------------------------------------------
 *  Copyright (c) .NET Foundation and Contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Simple subject for async notifications
 * Used for signaling when configuration is done
 */
export class Subject {
    private _resolved = false;
    private _waiting: Array<() => void> = [];

    /**
     * Notify all waiting parties
     */
    public notify(): void {
        this._resolved = true;
        for (const fn of this._waiting) {
            fn();
        }
        this._waiting = [];
    }

    /**
     * Wait for notification with optional timeout
     */
    public wait(timeout?: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (this._resolved) {
                resolve();
                return;
            }

            this._waiting.push(resolve);

            if (timeout) {
                setTimeout(() => {
                    const index = this._waiting.indexOf(resolve);
                    if (index !== -1) {
                        this._waiting.splice(index, 1);
                        resolve(); // Resolve anyway after timeout
                    }
                }, timeout);
            }
        });
    }

    /**
     * Reset the subject
     */
    public reset(): void {
        this._resolved = false;
    }
}
