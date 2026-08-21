import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The meters page is a self-contained script inside `server.ts`, and the queue
 * / Vorhören logic living there is real logic worth testing. Rather than pull
 * in a browser stack for one page, this suite extracts that script and runs it
 * against a deliberately small DOM stub: enough element behaviour for the page
 * to boot, plus hooks to click things, answer fetches and push WebSocket
 * frames. It is a black-box test — everything goes through the stubbed DOM.
 */
function pageScript(): string {
  const src = fs.readFileSync(path.join(__dirname, '../../src/meters/server.ts'), 'utf8');
  const page = src.split('const PAGE = `')[1].split('`;\n')[0];
  return page.split('<script>')[1].split('</script>')[0].replace('__SERVER_TZ__', 'Europe/Berlin');
}

/** A DOM node with just the surface the page touches. */
class El {
  tagName: string;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: El[] = [];
  textContent = '';
  onclick: (() => void) | null = null;
  src?: string;
  paused = false;
  duration = 0;
  currentTime = 0;
  private cls = new Set<string>();
  private html = '';
  private qs: Record<string, El> = {};
  private qsa: Record<string, El[]> = {};
  private ev: Record<string, Array<(e: unknown) => void>> = {};
  classList = {
    add: (c: string) => this.cls.add(c),
    remove: (c: string) => this.cls.delete(c),
    contains: (c: string) => this.cls.has(c),
    toggle: (c: string, v?: boolean) => {
      const on = v === undefined ? !this.cls.has(c) : !!v;
      if (on) this.cls.add(c);
      else this.cls.delete(c);
      return on;
    },
  };

  constructor(tag = 'div') {
    this.tagName = tag;
  }
  get className(): string {
    return [...this.cls].join(' ');
  }
  set className(v: string) {
    this.cls = new Set(String(v).split(' ').filter(Boolean));
  }
  has(c: string): boolean {
    return this.cls.has(c);
  }
  get innerHTML(): string {
    return this.html;
  }
  set innerHTML(v: string) {
    this.html = v;
    this.children = [];
    this.qs = {};
    this.qsa = {};
  }
  appendChild(c: El): El {
    this.children.push(c);
    return c;
  }
  /** Memoized so a handler the page attaches to a queried child is the one a
   *  test finds again. */
  querySelector(sel: string): El {
    return (this.qs[sel] ??= new El());
  }
  /** Only ever used for the queue rows' ↑ ↓ ✕ — recover them from the markup
   *  so their `data-a` (and therefore the click they send) is real. */
  querySelectorAll(sel: string): El[] {
    if (!this.qsa[sel]) {
      const out: El[] = [];
      const re = /<button data-a="([a-z]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(this.html))) {
        const b = new El('button');
        b.dataset.a = m[1];
        out.push(b);
      }
      this.qsa[sel] = out;
    }
    return this.qsa[sel];
  }
  addEventListener(t: string, fn: (e: unknown) => void): void {
    (this.ev[t] ??= []).push(fn);
  }
  fire(t: string): void {
    (this.ev[t] ?? []).forEach((fn) => fn({ target: this }));
  }
  contains(): boolean {
    return false;
  }
  closest(): null {
    return null;
  }
  pause(): void {
    this.paused = true;
  }
  load(): void {
    /* no-op */
  }
  play(): Promise<void> {
    return Promise.resolve();
  }
  removeAttribute(a: string): void {
    delete (this as unknown as Record<string, unknown>)[a];
  }
  /** Click carries an event object: the page stops propagation on the row
   *  controls so they don't also trigger the row itself. */
  click(): void {
    (this.onclick as unknown as ((e: unknown) => void) | null)?.({ stopPropagation: () => {} });
  }
}

interface FileRow {
  name: string;
  dir?: boolean;
  playAtMs?: number;
}

const FOLDERS = [
  { label: 'Programm', icon: '📻' },
  { label: 'Musik', icon: '🎵' },
];

