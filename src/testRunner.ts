/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { TestDiscovery, TestProjectInfo } from './testDiscovery';
import { NanoCLRManager } from './nanoclrManager';
import { buildTestProject, runTestsOnEmulator, runTestsOnHardware } from './testExecution';
import { TestOutcome } from './testResultParser';
import { TestCodeLensProvider } from './testCodeLensProvider';
import { configureRunSettings } from './runSettings';

/**
 * Tag stored on TestItem.data to identify the kind and carry metadata.
 */
interface TestItemData {
    kind: 'project' | 'class' | 'method';
    projectPath?: string;
    projectDir?: string;
    fullyQualifiedName?: string;
}

// Map from TestItem id to its metadata
const testItemDataMap = new Map<string, TestItemData>();

let testController: vscode.TestController | undefined;
let fileWatcher: vscode.FileSystemWatcher | undefined;
let projectWatcher: vscode.FileSystemWatcher | undefined;
let saveWatcher: vscode.Disposable | undefined;
let extensionUtilsPath: string = '';
let statusBarItem: vscode.StatusBarItem | undefined;
let codeLensProvider: TestCodeLensProvider | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
const debounceDelay = 500; // ms

// Test tags for filtering in the Test Explorer sidebar
const tagSetup = new vscode.TestTag('setup');
const tagCleanup = new vscode.TestTag('cleanup');
const tagTestMethod = new vscode.TestTag('testMethod');
const tagDataRow = new vscode.TestTag('dataRow');

/**
 * Activates the nanoFramework test runner and registers the TestController.
 * Call once from extension activation.
 */
export function activateTestRunner(context: vscode.ExtensionContext): vscode.TestController {
    extensionUtilsPath = path.join(context.extensionPath, 'dist', 'utils');
    testController = vscode.tests.createTestController(
        'nanoframework-tests',
        '.NET nanoFramework Tests'
    );
    context.subscriptions.push(testController);

    // Resolve handler: called when the test explorer needs to discover tests
    testController.resolveHandler = async (item) => {
        if (!item) {
            // Root-level resolve: discover all test projects
            await discoverAllTests();
        }
        // Individual item resolution not needed — we populate children eagerly
    };

    // Register run profile for emulator
    testController.createRunProfile(
        'Run on nanoCLR Emulator',
        vscode.TestRunProfileKind.Run,
        (request, token) => runHandler(request, token),
        true // isDefault
    );

    // Register run profile for hardware device
    testController.createRunProfile(
        'Run on Device',
        vscode.TestRunProfileKind.Run,
        (request, token) => runOnDeviceHandler(request, token),
        false
    );

    // Status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    context.subscriptions.push(statusBarItem);

    // CodeLens provider for [TestMethod] and [TestClass]
    codeLensProvider = new TestCodeLensProvider();
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { language: 'csharp', scheme: 'file' },
            codeLensProvider
        )
    );

    // Commands for CodeLens actions and runsettings
    context.subscriptions.push(
        vscode.commands.registerCommand('nanoframework-tests.runMethod', runSingleMethod),
        vscode.commands.registerCommand('nanoframework-tests.runClass', runSingleClass),
        vscode.commands.registerCommand('vscode-nanoframework.configureRunSettings', configureRunSettings)
    );

    // Set up file watchers for automatic re-discovery
    setupFileWatchers(context);

    // Set up watch mode (auto-run on save) if enabled
    setupWatchMode(context);

    // Initial discovery
    discoverAllTests();

    return testController;
}

/**
 * Discovers all test projects in the workspace and populates the test tree.
 */
async function discoverAllTests(): Promise<void> {
    if (!testController) { return; }

    const projects = await TestDiscovery.findTestProjects();

    // Collect current project item IDs to detect removed projects
    const currentIds = new Set<string>();

    for (const project of projects) {
        const projectId = `project:${project.projectPath}`;
        currentIds.add(projectId);
        updateProjectItems(project);
    }

    // Remove project items that no longer exist
    testController.items.forEach(item => {
        if (!currentIds.has(item.id)) {
            testController!.items.delete(item.id);
            deleteItemData(item);
        }
    });
}

/**
 * Update or create test items for a project and its contents.
 */
