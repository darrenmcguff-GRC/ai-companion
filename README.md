# AI Companion v2.0 — User Guide

**AI-GM Companion for Foundry VTT (D&D 5e)**

---

## 1. Overview

AI Companion is an embedded AI game-master agent that automates NPCs, parses chat, applies conditions, rolls dice, assists players, and serves as a co-GM inside Foundry VTT. It runs entirely on local heuristics (no API required) with an optional LLM proxy for smarter responses.

**Architecture (v2.0):**
- `main.js` — Core UI, chat interception, settings, framework hooks
- `npc-automation.js` — NPC autopilot with tactical movement
- `gm-assist.js` — GM narration scanning, condition application, AI proxy
- `effect-library.js` — Knowledge base (KB) and mode response engines

---

## 2. Installation

### Method A — Manifest URL (recommended, auto-updates)

1. In Foundry VTT, go to **Add-On Modules → Install Module**
2. Paste the manifest URL:  
   `https://spotty-plums-swim.loca.lt/module.json`
3. Click **Install**
4. Enable the module in your world

### Method B — Manual ZIP

1. Download `https://spotty-plums-swim.loca.lt/ai-companion.zip`
2. Extract to `Data/modules/ai-companion/`
3. Enable in your world

---

## 3. Module Settings

Open **Configure Settings → Module Settings → AI Companion**.

| Setting | Default | Description |
|---------|---------|-------------|
| **AI Proxy URL** | — | Full URL to your LLM proxy endpoint |
| **API Key** | — | Bearer token if required |
| **LLM Model** | `gpt-4o-mini` | Model name passed to proxy |
| **NPC Autopilot** | Off | AI automatically plays NPC turns |
| **NPC Movement** | On | NPCs move within weapon range before attacking |
| **GM Assist** | On | Scan GM chat for conditions and auto-apply |
| **GM Assist Strict** | Off | Only apply effects after GM confirms |
| **Player Assist** | On | Suggest tactics and answer `/ai` questions |
| **Auto-Advance** | On | End NPC turn and advance to next automatically |
| **Auto Loot** | Off | Suggest loot after combat ends |
| **Loot Table UUID** | — | Optional RollTable for loot suggestions |
| **AI Name** | `AI-GM` | Name shown in AI chat messages |
| **AI Avatar** | `icons/svg/mystery-man.svg` | Image path for AI messages |

---

## 4. Chat Commands

All commands use the Foundry chat input (`/` prefix).

### `/ai [question or command]`

Ask the AI anything or issue a command.

#### Autopilot Mode (if your message contains autopilot keywords)
- `status` — list NPCs in combat
- `enable` / `disable` — toggle autopilot
- `take turn` — manually trigger autopilot for selected token

#### Action Commands
- `roll initiative` — roll initiative for selected token
- `cast [spell]` — cast a spell if prepared
- `attack [weapon]` — attack with weapon (or default equipped)
- `apply [condition] to [target]` — apply condition to target actor
- `move [direction]` — manual movement (WIP, drag recommended)

#### Knowledge Modes
- **Rules Lawyer** — conditions, advantage, cover, death saves, grappling, resting
- **Tactical** — turn-by-turn advice based on HP, spell slots, combat state
- **Lore Keeper** — deities, planes, cities, monsters, magic items
- **Builder** — class builds, feat choices, multiclassing

Examples:
```
/ai What does Paralyzed do?
/ai How does flanking work?
/ai build a fireball wizard
/ai Should I cast Shield or Misty Step?
```

### `/npc [name] [action]`

Direct a specific NPC without selecting them.

```
/npc Goblin attack Fighter
/npc Orc cast fireball
```

### `/effect [condition] on [target]`

Quickly apply a condition.

```
/effect poisoned on Fighter
/effect prone on Goblin
```

### `/roll [formula]`

Standard Foundry roll, intercepted for AI reaction logging.

---

## 5. NPC Autopilot Engine

When **NPC Autopilot** is enabled, the AI automatically runs every NPC turn in combat.

### Turn Flow

1. **Movement Phase** (if enabled)
   - Retreats if HP < 20% and ≥2 enemies nearby
   - Advances toward weakest enemy
   - Flanks if an ally is already adjacent to target
   - Uses `CONFIG.Canvas.polygonBackends.move.testCollision` to avoid walls
   - Speed-based movement distance (30 ft base)
   - Snaps to grid, checks collision

