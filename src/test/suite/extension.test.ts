/**
 * These tests serve as a placeholder for future tests that will need to be added
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { getProjectFamily } from '../../dotnet';
import { NuGetManager, NuGetService, selectNugetSources } from '../../nuget';
import { getTemplatePackages } from '../../projectTemplates';
import { convertWindowsPathsInCommand, toWslPathArgument } from '../../wsl';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');
	const templateRoot = path.join(__dirname, '..', '..', '..', 'dist', 'utils');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('Defines independent opt-in WSL execution settings', () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
		const properties = manifest.contributes.configuration.properties;

		for (const kind of ['build', 'deployment', 'test', 'debug', 'tooling']) {
			const setting = properties[`nanoFramework.wsl.${kind}`];
			assert.strictEqual(setting.type, 'boolean');
			assert.strictEqual(setting.default, false);
		}
		assert.strictEqual(properties['nanoFramework.runCommandsInWsl'], undefined);
	});

	test('Converts Windows paths without corrupting URLs', () => {
		const url = 'https://api.nuget.org/v3/index.json';
		assert.strictEqual(toWslPathArgument(url), url);
		assert.strictEqual(toWslPathArgument('C:\\Repos\\nanoFramework\\App.nfproj'), '/mnt/c/Repos/nanoFramework/App.nfproj');
		assert.strictEqual(convertWindowsPathsInCommand(`curl '${url}'`), `curl '${url}'`);
		assert.strictEqual(
			convertWindowsPathsInCommand('msbuild "C:\\Repos\\nanoFramework\\App.nfproj" output=C:\\Temp\\build'),
			'msbuild "/mnt/c/Repos/nanoFramework/App.nfproj" output=/mnt/c/Temp/build'
		);
	});

	test('Uses only enabled dotnet NuGet sources with a default fallback', () => {
		const defaultSource = 'https://api.nuget.org/v3/index.json';
		const configuredSources = [
			'E https://packages.example.test/v3/index.json',
			'D https://disabled.example.test/v3/index.json',
			'E https://mirror.example.test/v3/index.json',
			'EM C:\\Program Files (x86)\\Microsoft SDKs\\NuGetPackages\\',
			'DM C:\\Program Files (x86)\\DisabledPackages\\'
		].join('\r\n');

		assert.deepStrictEqual(selectNugetSources(configuredSources, defaultSource), [
			'https://packages.example.test/v3/index.json',
			'https://mirror.example.test/v3/index.json',
			'C:\\Program Files (x86)\\Microsoft SDKs\\NuGetPackages\\'
		]);
		assert.deepStrictEqual(
			selectNugetSources('D https://disabled.example.test/v3/index.json', defaultSource),
			[defaultSource]
		);
		assert.deepStrictEqual(selectNugetSources('', defaultSource), [defaultSource]);
	});

	test('Uses distinct stable and Preview template package families', () => {
		assert.deepStrictEqual(getTemplatePackages(templateRoot, 1, 'unitTest'), [
			{ id: 'nanoFramework.CoreLibrary', version: '1.17.11' },
			{ id: 'nanoFramework.TestFramework', version: '3.0.77' }
		]);
		assert.deepStrictEqual(getTemplatePackages(templateRoot, 2, 'unitTest'), [
			{ id: 'nanoFramework.CoreLibrary', version: '2.0.0-preview.30' },
			{ id: 'nanoFramework.TestFramework', version: '4.0.0-preview.45' }
		]);
	});

	test('Resolves the selected project family in a mixed-family solution', () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-mixed-family-'));
		const solutionPath = path.join(directory, 'Mixed.sln');
		const stableProject = createFamilyProject(directory, 'StableApp', '1.17.11');
		const previewProject = createFamilyProject(directory, 'PreviewApp', '2.0.0-preview.30');
		fs.writeFileSync(solutionPath, '', 'utf8');

		try {
			assert.strictEqual(getProjectFamily(stableProject), 1);
			assert.strictEqual(getProjectFamily(previewProject), 2);
			assert.throws(() => getProjectFamily(solutionPath), /cannot mix nanoFramework v1 and v2/i);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	test('Migrates project packages between v1 and preview v2', async () => {
		const fixture = createMigrationFixture(true);
		const originalGetVersions = NuGetService.getPackageVersions;
		NuGetService.getPackageVersions = async packageId => packageId === 'nanoFramework.CoreLibrary'
			? ['2.0.0-preview.10', '1.17.11']
			: ['2.0.0-preview.4', '1.4.0'];

		try {
			await NuGetManager.migrateProjectVersion(fixture.projectPath, 2, templateRoot);
			assert.strictEqual(NuGetManager.getProjectVersion(fixture.projectPath), 2);
			let project = fs.readFileSync(fixture.projectPath, 'utf8');
			let packages = fs.readFileSync(fixture.packagesPath, 'utf8');
			assert.match(project, /CoreLibrary\.2\.0\.0-preview\.30\\lib\\netnano1\.0/);
			assert.match(project, /System\.Text\.2\.0\.0-preview\.4\\lib\\netnano1\.0/);
			assert.match(project, /mscorlib, Version=2\.0\.0\.0/);
			assert.doesNotMatch(project, /Version=2\.0\.0-preview/);
			assert.match(project, /TestFramework\.4\.0\.0-preview\.45/);
			assert.match(packages, /TestFramework" version="4\.0\.0-preview\.45"/);

			await NuGetManager.migrateProjectVersion(fixture.projectPath, 1, templateRoot);
			assert.strictEqual(NuGetManager.getProjectVersion(fixture.projectPath), 1);
			project = fs.readFileSync(fixture.projectPath, 'utf8');
			packages = fs.readFileSync(fixture.packagesPath, 'utf8');
			assert.match(project, /CoreLibrary\.1\.17\.11/);
			assert.match(project, /System\.Text\.1\.4\.0\\lib\\System\.Text\.dll/);
			assert.doesNotMatch(project, /System\.Text\.1\.4\.0\\lib\\netnano1\.0/);
			assert.match(project, /TestFramework\.3\.0\.77/);
			assert.match(packages, /TestFramework" version="3\.0\.77"/);
		} finally {
			NuGetService.getPackageVersions = originalGetVersions;
			fs.rmSync(fixture.directory, { recursive: true, force: true });
		}
	});

	test('Rolls back migration when a project reference cannot be updated', async () => {
		const fixture = createMigrationFixture(false);
		const originalProject = fs.readFileSync(fixture.projectPath, 'utf8');
		const originalPackages = fs.readFileSync(fixture.packagesPath, 'utf8');
		const originalGetVersions = NuGetService.getPackageVersions;
		NuGetService.getPackageVersions = async () => ['2.0.0-preview.1'];

		try {
			await assert.rejects(NuGetManager.migrateProjectVersion(fixture.projectPath, 2, templateRoot));
			assert.strictEqual(fs.readFileSync(fixture.projectPath, 'utf8'), originalProject);
			assert.strictEqual(fs.readFileSync(fixture.packagesPath, 'utf8'), originalPackages);
		} finally {
			NuGetService.getPackageVersions = originalGetVersions;
			fs.rmSync(fixture.directory, { recursive: true, force: true });
		}
	});

	test('Updates only the selected NuGet package version', async () => {
		const fixture = createMigrationFixture(true);
		const packages = fs.readFileSync(fixture.packagesPath, 'utf8').replace(
			'<packages>',
			'<packages>\n  <package id="nanoFrameworkXSystemYText" version="9.9.9" targetFramework="netnano1.0" />'
		);
		fs.writeFileSync(fixture.packagesPath, packages, 'utf8');

		try {
			await NuGetManager.updatePackageVersion(
				fixture.projectPath,
				'nanoFramework.System.Text',
				'1.5.0'
			);

			const installed = new Map(
				NuGetManager.getInstalledPackages(fixture.projectPath).map(pkg => [pkg.id, pkg.version])
			);
			assert.strictEqual(installed.get('nanoFramework.System.Text'), '1.5.0');
			assert.strictEqual(installed.get('nanoFramework.CoreLibrary'), '1.17.11');
			assert.strictEqual(installed.get('nanoFramework.TestFramework'), '2.1.107');
			assert.strictEqual(installed.get('nanoFrameworkXSystemYText'), '9.9.9');

			const project = fs.readFileSync(fixture.projectPath, 'utf8');
			assert.match(project, /nanoFramework\.System\.Text\.1\.5\.0\\lib\\System\.Text\.dll/);
			assert.match(project, /nanoFramework\.CoreLibrary\.1\.17\.11/);
			assert.match(project, /nanoFramework\.TestFramework\.3\.0\.77/);
		} finally {
			fs.rmSync(fixture.directory, { recursive: true, force: true });
		}
	});
});

function createMigrationFixture(includeSystemTextReference: boolean) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-project-migration-'));
	const projectPath = path.join(directory, 'Migration.nfproj');
	const packagesPath = path.join(directory, 'packages.config');
	const systemTextReference = includeSystemTextReference ? `
    <Reference Include="System.Text, Version=1.4.0.0">
      <HintPath>..\\packages\\nanoFramework.System.Text.1.4.0\\lib\\System.Text.dll</HintPath>
    </Reference>` : '';
	fs.writeFileSync(projectPath, `<Project>
	<PropertyGroup>
		<IsTestProject>true</IsTestProject>
	</PropertyGroup>
  <ItemGroup>
    <Reference Include="mscorlib, Version=1.17.11.0">
      <HintPath>..\\packages\\nanoFramework.CoreLibrary.1.17.11\\lib\\mscorlib.dll</HintPath>
		</Reference>
		<Reference Include="nanoFramework.TestFramework, Version=3.0.77.0">
			<HintPath>..\\packages\\nanoFramework.TestFramework.3.0.77\\lib\\nanoFramework.TestFramework.dll</HintPath>
		</Reference>${systemTextReference}
  </ItemGroup>
</Project>`, 'utf8');
	fs.writeFileSync(packagesPath, `<packages>
  <package id="nanoFramework.CoreLibrary" version="1.17.11" targetFramework="netnano1.0" />
  <package id="nanoFramework.System.Text" version="1.4.0" targetFramework="netnano1.0" />
  <package id="nanoFramework.TestFramework" version="2.1.107" targetFramework="netnano1.0" />
</packages>`, 'utf8');
	return { directory, projectPath, packagesPath };
}

function createFamilyProject(root: string, name: string, coreLibraryVersion: string): string {
	const projectDirectory = path.join(root, name);
	const projectPath = path.join(projectDirectory, `${name}.nfproj`);
	fs.mkdirSync(projectDirectory);
	fs.writeFileSync(projectPath, '<Project />', 'utf8');
	fs.writeFileSync(
		path.join(projectDirectory, 'packages.config'),
		`<packages><package id="nanoFramework.CoreLibrary" version="${coreLibraryVersion}" /></packages>`,
		'utf8');
	return projectPath;
}
