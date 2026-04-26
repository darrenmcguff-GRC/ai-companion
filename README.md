# NPC Autopilot for Foundry VTT

Striped-down NPC combat autopilot for D&D 5e in Foundry VTT.

## What it does
- Automatically takes NPC turns in combat (movement, attacks, spells, dodge)
- Targets the weakest PC first
- Flanks when allies are present
- Retreats if critically wounded & outnumbered
- Shows a live panel with current combatant info and NPC roster

## Settings
- **NPC Autopilot** — enable/disable automatic NPC turns
- **Auto-Advance Combat** — automatically end turn after NPC action
- **NPC Movement** — move into weapon range before attacking

## How to trigger manually
Open the NPC Autopilot panel from the Token HUD or by running:
```js
NpcAutopilot.takeTurn(actor, token)
```

## Compatibility
Foundry VTT v11–v14, dnd5e system.

---
Manifest: `https://raw.githubusercontent.com/darrenmcguff-GRC/ai-companion/main/module.json`
