import { guessDirIcon } from '../../src/config/load';

describe('guessDirIcon', () => {
  it('picks topical icons for the folder names this station actually uses', () => {
    expect(guessDirIcon('Jingles', '/mnt/x/Jingles')).toBe('🔔');
    expect(guessDirIcon('Nextcloud', '/home/u/nextcloud')).toBe('☁️');
    expect(guessDirIcon('THEMENSAMPLER', '/mnt/x/THEMENSAMPLER')).toBe('🗂️');
    expect(guessDirIcon('unterleger-instrumental', '/mnt/x/u')).toBe('🛏️');
    expect(guessDirIcon('Archiv', '/mnt/x/Archiv')).toBe('📦');
  });

  it('matches case-insensitively and on German words', () => {
    expect(guessDirIcon('WIEDERHOLUNGEN', '/x')).toBe('🔁');
    expect(guessDirIcon('nachrichten', '/x')).toBe('📰');
    expect(guessDirIcon('Werbung', '/x')).toBe('📢');
  });

  it('prefers the more specific keyword over the generic music one', () => {
    // "MP3 Eingang" is the incoming drop folder, not a music library.
    expect(guessDirIcon('MP3 Eingang', '/mnt/x/MP3 Eingang')).toBe('📥');
  });

  it('falls back to the path when the label carries no keyword', () => {
    expect(guessDirIcon('Sonstiges', '/mnt/musik/Sonstiges')).toBe('🎵');
  });

  it('always returns something for an unknown folder', () => {
    expect(guessDirIcon('Dokumente', '/mnt/x/Dokumente')).toBe('📁');
  });
});
