import { EventEmitter } from 'node:events';
import { PlayQueue, QueuePlayer, MAX_QUEUE } from '../../src/audio/play-queue';

const makeLog = () => ({ info: () => {}, warn: () => {}, error: () => {} });

/** Stand-in for FilePlayer: records what was asked to play and lets a test
 *  emit 'ended' the way real playback (or a completed fade-out) does. */
class FakePlayer extends EventEmitter {
  playing: string | null = null;
  played: string[] = [];
  fades = 0;
  play(file: string): void {
    this.playing = file;
    this.played.push(file);
  }
  fadeOut(ms: number): void {
    this.fades++;
    // Mirrors FilePlayer: a real ramp keeps `playing` set until it completes;
    // with nothing playing (or no fade time) it hard-stops silently.
    if (!this.playing || ms <= 0) this.playing = null;
  }
  /** Natural end of playback (or the end of a fade-out ramp). */
  end(): void {
    this.playing = null;
    this.emit('ended');
  }
}

const setup = (files: Record<string, string> = {}) => {
  const player = new FakePlayer();
  let changes = 0;
  const qp = new QueuePlayer({
    player,
    resolve: (folder, name) => files[`${folder}:${name}`] ?? null,
    onChange: () => changes++,
    log: makeLog(),
  });
  return { player, qp, changes: () => changes };
};

describe('PlayQueue', () => {
  it('appends with stable ids and reports them in play order', () => {
    const q = new PlayQueue();
    const added = q.add([
      { folder: 0, name: 'a.mp3' },
      { folder: 1, name: 'Musik/b.flac' },
    ]);
    expect(added.map((i) => i.name)).toEqual(['a.mp3', 'Musik/b.flac']);
    expect(added[0].id).not.toBe(added[1].id);
    expect(q.list().map((i) => i.name)).toEqual(['a.mp3', 'Musik/b.flac']);
    expect(q.length).toBe(2);
  });

  it('ids stay unique after removals, so a stale page cannot hit the wrong row', () => {
    const q = new PlayQueue();
    const [a, b] = q.add([
      { folder: 0, name: 'a' },
      { folder: 0, name: 'b' },
    ]);
    q.remove(a.id);
    const [c] = q.add([{ folder: 0, name: 'c' }]);
    expect(c.id).not.toBe(a.id);
    expect(q.remove(a.id)).toBe(false);
    expect(q.list().map((i) => i.id)).toEqual([b.id, c.id]);
  });

  it('moves items and clamps at both ends', () => {
    const q = new PlayQueue();
    const [a, b, c] = q.add([
      { folder: 0, name: 'a' },
      { folder: 0, name: 'b' },
      { folder: 0, name: 'c' },
    ]);
    expect(q.move(c.id, -1)).toBe(true);
    expect(q.list().map((i) => i.name)).toEqual(['a', 'c', 'b']);
    expect(q.move(a.id, -1)).toBe(false); // already at the top
    expect(q.move(b.id, 5)).toBe(false); // already at the bottom
    expect(q.list().map((i) => i.name)).toEqual(['a', 'c', 'b']);
  });

  it('take() jumps: the skipped entries are dropped, not played later', () => {
    const q = new PlayQueue();
    const items = q.add([
      { folder: 0, name: 'a' },
      { folder: 0, name: 'b' },
      { folder: 0, name: 'c' },
    ]);
    expect(q.take(items[2].id)?.name).toBe('c');
    expect(q.list()).toEqual([]);
    expect(q.take(items[0].id)).toBeNull();
  });

  it('caps the pending list so an "add all" on a huge share stays bounded', () => {
    const q = new PlayQueue();
    const many = Array.from({ length: MAX_QUEUE + 10 }, (_, i) => ({ folder: 0, name: `f${i}` }));
    expect(q.add(many).length).toBe(MAX_QUEUE);
    expect(q.length).toBe(MAX_QUEUE);
    expect(q.add([{ folder: 0, name: 'one more' }])).toEqual([]);
  });
});

