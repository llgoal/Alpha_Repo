"""Turns homr's MusicXML into the ScoreLens result shape the app plays.

Only the parts of MusicXML that homr writes are read: one piano part with
one or two staves, notes (chords, voices, ties), rests, backup/forward,
key/clef/time, repeat barlines and first/second endings. homr also leaves
the image position of every note in a comment ("imgpos: x, y"), which the
app uses to light up the notes while playing.
"""
import re
import xml.etree.ElementTree as ET

STEPS = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
IMGPOS = re.compile(r'imgpos:\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)')


def note_name(midi):
    return NAMES[midi % 12] + str(midi // 12 - 1)


def _int(el, path, default=0):
    v = el.find(path)
    try:
        return int(float(v.text)) if v is not None and v.text else default
    except ValueError:
        return default


def parse(xml_text):
    parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True))
    root = ET.fromstring(xml_text.encode('utf-8') if isinstance(xml_text, str) else xml_text, parser=parser)
    part = root.find('part')
    if part is None:
        raise ValueError('No part in MusicXML')

    divisions = 1
    nstaves = 1
    clefs, keys, time = {}, 0, None
    measures = []  # each: {'notes': [...], 'len': divs, flags}
    for m in part.findall('measure'):
        cur = 0
        maxpos = 0
        last_onset = 0
        meas = {'notes': [], 'start_repeat': False, 'end_repeat': False, 'endings': []}
        for el in m:
            tag = el.tag if isinstance(el.tag, str) else ''
            if tag == 'attributes':
                divisions = _int(el, 'divisions', divisions) or divisions
                nstaves = _int(el, 'staves', nstaves) or nstaves
                k = el.find('key/fifths')
                if k is not None and k.text:
                    keys = int(k.text)
                t = el.find('time')
                if t is not None and time is None:
                    time = '%s/%s' % (t.findtext('beats'), t.findtext('beat-type'))
                for c in el.findall('clef'):
                    clefs.setdefault(int(c.get('number', '1')), c.findtext('sign'))
            elif tag == 'backup':
                cur -= _int(el, 'duration')
            elif tag == 'forward':
                cur += _int(el, 'duration')
                maxpos = max(maxpos, cur)
            elif tag == 'barline':
                rep = el.find('repeat')
                loc = el.get('location', 'right')
                if rep is not None:
                    d = rep.get('direction')
                    if d == 'forward':
                        # It opens the repeat at this bar when it comes before
                        # the bar's notes (homr may still mark it "right"),
                        # else at the next bar.
                        before = not meas['notes']
                        meas['start_repeat' if loc == 'left' or before else 'start_repeat_next'] = True
                    elif d == 'backward':
                        meas['end_repeat'] = True
                for e in el.findall('ending'):
                    nums = [int(x) for x in re.findall(r'\d+', e.get('number', ''))]
                    meas['endings'].append((e.get('type'), nums[0] if nums else None))
            elif tag == 'note':
                if el.find('grace') is not None:
                    continue
                dur = _int(el, 'duration')
                chord = el.find('chord') is not None
                onset = last_onset if chord else cur
                if not chord:
                    cur += dur
                    maxpos = max(maxpos, cur)
                last_onset = onset
                pos = None
                for c in el:
                    if c.tag is ET.Comment and c.text:
                        mm = IMGPOS.search(c.text)
                        if mm:
                            pos = (float(mm.group(1)), float(mm.group(2)))
                n = {
                    'onset': onset, 'dur': dur, 'chord': chord,
                    'staff': _int(el, 'staff', 1), 'voice': el.findtext('voice') or '1',
                    'rest': el.find('rest') is not None,
                    'hidden': el.get('print-object') == 'no',
                    'tie_stop': any(t.get('type') == 'stop' for t in el.findall('tie')),
                    'tie_start': any(t.get('type') == 'start' for t in el.findall('tie')),
                    'pos': pos,
                }
                if not n['rest']:
                    step = el.findtext('pitch/step')
                    octave = int(el.findtext('pitch/octave') or 4)
                    alter = int(float(el.findtext('pitch/alter') or 0))
                    n['midi'] = (octave + 1) * 12 + STEPS.get(step, 0) + alter
                meas['notes'].append(n)
        meas['len'] = maxpos
        measures.append(meas)
    return {'divisions': divisions, 'nstaves': nstaves, 'clefs': clefs, 'fifths': keys, 'time': time, 'measures': measures}