/** Boot the page against the stub DOM. `listings` maps "folder/path" to rows. */
function boot(listings: Record<string, FileRow[]>, folders = FOLDERS) {
  const els: Record<string, El> = {};
  const byId = (id: string) => (els[id] ??= new El());
  const sent: Array<{ type: string; value?: Record<string, unknown> }> = [];
  let socket: { onmessage?: (e: { data: string }) => void; onclose?: () => void } = {};

  const document = {
    getElementById: byId,
    createElement: (t: string) => new El(t),
    querySelector: (sel: string) => byId(`sel:${sel}`),
    addEventListener: () => {},
    body: new El('body'),
  };
  class WS {
    readyState = 1;
    constructor() {
      socket = this as never;
    }
    send(raw: string): void {
      sent.push(JSON.parse(raw));
    }
  }
  const fetchStub = (url: string) => {
    const json = () => {
      if (url.startsWith('folders')) return Promise.resolve({ folders });
      if (url.startsWith('files')) {
        const q = url.split('?')[1];
        const folder = /folder=(\d+)/.exec(q)?.[1] ?? '0';
        const sub = decodeURIComponent(/path=([^&]*)/.exec(q)?.[1] ?? '');
        return Promise.resolve({ files: listings[`${folder}/${sub}`] ?? [], now: Date.now() });
      }
      return Promise.resolve({ scheduled: [], now: Date.now() });
    };
    return Promise.resolve({ json });
  };

  const run = new Function(
    'document',
    'window',
    'location',
    'WebSocket',
    'fetch',
    'setInterval',
    'setTimeout',
    pageScript()
  );
  run(
    document,
    {},
    { host: 'box:4445' },
    WS,
    fetchStub,
    () => 0,
    () => 0
  );

  const flush = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  };
  return {
    els,
    byId,
    sent,
    flush,
    /** Push a server frame (meter snapshot or queue list) to the page. */
    push: (msg: unknown) => socket.onmessage?.({ data: JSON.stringify(msg) }),
    /** Rows of the file listing, with '*' marking the pre-listen highlight. */
    fileRows: () =>
      byId('flist').children.map((li) => li.dataset.rel + (li.has('cued') ? '*' : '')),
    /** Rendered queue rows, tags stripped (a single row is the empty-list
     *  placeholder, which the page writes as raw markup). */
    queueRows: () => {
      const ul = byId('qlist');
      const strip = (h: string) => h.replace(/<[^>]*>/g, '');
      return ul.children.length
        ? ul.children.map((li) => strip(li.innerHTML))
        : [strip(ul.innerHTML)];
    },
    selectFolder: async (i: number) => {
      byId('folderList').children[i].click();
      await flush();
    },
    /** One of a queue row's controls (📂 ↑ ↓ ✕), by action. */
    rowBtn: (row: number, action: string) => {
      const b = byId('qlist')
        .children[row].querySelectorAll('.qb button')
        .find((x) => x.dataset.a === action);
      if (!b) throw new Error(`no ${action} button on queue row ${row}`);
      return b;
    },
    /** Is the queue panel on screen at all? */
    queueShown: () => byId('queuebox').style.display !== 'none',
    /** Is "＋ alle" offered, and for how many files? */
    addAll: () => (byId('addall').style.display === 'none' ? null : byId('addall').textContent),
    /** The listing row a jump flashed, if any. */
    focused: () =>
      byId('flist')
        .children.filter((li) => li.has('focus'))
        .map((li) => li.dataset.rel),
    bodyClasses: () => document.body.className,
    crumb: () =>
      byId('crumbs')
        .innerHTML.replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
  };
}

const LISTINGS: Record<string, FileRow[]> = {
  '0/': [{ name: 'sendung.mp3' }, { name: 'jingle.wav' }],
  '1/': [{ name: 'a.mp3' }, { name: 'b.wma' }, { name: 'c.flac' }],
  '1/Sub': [{ name: 'deep.mp3' }],
};

/** A meter frame carrying just what the now-playing line reads. */
const frame = (
  playing: string | null,
  at: { folder: number; name: string } | null,
  position: number | null = null
) => ({
  channels: [],
  filePlaying: playing,
  filePlayingAt: at,
  filePosition: position,
  serverNowMs: Date.now(),
});

