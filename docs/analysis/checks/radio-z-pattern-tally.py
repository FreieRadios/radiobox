#!/usr/bin/env python3
"""Tally the schedule patterns of a station to see what a migration would need.

Reads pattern strings in radiobox's schema grammar (M:/D:/H:/R:/O:/N:) and
counts the month sets, the nth-weekday sets, the repeat offsets and the
override / no-merge flags.

Usage:
    radio-z-pattern-tally.py <file>

<file> is any text file containing `muster: "<pattern>"` literals. On
2026-09-29 this was run against eve's hand transcription of the Radio Z sheet,
`eve/packages/backend/src/scripts/radio-z-programm.ts`.
"""
import collections
import re
import sys


def expand(spec):
    out = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        m = re.match(r"^(-?\d+)-(\d+)$", part)
        if m:
            out += list(range(int(m.group(1)), int(m.group(2)) + 1))
        else:
            out.append(int(part))
    return out


def main(path):
    src = open(path, encoding="utf-8").read()
    patterns = [m[1] for m in re.findall(r"muster:\s*(['\"`])(.*?)\1", src)]
    days, months, repeats = (collections.Counter() for _ in range(3))
    overrides = no_merge = multi = 0

    for pattern in patterns:
        has_multi = False
        for block in pattern.split(";"):
            d = re.search(r"D:\[([^\]]*)\]", block)
            m = re.search(r"M:\[([^\]]*)\]", block)
            r = re.search(r"R:(\d+)", block)
            if d:
                days[d.group(1)] += 1
                if 1 < len(expand(d.group(1))) < 5:
                    has_multi = True
            if m:
                months[m.group(1)] += 1
            if r:
                repeats[r.group(1)] += 1
            overrides += bool(re.search(r"O:\s*true", block))
            no_merge += bool(re.search(r"N:\s*true", block))
        multi += has_multi

    print("patterns:", len(patterns))
    print("month sets (M:):", months.most_common())
    print("nth-weekday sets (D:):", days.most_common())
    print("repeat offsets in hours (R:):", repeats.most_common())
    print("override flags (O:true):", overrides)
    print("no-merge flags (N:true):", no_merge)
    print("patterns combining 2-4 nth values:", multi)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
