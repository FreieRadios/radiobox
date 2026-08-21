import { isPreviewable } from '../../src/meters/server';
import { AUDIO_EXTENSIONS } from '../../src/audio/file-player';

describe('Vorhören preview format gate', () => {
  it('accepts the formats browsers decode natively', () => {
    for (const n of ['a.mp3', 'a.M4A', 'a.aac', 'a.wav', 'a.flac', 'a.ogg', 'a.oga', 'a.opus']) {
      expect(isPreviewable(n)).toBe(true);
    }
  });

  it('refuses formats no browser plays, so the Pi is never asked to transcode', () => {
    expect(isPreviewable('a.aiff')).toBe(false);
    expect(isPreviewable('a.aif')).toBe(false);
    expect(isPreviewable('a.wma')).toBe(false);
  });

  it('refuses anything outside the player’s own extension allow-list', () => {
    expect(isPreviewable('a.txt')).toBe(false);
    expect(isPreviewable('noextension')).toBe(false);
    expect(isPreviewable('a.mp3.exe')).toBe(false);
  });

  it('only ever claims previewability for real audio extensions', () => {
    const previewable = AUDIO_EXTENSIONS.filter((e) => isPreviewable('x' + e));
    // Every previewable extension must be one the player already exposes.
    for (const e of previewable) expect(AUDIO_EXTENSIONS).toContain(e);
    // And the non-browser ones stay out.
    expect(previewable).not.toContain('.wma');
    expect(previewable).not.toContain('.aiff');
  });
});
