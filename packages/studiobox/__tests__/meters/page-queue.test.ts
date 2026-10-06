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
  disabled = false;
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
  /** Dispatch an event to the listeners the page added; `extra` carries what
   *  the handler reads off the event (e.g. `key` for keydown/keyup). */
  fire(t: string, extra: Record<string, unknown> = {}): void {
    (this.ev[t] ?? []).forEach((fn) => fn({ target: this, ...extra }));
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
  /** ARIA state the page writes (aria-pressed, aria-valuenow, …). */
  attrs: Record<string, string> = {};
  setAttribute(a: string, v: unknown): void {
    this.attrs[a] = String(v);
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

/** Boot the page against the stub DOM. `listings` maps "folder/path" to rows;
 *  `search` is the page's query string (the role token, `?k=…`). */
function boot(
  listings: Record<string, FileRow[]>,
  folders = FOLDERS,
  search = '',
  connectBody: unknown = { enabled: true, pinned: true, links: [] }
) {
  const els: Record<string, El> = {};
  const byId = (id: string) => (els[id] ??= new El());
  const sent: Array<{ type: string; value?: unknown }> = [];
  const fetched: string[] = [];
  // The page's timers (hold-to-stop, confirm windows, reconnect) and its clock
  // are virtual: nothing fires and no time passes until a test calls `tick`.
  let clock = 0;
  let timerSeq = 0;
  let timers: Array<{ id: number; at: number; fn: () => void }> = [];
  const setTimeoutStub = (fn: () => void, ms = 0) => {
    timers.push({ id: ++timerSeq, at: clock + ms, fn });
    return timerSeq;
  };
  const clearTimeoutStub = (id: number) => {
    timers = timers.filter((t) => t.id !== id);
  };
  const tick = (ms: number) => {
    clock += ms;
    const due = timers.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at);
    timers = timers.filter((t) => t.at > clock);
    due.forEach((t) => t.fn());
  };
  const bootedAt = Date.now();
  const pageDate = { now: () => bootedAt + clock };
  let socket: {
    onopen?: () => void;
    onmessage?: (e: { data: string }) => void;
    onclose?: () => void;
  } = {};

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
    fetched.push(url);
    const json = () => {
      if (url.startsWith('folders')) return Promise.resolve({ folders });
      if (url.startsWith('files')) {
        const q = url.split('?')[1];
        const folder = /folder=(\d+)/.exec(q)?.[1] ?? '0';
        const sub = decodeURIComponent(/path=([^&]*)/.exec(q)?.[1] ?? '');
        return Promise.resolve({ files: listings[`${folder}/${sub}`] ?? [], now: Date.now() });
      }
      if (url.startsWith('connect')) return Promise.resolve(connectBody);
      return Promise.resolve({ scheduled: [], now: Date.now() });
    };
    return Promise.resolve({ ok: true, json });
  };

  const run = new Function(
    'document',
    'window',
    'location',
    'WebSocket',
    'fetch',
    'setInterval',
    'setTimeout',
    'clearTimeout',
    'Date',
    pageScript()
  );
  run(
    document,
    {},
    { host: 'box:4445', search },
    WS,
    fetchStub,
    () => 0,
    setTimeoutStub,
    clearTimeoutStub,
    pageDate
  );

  const flush = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  };
  return {
    els,
    byId,
    sent,
    fetched,
    flush,
    /** Let `ms` of the page's time pass, firing the timers that fall due. */
    tick,
    /** Press a button and keep it down for `ms` before letting go — the
     *  events a finger or a mouse produces, in their order. */
    press: (id: string, ms: number) => {
      const b = byId(id);
      b.fire('pointerdown');
      tick(ms);
      b.fire('pointerup');
      b.click();
    },
    /** Hold a key down on a button for `ms`. Enter clicks on keydown, Space
     *  on keyup — as browsers do. */
    pressKey: (id: string, key: string, ms: number) => {
      const b = byId(id);
      b.fire('keydown', { key });
      if (key === 'Enter') b.click();
      tick(ms);
      b.fire('keyup', { key });
      if (key === ' ') b.click();
    },
    /** Push a server frame (meter snapshot or queue list) to the page. */
    push: (msg: unknown) => socket.onmessage?.({ data: JSON.stringify(msg) }),
    /** The WebSocket coming up / going away (the reconnect timer only fires
     *  on `tick`, so a drop stays dropped). */
    open: () => socket.onopen?.(),
    drop: () => socket.onclose?.(),
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

/** A mixer-mode frame: two mics (one muted) and a music channel. */
const liveFrame = (over: Record<string, unknown> = {}) => ({
  channels: [
    {
      label: 'Host',
      role: 'mic',
      outDb: -18.34,
      gateOpen: 1,
      compGrDb: 3.2,
      levelerDb: 2.5,
      automixGainDb: -4.1,
      muted: false,
    },
    {
      label: 'Gast',
      role: 'mic',
      outDb: -58,
      gateOpen: 0,
      compGrDb: 0,
      levelerDb: 0,
      automixGainDb: -30,
      muted: true,
    },
    {
      label: 'Player',
      role: 'music',
      outDb: -12,
      gateOpen: 1,
      compGrDb: 0,
      levelerDb: -3.4,
      automixGainDb: 0,
      muted: false,
    },
  ],
  micsMuted: false,
  recording: false,
  streaming: true,
  monitor: null,
  filePlaying: null,
  filePlayingAt: null,
  filePosition: null,
  fileDuration: null,
  shortTermLufs: -16.3,
  momentaryLufs: -15.04,
  outPeakDb: -4,
  limiterGrDb: 1.2,
  duckDepthDb: -9,
  serverNowMs: Date.now(),
  ...over,
});

describe('meters page — states in words, not only colour', () => {
  it('labels the output toggles with their state and mirrors it in aria-pressed', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(liveFrame());
    expect(p.byId('rec').textContent).toBe('Aufnahme aus');
    expect(p.byId('rec').attrs['aria-pressed']).toBe('false');
    expect(p.byId('ship').textContent).toBe('Stream läuft');
    expect(p.byId('ship').attrs['aria-pressed']).toBe('true');
    expect(p.byId('mon').style.display).toBe('none'); // not configured on this box
    p.byId('rec').click();
    expect(p.sent).toEqual([{ type: 'recording', value: true }]);
    expect(p.byId('rec').textContent).toBe('● Aufnahme läuft');
    expect(p.byId('rec').attrs['aria-pressed']).toBe('true');
  });

  it('names each channel state and the global mic switch', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(liveFrame());
    const state = () => p.byId('rows').children.map((r) => r.querySelector('.chstate').textContent);
    const btn = (i: number) => p.byId('rows').children[i].querySelector('.mtbtn');
    expect(state()).toEqual(['OFFEN', 'STUMM', 'AN']);
    expect(btn(0).textContent).toBe('Offen');
    expect(btn(1).textContent).toBe('Stumm');
    expect(btn(1).attrs['aria-pressed']).toBe('true');
    expect(p.byId('mute').textContent).toBe('● Mikros offen');
    // All mics closed by the host: an open mic is paused, a muted one stays muted.
    p.push(liveFrame({ micsMuted: true }));
    expect(state()).toEqual(['PAUSE', 'STUMM', 'AN']);
    expect(p.byId('mute').textContent).toBe('Mikros zu');
    expect(p.byId('mute').attrs['aria-pressed']).toBe('false');
  });

  it('writes levels the German way and gain reduction as a cut', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(liveFrame());
    const host = p.byId('rows').children[0];
    expect(host.querySelector('.s-lvl .val').textContent).toBe('−18 dB');
    expect(host.querySelector('.s-comp .val').textContent).toBe('−3 dB');
    expect(host.querySelector('.s-lev .val').textContent).toBe('+3 dB');
    expect(host.querySelector('.s-lvl .meter').attrs['aria-valuetext']).toBe('−18 dB, ok');
    // The large short-term loudness keeps its decimal; the rest is whole dB.
    expect(p.byId('st').textContent).toBe('−16,3');
    expect(p.byId('mom').textContent).toBe('−15');
    expect(p.byId('lgr').textContent).toBe('−1');
  });

  it('changes the numbers once a second, showing the highest level in between', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    const hostCh = (outDb: number, compGrDb = 3.2) => ({
      ...liveFrame().channels[0],
      outDb,
      compGrDb,
    });
    const val = (s: string) => p.byId('rows').children[0].querySelector(s).textContent;
    p.push(liveFrame({ channels: [hostCh(-30)], shortTermLufs: -20, outPeakDb: -10 }));
    expect(val('.s-lvl .val')).toBe('−30 dB');
    p.tick(300);
    p.push(liveFrame({ channels: [hostCh(-12, 6)], shortTermLufs: -18, outPeakDb: -2 }));
    p.tick(300);
    p.push(liveFrame({ channels: [hostCh(-25)], shortTermLufs: -19, outPeakDb: -9 }));
    // Within the second nothing moves.
    expect(val('.s-lvl .val')).toBe('−30 dB');
    expect(p.byId('st').textContent).toBe('−20,0');
    p.tick(400);
    p.push(liveFrame({ channels: [hostCh(-28)], shortTermLufs: -19.4, outPeakDb: -8 }));
    // The reading is the loudest moment of the second, not the last frame;
    // loudness is already a window and reads as it is now.
    expect(val('.s-lvl .val')).toBe('−12 dB');
    expect(val('.s-comp .val')).toBe('−6 dB');
    expect(p.byId('pk').textContent).toBe('−2');
    expect(p.byId('st').textContent).toBe('−19,4');
    // The next second starts afresh.
    p.tick(1000);
    p.push(liveFrame({ channels: [hostCh(-28)], outPeakDb: -8 }));
    expect(val('.s-lvl .val')).toBe('−28 dB');
    expect(p.byId('pk').textContent).toBe('−8');
  });

  it('lets the level bar rise at once and fall back gently', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    const cover = () =>
      parseFloat(p.byId('rows').children[0].querySelector('.s-lvl .cover').style.width);
    const hostAt = (outDb: number) =>
      liveFrame({ channels: [{ ...liveFrame().channels[0], outDb }] });
    p.push(hostAt(-6));
    expect(cover()).toBeCloseTo(10); // −6 dB of −60…0
    p.tick(100);
    p.push(hostAt(-60));
    // 100 ms at 20 dB/s: −8 dB, not the silence of this frame.
    expect(cover()).toBeCloseTo((8 / 60) * 100);
    p.tick(100);
    p.push(hostAt(-3));
    expect(cover()).toBeCloseTo(5);
  });

  it('shows a dash, not −159 LUFS, while the programme is digital silence', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(liveFrame({ shortTermLufs: -159.2, momentaryLufs: -159.4, outPeakDb: -157.9 }));
    expect(p.byId('st').textContent).toBe('–');
    expect(p.byId('mom').textContent).toBe('–');
    expect(p.byId('pk').textContent).toBe('–');
    p.tick(1000);
    p.push(liveFrame({ shortTermLufs: -42.5, momentaryLufs: -40, outPeakDb: -30 }));
    expect(p.byId('st').textContent).toBe('−42,5');
  });

  it('spells out the connection state', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.open();
    expect(p.byId('connText').textContent).toBe('Verbunden');
    p.drop();
    expect(p.byId('connText').textContent).toContain('Verbindung weg');
    expect(p.byId('conn').className).toContain('lost');
  });
});

