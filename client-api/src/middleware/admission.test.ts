import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PriorityAdmission, classify } from './admission.js';

const limits = { total: 10, reservedFieldTeam: 4, mediaMax: 3 };

test('classification follows the token subject, unknown subjects are treated as Media', () => {
    assert.equal(classify('field-team'), 'field_team');
    assert.equal(classify('bnpb-ops'), 'ops');
    assert.equal(classify('media'), 'media');
    assert.equal(classify(undefined), 'media');
    assert.equal(classify('someone-else'), 'media');
});

test('Media is capped at its ceiling and rejected beyond it', () => {
    const a = new PriorityAdmission(limits);
    const held = Array.from({ length: 3 }, () => a.tryAdmit('media'));
    assert.ok(held.every(Boolean));
    assert.equal(a.tryAdmit('media'), null);
    assert.equal(a.rejected.media, 1);
});

test('a Media flood cannot take the slots reserved for Tim Lapangan', () => {
    const a = new PriorityAdmission({ total: 10, reservedFieldTeam: 4, mediaMax: 10 });
    let media = 0;
    for (let i = 0; i < 50; i++) if (a.tryAdmit('media')) media++;
    assert.equal(media, 6);
    let field = 0;
    for (let i = 0; i < 10; i++) if (a.tryAdmit('field_team')) field++;
    assert.equal(field, 4, 'Tim Lapangan is served with the reserved slots');
    assert.equal(a.tryAdmit('field_team'), null, 'hard total is respected');
});

test('Tim Lapangan may also use idle shared capacity', () => {
    const a = new PriorityAdmission(limits);
    let n = 0;
    while (a.tryAdmit('field_team')) n++;
    assert.equal(n, 10);
});

test('slots are returned once and reusable', () => {
    const a = new PriorityAdmission(limits);
    const r = a.tryAdmit('media')!;
    r();
    r();
    assert.equal(a.inFlight.media, 0);
    for (let i = 0; i < 3; i++) assert.ok(a.tryAdmit('media'));
});

test('ops shares the non-reserved pool with Media', () => {
    const a = new PriorityAdmission({ total: 10, reservedFieldTeam: 4, mediaMax: 3 });
    for (let i = 0; i < 3; i++) assert.ok(a.tryAdmit('media'));
    for (let i = 0; i < 3; i++) assert.ok(a.tryAdmit('ops'));
    assert.equal(a.tryAdmit('ops'), null);
    assert.ok(a.tryAdmit('field_team'));
});
