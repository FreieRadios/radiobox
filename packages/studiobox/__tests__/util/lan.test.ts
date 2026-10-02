import { NetworkInterfaceInfo } from 'node:os';
import { pickLanAddress } from '../../src/util/lan';

const v4 = (address: string, internal = false) =>
  ({ address, family: 'IPv4', internal }) as NetworkInterfaceInfo;
const v6 = (address: string) =>
  ({ address, family: 'IPv6', internal: false }) as NetworkInterfaceInfo;

describe('pickLanAddress', () => {
  it('passes over docker bridges to the Wi-Fi the tablets are on', () => {
    expect(
      pickLanAddress({
        lo: [v4('127.0.0.1', true)],
        docker0: [v4('172.17.0.1')],
        'br-3f2a': [v4('172.18.0.1')],
        wlp2s0: [v6('fe80::1'), v4('192.168.1.23')],
      })
    ).toBe('192.168.1.23');
  });

  it('takes a virtual interface when there is nothing else, and null without any', () => {
    expect(pickLanAddress({ lo: [v4('127.0.0.1', true)], docker0: [v4('172.17.0.1')] })).toBe(
      '172.17.0.1'
    );
    expect(pickLanAddress({ lo: [v4('127.0.0.1', true)] })).toBeNull();
  });
});