def to_result(xml_text, width=None, height=None):
    d = parse(xml_text)
    div = float(d['divisions'] or 1)
    two = d['nstaves'] >= 2
    fifths = d['fifths']
    key = {'type': 'sharp' if fifths > 0 else 'flat' if fifths < 0 else None, 'count': abs(fifths)}
    staves = []
    for s in range(1, (2 if two else 1) + 1):
        sign = d['clefs'].get(s, 'G' if s == 1 else 'F')
        staves.append({
            'index': s - 1, 'clef': 'bass' if sign == 'F' else 'treble', 'key': key, 'time': d['time'],
            'hand': ('right' if s == 1 else 'left') if two else None, 'bars': [], 'repeats': [], 'voltas': [],
        })

    # Bars that hold nothing at all (homr sometimes closes with one) are dropped.
    measures = [m for m in d['measures'] if m['notes']]
    # Open repeats carried over from a right-hand forward barline.
    for i, m in enumerate(d['measures']):
        if m.get('start_repeat_next'):
            j = i + 1
            while j < len(d['measures']) and not d['measures'][j]['notes']:
                j += 1
            if j < len(d['measures']):
                d['measures'][j]['start_repeat'] = True

    events = []
    for mi, m in enumerate(measures):
        last_by_key = {}
        for n in m['notes']:
            if n['hidden'] and n['rest']:
                continue
            staff = n['staff'] - 1 if two else 0
            beats = n['dur'] / div
            if beats <= 0:
                continue
            off = n['onset'] / div
            if n['rest']:
                x, y = n['pos'] or (None, None)
                events.append({'type': 'rest', 'beats': beats, 'staff': staff, 'measure': mi, 'off': off, 'x': x, 'y': y})
                continue
            p = {'midi': n['midi'], 'name': note_name(n['midi']), 'tied': n['tie_stop'], 'tie_start': n['tie_start']}
            if n['pos']:
                p['x'], p['y'] = n['pos']
            k = (staff, n['voice'], n['onset'])
            if n['chord'] and k in last_by_key:
                ev = last_by_key[k]
                ev['pitches'].append(p)
                continue
            ev = {'type': 'note', 'pitches': [p], 'beats': beats, 'staff': staff, 'measure': mi, 'off': off}
            if n['pos']:
                ev['x'], ev['y'] = n['pos']
            last_by_key[k] = ev
            events.append(ev)

    # Ties: a note tied from the one before is not struck again; when a whole
    # chord is tied over, the first one simply sounds longer.
    by_staff = {}
    for ev in events:
        by_staff.setdefault(ev['staff'], []).append(ev)
    timeline = _play_order(measures)
    m_start = {}
    t = 0.0
    for mi in range(len(measures)):
        m_start[mi] = t
        t += measures[mi]['len'] / div
    kept = []
    open_ties = {}  # (staff, midi) -> event
    for ev in sorted(events, key=lambda e: (e['staff'], m_start[e['measure']] + e['off'])):
        if ev['type'] != 'note':
            kept.append(ev)
            continue
        tied = [p for p in ev['pitches'] if p['tied'] and (ev['staff'], p['midi']) in open_ties]
        if tied and len(tied) == len(ev['pitches']):
            prev = open_ties[(ev['staff'], tied[0]['midi'])]
            prev['beats'] += ev['beats']
            for p in ev['pitches']:
                if not p['tie_start']:
                    open_ties.pop((ev['staff'], p['midi']), None)
            continue
        ev['pitches'] = [p for p in ev['pitches'] if p not in tied] or ev['pitches']
        for p in ev['pitches']:
            if p['tie_start']:
                open_ties[(ev['staff'], p['midi'])] = ev
        kept.append(ev)
    events = sorted(kept, key=lambda e: (e['staff'], m_start[e['measure']] + e['off']))

    for ev in events:
        if ev['type'] == 'note':
            ev['pitches'].sort(key=lambda p: p['midi'])
            for p in ev['pitches']:
                p.pop('tied', None)
                p.pop('tie_start', None)
            ev['midi'] = ev['pitches'][0]['midi']
            ev['name'] = '+'.join(p['name'] for p in ev['pitches'])
            ev['hand'] = staves[ev['staff']]['hand']
        else:
            ev['hand'] = staves[ev['staff']]['hand']
        ev['starts'] = []

    order = timeline
    t = 0.0
    for mi in order:
        for ev in events:
            if ev['measure'] == mi:
                ev['starts'].append(t + ev['off'])
        t += measures[mi]['len'] / div
    for ev in events:
        ev['start'] = ev['starts'][0] if ev['starts'] else 0
        ev.pop('off', None)

    has_rep = any(m['start_repeat'] or m['end_repeat'] or m['endings'] for m in measures)
    return {
        'engine': 'homr',
        'width': width, 'height': height, 'scale': 1,
        'staves': staves,
        'systems': [{'staves': [0, 1]}] if two else [{'staves': [0]}],
        'events': events,
        'totalBeats': t,
        'measures': len(measures),
        'playOrder': [mi + 1 for mi in order],
        'repeats': has_rep,
        'tempo': None,
        'warnings': [],
    }


def _play_order(measures):
    """Bar order with repeats taken: back to the last start repeat (or the
    beginning) at an end repeat, once; the second time through, take the
    second ending."""
    n = len(measures)
    ending = [None] * n
    for i, m in enumerate(measures):
        for typ, num in m['endings']:
            if typ == 'start' and num:
                j = i
                while j < n:
                    ending[j] = num
                    stops = [t for t, _ in measures[j]['endings'] if t in ('stop', 'discontinue')]
                    if stops or (j > i and any(t == 'start' for t, _ in measures[j]['endings'])):
                        if j > i and any(t == 'start' for t, _ in measures[j]['endings']) and not stops:
                            ending[j] = None
                        break
                    if measures[j]['end_repeat']:
                        break
                    j += 1
    if not any(m['end_repeat'] for m in measures):
        ending = [None] * n
    order, done = [], set()
    i, rep_start, pass_no, back = 0, 0, 1, -1
    while i < n and len(order) < 4 * n + 8:
        m = measures[i]
        if m['start_repeat'] and i != back:
            rep_start, pass_no = i, 1
        back = -1
        if ending[i] and ending[i] != pass_no:
            i += 1
            continue
        order.append(i)
        if m['end_repeat'] and i not in done:
            done.add(i)
            pass_no += 1
            i = rep_start
            back = rep_start
            continue
        i += 1
    return order
