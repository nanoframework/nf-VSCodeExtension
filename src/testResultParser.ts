/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Outcome of a single test method.
 */
export enum TestOutcome {
    passed = 'passed',
    failed = 'failed',
    skipped = 'skipped',
    none = 'none'
}

/**
 * Parsed result of a single test method execution.
 */
export interface ParsedTestResult {
    /** Fully qualified method name (Namespace.Class.Method) */
    fullyQualifiedName: string;
    outcome: TestOutcome;
    /** Duration in ticks (only for passed tests) */
    durationTicks?: number;
    /** Error message (for failed tests) */
    errorMessage?: string;
    /** Captured stdout output between result lines */
    output?: string;
}

/**
 * Overall result of parsing nanoCLR / device test output.
 */
export interface TestRunResult {
    /** Whether the run completed (saw "Done." marker) */
    completed: boolean;
    /** Individual test results */
    results: ParsedTestResult[];
    /** Raw output for diagnostics */
    rawOutput: string;
    /** Error if the run itself failed (e.g. nanoclr crash) */
    runError?: string;
}

// Markers used by the nanoFramework test launcher
const READY_MARKER = 'Ready.';
const DONE_MARKER = 'Done.';
const TEST_PASSED = 'Test passed';
const TEST_FAILED = 'Test failed';
const TEST_SKIPPED = 'Test skipped';

/**
 * Parses the stdout output from nanoCLR test execution into structured results.
 *
 * Output format from nanoFramework.UnitTestLauncher:
 *   Ready.
 *   Test passed, Namespace.Class.Method, 12345
 *   Test failed, Namespace.Class.Method2, Assert.AreEqual failed
 *   Test skipped, Namespace.Class.Method3, Reason
 *   Done.
 */
export function parseTestOutput(rawOutput: string): TestRunResult {
    const result: TestRunResult = {
        completed: false,
        results: [],
        rawOutput
    };

    if (!rawOutput) {
        result.runError = 'No output received from test runner';
        return result;
    }

    const lines = rawOutput.replace(/\r\n/g, '\n').split('\n');

    // Pre-process: reassemble lines that were split by the serial transport.
    // A test result line starts with "Test passed/failed/skipped," and must
    // contain at least 3 comma-separated parts. If a result prefix is found
    // but the line has too few commas, join subsequent lines until complete
    // or until another test/marker line is encountered.
    const reassembled: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        const isResultStart = trimmed.startsWith(TEST_PASSED) ||
            trimmed.startsWith(TEST_FAILED) ||
            trimmed.startsWith(TEST_SKIPPED);

        if (isResultStart) {
            let joined = trimmed;
            // Keep joining subsequent lines until we have at least 3 comma parts
            while (joined.split(',').length < 3 && i + 1 < lines.length) {
                const nextTrimmed = lines[i + 1].trim();
                // Stop if the next line is a new test result, a marker, or empty
                if (nextTrimmed === DONE_MARKER ||
                    nextTrimmed === READY_MARKER ||
                    nextTrimmed.startsWith(TEST_PASSED) ||
                    nextTrimmed.startsWith(TEST_FAILED) ||
                    nextTrimmed.startsWith(TEST_SKIPPED)) {
                    break;
                }
                i++;
                joined += nextTrimmed;
            }
            reassembled.push(joined);
        } else {
            reassembled.push(lines[i]);
        }
    }

    let readyFound = false;
    let testOutput = '';

    for (const line of reassembled) {
        const trimmed = line.trim();

        if (trimmed === DONE_MARKER) {
            result.completed = true;
            break;
        }

        if (!readyFound) {
            if (trimmed.startsWith(READY_MARKER)) {
                readyFound = true;
            }
            continue;
        }

        // Check for test result lines
        if (trimmed.startsWith(TEST_PASSED) || trimmed.startsWith(TEST_FAILED) || trimmed.startsWith(TEST_SKIPPED)) {
            // Format: "Test passed, FQN, data" — split on comma
            const parts = trimmed.split(',');
            if (parts.length < 3) {
                // Still malformed after reassembly, skip
                continue;
            }

            const status = parts[0].trim();
            const fqn = parts[1].trim();
            // Data is everything after the second comma (error messages may contain commas)
            const data = parts.slice(2).join(',').trim();

            const parsed: ParsedTestResult = {
                fullyQualifiedName: fqn,
                outcome: TestOutcome.none,
                output: testOutput || undefined
            };

            if (status === TEST_PASSED) {
                parsed.outcome = TestOutcome.passed;
                const ticks = parseInt(data, 10);
                if (!isNaN(ticks)) {
                    parsed.durationTicks = ticks;
                }
            } else if (status === TEST_FAILED) {
                parsed.outcome = TestOutcome.failed;
                parsed.errorMessage = data;
            } else if (status === TEST_SKIPPED) {
                parsed.outcome = TestOutcome.skipped;
                parsed.errorMessage = data || undefined;
            }

            result.results.push(parsed);
            testOutput = '';
        } else {
            // Accumulate stdout output for the next test result
            if (readyFound) {
                testOutput += (testOutput ? '\n' : '') + line;
            }
        }
    }

    if (!readyFound && !result.completed) {
        result.runError = 'Test runner did not output "Ready." marker. Possible build or launch failure.';
    }

    return result;
}