describe('meters page — footer transport', () => {
  it('keeps Stop in place but disabled while nothing plays', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    expect(p.byId('stop').disabled).toBe(true);
    p.push(frame(null, null));
    expect(p.byId('stop').disabled).toBe(true);
    expect(p.byId('nowplaying').innerHTML).toBe('Keine Datei läuft');
    expect(p.byId('rem').textContent).toBe('–:––');
    p.push(frame('a.mp3', { folder: 1, name: 'a.mp3' }, 5));
    expect(p.byId('stop').disabled).toBe(false);
    p.press('stop', 800);
    expect(p.sent).toEqual([{ type: 'stopFile' }]);
  });

  it('shows the remaining time large, elapsed beside it, and the progress', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push({ ...frame('a.mp3', { folder: 1, name: 'a.mp3' }, 60), fileDuration: 240 });
    expect(p.byId('remlbl').textContent).toBe('noch');
    expect(p.byId('rem').textContent).toBe('3:00');
    expect(p.byId('ftime').textContent).toBe('1:00 von 4:00');
    expect(p.byId('pbar').style.width).toBe('25%');
    // Length unknown (e.g. a stream-like source): count up instead.
    p.push(frame('a.mp3', { folder: 1, name: 'a.mp3' }, 75));
    expect(p.byId('remlbl').textContent).toBe('läuft seit');
    expect(p.byId('rem').textContent).toBe('1:15');
  });

  it('cuts a long title in its middle so prefix and ending both survive', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    const name = '04_Musik_Titel_Extended_Club_Mix_2026_Remaster.mp3';
    p.push(frame(name, null));
    const html = p.byId('nowplaying').innerHTML;
    expect(html).toContain('<span class="nh">04_Musik_Titel_Extended_Club_Mix_202</span>');
    expect(html).toContain('<span class="nt">6_Remaster.mp3</span>');
  });
});

