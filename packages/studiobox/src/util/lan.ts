import * as os from 'node:os';

/** Interfaces no tablet reaches the box through: container and VM bridges,
 *  their veth ends, and VPN tunnels. */
const VIRTUAL =
  /^(docker|br-|veth|virbr|vnet|lxcbr|lxdbr|podman|cni|flannel|tun|tap|wg|tailscale|zt)/;

/** The address the tablets reach this machine at: the first non-internal
 *  IPv4 address on a real interface (Ethernet, Wi-Fi), else on any, else
 *  null. On a box that also runs docker the bridge (172.17.0.1, …) would
 *  otherwise often come first — and end up in the links and QR codes. */
export function pickLanAddress(
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): string | null {
  const v4 = (real: boolean): string | null => {
    for (const [name, list] of Object.entries(ifaces)) {
      if (VIRTUAL.test(name) === real) continue;
      for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
    }
    return null;
  };
  return v4(true) ?? v4(false);
}
