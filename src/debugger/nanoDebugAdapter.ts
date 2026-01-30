/*---------------------------------------------------------------------------------------------
 *  Copyright (c) .NET Foundation and Contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { NanoDebugSession } from './nanoDebugSession';

/**
 * Entry point for the debug adapter when running as a separate process.
 * 
 * The debug adapter can be run in two modes:
 * 1. As a separate process (this file is the entry point)
 * 2. Inline within the extension (using DebugAdapterInlineImplementation)
 * 
 * When running as a separate process, VS Code communicates with the adapter
 * via stdin/stdout using the Debug Adapter Protocol.
 */

// Start the debug session
NanoDebugSession.run(NanoDebugSession);