describe('meters page — ending output takes a hold, never a stray tap', () => {
  const playing = frame('a.mp3', { folder: 1, name: 'a.mp3' }, 5);

  it('a tap on Stopp does not stop; it asks', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(playing);
    p.press('stop', 120);
    expect(p.sent).toEqual([]);
    expect(p.byId('stop').textContent).toBe('Stoppen? Nochmal tippen');
    expect(p.byId('stop').has('armed')).toBe(true);
    expect(p.byId('say').textContent).toContain('Gedrückt halten');
    // Left alone, the question goes away again.
    p.tick(4000);
    expect(p.byId('stop').textContent).toBe('■ Stopp');
    expect(p.byId('stop').has('armed')).toBe(false);
    expect(p.sent).toEqual([]);
  });

  it('holding for 0.8 s stops, with the fill showing while it runs', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(playing);
    const stop = p.byId('stop');
    stop.fire('pointerdown');
    expect(stop.has('holding')).toBe(true);
    p.tick(799);
    expect(p.sent).toEqual([]);
    p.tick(1);
    expect(p.sent).toEqual([{ type: 'stopFile' }]);
    expect(stop.has('holding')).toBe(false);
    // Letting go afterwards is not a second command.
    stop.fire('pointerup');
    stop.click();
    expect(p.sent).toEqual([{ type: 'stopFile' }]);
  });

  it('letting go early, or sliding off the button, cancels', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(playing);
    const stop = p.byId('stop');
    stop.fire('pointerdown');
    p.tick(500);
    stop.fire('pointerleave');
    expect(stop.has('holding')).toBe(false);
    p.tick(1000);
    expect(p.sent).toEqual([]);
  });

  it('a second tap confirms — but a bounce does not', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(playing);
    p.press('stop', 80);
    p.tick(100);
    p.press('stop', 80); // 180 ms after the first: a bouncing finger
    expect(p.sent).toEqual([]);
    p.tick(400);
    p.press('stop', 80);
    expect(p.sent).toEqual([{ type: 'stopFile' }]);
    expect(p.byId('stop').has('armed')).toBe(false);
  });

  it('a bare click (a screen reader activating the button) gets the same two steps', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(playing);
    p.byId('stop').click();
    expect(p.sent).toEqual([]);
    p.tick(1000);
    p.byId('stop').click();
    expect(p.sent).toEqual([{ type: 'stopFile' }]);
  });

  it('works from the keyboard: hold Enter or Space', async () => {
    for (const key of ['Enter', ' ']) {
      const p = boot(LISTINGS);
      await p.flush();
      p.push(playing);
      p.pressKey('stop', key, 800);
      expect(p.sent).toEqual([{ type: 'stopFile' }]);
    }
  });

  it('key repeat while holding Enter neither confirms early nor acts twice', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(liveFrame({ recording: true }));
    const rec = p.byId('rec');
    rec.fire('keydown', { key: 'Enter' });
    rec.click();
    for (let i = 0; i < 40; i++) {
      p.tick(30);
      rec.fire('keydown', { key: 'Enter', repeat: true });
      rec.click();
    }
    rec.fire('keyup', { key: 'Enter' });
    // One stop — and above all no "start" on the repeats that followed it.
    expect(p.sent).toEqual([{ type: 'recording', value: false }]);
  });

  it('a short Enter asks, like a short tap', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(playing);
    p.pressKey('stop', 'Enter', 100);
    expect(p.sent).toEqual([]);
    expect(p.byId('stop').has('armed')).toBe(true);
  });

  it('starting a recording is one tap, ending it needs the hold', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(liveFrame());
    p.press('rec', 50);
    expect(p.sent).toEqual([{ type: 'recording', value: true }]);
    p.push(liveFrame({ recording: true }));
    p.press('rec', 50);
    expect(p.sent).toHaveLength(1);
    expect(p.byId('rec').textContent).toBe('Aufnahme beenden? Nochmal tippen');
    p.tick(4000); // the question lapses, the label is the state again
    expect(p.byId('rec').textContent).toBe('● Aufnahme läuft');
    p.press('rec', 800);
    expect(p.sent).toEqual([
      { type: 'recording', value: true },
      { type: 'recording', value: false },
    ]);
  });

  it('reads the seconds the box still writes after a stop as "endet", not as a failed stop', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(liveFrame({ recording: true }));
    p.press('rec', 800);
    expect(p.byId('rec').textContent).toBe('Aufnahme endet …');
    // The look-ahead plays out into the file: the box says "recording" a little longer.
    p.tick(1000);
    p.push(liveFrame({ recording: true }));
    expect(p.byId('rec').textContent).toBe('Aufnahme endet …');
    p.tick(2000);
    p.push(liveFrame({ recording: false }));
    expect(p.byId('rec').textContent).toBe('Aufnahme aus');
    expect(p.sent).toEqual([{ type: 'recording', value: false }]);
  });

  it('shows a recording that did not stop as running again', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(liveFrame({ recording: true }));
    p.press('rec', 800);
    p.tick(6000);
    p.push(liveFrame({ recording: true }));
    expect(p.byId('rec').textContent).toBe('● Aufnahme läuft');
  });

  it('guards the stream the same way', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(liveFrame());
    p.press('ship', 50);
    expect(p.sent).toEqual([]);
    p.press('ship', 800);
    expect(p.sent).toEqual([{ type: 'streaming', value: false }]);
  });

  it('guards the *start* of the test tone, which replaces the programme', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(liveFrame({ monitor: true, testTone: false }));
    p.press('tone', 50);
    expect(p.sent).toEqual([]);
    p.press('tone', 800);
    expect(p.sent).toEqual([{ type: 'testTone', value: true }]);
    p.push(liveFrame({ monitor: true, testTone: true }));
    expect(p.byId('toneChip').style.display).toBe('');
    p.press('tone', 50); // getting the programme back is one tap
    expect(p.sent[1]).toEqual({ type: 'testTone', value: false });
  });
});

/** Air-delay state as the live pipeline reports it. */
const air = (state: string, over: Record<string, unknown> = {}) => ({
  targetMs: 10000,
  delayMs: 10000,
  nowMs: Date.now() + 10000,
  state,
  drainEndsMs: null,
  underruns: 0,
  resyncs: 0,
  ...over,
});