function updateProjectItems(project: TestProjectInfo): void {
    if (!testController) { return; }

    const projectId = `project:${project.projectPath}`;
    let projectItem = testController.items.get(projectId);

    if (!projectItem) {
        projectItem = testController.createTestItem(projectId, project.name);
        projectItem.canResolveChildren = false;
        testController.items.add(projectItem);
    }

    setItemData(projectItem, {
        kind: 'project',
        projectPath: project.projectPath,
        projectDir: project.projectDir
    });

    // Track existing class IDs to detect removals
    const currentClassIds = new Set<string>();

    for (const cls of project.classes) {
        const classId = `class:${project.projectPath}:${cls.namespace}.${cls.className}`;
        currentClassIds.add(classId);

        let classItem = projectItem.children.get(classId);
        if (!classItem) {
            classItem = testController.createTestItem(
                classId,
                cls.className,
                cls.uri
            );
            classItem.range = new vscode.Range(cls.line, 0, cls.line, 0);
            projectItem.children.add(classItem);
        } else {
            // Re-create the item if uri changed, since uri is read-only
            if (classItem.uri?.toString() !== cls.uri.toString()) {
                projectItem.children.delete(classId);
                classItem = testController.createTestItem(classId, cls.className, cls.uri);
                projectItem.children.add(classItem);
            }
            classItem.range = new vscode.Range(cls.line, 0, cls.line, 0);
        }

        setItemData(classItem, {
            kind: 'class',
            projectPath: project.projectPath,
            projectDir: project.projectDir
        });

        // Track method IDs
        const currentMethodIds = new Set<string>();

        for (const method of cls.methods) {
            const methodId = `method:${method.fullyQualifiedName}:${project.projectPath}`;
            currentMethodIds.add(methodId);

            // Build display name: for DataRow, append the arguments
            const displayName = method.dataRowArgs
                ? `${method.methodName}(${method.dataRowArgs})`
                : method.methodName;

            let methodItem = classItem.children.get(methodId);
            if (!methodItem) {
                methodItem = testController.createTestItem(
                    methodId,
                    displayName,
                    method.uri
                );
                classItem.children.add(methodItem);
            }
            methodItem.range = new vscode.Range(method.line, 0, method.line, 0);

            // Apply tags for filtering
            const tags: vscode.TestTag[] = [];
            switch (method.traitType) {
                case 'Setup': tags.push(tagSetup); break;
                case 'Cleanup': tags.push(tagCleanup); break;
                case 'DataRow': tags.push(tagDataRow); break;
                default: tags.push(tagTestMethod); break;
            }
            methodItem.tags = tags;

            setItemData(methodItem, {
                kind: 'method',
                projectPath: project.projectPath,
                projectDir: project.projectDir,
                fullyQualifiedName: method.fullyQualifiedName
            });
        }

        // Remove methods that no longer exist
        classItem.children.forEach(child => {
            if (!currentMethodIds.has(child.id)) {
                classItem!.children.delete(child.id);
                testItemDataMap.delete(child.id);
            }
        });
    }

    // Remove classes that no longer exist
    projectItem.children.forEach(child => {
        if (!currentClassIds.has(child.id)) {
            projectItem!.children.delete(child.id);
            deleteItemData(child);
        }
    });
}

/**
 * The run handler invoked when the user clicks "Run Tests" in the Test Explorer.
 */
async function runHandler(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken
): Promise<void> {
    if (!testController) { return; }

    const run = testController.createTestRun(request);
    const channel = NanoCLRManager.outputChannel;
    channel.show(true);
    showStatusBar('Running tests on emulator...');

    try {
        // Ensure nanoclr is ready
        const ready = await NanoCLRManager.ensureReady(token);
        if (!ready) {
            run.appendOutput('Failed to set up nanoclr. See nanoFramework Tests output for details.\r\n');
            endRunWithError(run, request, 'nanoclr setup failed');
            return;
        }

        if (token.isCancellationRequested) { run.end(); return; }

        // Collect tests to run, grouped by project
        const projectGroups = groupTestsByProject(request);

        const configuration = 'Debug'; // Default for test runs

        for (const [projectPath, items] of projectGroups) {
            if (token.isCancellationRequested) { break; }

            const data = testItemDataMap.get(items[0].id);
            if (!data?.projectDir) { continue; }

            const projectDir = data.projectDir;

            // Enqueue all tests in this project
            const allMethods = collectMethodItems(items);
            for (const m of allMethods) { run.enqueued(m); }

            // Build
            run.appendOutput(`\r\n--- Building ${path.basename(projectPath)} ---\r\n`);
            const buildOk = await buildTestProject(projectPath, extensionUtilsPath, configuration, channel, token);
            if (!buildOk) {
                for (const m of allMethods) {
                    run.errored(m, new vscode.TestMessage('Build failed. Check the nanoFramework Tests output.'));
                }
                continue;
            }

            if (token.isCancellationRequested) { break; }

            // Mark as started
            for (const m of allMethods) { run.started(m); }

            // Run on emulator
            // Note: nanoCLR runs ALL tests in the assembly — there's no per-method filter.
            // We map only the requested tests back to the Test Explorer.
            if (allMethods.length === 1) {
                run.appendOutput(`\r\n--- Running tests (targeting: ${allMethods[0].label}) ---\r\n`);
                run.appendOutput(`Note: nanoCLR executes all tests in the assembly; only the selected test result is reported.\r\n`);
            } else {
                run.appendOutput(`\r\n--- Running tests ---\r\n`);
            }
            const result = await runTestsOnEmulator(projectDir, configuration, channel, token);

            if (result.runError) {
                run.appendOutput(`Run error: ${result.runError}\r\n`);
            }

            // Map results back to test items
            mapResults(run, allMethods, result);
        }
    } catch (err) {
        run.appendOutput(`Unexpected error: ${err}\r\n`);
    }

    hideStatusBar();
    run.end();
}