describe('QueuePlayer', () => {
  it('enqueuing never starts audio by itself', () => {
    const { player, qp } = setup({ '0:a.mp3': '/m/a.mp3' });
    qp.handleCommand('queueAdd', { folder: 0, name: 'a.mp3' });
    expect(player.played).toEqual([]);
    expect(qp.list()).toHaveLength(1);
  });

  it('starts the head only when asked, then chains on natural end', () => {
    const { player, qp } = setup({ '0:a.mp3': '/m/a.mp3', '0:b.mp3': '/m/b.mp3' });
    qp.handleCommand('queueAdd', {
      items: [
        { folder: 0, name: 'a.mp3' },
        { folder: 0, name: 'b.mp3' },
      ],
    });
    qp.handleCommand('queueStart', {});
    expect(player.played).toEqual(['/m/a.mp3']);
    player.end();
    expect(player.played).toEqual(['/m/a.mp3', '/m/b.mp3']);
    expect(qp.list()).toEqual([]);
    player.end(); // empty queue: nothing more starts
    expect(player.played).toHaveLength(2);
  });

  it('chains on from a file that was started outside the queue', () => {
    const { player, qp } = setup({ '0:q.mp3': '/m/q.mp3' });
    qp.handleCommand('queueAdd', { folder: 0, name: 'q.mp3' });
    player.play('/m/manual.mp3'); // a click in the file list, or a scheduled start
    player.end();
    expect(player.played).toEqual(['/m/manual.mp3', '/m/q.mp3']);
  });

  it('an operator stop ends playback without rolling into the next item', () => {
    const { player, qp } = setup({ '0:a.mp3': '/m/a.mp3' });
    qp.handleCommand('queueAdd', { folder: 0, name: 'a.mp3' });
    player.play('/m/on-air.mp3');
    qp.stop(300); // fade-out running
    player.end(); // the 'ended' the fade emits
    expect(player.played).toEqual(['/m/on-air.mp3']);
    expect(qp.list()).toHaveLength(1); // the list itself survives the stop
  });

  it('a stop while idle does not swallow the next natural end', () => {
    const { player, qp } = setup({ '0:a.mp3': '/m/a.mp3' });
    qp.handleCommand('queueAdd', { folder: 0, name: 'a.mp3' });
    qp.stop(300); // nothing playing: hard stop, no 'ended' will come
    player.play('/m/other.mp3');
    player.end();
    expect(player.played).toEqual(['/m/other.mp3', '/m/a.mp3']);
  });

  it('skips files that vanished from the share instead of stalling', () => {
    const { player, qp } = setup({ '0:c.mp3': '/m/c.mp3' });
    qp.handleCommand('queueAdd', {
      items: [
        { folder: 0, name: 'gone.mp3' },
        { folder: 0, name: 'also-gone.mp3' },
        { folder: 0, name: 'c.mp3' },
      ],
    });
    qp.handleCommand('queueStart', {});
    expect(player.played).toEqual(['/m/c.mp3']);
    expect(qp.list()).toEqual([]);
  });

  it('queuePlay jumps to an item and drops the ones above it', () => {
    const { player, qp } = setup({ '0:a': '/m/a', '0:b': '/m/b', '0:c': '/m/c' });
    qp.handleCommand('queueAdd', {
      items: [
        { folder: 0, name: 'a' },
        { folder: 0, name: 'b' },
        { folder: 0, name: 'c' },
      ],
    });
    const c = qp.list()[2];
    qp.handleCommand('queuePlay', { id: c.id });
    expect(player.played).toEqual(['/m/c']);
    expect(qp.list()).toEqual([]);
  });

  it('reorders, removes and clears, and reports every change once', () => {
    const { qp, changes } = setup();
    qp.handleCommand('queueAdd', {
      items: [
        { folder: 0, name: 'a' },
        { folder: 0, name: 'b' },
      ],
    });
    expect(changes()).toBe(1); // one batch, one broadcast
    const [a] = qp.list();
    qp.handleCommand('queueMove', { id: a.id, delta: 1 });
    expect(qp.list().map((i) => i.name)).toEqual(['b', 'a']);
    qp.handleCommand('queueRemove', { id: a.id });
    expect(qp.list().map((i) => i.name)).toEqual(['b']);
    qp.handleCommand('queueClear', {});
    expect(qp.list()).toEqual([]);
    expect(changes()).toBe(4);
    qp.handleCommand('queueClear', {}); // nothing to clear: no broadcast
    expect(changes()).toBe(4);
  });

  it('leaves non-queue commands to the pipeline', () => {
    const { qp } = setup();
    expect(qp.handleCommand('playFile', { folder: 0, name: 'a' })).toBe(false);
    expect(qp.handleCommand('queueClear', {})).toBe(true);
  });
});