describe('meters page — AUF SENDUNG', () => {
  const chip = (p: ReturnType<typeof boot>) =>
    p.byId('air').style.display === 'none'
      ? null
      : p.byId('airText').textContent + (p.byId('air').has('on') ? ' [rot]' : '');

  it('says in words whether programme is leaving the box', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(liveFrame({ air: air('filling'), onAir: false }));
    expect(chip(p)).toBe('Puffer füllt');
    p.push(liveFrame({ air: air('live'), onAir: true }));
    expect(chip(p)).toBe('Auf Sendung [rot]');
    // Live, but no output running: nothing reaches anybody.
    p.push(liveFrame({ air: air('live'), onAir: false }));
    expect(chip(p)).toBe('Nicht auf Sendung');
    p.push(liveFrame({ air: air('draining', { drainEndsMs: Date.now() + 7000 }), onAir: true }));
    expect(chip(p)).toBe('Auf Sendung [rot]'); // what was said is still going out
    p.push(liveFrame({ air: air('ended'), onAir: false }));
    expect(chip(p)).toBe('Sendung beendet');
  });

  it('shows no chip where the box cannot know (playout mode)', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(frame('a.mp3', { folder: 1, name: 'a.mp3' }, 1));
    expect(chip(p)).toBeNull();
  });

  it('"Sendung beenden" takes a hold; while the buffer drains one tap takes it back', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(liveFrame({ air: air('live'), onAir: true }));
    expect(p.byId('endShow').textContent).toBe('Sendung beenden');
    p.press('endShow', 50);
    expect(p.sent).toEqual([]);
    p.press('endShow', 800);
    expect(p.sent).toEqual([{ type: 'endShow', value: true }]);
    p.push(liveFrame({ air: air('draining', { drainEndsMs: Date.now() + 7000 }), onAir: true }));
    expect(p.byId('endShow').textContent).toBe('Beenden abbrechen');
    p.press('endShow', 50);
    expect(p.sent[1]).toEqual({ type: 'endShow', value: false });
  });
});

describe('meters page — Sendezeit', () => {
  it('marks a timestamped file as upcoming against the on-air clock, not the wall clock', async () => {
    // Stamped 5 s from now on the wall clock. With 10 s of air delay the
    // Sendezeit clock is already past it: it has started.
    const soon = Date.now() + 5000;
    const p = boot({ '0/': [{ name: 'jingle-x.mp3', playAtMs: soon }] });
    await p.flush();
    expect(p.byId('flist').children[0].has('sched')).toBe(true);
    p.push(liveFrame({ air: air('live'), onAir: true }));
    p.byId('folderList').children[0].click(); // reload the listing
    await p.flush();
    expect(p.byId('flist').children[0].has('sched')).toBe(false);
  });
});

describe('meters page — music return level', () => {
  const lvl = (p: ReturnType<typeof boot>) =>
    p.byId('retLvl') as unknown as { value: string; oninput: () => void; onchange: () => void };

  it('is absent without a music return', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(liveFrame({ returnGainDb: null }));
    expect(p.byId('retLvlBox').style.display).toBe('none');
    p.push(liveFrame({ returnGainDb: -12 }));
    expect(p.byId('retLvlBox').style.display).toBe('');
    expect(lvl(p).value).toBe('-12');
    expect(p.byId('retLvlVal').textContent).toBe('−12 dB');
  });

  it('sends the level and does not fight the finger with stale echoes', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(liveFrame({ returnGainDb: -12 }));
    lvl(p).value = '-20';
    lvl(p).oninput();
    expect(p.sent).toEqual([{ type: 'returnGain', value: -20 }]);
    p.push(liveFrame({ returnGainDb: -12 }));
    expect(lvl(p).value).toBe('-20');
    p.tick(50);
    lvl(p).value = '-22';
    lvl(p).oninput();
    lvl(p).onchange();
    expect(p.sent[1]).toEqual({ type: 'returnGain', value: -22 });
    p.tick(2000);
    p.push(liveFrame({ returnGainDb: -22 }));
    expect(lvl(p).value).toBe('-22');
    expect(p.byId('retLvlVal').textContent).toBe('−22 dB');
  });
});

describe('meters page — music level on air', () => {
  const lvl = (p: ReturnType<typeof boot>) =>
    p.byId('musLvl') as unknown as { value: string; oninput: () => void; onchange: () => void };

  it('shows the level, sends a change and resets to 0 dB', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(liveFrame()); // a box that does not report it (playout)
    expect(p.byId('musLvlBox').style.display).toBe('none');
    p.push(liveFrame({ musicGainDb: -3 }));
    expect(p.byId('musLvlBox').style.display).toBe('');
    expect(lvl(p).value).toBe('-3');
    expect(p.byId('musLvlVal').textContent).toBe('−3 dB');
    expect(p.byId('musLvlReset').style.display).toBe('');
    lvl(p).value = '2';
    lvl(p).oninput();
    expect(p.sent).toEqual([{ type: 'musicGain', value: 2 }]);
    expect(p.byId('musLvlVal').textContent).toBe('+2 dB');
    p.push(liveFrame({ musicGainDb: -3 })); // a stale echo does not pull the thumb back
    expect(lvl(p).value).toBe('2');
    p.tick(200);
    (p.byId('musLvlReset') as unknown as { onclick: () => void }).onclick();
    expect(p.sent[1]).toEqual({ type: 'musicGain', value: 0 });
    expect(p.byId('musLvlReset').style.display).toBe('none');
  });
});

describe('meters page — Studio-Stream', () => {
  it('says how many pull it, starts with a tap and ends with the hold', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(liveFrame({ serve: { on: true, clients: 0 } }));
    expect(p.byId('srv').style.display).toBe('');
    expect(p.byId('srv').textContent).toBe('Studio-Stream läuft · 0 Geräte');
    p.push(liveFrame({ serve: { on: true, clients: 1 } }));
    expect(p.byId('srv').textContent).toBe('Studio-Stream läuft · 1 Gerät');
    expect(p.byId('srv').attrs['aria-pressed']).toBe('true');
    p.press('srv', 50); // a tap only asks
    expect(p.sent).toEqual([]);
    p.tick(4000);
    p.press('srv', 800);
    expect(p.sent).toEqual([{ type: 'serve', value: false }]);
    expect(p.byId('srv').textContent).toBe('Studio-Stream aus');
    p.push(liveFrame({ serve: { on: false, clients: 0 } }));
    p.press('srv', 50); // starting is one tap
    expect(p.sent[1]).toEqual({ type: 'serve', value: true });
    p.push(liveFrame({ serve: null })); // a box without it
    expect(p.byId('srv').style.display).toBe('none');
  });
});