/**
 * Prompts the user for a device serial port if one isn't configured.
 */
async function pickDevicePort(token: vscode.CancellationToken): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration('nanoFramework.test');
    const savedPort = config.get<string>('hardwarePort', '');
    if (savedPort) { return savedPort; }

    // Try to list serial ports using SerialPortCtrl
    try {
        const { SerialPortCtrl: serialPortCtrl } = await import('./serialportctrl');
        const ports = await serialPortCtrl.list(undefined);
        if (token.isCancellationRequested) { return undefined; }

        if (ports.length === 0) {
            vscode.window.showWarningMessage(
                'No serial ports found. Connect a nanoFramework device and try again, ' +
                'or set nanoFramework.test.hardwarePort in settings.'
            );
            return undefined;
        }

        const items = ports.map(p => ({
            label: p.port,
            description: p.desc || ''
        }));

        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a device serial port for test execution',
            ignoreFocusOut: true
        });

        return picked?.label;
    } catch {
        // Fallback: simple input box
        return vscode.window.showInputBox({
            prompt: 'Enter the serial port (e.g., COM3, /dev/ttyUSB0) or IP:port of the device',
            placeHolder: 'COM3',
            ignoreFocusOut: true
        });
    }
}

/**
 * Run handler for the "Run on Device" profile.
 * Deploys tests to real hardware and captures results.
 */
async function runOnDeviceHandler(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken
): Promise<void> {
    if (!testController) { return; }

    const run = testController.createTestRun(request);
    const channel = NanoCLRManager.outputChannel;
    channel.show(true);

    try {
        // Determine device port
        const device = await pickDevicePort(token);
        if (!device) {
            run.appendOutput('No device selected. Aborting hardware test run.\r\n');
            run.end();
            return;
        }

        showStatusBar(`Running tests on ${device}...`, `Deploying and running tests on device ${device}`);

        if (token.isCancellationRequested) { run.end(); return; }

        // Collect tests grouped by project
        const projectGroups = groupTestsByProject(request);
        const configuration = 'Debug';

        for (const [projectPath, items] of projectGroups) {
            if (token.isCancellationRequested) { break; }

            const data = testItemDataMap.get(items[0].id);
            if (!data?.projectDir) { continue; }

            const projectDir = data.projectDir;

            // Enqueue all tests
            const allMethods = collectMethodItems(items);
            for (const m of allMethods) { run.enqueued(m); }

            // Build
            run.appendOutput(`\r\n--- Building ${path.basename(projectPath)} ---\r\n`);
            const buildOk = await buildTestProject(projectPath, extensionUtilsPath, configuration, channel, token);
            if (!buildOk) {
                for (const m of allMethods) {
                    run.errored(m, new vscode.TestMessage('Build failed. Check the nanoFramework Tests output.'));
                }
                continue;
            }

            if (token.isCancellationRequested) { break; }

            // Mark as started
            for (const m of allMethods) { run.started(m); }

            // Deploy and run on hardware
            run.appendOutput(`\r\n--- Deploying to device ${device} ---\r\n`);
            const result = await runTestsOnHardware(projectDir, configuration, device, channel, token);

            if (result.runError) {
                run.appendOutput(`Run error: ${result.runError}\r\n`);
            }

            // Map results
            mapResults(run, allMethods, result);
        }
    } catch (err) {
        run.appendOutput(`Unexpected error: ${err}\r\n`);
    }

    hideStatusBar();
    run.end();
}

/**
 * Groups requested test items by their project path.
 * If request.include is undefined (run all), gathers all project items.
 */