2. **Action Phase**
   - **Priority 1**: Heal (self or wounded ally ≤30% HP)
   - **Priority 2**: Buff/debuff spell (Bless, Haste, Bane)
   - **Priority 3**: Equipped weapon attack (targets lowest HP enemy)
   - **Priority 4**: Dodge (if <25% HP and no valid action)

### Weapon Range Lookup

| Property | Range |
|----------|-------|
| No property / default | 5 ft |
| `rch` (Reach) | 10 ft |
| `thr` (Thrown) | 60 ft |
| `range.value` set | parsed from item data |

### Tactical Movement Rules

- **Flanking**: Moves to opposite side of target relative to nearest ally. Only attempts if ally is adjacent.
- **Retreat**: Moves directly away from enemy cluster center. If blocked, falls back as far as collision-free path allows.
- **Safe Position**: Ray-casts in 20 steps toward destination; stops before first wall collision.

---

## 6. GM Assist

The AI scans every GM chat message for condition keywords.

### Detected Keywords

| Keyword | Auto-Applies |
|---------|-------------|
| blinded, charmed, deafened, frightened, grappled, incapacitated, invisible, paralyzed, petrified, poisoned, prone, restrained, stunned, unconscious, concentration | Foundry ActiveEffect via `token.toggleActiveEffect` |
| exhaustion, exhausted | **Exhaustion 1** (increment manually for higher levels) |

### Strict Mode

If **GM Assist Strict** is on, the AI posts a whisper to the GM with `[Accept]` / `[Reject]` buttons instead of applying immediately.

### Combat Reactions

- Damage > 40: Warns about concentration break (CON save DC 10 or half damage)
- Damage = 0 HP: Notifies of target dropping (GM loot suggestions if enabled)

---

## 7. Knowledge Base (Local)

All responses run locally — no internet required unless AI Proxy is enabled.

### Conditions
All 15 core conditions + exhaustion levels 1–6 with full mechanical descriptions.

### Rules
Advantage, disadvantage, cover, opportunity attacks, grappling, shoving, death saves, resting (short/long), initiative.

### Lore
Major deities (Mystra, Tyr, Bane, etc.), planes of existence, Sword Coast cities, monster traits.

### Builds
Quick starter builds for all 13 classes (Fighter Champion, Wizard Evocation, Cleric Life, etc.).

### Spells
Usage tips for 80+ common spells (Fireball, Counterspell, Shield, Healing Word, Hex, etc.).

---

## 8. Optional AI Proxy

Enable **AI Proxy** in settings. The module will forward any unmatched queries to your LLM endpoint.

### Supported Proxy Formats

OpenAI-compatible JSON:
```json
{
  "model": "gpt-4o-mini",
  "messages": [{"role": "user", "content": "prompt"}]
}
```

Expected response:
```json
{"choices": [{"message": {"content": "response"}}]}
```

Fallbacks: `data.content`, `data.response`

### Example Local Proxy (Ollama)

```bash
curl -X POST http://localhost:11434/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model": "llama3.2", "messages": [{"role": "user", "content": "hello"}]}'
```

---

## 9. UI Controls

- **Floating Panel**: Right-side drag, bottom-right resize, top-left popout/settings/close
- **Mode Tabs**: Rules / Tactical / Lore / Builder / Autopilot
- **Input**: Type and send, or press Enter. Messages show in panel first, then echo to chat.
- **Context**: Token image, name, class, HP automatically shown on selection

---

## 10. Troubleshooting

| Problem | Solution |
|---------|----------|
| NPCs not autopiloting | Enable module setting + start combat + is player-owned? |
| Token won't move | Check movement speed on token sheet |
| Conditions not applied | Check GM Assist is on; try strict mode for manual approval |
| AI Proxy timeout | Check URL, API key, CORS headers |
| Chat commands not working | Ensure command starts with `/` and no extra spaces |
| Error in console | Check `CONFIG.Canvas.polygonBackends` exists (v11+ only) |

---

## 11. Version History

**v2.0.0** — Full NPC autopilot with tactical movement, GM narration scanning, condition auto-application, AI proxy, 5-mode UI, split architecture.

**v1.0.0** — Initial release with mode responses, basic UI, rules KB.

---

## License

MIT — Steve / AI Companion for Foundry VTT
