# Lotto Max History Web App

Simple web app that lists Lotto Max historical winning numbers by draw date.

## Files
- `index.html` — UI
- `results.json` — draw data consumed by the UI

## Notes
The app is intentionally simple: it only lists draw date + winning numbers.

## Updating data
Populate `results.json` with objects like:

```json
{
  "drawDate": "2026-03-20",
  "numbers": ["02", "14", "25", "31", "36", "41", "47"],
  "bonus": "13"
}
```

Sort newest first.