function groupTestsByProject(request: vscode.TestRunRequest): Map<string, vscode.TestItem[]> {
    const groups = new Map<string, vscode.TestItem[]>();

    const items = request.include ?? gatherAllItems();

    for (const item of items) {
        const data = testItemDataMap.get(item.id);
        const projectPath = data?.projectPath;
        if (!projectPath) { continue; }

        let list = groups.get(projectPath);
        if (!list) {
            list = [];
            groups.set(projectPath, list);
        }
        list.push(item);
    }

    return groups;
}

/**
 * Gathers all root-level items from the test controller.
 */
function gatherAllItems(): vscode.TestItem[] {
    const items: vscode.TestItem[] = [];
    testController?.items.forEach(item => items.push(item));
    return items;
}

/**
 * Recursively collects all leaf method-level TestItems from the given items.
 */
function collectMethodItems(items: vscode.TestItem[]): vscode.TestItem[] {
    const methods: vscode.TestItem[] = [];

    function walk(item: vscode.TestItem) {
        const data = testItemDataMap.get(item.id);
        if (data?.kind === 'method') {
            methods.push(item);
        } else {
            item.children.forEach(child => walk(child));
        }
    }

    for (const item of items) { walk(item); }
    return methods;
}

/**
 * Maps parsed test results to VS Code TestRun outcomes.
 */
function mapResults(
    run: vscode.TestRun,
    methods: vscode.TestItem[],
    result: import('./testResultParser').TestRunResult
): void {
    // Build a lookup from FQN to test result
    const resultMap = new Map<string, import('./testResultParser').ParsedTestResult>();
    for (const r of result.results) {
        resultMap.set(r.fullyQualifiedName, r);
    }

    for (const method of methods) {
        const data = testItemDataMap.get(method.id);
        if (!data?.fullyQualifiedName) { continue; }

        let testResult = resultMap.get(data.fullyQualifiedName);

        if (!testResult) {
            // nanoCLR appends a .{index} suffix to ALL test FQNs (e.g. ".0"),
            // even for non-DataRow single [TestMethod] entries.
            // Try matching with ".0" appended when exact match fails.
            testResult = resultMap.get(data.fullyQualifiedName + '.0');
        }

        if (!testResult) {
            // No result found — either the test didn't run or there was an error
            if (result.runError) {
                run.errored(method, new vscode.TestMessage(result.runError));
            } else {
                run.skipped(method);
            }
            continue;
        }

        switch (testResult.outcome) {
            case TestOutcome.passed: {
                // Convert ticks to milliseconds (1 tick = 100 nanoseconds)
                const durationMs = testResult.durationTicks
                    ? testResult.durationTicks / 10000
                    : undefined;
                run.passed(method, durationMs);
                break;
            }
            case TestOutcome.failed: {
                const msg = new vscode.TestMessage(testResult.errorMessage || 'Test failed');
                if (method.uri && method.range) {
                    msg.location = new vscode.Location(method.uri, method.range);
                }
                run.failed(method, msg);
                break;
            }
            case TestOutcome.skipped:
                run.skipped(method);
                break;
            default:
                run.skipped(method);
                break;
        }
    }
}

/**
 * Marks all methods in a request as errored and ends the run.
 */
function endRunWithError(run: vscode.TestRun, request: vscode.TestRunRequest, message: string): void {
    const items = request.include ? [...request.include] : gatherAllItems();
    const methods = collectMethodItems(items);
    for (const m of methods) {
        run.errored(m, new vscode.TestMessage(message));
    }
    run.end();
}

/**
 * Debounced wrapper around discoverAllTests to avoid rapid re-discovery
 * when many files change at once (e.g. Git checkout, branch switch).
 */
function debouncedDiscover(): void {
    if (debounceTimer) { clearTimeout(debounceTimer); }
    debounceTimer = setTimeout(() => {
        discoverAllTests();
        codeLensProvider?.refresh();
    }, debounceDelay);
}

/**
 * Sets up file watchers for automatic re-discovery on file changes.
 */
function setupFileWatchers(context: vscode.ExtensionContext): void {
    // Watch for C# file changes in the workspace
    fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.cs');
    fileWatcher.onDidChange(() => debouncedDiscover());
    fileWatcher.onDidCreate(() => debouncedDiscover());
    fileWatcher.onDidDelete(() => debouncedDiscover());
    context.subscriptions.push(fileWatcher);

    // Watch for .nfproj changes
    projectWatcher = vscode.workspace.createFileSystemWatcher('**/*.nfproj');
    projectWatcher.onDidChange(() => debouncedDiscover());
    projectWatcher.onDidCreate(() => debouncedDiscover());
    projectWatcher.onDidDelete(() => debouncedDiscover());
    context.subscriptions.push(projectWatcher);
}

