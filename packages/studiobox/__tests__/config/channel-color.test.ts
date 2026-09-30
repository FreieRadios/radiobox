import { resolveChannelColor } from '../../src/config/load';
import { Graph } from '../../src/dsp/graph';
import { config, mic } from '../../test-support/config';

describe('resolveChannelColor', () => {
  it('maps cable colour names, English and German, to hex', () => {
    expect(resolveChannelColor('red', 'Gast 1')).toBe('#e53935');
    expect(resolveChannelColor('Blau', 'Gast 2')).toBe('#1e88e5');
    expect(resolveChannelColor('gelb', 'Host')).toBe('#fdd835');
    expect(resolveChannelColor(' schwarz ', 'Technik')).toBe('#000000');
  });

  it('passes hex through, lower-cased', () => {
    expect(resolveChannelColor('#FF8800', 'A')).toBe('#ff8800');
    expect(resolveChannelColor('#abc', 'A')).toBe('#abc');
  });

  it('is undefined when unset', () => {
    expect(resolveChannelColor(undefined, 'A')).toBeUndefined();
    expect(resolveChannelColor('', 'A')).toBeUndefined();
  });

  it('fails loudly on a typo or anything that is not a colour', () => {
    expect(() => resolveChannelColor('rott', 'Gast 1')).toThrow(/Gast 1.*rott/);
    expect(() => resolveChannelColor('#12', 'A')).toThrow();
    expect(() => resolveChannelColor('red;background:url(x)', 'A')).toThrow();
  });
});

describe('channel colour in the meter snapshot', () => {
  it('carries the configured colour per channel, null where unset', () => {
    const graph = new Graph(config([{ ...mic(1, 'A'), color: '#e53935' }, mic(2, 'B')]));
    const chans = graph.getMeters().channels;
    expect(chans.find((c) => c.label === 'A')!.color).toBe('#e53935');
    expect(chans.find((c) => c.label === 'B')!.color).toBeNull();
  });
});
