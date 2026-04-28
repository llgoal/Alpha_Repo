# BaZi integration research

This folder is the early research layer for a future multi-source 八字 / 五行 engine.

## What is already verified

### 1. BaZi Lab structured chart API
- Endpoint: `POST https://www.bazi-lab.com/api/sxtwl`
- Best use: structured pillar baseline
- Returns JSON with:
  - year/month/day/hour pillars
  - ten gods /藏干 /纳音 /神煞
- Notes:
  - looks powered by a calendar library rather than a plain LLM
  - good candidate for cross-checking local calculations

### 2. BaZi Lab AI explanation API
- Endpoint: `POST https://www.bazi-lab.com/api/deepseek/calculate`
- Best use: narrative interpretation layer
- Needs more fields than `sxtwl`, including `location`
- Notes:
  - useful for generated explanations
  - should not be the single source of truth for pillar accuracy

### 3. 九风水 analysis API
- Endpoint: `POST https://jiufengshui.com/api/tools/bazi-analysis/`
- Best use: second-opinion interpretation + five-element distribution
- Returns JSON with:
  - pillars
  - five-element distribution
  - day-master commentary
  - career / relationship / health sections
- Notes:
  - input semantics must be handled carefully
  - likely mixes lunar-facing UX assumptions into the experience

### 4. 易算 HTML result page
- URL pattern: `GET https://yisuan.net/app/bazi-wuxing?...`
- Best use: scrape-only backup source
- Query parameters found so far:
  - `_year`
  - `_month`
  - `_day`
  - `_hour`
  - `_sex`
- Notes:
  - not a clean JSON API
  - still useful for favorable elements and quick cross-checking

## Strategy recommendation

### Truth layers
1. **Local engine**: exact pillars, time normalization, true solar time, calendar conversion
2. **External structured sources**: BaZi Lab `sxtwl`, maybe astrology.tw later
3. **Interpretation sources**: BaZi Lab `deepseek`, 九风水
4. **Application layer**: our own color / wardrobe recommendation engine

### Why not just average the answers?
Different tools may disagree because of:
- solar vs lunar input assumptions
- solar-term month boundaries
- true solar time corrections
- 子时换日 rules
- timezone / DST handling

So the correct design is:
- align inputs first
- compare hard outputs second
- generate wardrobe advice last

## Latest progress

- Local engine day pillar has been calibrated to the BaZi Lab structured source using `1984-01-31 = 甲子`.
- Local engine now supports a configurable day rollover hour:
  - `0` = midnight rollover
  - `23` = traditional 子时换日
- Comparison CLI now emits a conflict report showing consensus and per-source mismatches.
- Probe result: BaZi Lab `sxtwl` accepts `calendarType: lunar` and returns stable structured JSON.
- Probe result: 九风水 still appears to interpret the tested input through a lunar-facing flow, even when `useSolarTime` is enabled.

## Next algorithm upgrades

### Must-have
- solar/lunar dual input
- true solar time correction
- timezone + DST support
- configurable 子时换日 rule
- exact solar-term month boundaries

### Nice-to-have
- historical location presets
- result confidence / disagreement markers
- cache external source comparisons

## Files
- `projects/bazi/bazi_engine.py` → local approximation engine v2
- `projects/bazi/bazi_sources.py` → adapters for external sources
- `projects/bazi/bazi_compare.py` → CLI comparison runner
