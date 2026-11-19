import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SatelliteProcessor } from './processor.js';
import { runSatelliteProcessing, SATELLITE_PARTITION, SATELLITE_SOURCE } from './runner.js';
import { CFG, canonical, committedOffset, deps, genStream, newHandle, newRig, reference, runToCatchUp, toEntries, waitFor } from './testSupport.js';

test('runner: canonical records match the processor and carry the wildfire contract', async () => {
    const frames = genStream(3);
    const rig = newRig();
    await rig.log.append(toEntries(frames));
    await runToCatchUp(rig);
    const proc = new SatelliteProcessor({ ...CFG, evict_every_offsets: 0 });
    toEntries(frames).forEach((e) => proc.apply(e.offset, e.kind, e.raw));
    const records = (await canonical(rig.repo)) as Array<Record<string, unknown>>;
    assert.equal(records.length, proc.index.fires().length);
    assert.ok(records.length > 0);
    for (const rec of records) {
        assert.equal(rec.source, 'SATELIT');
        assert.equal(rec.hazard_type, 'WILDFIRE');
        assert.ok(['WASPADA', 'SIAGA', 'AWAS'].includes(rec.severity as string));
        assert.equal(typeof rec.area_name, 'string');
        const attrs = rec.attributes as { detection_count: number; detection_keys: string[] };
        assert.ok(attrs.detection_count >= 2);
        assert.equal(attrs.detection_keys.length, attrs.detection_count);
    }
    const lateKeys = new Set<string>();
    const again = new SatelliteProcessor({ ...CFG, evict_every_offsets: 0 });
    toEntries(frames).forEach((e) => {
        const r = again.apply(e.offset, e.kind, e.raw);
        if (r.late) lateKeys.add(r.late.key);
    });
    assert.ok(lateKeys.size > 0);
    assert.deepEqual([...rig.late.records.keys()].sort(), [...lateKeys].sort());
});

test('crash after the canonical writes but before the checkpoint yields the same final set, at every batch', async () => {
    const frames = genStream(21);
    const ref = await reference(frames);
    assert.ok(ref.fires.length > 0);
    const total = frames.length;
    for (let crashAt = 6; crashAt < total; crashAt += 7) {
        const rig = newRig();
        await rig.log.append(toEntries(frames));
        const { handle, ac } = await newHandle(rig.fence);
        await runSatelliteProcessing(
            deps(rig, {
                beforeCheckpoint: (last) => {
                    if (last >= crashAt) {
                        ac.abort();
                        throw new Error('simulated crash');
                    }
                },
            }),
            handle
        );
        assert.ok((await committedOffset(rig)) < crashAt, `checkpoint must not pass the crash point ${crashAt}`);
        await runToCatchUp(rig);
        assert.deepEqual(await canonical(rig.repo), ref.fires, `crash before checkpoint at ${crashAt}`);
        assert.deepEqual([...rig.late.records.keys()].sort(), ref.late);
    }
});

test('crash after the checkpoint, with the rest of the feed arriving later, yields the same final set', async () => {
    const frames = genStream(33);
    const ref = await reference(frames);
    const all = toEntries(frames);
    for (let cut = 3; cut < all.length; cut += 9) {
        const rig = newRig();
        await rig.log.append(all.slice(0, cut));
        await runToCatchUp(rig);
        assert.equal(await committedOffset(rig), cut - 1);
        await rig.log.append(all.slice(cut));
        await runToCatchUp(rig);
        assert.deepEqual(await canonical(rig.repo), ref.fires, `restart at ${cut}`);
        assert.deepEqual([...rig.late.records.keys()].sort(), ref.late);
    }
});

test('repeated crashes at different boundaries still converge on the uninterrupted result', async () => {
    const frames = genStream(44);
    const ref = await reference(frames);
    const rig = newRig();
    await rig.log.append(toEntries(frames));
    for (const crashAt of [10, 25, 60, 61, 90]) {
        if (crashAt >= frames.length) continue;
        const { handle, ac } = await newHandle(rig.fence);
        await runSatelliteProcessing(
            deps(rig, {
                beforeCheckpoint: (last) => {
                    if (last >= crashAt) {
                        ac.abort();
                        throw new Error('simulated crash');
                    }
                },
            }),
            handle
        );
    }
    await runToCatchUp(rig);
    assert.deepEqual(await canonical(rig.repo), ref.fires);
});

test('a frozen former leader cannot write after a newer epoch exists', async () => {
    const frames = genStream(55);
    const rig = newRig();
    await rig.log.append(toEntries(frames));
    const stale = await newHandle(rig.fence);
    await rig.fence.activateEpoch(SATELLITE_SOURCE, 'other-pod');
    await runSatelliteProcessing(deps(rig), stale.handle);
    assert.equal((await canonical(rig.repo)).length, 0);
    assert.equal(await committedOffset(rig), -1);
});

test('storage outage stalls the checkpoint and recovery applies the backlog exactly once', async () => {
    const frames = genStream(66);
    const ref = await reference(frames);
    const rig = newRig();
    await rig.log.append(toEntries(frames));
    for (const i of [0, 1, 2]) rig.repo.setUnitDown(i, true);
    const { handle, ac } = await newHandle(rig.fence);
    const run = runSatelliteProcessing(deps(rig), handle);
    try {
        await new Promise((r) => setTimeout(r, 60));
        assert.ok((await committedOffset(rig)) < (await rig.log.tail()), 'checkpoint must stall while the store is unavailable');
        for (const i of [0, 1, 2]) rig.repo.setUnitDown(i, false);
        await waitFor(async () => (await committedOffset(rig)) === (await rig.log.tail()));
    } finally {
        ac.abort();
        await run;
    }
    assert.deepEqual(await canonical(rig.repo), ref.fires);
});