describe('meters page — Abhören', () => {
  const air = { targetMs: 10000, delayMs: 10020, nowMs: Date.now(), state: 'live' };
  const frame = () => liveFrame({ air, lookaheadMs: 6200 });

  it("is the technician's, in live mode only", async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(liveFrame());
    expect(p.byId('abhBox').style.display).toBe('none'); // no air: playout box
    p.push(frame());
    expect(p.byId('abhBox').style.display).toBe('');
    p.push({ type: 'hello', role: 'host' });
    p.push(frame());
    expect(p.byId('abhBox').style.display).toBe('none');
  });

  it('starts one stream, switches its source on the box, and stops it', async () => {
    const p = boot(LISTINGS, FOLDERS, '?k=T');
    await p.flush();
    p.push(frame());
    const audio = p.byId('abhAudio');
    expect(p.byId('abhMic').children.map((o) => o.textContent)).toEqual([
      'alle Mikros',
      'Host',
      'Gast',
    ]);
    p.byId('abhPlay').click();
    const url = new URL(String(audio.src), 'http://box/');
    expect(url.pathname).toBe('/listen');
    expect(url.searchParams.get('src')).toBe('rec');
    expect(url.searchParams.get('k')).toBe('T');
    const id = url.searchParams.get('id');
    expect(id).toMatch(/^[\w-]{4,64}$/);
    expect(p.byId('abhPlay').attrs['aria-pressed']).toBe('true');
    p.push(frame());
    expect(p.byId('abhState').textContent).toBe('Etwa 6 s hinter dem Raum');
    // A/B: the same stream, the box switches.
    p.byId('abhRaw').click();
    expect(p.sent).toEqual([{ type: 'listen', value: { id, src: 'raw' } }]);
    expect(p.byId('abhMic').style.display).toBe('');
    const mic = p.byId('abhMic') as unknown as { value: string; onchange: () => void };
    mic.value = 'mic:Gast';
    mic.onchange();
    expect(p.sent[1]).toEqual({ type: 'listen', value: { id, src: 'mic:Gast' } });
    p.byId('abhAir').click();
    expect(p.sent[2]).toEqual({ type: 'listen', value: { id, src: 'air' } });
    expect(p.byId('abhMic').style.display).toBe('none');
    p.push(frame());
    expect(p.byId('abhState').textContent).toBe('Etwa 10 s hinter dem Raum');
    expect(audio.src).toBe(url.href.replace('http://box/', '')); // never reloaded
    p.byId('abhPlay').click();
    expect(audio.src).toBeUndefined();
    expect(audio.paused).toBe(true);
    expect(p.byId('abhPlay').textContent).toBe('▶ Abhören');
    // Stopped, a pick is only remembered.
    p.byId('abhRec').click();
    expect(p.sent).toHaveLength(3);
  });
});

describe('meters page — host priority', () => {
  const prio = (p: ReturnType<typeof boot>) =>
    p.byId('prio') as unknown as { value: string; oninput: () => void; onchange: () => void };

  it('is absent unless the box has a priority mic', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(liveFrame());
    expect(p.byId('prioBox').style.display).toBe('none');
    p.push(liveFrame({ priority: { label: 'Host', depthDb: -8, active: false } }));
    expect(p.byId('prioBox').style.display).toBe('');
    expect(prio(p).value).toBe('8');
    expect(p.byId('prioVal').textContent).toBe('−8 dB');
    expect(p.byId('prioWho').textContent).toBe('Host');
  });

  it('sends the depth as a cut and does not fight the finger with stale echoes', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(liveFrame({ priority: { label: 'Host', depthDb: -8, active: false } }));
    prio(p).value = '12';
    prio(p).oninput();
    expect(p.sent).toEqual([{ type: 'priorityDepth', value: -12 }]);
    expect(p.byId('prioVal').textContent).toBe('−12 dB');
    // A frame from before the change arrives: the slider stays where it was put.
    p.push(liveFrame({ priority: { label: 'Host', depthDb: -8, active: false } }));
    expect(prio(p).value).toBe('12');
    // Dragging on: throttled, but letting go always sends the final value.
    p.tick(50);
    prio(p).value = '13';
    prio(p).oninput();
    prio(p).value = '14';
    prio(p).oninput();
    expect(p.sent).toHaveLength(1);
    prio(p).onchange();
    expect(p.sent[1]).toEqual({ type: 'priorityDepth', value: -14 });
    // Once the finger is off, the box's value is the truth again.
    p.tick(2000);
    p.push(liveFrame({ priority: { label: 'Host', depthDb: -14, active: true } }));
    expect(prio(p).value).toBe('14');
    expect(p.byId('prioAct').style.display).toBe('');
  });

  it('names a mic that is being held back LEISER', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    const f = liveFrame();
    (f.channels[0] as Record<string, unknown>).priorityDb = -6.5;
    p.push(f);
    const host = p.byId('rows').children[0].querySelector('.chstate');
    expect(host.textContent).toBe('LEISER');
    expect(host.className).toContain('duck');
    // Closed mics and a muted mic say so first.
    p.push({ ...f, micsMuted: true });
    expect(host.textContent).toBe('PAUSE');
  });
});

describe('meters page — trim', () => {
  it('shows each mic trim and steps it from a stepper, building on what was just sent', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    const f = liveFrame();
    (f.channels[0] as Record<string, unknown>).trimDb = 12;
    p.push(f);
    const btn = p.byId('rows').children[0].querySelector('.trimbtn');
    expect(btn.textContent).toBe('+12,0');
    expect(p.byId('trimEd').style.display).not.toBe(''); // (inline style: see the help test)
    btn.click();
    expect(p.byId('trimEd').style.display).toBe('');
    expect(p.byId('trimWho').textContent).toBe('Host');
    p.byId('trimUp').click();
    p.byId('trimUp').click(); // faster than the snapshot comes back
    p.byId('trimDn3').click();
    expect(p.sent).toEqual([
      { type: 'trim', value: { label: 'Host', trimDb: 13 } },
      { type: 'trim', value: { label: 'Host', trimDb: 14 } },
      { type: 'trim', value: { label: 'Host', trimDb: 11 } },
    ]);
    (f.channels[0] as Record<string, unknown>).trimDb = 11;
    p.push(f);
    expect(p.byId('trimVal').textContent).toBe('+11,0 dB');
    p.byId('trimClose').click();
    expect(p.byId('trimEd').style.display).toBe('none');
  });
});

/** The setup assistant's state as the snapshot carries it. */
const setup = (phase: string, over: Record<string, unknown> = {}) => ({
  phase,
  current: null,
  sentence: 'Sechs fleißige Gäste testen das Studio.',
  silence: 0,
  mics: [],
  results: null,
  automixFloorDb: null,
  ...over,
});
const settings = (trimDb: number) => ({
  trimDb,
  hpfHz: 80,
  gateThresholdDb: -45,
  compThresholdDb: -18,
  deessThresholdDb: -24,
  seedDb: 0,
  zoneCenterDb: -20,
});