describe('meters page — on-air queue', () => {
  it('＋ on a file row asks the server to enqueue, and the pushed list renders', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.byId('flist').children[0].querySelector('.addbtn').click();
    expect(p.sent).toEqual([{ type: 'queueAdd', value: { folder: 0, name: 'sendung.mp3' } }]);
    // Nothing renders until the server echoes the authoritative list back.
    expect(p.queueShown()).toBe(false);
    p.push({ type: 'queue', items: [{ id: 7, folder: 0, name: 'sendung.mp3' }] });
    expect(p.queueShown()).toBe(true);
    expect(p.queueRows()).toEqual(['1Programm / sendung.mp3📂↑↓✕']);
    expect(p.byId('qtitle').textContent).toContain('(1)');
  });

  it('row controls send id-based commands, not positions', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push({
      type: 'queue',
      items: [
        { id: 4, folder: 0, name: 'sendung.mp3' },
        { id: 9, folder: 1, name: 'a.mp3' },
      ],
    });
    p.rowBtn(1, 'up').click();
    p.rowBtn(1, 'rm').click();
    p.byId('qlist').children[1].querySelector('.fname').click(); // play it now
    p.byId('qplay').click();
    p.byId('qclear').click();
    expect(p.sent).toEqual([
      { type: 'queueMove', value: { id: 9, delta: -1 } },
      { type: 'queueRemove', value: { id: 9 } },
      { type: 'queuePlay', value: { id: 9 } },
      { type: 'queueStart' },
      { type: 'queueClear' },
    ]);
  });

  it('shows the folder of each entry when more than one folder is configured', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push({ type: 'queue', items: [{ id: 1, folder: 1, name: 'Sub/a.mp3' }] });
    expect(p.queueRows()).toEqual(['1Musik / Sub / a.mp3📂↑↓✕']);
  });

  it('＋ alle enqueues the whole listing in one message', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    expect(p.addAll()).toBe('＋ alle (2)');
    p.byId('addall').click();
    expect(p.sent).toEqual([
      {
        type: 'queueAdd',
        value: {
          items: [
            { folder: 0, name: 'sendung.mp3' },
            { folder: 0, name: 'jingle.wav' },
          ],
        },
      },
    ]);
  });
});

describe('meters page — ＋ alle only offers what is listed', () => {
  it('counts the files on screen, not the tree below them', async () => {
    const p = boot({ ...LISTINGS, '1/': [{ name: 'Sub', dir: true }, { name: 'a.mp3' }] });
    await p.flush();
    await p.selectFolder(1);
    expect(p.addAll()).toBe('＋ alle (1)'); // the subfolder is not a file
    p.byId('addall').click();
    expect(p.sent).toEqual([
      { type: 'queueAdd', value: { items: [{ folder: 1, name: 'a.mp3' }] } },
    ]);
  });

  it('is absent in a folder that only holds subfolders', async () => {
    const p = boot({ ...LISTINGS, '1/': [{ name: 'Sub', dir: true }] });
    await p.flush();
    await p.selectFolder(1);
    expect(p.addAll()).toBeNull();
  });

  it('is absent in an empty folder', async () => {
    const p = boot({ ...LISTINGS, '1/': [] });
    await p.flush();
    await p.selectFolder(1);
    expect(p.addAll()).toBeNull();
  });

  it('counts only what the browser can decode while pre-listening', async () => {
    const p = boot({ ...LISTINGS, '1/': [{ name: 'b.wma' }, { name: 'x.aiff' }] });
    await p.flush();
    p.byId('cue').click();
    await p.flush();
    await p.selectFolder(1);
    expect(p.addAll()).toBeNull(); // neither format plays in a browser
    p.byId('cue').click(); // on air the box decodes both
    await p.flush();
    expect(p.addAll()).toBe('＋ alle (2)');
  });
});

