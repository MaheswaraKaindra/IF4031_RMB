import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRulesBackend, SchemaRulesStore } from './schemaRulesStore.js';
import { defaultSchemaRules } from './schemaValidator.js';

const base = () => ({ ...defaultSchemaRules(), enablePvmbgV2Compat: false, fieldAliases: {}, coerceNumericStrings: false, defaults: {} });

test('a rule saved through one pod reaches another pod after a refresh', async () => {
    const backend = new InMemoryRulesBackend();
    const podA = new SchemaRulesStore(backend, base());
    const podB = new SchemaRulesStore(backend, base());
    await podA.update({ enablePvmbgV2Compat: true });
    assert.equal(podB.current().enablePvmbgV2Compat, false, 'before the refresh pod B still has the old copy');
    await podB.refresh();
    assert.equal(podB.current().enablePvmbgV2Compat, true);
    assert.deepEqual(podB.current().fieldAliases, { mountain_code: 'volcano_id', status_level: 'alert_level' });
});

test('rules survive a restart because a new pod loads the stored copy', async () => {
    const backend = new InMemoryRulesBackend();
    await new SchemaRulesStore(backend, base()).update({ coerceNumericStrings: true, defaults: { x: 1 } });
    const restarted = new SchemaRulesStore(backend, base());
    assert.equal(restarted.current().coerceNumericStrings, false);
    await restarted.refresh();
    assert.equal(restarted.current().coerceNumericStrings, true);
    assert.deepEqual(restarted.current().defaults, { x: 1 });
});

test('a failed save leaves the rules unchanged and reports the error', async () => {
    const backend = new InMemoryRulesBackend();
    const pod = new SchemaRulesStore(backend, base());
    backend.failing = true;
    await assert.rejects(pod.update({ enablePvmbgV2Compat: true }));
    assert.equal(pod.current().enablePvmbgV2Compat, false);
});

test('a store outage during refresh keeps the last known rules', async () => {
    const backend = new InMemoryRulesBackend();
    const pod = new SchemaRulesStore(backend, base());
    await pod.update({ coerceNumericStrings: true });
    backend.failing = true;
    assert.equal(await pod.refresh(), false);
    assert.equal(pod.current().coerceNumericStrings, true);
});

test('two pods saving in turn never lose the earlier change', async () => {
    const backend = new InMemoryRulesBackend();
    const podA = new SchemaRulesStore(backend, base());
    const podB = new SchemaRulesStore(backend, base());
    await podA.update({ defaults: { a: 1 } });
    await podB.update({ coerceNumericStrings: true });
    await podA.refresh();
    assert.deepEqual(podA.current().defaults, { a: 1 });
    assert.equal(podA.current().coerceNumericStrings, true);
});