describe('meters page — Einmessen', () => {
  const tiles = (p: ReturnType<typeof boot>) =>
    p.byId('suSteps').children.map((li) => li.children.map((c) => c.textContent).join(' | '));
  const shown = (p: ReturnType<typeof boot>, ...ids: string[]) =>
    ids.filter((id) => p.byId(id).style.display !== 'none');
  const BUTTONS = ['suStart', 'suCancel', 'suFinish', 'suApply', 'suDiscard'];

  it('offers the start while idle and says whether a result is in force', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(liveFrame({ setup: setup('idle'), setupApplied: false }));
    expect(shown(p, ...BUTTONS)).toEqual(['suStart']);
    expect(p.byId('suInfo').textContent).toBe('Noch nicht eingemessen');
    expect(p.byId('suIntro').style.display).toBe(''); // what it does, until it has been done
    p.byId('suStart').click();
    expect(p.sent).toEqual([{ type: 'setupStart' }]);
    p.push(liveFrame({ setup: setup('idle'), setupApplied: true }));
    expect(p.byId('suInfo').textContent).toBe('Eingemessen ✓');
    expect(p.byId('suIntro').style.display).toBe('none');
  });

  it('walks the steps in words: silence, then who is up, with what to read', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    const mics = [
      { label: 'Gast 1', channel: 1, progress: 0, done: false },
      { label: 'Host', channel: 3, progress: 0, done: false },
    ];
    p.push(liveFrame({ setup: setup('silence', { silence: 0.4, mics }) }));
    expect(p.byId('setupChip').style.display).toBe('');
    expect(shown(p, ...BUTTONS)).toEqual(['suCancel']);
    expect(tiles(p)).toEqual([
      '1 · JETZT | Stille | Raumgeräusch · 40 %',
      '2 · OFFEN | Gast 1 | Kanal 1 · 0 %',
      '3 · OFFEN | Host | Kanal 3 · 0 %',
      '4 · OFFEN | Ergebnis | vorher / nachher',
    ]);
    expect(p.byId('suNow').textContent).toContain('Stille');

    const tile = p.byId('suSteps').children[2];
    mics[0] = { ...mics[0], progress: 1, done: true };
    mics[1] = { ...mics[1], progress: 0.5 };
    p.push(liveFrame({ setup: setup('speakers', { silence: 1, current: 'Host', mics }) }));
    expect(tiles(p)).toEqual([
      '1 · ERLEDIGT | Stille | gemessen',
      '2 · ERLEDIGT | Gast 1 | Kanal 1 · 100 %',
      '3 · JETZT | Host | Kanal 3 · 50 %',
      '4 · OFFEN | Ergebnis | vorher / nachher',
    ]);
    // Updated in place: the tiles of a run are not rebuilt under a finger.
    expect(p.byId('suSteps').children[2]).toBe(tile);
    expect(p.byId('suNow').textContent).toBe('Jetzt: Host — bitte diesen Satz vorlesen:');
    expect(p.byId('suSent').textContent).toBe('Sechs fleißige Gäste testen das Studio.');
    expect(shown(p, ...BUTTONS)).toEqual(['suCancel', 'suFinish']);
    p.byId('suFinish').click();
    p.byId('suCancel').click();
    expect(p.sent).toEqual([{ type: 'setupFinish' }, { type: 'setupCancel' }]);
  });

  it('shows before and after per mic, the knob advice, and applies only on "Übernehmen"', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    const results = [
      {
        label: 'Gast 1',
        channel: 1,
        verdict: 'gut',
        advice: null,
        notes: [],
        speechDb: -24.1,
        snrDb: 52,
        before: settings(0),
        after: settings(4.1),
      },
      {
        label: 'Host',
        channel: 3,
        verdict: 'zu leise',
        advice: 'Kanal 3 (Host): Gain um etwa +18 dB aufdrehen.',
        notes: [],
        speechDb: -48,
        snrDb: 30,
        before: settings(0),
        after: settings(28),
      },
      {
        label: 'Technik',
        channel: 4,
        verdict: 'kein Signal',
        advice: 'Kanal 4 (Technik): kein Sprachsignal – Mikrofon, Kabel und Gain prüfen.',
        notes: [],
        speechDb: null,
        snrDb: null,
        before: settings(0),
        after: null,
      },
    ];
    p.push(liveFrame({ setup: setup('result', { results, automixFloorDb: -18 }) }));
    expect(shown(p, ...BUTTONS)).toEqual(['suApply', 'suDiscard']);
    expect(p.byId('setupChip').style.display).toBe('none');
    expect(p.byId('suInfo').textContent).toBe(
      'Ergebnis — noch nicht übernommen · Automix-Boden −18 dB'
    );
    const cards = p.byId('suRows').children;
    const text = (i: number) =>
      cards[i].innerHTML
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    // Only what changes gets an arrow; the high-pass stays at 80 Hz and says just that.
    expect(text(0)).toBe(
      'Gast 1 Kanal 1 · Sprache −24,1 dB · Abstand 52 dB gut Trim 0,0 → +4,1 dB Hochpass 80 Hz ' +
        'Gate −45,0 dB Comp −18,0 dB De-Esser −24,0 dB Leveler-Start 0,0 dB'
    );
    expect(text(1)).toContain('zu leise');
    expect(text(1)).toContain('Trim 0,0 → +28,0 dB');
    // Nothing usable was measured: the settings stay as they are.
    expect(text(2)).toContain('keine Sprache kein Signal Trim 0,0 dB Hochpass 80 Hz');
    expect(text(2)).not.toContain('→');
    // What studiobox cannot set — the analog gain — with a way to re-check it,
    // on the mics that need it and only there.
    expect(cards.map((c) => c.children.length)).toEqual([0, 1, 1]);
    const advice = cards[1].children[0];
    expect(advice.innerHTML).toContain('Kanal 3 (Host): Gain um etwa +18 dB aufdrehen.');
    advice.children[0].click();
    expect(p.sent).toEqual([{ type: 'setupStart', value: { only: ['Host'] } }]);
    p.byId('suApply').click();
    p.byId('suDiscard').click();
    expect(p.sent.slice(1)).toEqual([{ type: 'setupApply' }, { type: 'setupDiscard' }]);
  });

  it('has no assistant on a playout-only box', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(frame(null, null));
    expect(p.byId('setupBox').style.display).toBe('none');
  });
});

