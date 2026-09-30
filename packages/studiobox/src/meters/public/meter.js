/* Shared by the guest and spectator views: formatting, the WebSocket with its
   reconnect, and — the part worth testing — the view models as pure functions
   of a snapshot. The HTML files only bind what these return to the DOM.
   No framework and no build step: the Pi has to serve this as it is. */
(function (root) {
  'use strict';

  // Numbers the German way: decimal comma and a real minus sign.
  function fmt(v, d) {
    if (v === null || v === undefined || !isFinite(v)) return '–';
    var t = v.toFixed(d === undefined ? 1 : d);
    if (Number(t) === 0) t = t.replace('-', '');
    return t.replace('-', '−').replace('.', ',');
  }

  // Seconds as M:SS.
  function mmss(v) {
    if (v === null || v === undefined || !isFinite(v)) return '–';
    var s = Math.max(0, Math.round(v));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // A long file name loses its middle, not its end: the numbering prefix and
  // the ending both stay readable.
  function midName(n) {
    n = String(n);
    if (n.length <= 44) return n;
    return n.slice(0, 26) + ' … ' + n.slice(n.length - 14);
  }

  // Level on the −60…0 dB meter, in percent.
  function pct(db) {
    return typeof db === 'number' && isFinite(db)
      ? Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
      : 0;
  }

  // ---- guest view ---------------------------------------------------------

  // A mic's state as a word. STUMM: the technician muted this mic. PAUSE: all
  // mics are closed (music only). LEISER: host priority holds it back.
  function micState(c, s) {
    if (c.muted) return 'STUMM';
    if (s.micsMuted) return 'PAUSE';
    if (c.priorityDb < -1) return 'LEISER';
    return 'OFFEN';
  }

  function stateSub(state, s) {
    if (state === 'STUMM') return 'Die Technik hat dein Mikro stumm geschaltet';
    if (state === 'PAUSE')
      return s.filePlaying ? 'Pause – gerade läuft nur Musik' : 'Pause – die Mikros sind zu';
    if (state === 'LEISER') return 'Moderation spricht – du bist leiser';
    return s.onAir === false ? 'Dein Mikro ist offen' : 'Dein Mikro ist auf Sendung';
  }

  // The three zones of the mouth-distance indicator. The words are the whole
  // message — a guest never sees a dB value.
  var ZONES = {
    low: { word: 'Näher ran', fill: 26, hint: 'Etwas näher ans Mikro,\ndann hört man dich gut.' },
    ok: { word: 'Passt', fill: 64, hint: 'Genau richtig.\nBleib so.' },
    high: { word: 'Etwas weiter weg', fill: 90, hint: 'Ein kleines Stück\nzurück vom Mikro.' },
  };
  // The target band drawn on the bar: from 52 % to 76 % of its height.
  var BAND = { bottom: 52, height: 24 };

  // Height of the bar, in percent. With the zone's centre and width in the
  // snapshot the speech level is placed against the drawn band (its edges are
  // the zone's edges); without them the bar takes one of three fixed heights.
  function zoneFill(c) {
    var z = ZONES[c.zone];
    if (!z) return 0;
    if (
      typeof c.speechDb !== 'number' ||
      typeof c.zoneCenterDb !== 'number' ||
      !(c.zoneWidthDb > 0)
    ) {
      return z.fill;
    }
    var mid = BAND.bottom + BAND.height / 2;
    var fill = mid + ((c.speechDb - c.zoneCenterDb) / c.zoneWidthDb) * (BAND.height / 2);
    return Math.max(4, Math.min(100, fill));
  }

  // Everything the guest view shows for one mic. `c` is that mic's channel of
  // the snapshot, or undefined when the box has no such mic (any more).
  function guestMic(c, s) {
    if (!c) {
      return {
        state: '—',
        sub: 'Dieses Mikro gibt es gerade nicht',
        live: false,
        zone: 'none',
        word: '—',
        hint: '',
        fill: 0,
      };
    }
    var state = micState(c, s);
    var live = state === 'OFFEN' || state === 'LEISER';
    // The box holds the last level for a moment after a guest stops talking
    // and then reports none: the bar goes to "—", not to "näher ran".
    var z = live ? ZONES[c.zone] : null;
    // Before the mics have been measured ("Einmessen") the zone is only as good
    // as their raw sensitivities: say so rather than send a guest back and forth.
    var rough = z && s.setupApplied === false;
    return {
      state: state,
      sub: stateSub(state, s),
      live: live,
      zone: z ? c.zone : 'none',
      word: z ? z.word : '—',
      hint: rough
        ? 'Noch nicht eingemessen –\ndie Anzeige ist nur grob.'
        : z
          ? z.hint
          : live
            ? 'Sprich einfach los.'
            : 'Dein Mikro ist gerade nicht auf Sendung.',
      fill: z ? zoneFill(c) : 0,
    };
  }

  // The running file, for a guest: how long until the talk goes on.
  function guestMusic(s) {
    if (!s.filePlaying) return null;
    var known = typeof s.fileDuration === 'number' && isFinite(s.fileDuration);
    if (!known) return { label: 'Musik läuft', time: '', after: '' };
    return {
      label: 'Musik – noch',
      time: mmss(s.fileDuration - (s.filePosition || 0)),
      after: s.micsMuted ? 'dann geht’s weiter' : '',
    };
  }

  // The setup assistant as one screen for a guest: who is up, what to read,
  // and how much of it has been collected. Null while it is not running.
  function guestSetup(s, labels) {
    var st = s.setup;
    if (!st || (st.phase !== 'silence' && st.phase !== 'speakers')) return null;
    if (st.phase === 'silence') {
      return {
        kind: 'silence',
        title: 'Einmessen',
        text: 'Bitte kurz still sein',
        sentence: '',
        progress: st.silence,
      };
    }
    var mine = (st.mics || []).filter(function (m) {
      return labels.indexOf(m.label) >= 0;
    });
    var me = mine.filter(function (m) {
      return m.label === st.current;
    })[0];
    if (me) {
      return {
        kind: 'you',
        title: 'Jetzt du: ' + me.label,
        text: 'Bitte diesen Satz vorlesen:',
        sentence: st.sentence || '',
        progress: me.progress,
      };
    }
    var done =
      mine.length > 0 &&
      mine.every(function (m) {
        return m.done;
      });
    var who = st.current ? 'Jetzt: ' + st.current : 'Auswertung …';
    return {
      kind: done ? 'thanks' : 'wait',
      title: done ? 'Danke!' : 'Einmessen',
      text: done || !mine.length ? who : who + ' – du bist gleich dran',
      sentence: '',
      progress: done ? 1 : 0,
    };
  }

  // ---- clocks -------------------------------------------------------------

  // The clock a view shows. With an air delay that is Sendezeit — when what
  // is said now goes on air — and it is labelled as such.
  function clockOf(s, skewMs, nowMs) {
    var air = s && s.air;
    return {
      ms: nowMs + skewMs + (air ? air.nowMs - s.serverNowMs : 0),
      label: air ? 'Sendezeit' : 'Uhrzeit',
    };
  }

  // Times in the server's zone, 24 h. Falls back to the browser's zone when it
  // does not know the server's.
  function timeFormat(tz, seconds) {
    var o = { hour: '2-digit', minute: '2-digit', hour12: false };
    if (seconds) o.second = '2-digit';
    try {
      return new Intl.DateTimeFormat('de-DE', Object.assign({ timeZone: tz }, o));
    } catch (e) {
      return new Intl.DateTimeFormat('de-DE', o);
    }
  }

  // ---- spectator view -----------------------------------------------------

  // The last minute or so of snapshots. The snapshot is in room time; the
  // spectator view shows what listeners hear *now*, which the room did one
  // air delay ago — so it looks that far back.
  function History(maxMs) {
    this.items = [];
    this.maxMs = maxMs || 90000;
  }
  History.prototype.push = function (t, s) {
    this.items.push({ t: t, s: s });
    while (this.items.length > 1 && this.items[0].t < t - this.maxMs) this.items.shift();
  };
  // The newest snapshot at or before `t`; the oldest one while the history is
  // still shorter than that.
  History.prototype.at = function (t) {
    var it = this.items;
    for (var i = it.length - 1; i >= 0; i--) if (it[i].t <= t) return it[i].s;
    return it.length ? it[0].s : null;
  };

  function spectator(hist, s, nowMs) {
    var air = s.air;
    var delay = air ? (typeof air.delayMs === 'number' ? air.delayMs : air.targetMs) : 0;
    // The master meters already sit one look-ahead behind the room.
    var look = s.lookaheadMs || 0;
    var was = hist.at(nowMs - delay) || s;
    var lvl = hist.at(nowMs - Math.max(0, delay - look)) || s;
    return {
      // null: this box does not know (playout mode) — the view shows no chip.
      onAir: s.onAir === undefined ? null : s.onAir,
      title: was.filePlaying || null,
      // Below the BS.1770 absolute gate there is no loudness to show.
      lufs:
        typeof lvl.shortTermLufs === 'number' && lvl.shortTermLufs < -70 ? null : lvl.shortTermLufs,
      peakDb: lvl.outPeakDb,
    };
  }

  // ---- connection ---------------------------------------------------------

  // Opens the WebSocket (with the page's ?k= token) and keeps it open.
  // h.onState('wait' | 'ok' | 'lost'), h.onHello({role, tz}), h.onSnapshot(s).
  function connect(h) {
    function open() {
      var ws = new WebSocket(
        (location.protocol === 'https:' ? 'wss://' : 'ws://') +
          location.host +
          '/' +
          (location.search || '')
      );
      ws.onopen = function () {
        h.onState('ok');
      };
      ws.onmessage = function (e) {
        var s = JSON.parse(e.data);
        if (s.type === 'hello') {
          if (h.onHello) h.onHello(s);
        } else if (!s.type) {
          h.onSnapshot(s);
        }
      };
      ws.onclose = function () {
        h.onState('lost');
        setTimeout(open, 1000);
      };
    }
    h.onState('wait');
    open();
  }

  var SB = {
    fmt: fmt,
    mmss: mmss,
    midName: midName,
    pct: pct,
    micState: micState,
    guestMic: guestMic,
    guestMusic: guestMusic,
    guestSetup: guestSetup,
    zoneFill: zoneFill,
    BAND: BAND,
    clockOf: clockOf,
    timeFormat: timeFormat,
    History: History,
    spectator: spectator,
    connect: connect,
  };
  root.SB = SB;
  if (typeof module !== 'undefined' && module.exports) module.exports = SB;
})(typeof window !== 'undefined' ? window : globalThis);