describe('meters page — Vorhören queue', () => {
  const cueOn = async (p: ReturnType<typeof boot>) => {
    p.byId('cue').click();
    await p.flush();
  };

  it('builds a browser-local list that never touches the box', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    await cueOn(p);
    await p.selectFolder(1);
    p.byId('flist').children[0].querySelector('.addbtn').click(); // a.mp3
    p.byId('flist').children[2].querySelector('.addbtn').click(); // c.flac
    expect(p.sent).toEqual([]); // nothing goes to the server
    expect(p.queueRows()).toEqual(['1a.mp3📂↑↓✕', '2c.flac📂↑↓✕']);
    expect(p.byId('qtitle').textContent).toContain('Vorhören');
  });

  it('offers no ＋ for formats the browser cannot decode', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    await cueOn(p);
    await p.selectFolder(1);
    expect(p.byId('flist').children[1].innerHTML).not.toContain('addbtn'); // b.wma
    p.byId('addall').click();
    expect(p.queueRows()).toEqual(['1a.mp3📂↑↓✕', '2c.flac📂↑↓✕']);
  });

  it('▶ starts the head in the browser and the end of a track pulls the next', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    await cueOn(p);
    await p.selectFolder(1);
    p.byId('addall').click();
    p.byId('qplay').click();
    const audio = p.byId('cueAudio');
    expect(audio.src).toBe('preview?folder=1&name=a.mp3');
    expect(p.queueRows()).toEqual(['1c.flac📂↑↓✕']);
    expect(p.fileRows()).toEqual(['a.mp3*', 'b.wma', 'c.flac']);
    audio.fire('ended');
    expect(audio.src).toBe('preview?folder=1&name=c.flac');
    expect(p.fileRows()).toEqual(['a.mp3', 'b.wma', 'c.flac*']);
    expect(p.queueShown()).toBe(false); // drained: the panel goes away again
    audio.fire('ended'); // queue empty, and this file came from the queue: stop
    expect(audio.src).toBeUndefined();
  });

  it('keeps auditioning the folder straight through while the queue is empty', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    await cueOn(p);
    await p.selectFolder(1);
    p.byId('flist').children[0].click(); // click a.mp3 -> folder roll
    const audio = p.byId('cueAudio');
    audio.fire('ended');
    expect(audio.src).toBe('preview?folder=1&name=c.flac'); // b.wma skipped
  });

  it('an explicit queue wins over the folder roll', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    await cueOn(p);
    await p.selectFolder(1);
    p.byId('flist').children[0].click(); // playing a.mp3 from the roll
    await p.selectFolder(0);
    p.byId('flist').children[0].querySelector('.addbtn').click(); // queue sendung.mp3
    p.byId('cueAudio').fire('ended');
    expect(p.byId('cueAudio').src).toBe('preview?folder=0&name=sendung.mp3');
    expect(p.fileRows()).toEqual(['sendung.mp3*', 'jingle.wav']);
  });

  it('browsing elsewhere does not disturb what is being pre-listened to', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    await cueOn(p);
    await p.selectFolder(1);
    p.byId('flist').children[0].click();
    await p.selectFolder(0);
    expect(p.byId('cueAudio').src).toBe('preview?folder=1&name=a.mp3');
    expect(p.fileRows()).toEqual(['sendung.mp3', 'jingle.wav']); // no stale highlight
    expect(p.sent).toEqual([]);
  });

  it('hands the audition list to the box in one message and keeps it', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    await cueOn(p);
    await p.selectFolder(1);
    p.byId('addall').click();
    p.byId('qsend').click();
    expect(p.sent).toEqual([
      {
        type: 'queueAdd',
        value: {
          items: [
            { folder: 1, name: 'a.mp3' },
            { folder: 1, name: 'c.flac' },
          ],
        },
      },
    ]);
    expect(p.queueRows()).toEqual(['1a.mp3📂↑↓✕', '2c.flac📂↑↓✕']);
  });

  it('switches the panel between the two lists without mixing them', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push({ type: 'queue', items: [{ id: 3, folder: 0, name: 'sendung.mp3' }] });
    expect(p.queueRows()).toEqual(['1Programm / sendung.mp3📂↑↓✕']);
    await cueOn(p);
    expect(p.queueShown()).toBe(false); // the on-air list is not the cue list
    p.byId('cue').click(); // back to on-air
    await p.flush();
    expect(p.queueRows()).toEqual(['1Programm / sendung.mp3📂↑↓✕']);
  });
});

describe('meters page — jump to where a file is playing from', () => {
  it('offers the folder of the on-air file, wherever you have browsed to', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(frame('deep.mp3', { folder: 1, name: 'Sub/deep.mp3' }));
    await p.selectFolder(0); // browse somewhere else entirely
    expect(p.fileRows()).toEqual(['sendung.mp3', 'jingle.wav']);
    p.byId('nowplaying').querySelector('.jump').click();
    await p.flush();
    // Landed in folder 1 / Sub, with the playing row flashed.
    expect(p.crumb()).toBe('Musik / Sub');
    expect(p.fileRows()).toEqual(['Sub/deep.mp3']);
    expect(p.focused()).toEqual(['Sub/deep.mp3']);
    expect(p.sent).toEqual([]); // pure navigation: the box is not touched
  });

  it('offers no jump when the playing file sits outside the browsable folders', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(frame('somewhere.mp3', null));
    expect(p.byId('nowplaying').innerHTML).not.toContain('jump');
  });

  it('re-targets the jump when another file with the same name takes over', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(frame('deep.mp3', { folder: 1, name: 'Sub/deep.mp3' }));
    p.push(frame('deep.mp3', { folder: 0, name: 'deep.mp3' }));
    p.byId('nowplaying').querySelector('.jump').click();
    await p.flush();
    expect(p.crumb()).toBe('Programm');
  });

  it('offers the folder of the pre-listened file', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.byId('cue').click();
    await p.flush();
    await p.selectFolder(1);
    p.byId('flist').children[0].click(); // pre-listen a.mp3
    await p.selectFolder(0);
    expect(p.byId('cuejump').style.display).toBe('');
    p.byId('cuejump').click();
    await p.flush();
    expect(p.crumb()).toBe('Musik');
    expect(p.focused()).toEqual(['a.mp3']);
    p.byId('cueStop').click();
    expect(p.byId('cuejump').style.display).toBe('none');
  });

  it('offers the folder of every queue row', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push({ type: 'queue', items: [{ id: 2, folder: 1, name: 'Sub/deep.mp3' }] });
    p.rowBtn(0, 'go').click();
    await p.flush();
    expect(p.crumb()).toBe('Musik / Sub');
    expect(p.focused()).toEqual(['Sub/deep.mp3']);
    expect(p.sent).toEqual([]);
  });
});

