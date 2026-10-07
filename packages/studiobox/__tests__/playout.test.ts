import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { PlayoutPipeline } from '../src/playout';
import { StudioboxConfig } from '../src/config/schema';
import { bypass, config } from '../test-support/config';

/** The private surface these tests drive. */
interface Internals {
  pump(): void;
  onCommand(type: string, value?: unknown): void;
  monitor: { write(b: Buffer): boolean; waitWritable(cb: () => void, ms: number): void };
  listen: { attach(id: string, src: string, c: unknown): string; count: number };
}

function build() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-playout-'));
  const base = config([], {});
  const cfg: StudioboxConfig = {
    ...base,
    mode: 'playout',
    channels: [],
    meters: { ...base.meters, enabled: true },
    filePlayer: {
      enabled: true,
      dirs: [{ path: dir, label: 'Musik', hasScheduled: false, hideEmpty: false, icon: '🎵' }],
      label: 'Zuspieler',
      ducked: false,
      fadeOutMs: 0,
      prebufferMs: 0,
      autoPlay: { enabled: false, scanSeconds: 10, graceSeconds: 30 },
      bed: {
        enabled: false,
        dir: '',
        gainDb: -6,
        fadeInMs: 1500,
        fadeOutMs: 2500,
        havarie: { enabled: false, afterSeconds: 10, belowDb: -50 },
      },
      streams: [],
      processing: bypass(),
    },
  };
  const fed: number[] = [];
  const killed: boolean[] = [];
  const spawn = () => {
    const i = fed.push(0) - 1;
    killed.push(false);
    const stdin = new PassThrough();
    stdin.on('data', (b: Buffer) => (fed[i] += b.length));
    return { stdin, stdout: new PassThrough(), kill: () => (killed[i] = true), on: () => {} };
  };
  const playout = new PlayoutPipeline(cfg, { listenSpawn: spawn });
  const p = playout as unknown as Internals;
  const toCard: number[] = [];
  p.monitor.write = (b: Buffer) => (toCard.push(b.length), true);
  p.monitor.waitWritable = () => {}; // the test pumps by hand
  return { playout, p, fed, killed, toCard };
}

const client = () =>
  Object.assign(new EventEmitter(), {
    write: () => true,
    writableLength: 0,
    destroy() {
      this.emit('close');
    },
  });

describe('PlayoutPipeline: Abhören (what the box plays)', () => {
  it('offers "Auf Sendung" only and relays exactly what goes to the sound card', async () => {
    const { playout, p, fed, killed, toCard } = build();
    expect(playout.snapshot().listen).toEqual({ sources: ['air'] });
    for (let i = 0; i < 3; i++) p.pump();
    expect(fed).toEqual([]); // nobody listens: no encoder
    expect(p.listen.attach('tab-1', 'rec', client())).toBe('bad');
    expect(p.listen.attach('tab-1', 'air', client())).toBe('ok');
    for (let i = 0; i < 5; i++) p.pump();
    await new Promise((r) => setImmediate(r));
    expect(fed[0]).toBe(toCard.slice(-5).reduce((a, b) => a + b, 0));
    p.onCommand('listen', { id: 'tab-1', src: 'air' }); // accepted, nothing to switch
    playout.stop();
    expect(killed[0]).toBe(true);
  });
});
