#!/usr/bin/env python3
"""Check: can AURA's recurrence model express "fifth Sunday of odd-numbered months"?

AURA Steering builds its timeslots with dateutil.rrule from four stored
parameters (freq, interval, by_set_pos, by_weekdays); the weekday of a monthly
rule is taken from the schedule's first date. This script feeds dateutil the
parameters of AURA's built-in rule "bi-monthly on the fifth"
(freq=MONTHLY, interval=2, by_set_pos=5) with a first date on a fifth Sunday in
an odd month, and compares the result with a brute-force reference.

It exercises the library AURA uses, with AURA's parameters. It does not run
AURA itself.

Requires: pip install python-dateutil
"""
from datetime import datetime

from dateutil.rrule import MONTHLY, SU, rrule

FIRST = datetime(2026, 3, 29, 20, 0)  # fifth Sunday of March 2026
UNTIL = datetime(2028, 12, 31)

occurrences = list(
    rrule(MONTHLY, dtstart=FIRST, interval=2, bysetpos=5, byweekday=SU, until=UNTIL)
)

reference = [
    d
    for d in rrule(
        MONTHLY, dtstart=datetime(2026, 1, 1, 20, 0), bysetpos=5, byweekday=SU, until=UNTIL
    )
    if d.month % 2 == 1 and d >= FIRST
]

for o in occurrences:
    print(o.date(), "odd month" if o.month % 2 else "EVEN month")

ok = [o.date() for o in occurrences] == [r.date() for r in reference]
print("matches reference:", ok)
raise SystemExit(0 if ok else 1)
