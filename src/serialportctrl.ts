/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import { SerialPort } from 'serialport';

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
      const ports = await SerialPort.list();
      
      return ports.map(port => {
        const vendorId = port.vendorId || '';
        const productId = port.productId || '';
        const hwid = vendorId && productId ? `VID:PID=${vendorId}:${productId}` : (port.pnpId || '');
        
        return {
          port: port.path,
          desc: port.manufacturer || port.friendlyName || '',
          hwid: hwid,
          vendorId: vendorId,
          productId: productId
        };
      });
    } catch (error) {
      console.error('Error listing serial ports:', error);
      return [];
    }
  }
}
