/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

// Dynamic import to avoid loading native module at extension activation
// This prevents the extension from failing to load if serialport has ABI issues
let SerialPortModule: typeof import('serialport') | null = null;

async function getSerialPort(): Promise<typeof import('serialport')> {
  if (!SerialPortModule) {
    try {
      SerialPortModule = await import('serialport');
    } catch (error) {
      console.error('Failed to load serialport module:', error);
      throw new Error('Serial port support is not available. The native module may need to be rebuilt for your VS Code version.');
    }
  }
  return SerialPortModule;
}

export interface ISerialPortDetail {
  port: string;
  desc: string;
  hwid: string;
  vendorId: string;
  productId: string;
}

/**
 * Cross-platform SerialPort class that returns all connected serial ports
 * For Windows these are usually hosted on COM ports (e.g. COM3/COM4/etc)
 * For macOS/Linux they are usually hosted under e.g. /dev/tty.usbserial-xxxxxx
 * 
 * Uses the 'serialport' npm package which provides native cross-platform support
 * for Windows, macOS (including Apple Silicon), and Linux.
 */
export class SerialPortCtrl {
  /**
   * Lists all available serial ports on the system
   * @param _extensionPath - Kept for backwards compatibility, no longer used
   * @returns Promise resolving to array of serial port details
   */
  public static async list(_extensionPath?: string): Promise<ISerialPortDetail[]> {
    try {
      const { SerialPort } = await getSerialPort();
      const ports = await SerialPort.list();
      
      return ports.map(port => {
        const vendorId = port.vendorId || '';
        const productId = port.productId || '';
        const hwid = vendorId && productId ? `VID:PID=${vendorId}:${productId}` : (port.pnpId || '');
        
        return {
          port: port.path,
          desc: port.manufacturer || '',
          hwid: hwid,
          vendorId: vendorId,
          productId: productId
        };
      });
    } catch (error) {
      console.error('Error listing serial ports:', error);
      throw error;
    }
  }
}
