import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { SerializationConfigService } from '../sitecore/serializationConfigService';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('infers include from serialized yaml path', () => {
		const service = SerializationConfigService.getInstance();
		const includeName = service.inferIncludeFromYamlPath('D:/Git/Vizient/dxp-sitecoreai/serialization/_vizient.main/items/Content.Site.Vizient/vizient-website/Settings/Site Grouping/vizient-website.yml');

		assert.strictEqual(includeName, 'Content.Site.Vizient');
	});

	test('resolves include details case-insensitively', () => {
		const service = SerializationConfigService.getInstance();
		const includeInfo = service.getIncludeInfo('_vizient.main', 'content.site.vizient');

		assert.ok(includeInfo);
		assert.strictEqual(includeInfo?.include, 'Content.Site.Vizient');
		assert.strictEqual(includeInfo?.path, '/sitecore/content/vizient/vizient-website');
		assert.strictEqual(includeInfo?.scope, 'ItemAndChildren');
		assert.strictEqual(includeInfo?.pushOperations, 'CreateAndUpdate');
		assert.strictEqual(includeInfo?.database, 'master');
	});

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});
});
