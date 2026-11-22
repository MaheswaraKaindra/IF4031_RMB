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

test('a rebuild read page by page with read-ahead gives the same final set for any page size', async () => {
    const frames = genStream(33);
    const ref = await reference(frames);
    const all = toEntries(frames);
    for (const pageSize of [1, 2, 3, 5, 8, 1000]) {
        for (const cut of [4, 15, 40]) {
            if (cut >= all.length) continue;
            const rig = newRig();
            await rig.log.append(all.slice(0, cut));
            await runToCatchUp(rig, { rebuildPageSize: pageSize });
            await rig.log.append(all.slice(cut));
            await runToCatchUp(rig, { rebuildPageSize: pageSize }); // a fresh run: the state is rebuilt from the log in pages of this size
            assert.deepEqual(await canonical(rig.repo), ref.fires, `page size ${pageSize}, restart at ${cut}`);
        }
    }
});

test('processor state exported at any frame and imported into a new processor continues to the same result', async () => {
    const { InMemorySnapshotStore } = await import('./snapshotStore.js');
    void InMemorySnapshotStore;
    for (const seed of [5, 21, 33, 44]) {
        const entries = toEntries(genStream(seed));
        const whole = new SatelliteProcessor(CFG);
        for (const e of entries) whole.apply(e.offset, e.kind, e.raw);
        for (let cut = 1; cut < entries.length; cut += 5) {
            const first = new SatelliteProcessor(CFG);
            for (const e of entries.slice(0, cut)) first.apply(e.offset, e.kind, e.raw);
            const stored = JSON.parse(JSON.stringify(first.exportState())); // through JSON, as the store does
            const resumed = new SatelliteProcessor(CFG);
            resumed.importState(stored);
            for (const e of entries.slice(cut)) resumed.apply(e.offset, e.kind, e.raw);
            assert.deepEqual(resumed.index.fires(), whole.index.fires(), `seed ${seed}, snapshot after frame ${cut - 1}`);
            assert.equal(resumed.watermarkMs, whole.watermarkMs);
            assert.deepEqual(resumed.counters, whole.counters);
        }
    }
});

test('a restart uses the snapshot and replays only the frames after it, with the same final set', async () => {
    const { InMemorySnapshotStore } = await import('./snapshotStore.js');
    const frames = genStream(33);
    const ref = await reference(frames);
    const all = toEntries(frames);
    const cut = Math.floor(all.length * 0.7);
    const rig = newRig();
    const snapshots = new InMemorySnapshotStore();
    await rig.log.append(all.slice(0, cut));
    await runToCatchUp(rig, { snapshots, snapshotEveryOffsets: 10 });
    assert.ok(snapshots.snapshot && snapshots.snapshot.offset > 0, 'a snapshot was saved');
    const snapAt = snapshots.snapshot.offset;
    await rig.log.append(all.slice(cut));
    const reads: number[] = [];
    const realRead = rig.log.read.bind(rig.log);
    rig.log.read = async (from: number, limit: number) => { reads.push(from); return realRead(from, limit); };
    await runToCatchUp(rig, { snapshots, snapshotEveryOffsets: 10, rebuildPageSize: 4 });
    assert.equal(reads.includes(0), false, 'the restart did not replay the log from offset 0');
    assert.equal(Math.min(...reads) >= snapAt + 1, true, `the first replayed frame is after the snapshot (offset ${snapAt})`);
    assert.deepEqual(await canonical(rig.repo), ref.fires);
});

test('an unusable snapshot falls back to the full replay and still gives the same set', async () => {
    const { InMemorySnapshotStore } = await import('./snapshotStore.js');
    const frames = genStream(21);
    const ref = await reference(frames);
    const all = toEntries(frames);
    const rig = newRig();
    const snapshots = new InMemorySnapshotStore();
    await rig.log.append(all.slice(0, 30));
    await runToCatchUp(rig, { snapshots, snapshotEveryOffsets: 5 });
    snapshots.snapshot = { offset: 20, state: { ...snapshots.snapshot!.state, cfg: { lateness_ms: 1, evict_every_offsets: 1 } } }; // taken under other settings
    await rig.log.append(all.slice(30));
    await runToCatchUp(rig, { snapshots });
    assert.deepEqual(await canonical(rig.repo), ref.fires);
});