describe('meters page — bed and queue mode', () => {
  it('shows the bed switch only where a bed is configured, with its state in words', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(liveFrame());
    expect(p.byId('bed').style.display).toBe('none');
    p.push(
      liveFrame({ bed: { on: false, name: 'bett.flac', at: { folder: 1, name: 'bett.flac' } } })
    );
    expect(p.byId('bed').style.display).toBe('');
    expect(p.byId('bed').textContent).toBe('Bett aus');
    expect(p.byId('bed').attrs['aria-pressed']).toBe('false');
    p.byId('bed').click();
    expect(p.sent).toEqual([{ type: 'bed', value: true }]);
    // The button follows the box, not the click.
    expect(p.byId('bed').textContent).toBe('Bett aus');
    p.push(
      liveFrame({ bed: { on: true, name: 'bett.flac', at: { folder: 1, name: 'bett.flac' } } })
    );
    expect(p.byId('bed').textContent).toBe('Bett läuft');
    expect(p.byId('bed').attrs['aria-pressed']).toBe('true');
    p.byId('bed').click();
    expect(p.sent[1]).toEqual({ type: 'bed', value: false });
  });

  it('lets a file of the bed folder be made the bed, and marks the one that is', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    await p.selectFolder(1);
    const rows = () => p.byId('flist').children;
    expect(rows()[0].innerHTML).not.toContain('bedbtn'); // no bed on this box (yet)
    p.push(liveFrame({ bed: { on: false, name: 'a.mp3', at: { folder: 1, name: 'a.mp3' } } }));
    await p.flush(); // the listing of the bed's folder is redrawn with the marks
    expect(rows()[0].innerHTML).toContain('aria-pressed="true"');
    expect(rows()[2].innerHTML).toContain('aria-pressed="false"');
    rows()[2].querySelector('.bedbtn').click();
    expect(p.sent).toEqual([{ type: 'bedSelect', value: { folder: 1, name: 'c.flac' } }]);
    // Any other folder has no such button: a file there cannot become the bed by a slip.
    await p.selectFolder(0);
    expect(rows()[0].innerHTML).not.toContain('bedbtn');
  });

  it('cannot start a bed that has no file', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push(liveFrame({ bed: { on: false, name: null, at: null } }));
    expect(p.byId('bed').disabled).toBe(true);
  });

  it('offers "einzeln | laufend" for the box queue, not for the audition list', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push({ type: 'queue', items: [{ id: 1, folder: 0, name: 'sendung.mp3' }] });
    expect(p.byId('qmode').style.display).toBe('none'); // this box does not offer it
    p.push(liveFrame({ queueMode: 'single' }));
    expect(p.byId('qmode').style.display).toBe('');
    expect(p.byId('qmSingle').attrs['aria-pressed']).toBe('true');
    expect(p.byId('qmChain').attrs['aria-pressed']).toBe('false');
    p.byId('qmChain').click();
    expect(p.sent).toEqual([{ type: 'queueMode', value: 'chain' }]);
    p.push(liveFrame({ queueMode: 'chain' }));
    expect(p.byId('qmChain').attrs['aria-pressed']).toBe('true');
    p.byId('cue').click(); // Vorhören: the browser's own list always runs through
    await p.flush();
    expect(p.byId('qmode').style.display).toBe('none');
  });
});

describe('meters page — roles', () => {
  it('is the technician page unless the connection says otherwise', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push({ type: 'hello', role: 'tech' });
    expect(p.bodyClasses()).not.toContain('host');
    expect(p.byId('chTitle').textContent).toBe('Kanäle');
  });

  it('gives a host the host layout and keeps technician commands off the wire', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push({ type: 'hello', role: 'host' });
    expect(p.bodyClasses()).toContain('host');
    expect(p.byId('chTitle').textContent).toBe('Mikrofone');
    p.push(liveFrame({ recording: true, air: air('live'), onAir: true }));
    p.press('rec', 800);
    p.press('ship', 800);
    p.press('endShow', 800);
    expect(p.sent).toEqual([]);
    // What a host is for still works.
    p.byId('mute').click();
    expect(p.sent).toEqual([{ type: 'micsMuted', value: true }]);
  });

  it('tells a host who is up while the technician measures', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push({ type: 'hello', role: 'host' });
    const mics = [{ label: 'Host', channel: 3, progress: 0.2, done: false }];
    p.push(liveFrame({ setup: setup('speakers', { silence: 1, current: 'Host', mics }) }));
    expect(p.byId('setupLine').style.display).toBe('');
    expect(p.byId('setupLine').textContent).toContain('jetzt: Host');
    p.push(liveFrame({ setup: setup('idle') }));
    expect(p.byId('setupLine').style.display).toBe('none');
  });

  it('shows the technician a QR code per role link, the guest link per mic', async () => {
    const links = [
      { role: 'tech', label: 'Technik', url: 'http://box:4445/tech?k=T', svg: '<svg>T</svg>' },
      {
        role: 'guest',
        label: 'Gäste: <Gast 1>',
        url: 'http://box:4445/guest?k=G&mic=%3CGast%201%3E',
        mic: '<Gast 1>',
        svg: '<svg>G</svg>',
      },
    ];
    const p = boot(LISTINGS, FOLDERS, '?k=T', { enabled: true, pinned: false, links });
    await p.flush();
    p.push({ type: 'hello', role: 'tech' });
    p.byId('connBtn').click();
    await p.flush();
    expect(p.fetched).toContain('connect?k=T');
    expect(p.byId('connect').style.display).toBe('');
    const cards = p.byId('connList').children.map((c) => c.innerHTML);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain('<svg>T</svg>');
    expect(cards[0]).toContain('http://box:4445/tech?k=T');
    // Labels and links are text; only the server's SVG goes in as markup.
    expect(cards[1]).toContain('Gäste: &lt;Gast 1&gt;');
    expect(cards[1]).toContain('mic=%3CGast%201%3E');
    // Unpinned tokens: the page says the codes won't outlive a restart.
    expect(p.byId('connNote').textContent).toContain('nächsten Neustart');
  });

  it('never fetches the role links for a host', async () => {
    const p = boot(LISTINGS, FOLDERS, '?k=H');
    await p.flush();
    p.push({ type: 'hello', role: 'host' });
    p.byId('connBtn').click();
    await p.flush();
    expect(p.fetched.some((u) => u.startsWith('connect'))).toBe(false);
  });

  it('carries the role token on every request for the file tree', async () => {
    const p = boot(LISTINGS, FOLDERS, '?k=s3cret');
    await p.flush();
    expect(p.fetched[0]).toBe('folders?k=s3cret');
    expect(p.fetched[1]).toBe('files?folder=0&path=&k=s3cret');
    p.byId('cue').click();
    await p.flush();
    p.byId('flist').children[0].click();
    expect(p.byId('cueAudio').src).toBe('preview?folder=0&name=sendung.mp3&k=s3cret');
  });
});

