# python3 -m unittest discover music-sheet-player/server/tests
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import musicxml_events as M  # noqa: E402

# Two staves; bar 1 opens a repeat, bars 2/3 are first/second endings, a tie
# over the bar line, a chord, and an empty bar at the end (homr writes one).
XML = """<?xml version="1.0"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
<part id="P1">
<measure number="1"><attributes><divisions>2</divisions><key><fifths>1</fifths></key><time><beats>2</beats><beat-type>4</beat-type></time><staves>2</staves>
<clef number="1"><sign>G</sign></clef><clef number="2"><sign>F</sign></clef></attributes>
<barline location="right"><repeat direction="forward"/></barline>
<note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff><!-- imgpos: 10, 20 --></note>
<note><chord/><pitch><step>E</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff></note>
<note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff><tie type="start"/></note>
<backup><duration>4</duration></backup>
<note><pitch><step>G</step><octave>2</octave></pitch><duration>4</duration><voice>5</voice><staff>2</staff></note>
</measure>
<measure number="2"><barline location="left"><ending number="1" type="start"/></barline>
<note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff><tie type="stop"/></note>
<note><rest/><duration>2</duration><voice>1</voice><staff>1</staff></note>
<backup><duration>4</duration></backup>
<note><pitch><step>F</step><alter>1</alter><octave>3</octave></pitch><duration>4</duration><voice>5</voice><staff>2</staff></note>
<barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline></measure>
<measure number="3"><barline location="left"><ending number="2" type="start"/></barline>
<note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>
<backup><duration>4</duration></backup>
<note><pitch><step>G</step><octave>2</octave></pitch><duration>4</duration><voice>5</voice><staff>2</staff></note>
<barline location="right"><ending number="2" type="discontinue"/></barline></measure>
<measure number="4"></measure>
</part></score-partwise>"""


class MusicXmlEvents(unittest.TestCase):
    def setUp(self):
        self.r = M.to_result(XML)

    def test_play_order_takes_repeat_and_endings(self):
        self.assertEqual(self.r['playOrder'], [1, 2, 1, 3])
        self.assertEqual(self.r['totalBeats'], 8)

    def test_hands_chord_tie_and_positions(self):
        rh = [e for e in self.r['events'] if e['hand'] == 'right']
        lh = [e for e in self.r['events'] if e['hand'] == 'left']
        self.assertEqual([e['name'] if e['type'] == 'note' else 'R' for e in rh], ['C5+E5', 'D5', 'R', 'G4'])
        self.assertEqual(rh[1]['beats'], 2)  # D5 tied over the bar line sounds 2 beats
        self.assertEqual((rh[0]['x'], rh[0]['y']), (10, 20))
        self.assertEqual([e['name'] for e in lh], ['G2', 'F#3', 'G2'])
        self.assertEqual(self.r['staves'][0]['key'], {'type': 'sharp', 'count': 1})
        self.assertEqual(self.r['staves'][1]['clef'], 'bass')

    def test_starts_repeat_and_hands_line_up(self):
        c = self.r['events'][0]
        self.assertEqual(c['starts'], [0, 4])
        g4 = [e for e in self.r['events'] if e.get('name') == 'G4'][0]
        g2 = [e for e in self.r['events'] if e.get('name') == 'G2'][1]
        self.assertEqual(g4['starts'], g2['starts'])


if __name__ == '__main__':
    unittest.main()