// ---------------------------------------------------------------------------
// Watch mode (continuous test run)
// ---------------------------------------------------------------------------

/**
 * Sets up watch mode: when enabled, saving a .cs file inside a test project
 * automatically triggers a test run for the affected project.
 */
function setupWatchMode(context: vscode.ExtensionContext): void {
    saveWatcher = vscode.workspace.onDidSaveTextDocument(async (doc) => {
        const config = vscode.workspace.getConfiguration('nanoFramework.test');
        if (!config.get<boolean>('watchMode', false)) { return; }
        if (doc.languageId !== 'csharp') { return; }
        if (!testController) { return; }

        // Find which project this file belongs to
        const filePath = doc.uri.fsPath;
        let targetProject: vscode.TestItem | undefined;

        testController.items.forEach(projectItem => {
            const data = testItemDataMap.get(projectItem.id);
            if (data?.projectDir && filePath.startsWith(data.projectDir)) {
                targetProject = projectItem;
            }
        });

        if (!targetProject) { return; }

        // Re-discover first, then run the project
        await discoverAllTests();
        codeLensProvider?.refresh();

        const request = new vscode.TestRunRequest([targetProject]);
        await runHandler(request, new vscode.CancellationTokenSource().token);
    });
    context.subscriptions.push(saveWatcher);
}

// --- Data helpers ---

function setItemData(item: vscode.TestItem, data: TestItemData): void {
    testItemDataMap.set(item.id, data);
}

function deleteItemData(item: vscode.TestItem): void {
    testItemDataMap.delete(item.id);
    item.children.forEach(child => deleteItemData(child));
}

// ---------------------------------------------------------------------------
// Status bar helpers
// ---------------------------------------------------------------------------

function showStatusBar(text: string, tooltip?: string): void {
    if (!statusBarItem) { return; }
    statusBarItem.text = `$(beaker~spin) ${text}`;
    statusBarItem.tooltip = tooltip;
    statusBarItem.show();
}

function hideStatusBar(): void {
    statusBarItem?.hide();
}

// ---------------------------------------------------------------------------
// CodeLens command handlers (subset execution)
// ---------------------------------------------------------------------------

/**
 * Run a single test method by its fully-qualified name, triggered from CodeLens.
 */
async function runSingleMethod(fqn: string, _uri: vscode.Uri): Promise<void> {
    if (!testController) { return; }

    // Find the TestItem matching this FQN
    let targetItem: vscode.TestItem | undefined;
    testItemDataMap.forEach((data, id) => {
        if (data.kind === 'method' && data.fullyQualifiedName === fqn && !targetItem) {
            // Walk controller tree to find it
            testController!.items.forEach(project => {
                project.children.forEach(cls => {
                    const item = cls.children.get(id);
                    if (item) { targetItem = item; }
                });
            });
        }
    });

    if (!targetItem) {
        vscode.window.showWarningMessage(`Test method '${fqn}' not found. Try refreshing the test explorer.`);
        return;
    }

    // Create a run request for just this item and trigger via the default profile
    const request = new vscode.TestRunRequest([targetItem]);
    await runHandler(request, new vscode.CancellationTokenSource().token);
}

/**
 * Run all test methods in a class, triggered from CodeLens.
 */
async function runSingleClass(fqClass: string, _uri: vscode.Uri): Promise<void> {
    if (!testController) { return; }

    let targetItem: vscode.TestItem | undefined;
    testController.items.forEach(project => {
        project.children.forEach(cls => {
            const data = testItemDataMap.get(cls.id);
            // The class id is `class:<projectPath>:<namespace.className>`
            if (data?.kind === 'class' && cls.id.endsWith(`:${fqClass}`)) {
                targetItem = cls;
            }
        });
    });

    if (!targetItem) {
        vscode.window.showWarningMessage(`Test class '${fqClass}' not found. Try refreshing the test explorer.`);
        return;
    }

    const request = new vscode.TestRunRequest([targetItem]);
    await runHandler(request, new vscode.CancellationTokenSource().token);
}

/**
 * Deactivates the test runner and cleans up resources.
 */
export function deactivateTestRunner(): void {
    testController?.dispose();
    testController = undefined;
    fileWatcher?.dispose();
    projectWatcher?.dispose();
    saveWatcher?.dispose();
    statusBarItem?.dispose();
    statusBarItem = undefined;
    if (debounceTimer) { clearTimeout(debounceTimer); }
    testItemDataMap.clear();
}