describe('meters page — Hörer:innen (listener feedback)', () => {
  const status = (over: Record<string, unknown> = {}) => ({
    show: { slug: 'gruenfunk', name: 'Grünfunk', startMs: 0, endMs: 0 },
    pinned: false,
    hearts: 7,
    comments: [
      { id: 'c2', text: 'Wie hieß das Lied?', receivedAtMs: Date.UTC(2026, 8, 30, 16, 12) },
      {
        id: 'c1',
        text: '<b>Grüße</b>\naus Gostenhof',
        receivedAtMs: Date.UTC(2026, 8, 30, 16, 11),
      },
    ],
    state: 'ok',
    updatedMs: Date.UTC(2026, 8, 30, 16, 13),
    ...over,
  });

  it('stays off the page on a box without eve', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    // Hidden in the markup, and nothing ever shows it (the stub has no markup).
    expect(p.byId('lisbox').style.display).toBeUndefined();
    expect(p.bodyClasses()).not.toMatch(/listeners/);
  });

  it('is folded until the host opens it: hearts as a number, how many are new', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push({ type: 'listeners', status: status() });
    expect(p.byId('lisbox').style.display).toBe('');
    expect(p.bodyClasses()).toMatch(/listeners/);
    expect(p.byId('lisShow').textContent).toBe('Grünfunk');
    expect(p.byId('lisHearts').textContent).toBe('♥ 7');
    expect(p.byId('lisSum').textContent).toBe('2 Kommentare · 2 neu');
    expect(p.byId('lisList').style.display).toBe('none');
    expect(p.byId('lisTitle').attrs['aria-expanded']).toBe('false');
  });

  it('lists the comments newest first when opened, escaped, and sends nothing', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    const before = p.sent.length;
    p.push({ type: 'listeners', status: status() });
    p.byId('lisTitle').click();
    const rows = p.byId('lisList').children.map((li) => li.innerHTML);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Wie hieß das Lied?');
    expect(rows[1]).toContain('&lt;b&gt;Grüße&lt;/b&gt;');
    expect(rows[0]).toContain('18:12'); // server time zone (Berlin)
    expect(p.byId('lisSum').textContent).toBe('2 Kommentare');
    expect(p.byId('lisTitle').attrs['aria-expanded']).toBe('true');
    expect(p.sent.slice(before)).toEqual([]);
    // Folded again, a newly released comment counts as new; the seen ones don't.
    p.byId('lisTitle').click();
    const next = status();
    (next.comments as unknown[]).unshift({ id: 'c3', text: 'Danke!', receivedAtMs: 0 });
    p.push({ type: 'listeners', status: next });
    expect(p.byId('lisSum').textContent).toBe('3 Kommentare · 1 neu');
  });

  it('never lets an unreachable eve look like quiet listeners', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push({ type: 'listeners', status: status({ state: 'offline' }) });
    expect(p.byId('lisState').style.display).toBe('');
    expect(p.byId('lisState').textContent).toBe('eve nicht erreichbar – Stand 18:13');
    expect(p.byId('lisState').has('warn')).toBe(true);
    p.push({ type: 'listeners', status: status({ state: 'ok' }) });
    expect(p.byId('lisState').style.display).toBe('none');
  });

  it('says when the plan has no show on air', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push({ type: 'listeners', status: status({ show: null, comments: [], hearts: 0 }) });
    expect(p.byId('lisState').textContent).toBe('Laut Sendeplan läuft gerade keine Sendung');
    expect(p.byId('lisHearts').textContent).toBe('');
  });
});

describe('meters page — Sendung (the episode guide from eve)', () => {
  const episode = {
    id: 'ep1',
    title: 'Gentle Machine',
    airMs: 0,
    status: 'entwurf',
    opening: '<p><em>Jingle</em></p>',
    closing: '',
    topics: [
      { id: 't1', title: 'Die <Macherinnen>', cue: 'Wer seid ihr?', html: '<p>Notiz</p>' },
      { id: 't2', title: 'Die Idee', cue: '', html: '' },
    ],
    questions: [
      { id: 'q1', text: 'Was ist Erfolg?', asked: false },
      { id: 'q2', text: 'Hat es sich gelohnt?', asked: true },
    ],
  };
  const status = (over: Record<string, unknown> = {}) => ({
    show: {
      slug: 'tu',
      name: 'Tu was Du willst',
      startMs: Date.UTC(2026, 9, 5, 18),
      endMs: Date.UTC(2026, 9, 5, 19),
    },
    pinned: false,
    hearts: 0,
    comments: [],
    episode,
    guide: 'ok',
    state: 'ok',
    updatedMs: 1,
    ...over,
  });

  it('shows the show with its slot, and the guide in its planned order', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push({ type: 'listeners', status: status() });
    expect(p.byId('guidebox').style.display).toBe('');
    expect(p.byId('gdShow').textContent).toBe('Tu was Du willst · 20:00–21:00');
    expect(p.byId('gdBody').style.display).toBe('');
    expect(p.byId('gdEp').textContent).toBe('Gentle Machine');
    expect(p.byId('gdState').style.display).toBe('none');
    const html = p.byId('gdParts').innerHTML;
    // Opening first, then the topics in order, then the questions.
    const order = ['Anmoderation', 'Die &lt;Macherinnen&gt;', 'Die Idee', 'Was ist Erfolg?'];
    expect(order.map((w) => html.indexOf(w))).toEqual(
      [...order.map((w) => html.indexOf(w))].sort((a, b) => a - b)
    );
    expect(html).toContain('<p><em>Jingle</em></p>'); // sanitized on the box
    expect(html).toContain('Wer seid ihr?');
    expect(html).toContain(
      '<li class="asked"><span class="ok" aria-label="gestellt">✓</span> Hat es sich gelohnt?'
    );
    expect(html).not.toContain('Abmoderation'); // there is none
  });

  it('folds away and remembers it, sending nothing', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    const before = p.sent.length;
    p.push({ type: 'listeners', status: status() });
    p.byId('gdTitle').click();
    expect(p.byId('gdBody').style.display).toBe('none');
    expect(p.byId('gdTitle').attrs['aria-expanded']).toBe('false');
    expect(p.sent.slice(before)).toEqual([]);
  });

  it('is absent without a show on air, and says when eve has no guide', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push({ type: 'listeners', status: status({ show: null, episode: null, guide: 'pending' }) });
    expect(p.byId('guidebox').style.display).toBe('none');
    p.push({ type: 'listeners', status: status({ episode: null, guide: 'none' }) });
    expect(p.byId('guidebox').style.display).toBe('');
    expect(p.byId('gdState').textContent).toBe(
      'Für diese Sendung ist in eve kein Ablauf vorbereitet'
    );
    expect(p.byId('gdBody').style.display).toBe('none');
  });

  it('keeps the last guide when eve stops answering, and says so', async () => {
    const p = boot(LISTINGS);
    await p.flush();
    p.push({ type: 'listeners', status: status() });
    p.push({ type: 'listeners', status: status({ guide: 'unavailable' }) });
    expect(p.byId('gdState').textContent).toBe(
      'Stand von vorhin – eve liefert den Ablauf gerade nicht'
    );
    expect(p.byId('gdState').has('warn')).toBe(true);
    expect(p.byId('gdParts').innerHTML).toContain('Was ist Erfolg?');
  });
});