describe('meters page — Reinhören (listen in to what is on air)', () => {
  /** Let the stub <audio> report a duration, the way a browser does once it
   *  has parsed the file it is streaming from /preview. */
  const metadata = (audio: El, duration: number) => {
    audio.duration = duration;
    audio.fire('loadedmetadata');
  };

  it('opens the on-air file in Vorhören and seeks to its position', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(frame('deep.mp3', { folder: 1, name: 'Sub/deep.mp3' }, 92.5));
    p.byId('nowplaying').querySelector('.tune').click();
    await p.flush();
    const audio = p.byId('cueAudio');
    expect(audio.src).toBe('preview?folder=1&name=Sub/deep.mp3'.replace('/', '%2F'));
    expect(p.byId('cue').className).toContain('on'); // Vorhören switched itself on
    metadata(audio, 300);
    expect(audio.currentTime).toBeGreaterThanOrEqual(92.5);
    expect(audio.currentTime).toBeLessThan(94); // plus the frame's age, no more
    expect(p.byId('cname').textContent).toContain('on air');
    expect(p.sent).toEqual([]); // the box is never touched
  });

  it('parks what was being auditioned at the head of the queue', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.byId('cue').click();
    await p.flush();
    await p.selectFolder(1);
    p.byId('flist').children[2].querySelector('.addbtn').click(); // queue c.flac
    p.byId('flist').children[0].click(); // audition a.mp3
    p.push(frame('sendung.mp3', { folder: 0, name: 'sendung.mp3' }, 10));
    p.byId('nowplaying').querySelector('.tune').click();
    await p.flush();
    expect(p.byId('cueAudio').src).toBe('preview?folder=0&name=sendung.mp3');
    // a.mp3 went back on top, ahead of what was already queued.
    expect(p.queueRows()).toEqual(['1a.mp3📂↑↓✕', '2c.flac📂↑↓✕']);
    // ...and comes back when the on-air preview runs out.
    p.byId('cueAudio').fire('ended');
    expect(p.byId('cueAudio').src).toBe('preview?folder=1&name=a.mp3');
  });

  it('does not seek a file started the normal way', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(frame('a.mp3', { folder: 1, name: 'a.mp3' }, 60));
    p.byId('cue').click();
    await p.flush();
    await p.selectFolder(1);
    p.byId('flist').children[0].click(); // plain Vorhören of the same file
    metadata(p.byId('cueAudio'), 300);
    expect(p.byId('cueAudio').currentTime).toBe(0);
    expect(p.byId('cname').textContent).not.toContain('on air');
  });

  it('is offered only for a locatable file the browser can decode', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(frame('x.wma', { folder: 1, name: 'x.wma' }, 5));
    expect(p.byId('nowplaying').innerHTML).not.toContain('tune');
    p.push(frame('elsewhere.mp3', null, 5));
    expect(p.byId('nowplaying').innerHTML).not.toContain('tune');
    p.push(frame('a.mp3', { folder: 1, name: 'a.mp3' }, 5));
    expect(p.byId('nowplaying').innerHTML).toContain('tune');
  });
});

describe('meters page — help', () => {
  it('opens and closes the German manual from the header', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    // (The stub does not parse the markup's inline style, so "hidden" here is
    // simply "not opened yet".)
    expect(p.byId('help').style.display).not.toBe('');
    p.byId('helpBtn').click();
    expect(p.byId('help').style.display).toBe('');
    p.byId('hclose').click();
    expect(p.byId('help').style.display).toBe('none');
  });

  it('hides the mixer-only sections on a playout-only box', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(frame('a.mp3', { folder: 1, name: 'a.mp3' }, 1)); // channels: [] -> playout
    expect(p.bodyClasses()).toContain('playout');
  });
});
