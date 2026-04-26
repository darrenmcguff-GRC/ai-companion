const MODULE_ID = 'ai-companion';

/* ═══════════════════════════════════════════════════════════════════
   AI Companion for Foundry VTT (D&D 5e)
   — Embedded AI Game-Master Agent v2.0.0
   — Local heuristics engine + optional AI proxy + action automation
   ═══════════════════════════════════════════════════════════════════ */

console.log(`%c[AI Companion] v2.0.0 — AI Agent loaded`, 'color:#8b5cf6;font-weight:bold');

/* ─── Settings ──────────────────────────────────────────────────── */
Hooks.on('init', () => {
  game.settings.register(MODULE_ID, 'hudOpen',        { scope:'client', config:false, type:Boolean, default:false });
  game.settings.register(MODULE_ID, 'hudPosition',    { scope:'client', config:false, type:Object,  default:{top:80, right:10} });
  game.settings.register(MODULE_ID, 'hudSize',        { scope:'client', config:false, type:Object,  default:{width:420, height:700} });
  game.settings.register(MODULE_ID, 'popoutOpen',     { scope:'client', config:false, type:Boolean, default:false });
  game.settings.register(MODULE_ID, 'popoutPosition', { scope:'client', config:false, type:Object,  default:{top:100, left:600} });
  game.settings.register(MODULE_ID, 'popoutSize',     { scope:'client', config:false, type:Object,  default:{width:420, height:700} });
  game.settings.register(MODULE_ID, 'mode',           { scope:'client', config:false, type:String,  default:'rules' });

  // AI Proxy settings
  game.settings.register(MODULE_ID, 'apiEnabled',     { scope:'world',  config:true,  type:Boolean, default:false, name:'Enable AI Proxy', hint:'Send chat to an external AI for smarter responses.' });
  game.settings.register(MODULE_ID, 'apiEndpoint',    { scope:'world',  config:true,  type:String,  default:'', name:'AI Proxy URL', hint:'Full URL (e.g. http://localhost:3000/api/chat)' });
  game.settings.register(MODULE_ID, 'apiKey',         { scope:'world',  config:true,  type:String,  default:'', name:'API Key', hint:'Bearer token if required.' });
  game.settings.register(MODULE_ID, 'apiModel',       { scope:'world',  config:true,  type:String,  default:'gpt-4o-mini', name:'LLM Model', hint:'Model name passed to proxy.' });

  // Action automation toggles
  game.settings.register(MODULE_ID, 'npcAutopilot',    { scope:'world', config:true, type:Boolean, default:false, name:'NPC Autopilot', hint:'AI automatically plays NPC turns in combat.' });
  game.settings.register(MODULE_ID, 'gmAssist',         { scope:'world', config:true, type:Boolean, default:true, name:'GM Assist (Chat Scan)', hint:'Scan GM chat for condition/effect mentions and auto-apply them.' });
  game.settings.register(MODULE_ID, 'gmAssistStrict',   { scope:'world', config:true, type:Boolean, default:false, name:'GM Assist Strict Mode', hint:'Only apply effects when GM explicitly confirms via chat prompt.' });
  game.settings.register(MODULE_ID, 'playerAssist',     { scope:'world', config:true, type:Boolean, default:true, name:'Player Assist', hint:'Suggest tactics and answer player /ai questions.' });
  game.settings.register(MODULE_ID, 'autoLoot',         { scope:'world', config:true, type:Boolean, default:false, name:'Auto Loot Suggestions', hint:'Suggest loot after combat ends.' });
  game.settings.register(MODULE_ID, 'aiName',           { scope:'world', config:true, type:String, default:'AI-GM', name:'AI Persona Name', hint:'Name shown in chat when the AI speaks.' });
  game.settings.register(MODULE_ID, 'aiAvatar',         { scope:'world', config:true, type:String, default:'icons/svg/mystery-man.svg', name:'AI Avatar', hint:'Image path for AI chat messages.' });
  game.settings.register(MODULE_ID, 'autoAdvance',      { scope:'world', config:true, type:Boolean, default:true, name:'Auto-Advance Combat', hint:'Automatically end NPC turn and advance to next after autopilot action.' });
  game.settings.register(MODULE_ID, 'npcMovement',      { scope:'world', config:true, type:Boolean, default:true, name:'NPC Autopilot Movement', hint:'NPCs move within weapon range before attacking. Disable for static NPCs.' });
  game.settings.register(MODULE_ID, 'lootTable',        { scope:'world', config:true, type:String, default:'', name:'Loot Table UUID', hint:'Optional RollTable UUID to draw loot suggestions from.' });

  // Hidden state
  game.settings.register(MODULE_ID, 'chatHistory',      { scope:'client', config:false, type:Array, default:[] });
  game.settings.register(MODULE_ID, 'npcBrain',         { scope:'world', config:false, type:Object, default:{} });
  game.settings.register(MODULE_ID, 'pendingEffects',   { scope:'world', config:false, type:Array, default:[] });
});

/* ─── Ready ─────────────────────────────────────────────────────── */
Hooks.on('ready', () => {
  if (game.settings.get(MODULE_ID, 'hudOpen'))    AICompanion.open();
  if (game.settings.get(MODULE_ID, 'popoutOpen')) AICompanion.openPopout();
});

/* ─── Token HUD button ─────────────────────────────────────────── */
Hooks.on('renderTokenHUD', (hud, html) => {
  const $html = html instanceof HTMLElement ? $(html) : html;
  let target = $html.find('.col.left');
  if (!target.length) target = $html;
  const btn = $('<div class="control-icon" title="Open AI Companion"><i class="fas fa-robot"></i></div>');
  btn.on('click', () => { ui.notifications?.info?.('Opening AI Companion…'); AICompanion.open(); });
  target.append(btn);
});

/* ─── Selection / combat / item hooks ──────────────────────────── */
Hooks.on('controlToken',      () => AICompanion.refreshDebounced());
Hooks.on('updateActor',       () => AICompanion.refreshDebounced());
Hooks.on('updateCombat',      () => AICompanion.refreshDebounced());
Hooks.on('dnd5e.useItem',     (item) => AICompanion.onItemUsed(item));
Hooks.on('dnd5e.rollAttack',  (item) => AICompanion.onItemUsed(item));
Hooks.on('dnd5e.rollDamage',  (item) => AICompanion.onItemUsed(item));

/* ═══════════════════════════════════════════════════════════════════
   CHAT HOOKS — THE CORE OF THE AI AGENT
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Intercept outgoing chat messages for /ai commands and GM narration scanning.
 */
Hooks.on('preCreateChatMessage', (document, data, options, userId) => {
  const content = (data.content || '').trim();
  if (!content) return true;

  // ── /ai command interception ──
  if (content.startsWith('/ai ')) {
    const cmd = content.slice(4).trim();
    AICompanion._logCommand(cmd, userId);
    // Suppress the raw /ai message from appearing in chat
    data.content = '';
    // Schedule the AI to respond asynchronously
    setTimeout(() => AICompanion._handleUserCommand(cmd, userId), 50);
  }

  // ── /npc command (quick NPC action by name) ──
  if (content.startsWith('/npc ')) {
    const cmd = content.slice(5).trim();
    data.content = '';
    setTimeout(() => AICompanion._handleNPCCommand(cmd, userId), 50);
  }

  // ── /effect command (quick apply condition) ──
  if (content.startsWith('/effect ')) {
    const cmd = content.slice(8).trim();
    data.content = '';
    setTimeout(() => AICompanion._handleEffectCommand(cmd, userId), 50);
  }

  // ── /roll command (quick roll for actor or monster) ──
  if (content.startsWith('/roll ')) {
    const cmd = content.slice(6).trim();
    data.content = '';
    setTimeout(() => AICompanion._handleRollCommand(cmd, userId), 50);
  }

  return true;
});

/**
 * Observe created chat messages for GM narration scanning and reactions.
 */
Hooks.on('createChatMessage', (message, options, userId) => {
  const user = game.users.get(userId);
  const isGM = user?.isGM ?? false;
  const content = (message.content || '').toLowerCase();

  // GM Assist: scan for condition mentions in GM narration
  if (isGM && game.settings.get(MODULE_ID, 'gmAssist') && content) {
    AICompanion._scanGMNarration(message, userId);
  }

  // Combat reaction: enemy dropped to 0 hp
  if (message.flavor && message.flavor.includes('Damage')) {
    AICompanion._onDamageDealt(message, userId);
  }
});

/**
 * Combat turn hook — NPC Autopilot entry point.
 */
Hooks.on('updateCombat', (combat, changed, options, userId) => {
  if (!game.settings.get(MODULE_ID, 'npcAutopilot')) return;
  if (!combat?.started) return;
  if (!game.user.isGM) return;
  if (changed.turn === undefined && changed.round === undefined) return;

  const combatant = combat.combatant;
  if (!combatant?.token?.actor) return;
  if (combatant.token.actor.hasPlayerOwner) return;

  AICompanion._npcTakeTurn(combatant.token.actor, combatant.token);
  AICompanion._renderAutopilotPanel();
});

/* ═══════════════════════════════════════════════════════════════════
   KNOWLEDGE BASE (Preserved from v1)
   ═══════════════════════════════════════════════════════════════════ */
const KB = {
  conditions: {
    blinded:    "**Blinded** can't see. Auto-fails sight Perception checks. Attack rolls against you have advantage; your attack rolls have disadvantage.",
    charmed:    "**Charmed** — you can't attack the charmer or target them with harmful abilities. The charmer has advantage on social checks against you.",
    deafened:   "**Deafened** can't hear. Auto-fails hearing Perception checks.",
    frightened:  "**Frightened** — disadvantage on ability checks and attack rolls while the source is in line of sight. Can't willingly move closer.",
    grappled:   "**Grappled** — speed becomes 0. Ends if grappler is incapacitated or moved away via forced movement.",
    incapacitated:"**Incapacitated** — can't take actions, bonus actions, or reactions.",
    invisible:  "**Invisible** — impossible to see without special sense. Attack rolls against you have disadvantage; yours have advantage.",
    paralyzed:  "**Paralyzed** — incapacitated, can't move or speak. Auto-crit if attacker is within 5 ft. Auto-fail Str/Dex saves.",
    petrified:  "**Petrified** — turned to stone, incapacitated, can't move or speak. Attackers have advantage. Auto-fail Str/Dex saves. Resist all damage.",
    poisoned:   "**Poisoned** — disadvantage on attack rolls and ability checks.",
    prone:      "**Prone** — can only crawl. Disadvantage on attack rolls. Melee attacks against you have advantage; ranged have disadvantage. Standing costs half movement.",
    restrained: "**Restrained** — speed becomes 0. Disadvantage on attack rolls and Dex saves. Attacks against you have advantage.",
    stunned:    "**Stunned** — incapacitated, can't move, can speak only falteringly. Auto-fail Str/Dex saves. Attacks against you have advantage.",
    unconscious:"**Unconscious** — incapacitated, can't move or speak, prone, unaware. Drops what it's holding. Auto-fail Str/Dex saves. Attacks within 5 ft are auto-crit.",
    concentration:"**Concentrating** — if you take damage, roll a CON save (DC 10 or half damage, whichever is higher). Fail = spell ends. Lose concentration if incapacitated.",
    exhaustion1:"**Exhaustion (1)** — Disadvantage on ability checks.",
    exhaustion2:"**Exhaustion (2)** — Speed halved.",
    exhaustion3:"**Exhaustion (3)** — Disadvantage on attack rolls and saving throws.",
    exhaustion4:"**Exhaustion (4)** — Hit point maximum halved.",
    exhaustion5:"**Exhaustion (5)** — Speed reduced to 0.",
    exhaustion6:"**Exhaustion (6)** — Death."
  },

  rules: {
    advantage:      "**Advantage** means you roll two d20s and take the higher. Sources: help action, being unseen, flanking (optional rule), numerous spells.",
    disadvantage:   "**Disadvantage** means you roll two d20s and take the lower. If you have both, they cancel out. Sources: ranged attack in melee, blindness, restrained, etc.",
    cover:          "**Cover** — Half cover (+2 AC/Dex saves), Three-quarters (+5 AC/Dex saves), Total cover (can't be targeted).",
    flanking:       "**Flanking** (optional DMG rule) — When you and an ally are on opposite sides of an enemy, you both have advantage on melee attacks.",
    surprise:       "**Surprise** — If hidden when combat starts, enemies who didn't notice you are surprised. They can't move or take actions on their first turn.",
    death_saves:    "**Death Saves** — Roll d20 (no modifiers). 10+ = success, 9- = failure. 3 successes = stable. 3 failures = dead. Natural 20 = 1 HP. Natural 1 = 2 failures.",
    resting:        "**Short Rest** (1 hr) — spend Hit Dice to heal. **Long Rest** (8 hrs) — regain all HP, half HD (min 1), all spell slots, most features.",
    opportunity:    "**Opportunity Attack** — When a hostile creature moves out of your reach, you can make one melee attack as a reaction. Costs your reaction for the round.",
    two_weapon:     "**Two-Weapon Fighting** — When you Attack with a light weapon, bonus action attack with another light weapon (no ability mod to damage unless you have the fighting style).",
    dodge:          "**Dodge** action — attacks against you have disadvantage; you make Dex saves with advantage. Ends if incapacitated or speed drops to 0.",
    disengage:      "**Disengage** action — your movement doesn't provoke opportunity attacks for the turn.",
    dash:           "**Dash** action — double your movement for this turn.",
    hide:           "**Hide** action — make a Stealth check contested by passive Perception. If you beat it, you're hidden (unseen / unheard). Attacks from hidden have advantage.",
    ready:          "**Ready** action — prepare a specific action as a reaction. When the trigger occurs, you can choose to act. You can ready a spell (requires concentration).",
    help:           "**Help** action — give an ally advantage on their next ability check, or advantage on their next attack against a creature within 5 ft of you.",
    shove:          "**Shove** (Attack action option) — Str (Athletics) vs. Str (Athletics) or Dex (Acrobatics). Success: target prone or pushed 5 ft.",
    grapple:        "**Grapple** (Attack action option) — Str (Athletics) vs. Str (Athletics) or Dex (Acrobatics). Success: target Grappled (speed 0).",
  },

  tactics: {
    action_economy: "**Action Economy** is the most powerful resource in 5e. A party of 4 has 4 actions, 4 bonus actions, 4 reactions per round. Try to use all of them every round.",
    concentration: "**Concentration spells** are incredibly powerful — buffs, control, summons. Protect your concentration: Dodge, take cover, use Mage Armour, stay at range.",
    focus_fire:    "**Focus fire** — Concentrating damage on one enemy is far more effective than spreading it. A dead enemy deals 0 damage.",
    positioning:   "**Positioning beats stats.** Flank, use choke points, high ground (if DM allows), and stay out of melee as a caster.",
    spell_selection:"**Spell prep** — Prepare a mix: damage, control, utility, buffs. In combat, control spells (Hypnotic Pattern, Web) often out-perform raw damage.",
    saves_vs_ac:   "**Targeting saves vs AC** — If the enemy has high AC but low saves, target INT/WIS/CON saves. Vice versa for high-save enemies.",
    bonus_actions: "**Bonus actions** — Don't waste them. Two-Weapon Fighting, Shield spell, BA heals (Healing Word), Telekinetic shove. Every bonus action used is more output.",
    reactions:     "**Reactions** — Opportunity attacks, Shield, Counterspell, Absorb Elements. Save your reaction for something critical if possible.",
    healer_balance:"**In-combat healing** — Healing Word (bonus action, ranged) is usually better than Cure Wounds. Don't heal above 0 unless someone is going down next turn.",
    death_save_protect:"**Protecting downed allies** — Heal them to 1+ HP before their turn so they don't auto-fail death saves. Healing Word at range is ideal.",
    ranged_melee:  "**Ranged in melee** — You have disadvantage on ranged attack rolls if a hostile creature is within 5 ft. Move away (Disengage or Step of the Wind) first.",
    downed_enemy:  "**Hitting 0 HP enemies** — Two melee attacks within 5 ft = three death save failures = instant death. Great for assassination / coup de grâce situations.",
  },

  lore: {
    magic: "**Magic in the Forgotten Realms** — The Weave is the fabric of magic, maintained by Mystra. Arcane magic manipulates it directly; divine magic channels it through a deity.\n\nCommon phenomena: **Spellplague scars**, **wild magic zones**, **dead magic zones**, **mythals** (ancient protective fields).",
    deities: "**Major Deities of Toril** —\n- **Mystra** (Magic, Knowledge) — Weave keeper\n- **Tyr** (Justice) — Blind paladins' patron\n- **Lathander** (Dawn, Renewal) — Morninglord\n- **Bane** (Tyranny) — Lord of Darkness\n- **Shar** (Darkness, Loss) — Mystra's dark twin\n- **Selûne** (Moon) — Pursuit and prophecy",
    planes: "**The Great Wheel** —\n- **Material Plane** (Toril, Oerth, etc.)\n- **Inner Planes** — Elemental (Fire, Water, Air, Earth), Energy (Positive, Negative)\n- **Outer Planes** — Aligned realms (Celestia, Nine Hells, Abyss, Mechanus…)\n- **Transitive** — Astral, Ethereal, Shadowfell, Feywild",
    monsters: "**Monstrous Lore** — Legendary creatures have **legendary resistances** (auto-succeed a save, 3/day), **lair actions** (initiative 20), and **legendary actions** (reactions between turns).\n\nDragons: breath weapons recharge on 5-6 (d6). Undead: vulnerable to radiant, resistant to necrotic. Aberrations: often have psychic resistance.",
    cities: "**The Sword Coast** — From **Waterdeep** (City of Splendors) to **Baldur's Gate** (mercantile power), the coast is the adventuring heartland. Notable: **Neverwinter** (rebuilding), **Luskan** (pirate city), **Daggerford** (strategic small town).\n\nTo the east: the **Anauroch** desert, **Cormyr** (forest kingdom), **Thay** (red wizard magocracy).",
  }
};

/* ═══════════════════════════════════════════════════════════════════
   MAIN CLASS — AI Companion v2.0
   ═══════════════════════════════════════════════════════════════════ */
class AICompanion {
  static _messages = [];
  static _mode = 'rules';
  static _contextItem = null;
  static _typing = false;
  static _lastTokenId = null;
  static _npcTurnInProgress = false;

  static get actor() {
    const t = this.token;
    return t?.actor ?? t?.document?.actor ?? null;
  }
  static get token() {
    if (!canvas?.tokens) return null;
    const ctrl = canvas.tokens.controlled;
    let t = null;
    if (ctrl) {
      if (typeof ctrl[Symbol.iterator] === 'function') { for (const item of ctrl) { t = item; break; }}
      else if (Array.isArray(ctrl)) t = ctrl[0];
      else if (typeof ctrl.first === 'function') t = ctrl.first();
      else if (ctrl.size > 0) ctrl.forEach(v => { if (!t) t = v; });
    }
    if (!t && this._lastTokenId) t = canvas.tokens.get(this._lastTokenId);
    if (t) this._lastTokenId = t.id;
    return t;
  }

  static _refreshTimer = null;
  static refreshDebounced() {
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this.refresh(), 50);
  }

  /* ── Open sidebar ──────────────────────────────────────────────── */
  static async open() {
    let $el = $('#aic-panel');
    if (!$el.length) {
      const pos = await game.settings.get(MODULE_ID, 'hudPosition');
      const sz  = await game.settings.get(MODULE_ID, 'hudSize');
      const mode = await game.settings.get(MODULE_ID, 'mode');
      this._mode = mode;
      $('body').append(`
        <div id="aic-panel" style="top:${pos.top}px;right:${pos.right}px;width:${sz.width}px;height:${sz.height}px;">
          <div class="aic-header">
            <span><i class="fas fa-robot"></i> AI Companion <span class="aic-badge">${this._modeLabel()}</span></span>
            <div class="aic-actions">
              <i class="fas fa-window-maximize" data-action="popout" title="Pop out"></i>
              <i class="fas fa-cog" data-action="settings" title="Settings"></i>
              <i class="fas fa-times" data-action="close" title="Close"></i>
            </div>
          </div>
          <div class="aic-modes">
            <button class="aic-mode-btn ${mode==='rules'?'active':''}" data-mode="rules">Rules</button>
            <button class="aic-mode-btn ${mode==='tactical'?'active':''}" data-mode="tactical">Tactical</button>
            <button class="aic-mode-btn ${mode==='lore'?'active':''}" data-mode="lore">Lore</button>
            <button class="aic-mode-btn ${mode==='builder'?'active':''}" data-mode="builder">Builder</button>
            <button class="aic-mode-btn ${mode==='autopilot'?'active':''}" data-mode="autopilot">Autopilot</button>
          </div>
          <div class="aic-scroll"></div>
          <div class="aic-input-row">
            <textarea class="aic-input" placeholder="Ask or command the AI…" rows="1"></textarea>
            <button class="aic-btn-send"><i class="fas fa-paper-plane"></i></button>
          </div>
          <div class="aic-resize"></div>
        </div>`);
      $el = $('#aic-panel');
      this._bindDrag('#aic-panel');
      this._bindResize('#aic-panel');
      this._bindEvents();
      await this._loadHistory();
      this._renderMessages();
    }
    await game.settings.set(MODULE_ID, 'hudOpen', true);
    $el.show();
    this.refresh();
    if (this._mode === 'autopilot') this._renderAutopilotPanel();
  }

  static async close() { $('#aic-panel').hide(); await game.settings.set(MODULE_ID, 'hudOpen', false); }

  static async openPopout() {
    $('#aic-panel').hide();
    if (this._popout) { this._popout.render(true); return; }
    this._popout = new AICompanionPopout();
    this._popout.render(true);
    await game.settings.set(MODULE_ID, 'popoutOpen', true);
  }

  static _bindDrag(sel) {
    const $el = $(sel); let dragging=false, sx, sy, sl, st;
    $el.find('.aic-header').on('mousedown.aic-drag', (e) => {
      if (e.target.closest('.aic-actions')) return;
      dragging=true; sx=e.clientX; sy=e.clientY;
      const off=$el.offset(); sl=off.left; st=off.top;
      e.preventDefault();
    });
    const onMove=(e)=>{ if(dragging) $el.css({left:Math.max(0,sl+e.clientX-sx), top:Math.max(0,st+e.clientY-sy)}); };
    const onUp=()=>{ if(dragging){ const o=$el.offset(); game.settings.set(MODULE_ID, sel==='#aic-panel'?'hudPosition':'popoutPosition',{top:Math.round(o.top),left:Math.round(o.left),right:10}); } dragging=false; };
    $(document).off('mousemove.aic-drag mouseup.aic-drag')
      .on('mousemove.aic-drag', onMove).on('mouseup.aic-drag', onUp);
  }
  static _bindResize(sel) {
    const $el = $(sel); let resizing=false, sx, sy, sw, sh;
    $el.find('.aic-resize').on('mousedown.aic-resize', (e)=>{ resizing=true; sx=e.clientX; sy=e.clientY; sw=$el.outerWidth(); sh=$el.outerHeight(); e.preventDefault(); });
    const onMove=(e)=>{ if(resizing) $el.css({width:Math.max(320,sw+e.clientX-sx), height:Math.max(320,sh+e.clientY-sy)}); };
    const onUp=()=>{ if(resizing) game.settings.set(MODULE_ID, sel==='#aic-panel'?'hudSize':'popoutSize',{width:Math.round($el.outerWidth()),height:Math.round($el.outerHeight())}); resizing=false; };
    $(document).off('mousemove.aic-resize mouseup.aic-resize')
      .on('mousemove.aic-resize', onMove).on('mouseup.aic-resize', onUp);
  }

  static _bindEvents() {
    $('#aic-panel [data-action]').off('click.aic').on('click.aic', async function() {
      const action = $(this).data('action');
      if (action==='close') AICompanion.close();
      if (action==='popout') AICompanion.openPopout();
      if (action==='settings') new AICompanionSettings().render(true);
    });
    $('.aic-mode-btn').off('click.aic-mode').on('click.aic-mode', async function() {
      const mode = $(this).data('mode');
      AICompanion._mode = mode;
      await game.settings.set(MODULE_ID, 'mode', mode);
      $('.aic-mode-btn').removeClass('active');
      $(this).addClass('active');
      $('.aic-badge').text(AICompanion._modeLabel());
      AICompanion._pushSystem(`Switched to **${AICompanion._modeLabel()}** mode.`);
      if (mode === 'autopilot') AICompanion._renderAutopilotPanel();
    });
    const send = () => {
      const $input = $('#aic-panel .aic-input');
      const text = $input.val().trim();
      if (!text) return;
      $input.val('');
      AICompanion._pushUser(text);
      AICompanion._respond(text);
    };
    $('.aic-btn-send').off('click.aic').on('click.aic', send);
    $('.aic-input').off('keydown.aic').on('keydown.aic', (e)=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); send(); }});
  }

  static _modeLabel() {
    return {rules:'Rules Lawyer', tactical:'Tactical', lore:'Lore Keeper', builder:'Builder', autopilot:'Autopilot'}[this._mode] || 'Rules Lawyer';
  }

  static _pushUser(text)   { this._messages.push({role:'user', text, ts:Date.now()}); this._renderMessages(); this._saveHistory(); }
  static _pushAI(text)     { this._messages.push({role:'ai', text, ts:Date.now()}); this._renderMessages(); this._saveHistory(); }
  static _pushSystem(text) { this._messages.push({role:'system', text, ts:Date.now()}); this._renderMessages(); this._saveHistory(); }

  static async _saveHistory() { await game.settings.set(MODULE_ID, 'chatHistory', this._messages.slice(-50)); }
  static async _loadHistory() { try { this._messages = (await game.settings.get(MODULE_ID, 'chatHistory')) || []; } catch(e){ this._messages = []; } }

  static _renderMessages() {
    const $sc = $('#aic-panel .aic-scroll, #aic-popout .aic-scroll');
    if (!$sc.length) return;
    const html = this._messages.map(m => {
      if (m.role === 'system') return `<div class="aic-msg aic-msg-system">${m.text}</div>`;
      const cls = m.role === 'user' ? 'aic-msg-user' : 'aic-msg-ai';
      return `<div class="aic-msg ${cls}">${this._mdToHtml(m.text)}</div>`;
    }).join('');
    $sc.html(html);
    $sc.scrollTop($sc[0].scrollHeight);
  }

  static _mdToHtml(text) {
    return text
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/<\/li>\n<li>/g, '</li><li>')
      .replace(/(<li>.+<\/li>)/s, '<ul>$1</ul>');
  }

  /* ── Respond engine ────────────────────────────────────────────── */
  static async _respond(userText) {
    this._typing = true;
    this._renderTyping();
    await new Promise(r => setTimeout(r, 600));
    let response = '';
    const lower = userText.toLowerCase();
    const actor = this.actor;

    // Autopilot mode
    if (this._mode === 'autopilot') {
      response = this._autopilotQuery(lower, actor);
    } else if (this._mode === 'rules') {
      response = this._rulesQuery(lower, actor);
    } else if (this._mode === 'tactical') {
      response = this._tacticalQuery(lower, actor);
    } else if (this._mode === 'lore') {
      response = this._loreQuery(lower, actor);
    } else if (this._mode === 'builder') {
      response = this._builderQuery(lower, actor);
    }

    if (!response) response = this._genericQuery(userText, actor);

    this._typing = false;
    this._pushAI(response);
  }

  static _renderTyping() {
    const $sc = $('#aic-panel .aic-scroll, #aic-popout .aic-scroll');
    if (!$sc.length) return;
    if (!this._typing) { $sc.find('.aic-typing').remove(); return; }
    if ($sc.find('.aic-typing').length) return;
    $sc.append('<div class="aic-typing aic-msg aic-msg-ai"><span></span><span></span><span></span></div>');
    $sc.scrollTop($sc[0].scrollHeight);
  }

  /* ═══════════════════════════════════════════════════════════════════
     MODE: AUTOPILOT (NPC AI)
     ═══════════════════════════════════════════════════════════════════ */
  static _autopilotQuery(lower, actor) {
    if (lower.includes('enable') || lower.includes('on') || lower.includes('start')) {
      game.settings.set(MODULE_ID, 'npcAutopilot', true);
      this._renderAutopilotPanel();
      return "✅ **NPC Autopilot enabled**. I will automatically take NPC turns in combat.";
    }
    if (lower.includes('disable') || lower.includes('off') || lower.includes('stop')) {
      game.settings.set(MODULE_ID, 'npcAutopilot', false);
      this._renderAutopilotPanel();
      return "🛑 **NPC Autopilot disabled**. NPCs will wait for manual control.";
    }
    if (lower.includes('take') || lower.includes('roll') || lower.includes('attack')) {
      if (!actor) return "Select a token first to trigger autopilot action for that NPC.";
      const token = this.token;
      setTimeout(() => this._npcTakeTurn(actor, token), 100);
      return `🎲 Triggering autopilot for **${actor.name}**…`;
    }
    this._renderAutopilotPanel();
    return null;
  }

  /* ═══════════════════════════════════════════════════════════════════
     AUTOPILOT PANEL — Live combat state + current token
     ═══════════════════════════════════════════════════════════════════ */
  static _renderAutopilotPanel() {
    const $sc = $('#aic-panel .aic-scroll, #aic-popout .aic-scroll');
    if (!$sc.length) return;
    if (this._mode !== 'autopilot') return;

    const autopilotOn = game.settings.get(MODULE_ID, 'npcAutopilot');
    const combat = game.combat;
    const active = combat?.started || false;
    const current = combat?.combatant;
    const currentToken = current?.token;
    const currentActor = currentToken?.actor;
    const isNPC = currentActor && !currentActor.hasPlayerOwner;

    let html = `
      <div class="aic-autopilot-header">
        <div class="aic-ap-status-row">
          <span class="aic-ap-toggle ${autopilotOn ? 'on' : 'off'}" data-action="toggle-ap">
            <i class="fas fa-power-off"></i> ${autopilotOn ? 'ON' : 'OFF'}
          </span>
          <span class="aic-ap-combat-status">${active ? '🎲 Combat — Round ' + (combat.round || 1) + ', Turn ' + ((combat.turn || 0) + 1) : 'No combat active'}</span>
        </div>`;

    if (currentToken) {
      const hp = currentActor?.system?.attributes?.hp || {};
      const hpPct = Math.round((hp.value || 0) / (hp.max || 1) * 100);
      const hpColor = hpPct > 50 ? '#4ade80' : hpPct > 25 ? '#facc15' : '#f87171';
      const typeLabel = isNPC ? 'NPC (AI)' : 'Player';
      html += `
        <div class="aic-ap-token-card">
          <img src="${currentToken.texture?.src || currentActor?.img || 'icons/svg/mystery-man.svg'}" alt="">
          <div class="aic-ap-token-info">
            <div class="aic-ap-token-name">${currentToken.name || currentActor?.name || 'Unknown'}</div>
            <div class="aic-ap-token-meta">${typeLabel} | HP <span style="color:${hpColor};font-weight:700;">${hp.value || 0}/${hp.max || '?'}</span> (${hpPct}%)</div>
            <div class="aic-ap-hp-bar"><div style="width:${hpPct}%;background:${hpColor};"></div></div>
          </div>
          ${isNPC && autopilotOn ? `<div class="aic-ap-badge">🤖 AI Turn</div>` : ''}
        </div>`;
    } else if (active) {
      html += `<div class="aic-ap-empty">Waiting for combat to begin…</div>`;
    }

    if (active) {
      const npcs = combat.combatants.filter(c => c.token?.actor && !c.token.actor.hasPlayerOwner);
      if (npcs.length) {
        html += `<div class="aic-ap-npc-list"><div class="aic-ap-section-title">NPCs in Combat (${npcs.length})</div>`;
        for (const c of npcs) {
          const isCurrent = c.token?.id === currentToken?.id;
          const a = c.token?.actor;
          const hp2 = a?.system?.attributes?.hp || {};
          const hp2Pct = Math.round((hp2.value || 0) / (hp2.max || 1) * 100);
          const hp2Color = hp2Pct > 50 ? '#4ade80' : hp2Pct > 25 ? '#facc15' : '#f87171';
          html += `
            <div class="aic-ap-npc-item ${isCurrent ? 'current' : ''}">
              <img src="${c.token?.texture?.src || a?.img || 'icons/svg/mystery-man.svg'}">
              <div class="aic-ap-npc-name">${c.name}</div>
              <div class="aic-ap-npc-hp-bar"><div style="width:${hp2Pct}%;background:${hp2Color};"></div></div>
              <div class="aic-ap-npc-hp" style="color:${hp2Color};">${hp2Pct}%</div>
            </div>`;
        }
        html += '</div>';
      }
    }

    html += `
      <div class="aic-ap-controls">
        ${isNPC && active ? `<button class="aic-ap-btn" data-action="manual-take-turn"><i class="fas fa-play"></i> Take Turn for ${currentToken.name}</button>` : ''}
        <button class="aic-ap-btn secondary" data-action="refresh-status"><i class="fas fa-sync"></i> Refresh Status</button>
      </div>
    </div>`;

    $sc.html(html);

    $sc.find('[data-action="toggle-ap"]').off('click.aic-ap').on('click.aic-ap', () => {
      const now = !game.settings.get(MODULE_ID, 'npcAutopilot');
      game.settings.set(MODULE_ID, 'npcAutopilot', now);
      this._renderAutopilotPanel();
    });
    $sc.find('[data-action="manual-take-turn"]').off('click.aic-ap').on('click.aic-ap', () => {
      const c = game.combat?.combatant;
      if (c?.token?.actor) this._npcTakeTurn(c.token.actor, c.token);
    });
    $sc.find('[data-action="refresh-status"]').off('click.aic-ap').on('click.aic-ap', () => {
      this._renderAutopilotPanel();
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     NPC AUTOPILOT ENGINE
     ═══════════════════════════════════════════════════════════════════ */
  static async _npcTakeTurn(actor, tokenDoc) {
    if (this._npcTurnInProgress) return;
    this._npcTurnInProgress = true;

    try {
      const aiName = game.settings.get(MODULE_ID, 'aiName') || 'AI-GM';
      const doMove = game.settings.get(MODULE_ID, 'npcMovement');
      let moveLog = '';

      // ── Movement Phase ──
      if (doMove && tokenDoc) {
        const enemies = this._findEnemies(actor, tokenDoc);
        const allies = this._findAllies(actor, tokenDoc);
        const hpPct = this._getHPPct(actor);

        // Retreat if critically wounded and surrounded
        if (hpPct < 0.2 && enemies.length >= 2) {
          moveLog = await this._npcRetreat(tokenDoc, enemies);
        } else if (enemies.length) {
          // Move to attack range of weakest enemy
          const sorted = enemies.slice().sort((a, b) => {
            const ha = a.system?.attributes?.hp || {}; const hb = b.system?.attributes?.hp || {};
            return (ha.value || 0) - (hb.value || 0);
          });
          const targetActor = sorted[0];
          const targetToken = targetActor?.getActiveTokens()[0];
          const weapon = actor.items?.find(i => i.type === 'weapon' && i.system?.equipped !== false) || actor.items?.find(i => i.type === 'weapon');
          if (targetToken && weapon) {
            moveLog = await this._npcMoveToTarget(tokenDoc, targetToken, weapon);
          }
        }
      }

      if (moveLog) {
        await this._aiChat(`🏃 ${moveLog}`, { speaker: ChatMessage.getSpeaker({ actor }) });
        await new Promise(r => setTimeout(r, 300));
      }

      // ── Action Phase (existing decision tree) ──
      await this._npcTakeTurnAction(actor, tokenDoc);

    } catch(err) {
      console.error('[AI Companion] NPC autopilot error:', err);
      this._aiChat(`⚠️ Autopilot error: ${err.message}`, { whisper: [game.userId] });
    } finally {
      this._npcTurnInProgress = false;
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     NPC TACTICAL MOVEMENT ENGINE
     ═══════════════════════════════════════════════════════════════════ */
  static async _npcMoveToTarget(selfToken, targetToken, weapon) {
    if (!selfToken || !targetToken || !canvas?.grid) return '';
    const self = selfToken.document || selfToken;
    const target = targetToken.document || targetToken;

    // Get weapon range (ft)
    const range = this._getWeaponRange(weapon);
    const gridDist = canvas.grid.distance || 5;
    const rangeSq = (range / gridDist * canvas.grid.size) ** 2;

    // Current distance squared
    const dx = self.x - target.x; const dy = self.y - target.y;
    const distSq = dx*dx + dy*dy;

    // Already in range
    if (distSq <= rangeSq) return '';

    // Find a reachable point within range, prioritizing flanking
    const speed = selfToken.actor?.system?.attributes?.movement?.walk || 30;
    const maxDistPx = (speed / gridDist) * canvas.grid.size;

    // Try flanking position (opposite side from nearest ally)
    let dest = this._findFlankPosition(self, target);

    // Fallback: move directly toward target, stopping within range
    if (!dest) {
      const angle = Math.atan2(target.y - self.y, target.x - self.x);
      const approachDist = Math.sqrt(rangeSq) * 0.8; // stop slightly inside range
      const totalDist = Math.sqrt(distSq);
      const moveDist = Math.min(maxDistPx, totalDist - approachDist);
      if (moveDist <= 0) return '';
      dest = {
        x: self.x + Math.cos(angle) * moveDist,
        y: self.y + Math.sin(angle) * moveDist
      };
    }

    // Snap to grid
    const snapped = canvas.grid.getSnappedPoint ? canvas.grid.getSnappedPoint({x:dest.x,y:dest.y}, {mode:CONST.GRID_SNAPPING_MODES.CENTER}) : {x:dest.x,y:dest.y};

    // Check collision
    const hasCollision = CONFIG.Canvas.polygonBackends?.move?.testCollision ?
      CONFIG.Canvas.polygonBackends.move.testCollision({x:self.x,y:self.y}, snapped, {type:'move', mode:'any'})
      : false;

    if (hasCollision) {
      // Fallback: move as far as possible along path
      const safe = this._findSafePosition(self, snapped, maxDistPx);
      if (safe) { await self.update({x:safe.x,y:safe.y}); return `${selfToken.name} manoeuvres closer.`; }
      return '';
    }

    await self.update({x:snapped.x,y:snapped.y});
    return `${selfToken.name} advances toward ${targetToken.name}.`;
  }

  static async _npcRetreat(selfToken, enemies) {
    if (!selfToken || !canvas?.grid) return '';
    const self = selfToken.document || selfToken;
    const speed = selfToken.actor?.system?.attributes?.movement?.walk || 30;
    const gridDist = canvas.grid.distance || 5;
    const maxDistPx = (speed / gridDist) * canvas.grid.size;

    // Calculate average enemy position
    let ex = 0, ey = 0;
    for (const e of enemies) { const t = e?.getActiveTokens()[0]; if(t){ex += (t.document?.x||t.x); ey += (t.document?.y||t.y);} }
    ex /= enemies.length; ey /= enemies.length;

    // Move directly away from enemy cluster
    const angle = Math.atan2(self.y - ey, self.x - ex);
    const dest = { x: self.x + Math.cos(angle) * maxDistPx, y: self.y + Math.sin(angle) * maxDistPx };
    const snapped = canvas.grid.getSnappedPoint ? canvas.grid.getSnappedPoint({x:dest.x,y:dest.y}, {mode:CONST.GRID_SNAPPING_MODES.CENTER}) : dest;

    const hasCollision = CONFIG.Canvas.polygonBackends?.move?.testCollision ?
      CONFIG.Canvas.polygonBackends.move.testCollision({x:self.x,y:self.y}, snapped, {type:'move', mode:'any'})
      : false;

    if (hasCollision) {
      const safe = this._findSafePosition(self, snapped, maxDistPx);
      if (safe) { await self.update({x:safe.x,y:safe.y}); return `${selfToken.name} falls back cautiously.`; }
      return `${selfToken.name} holds position.`;
    }

    await self.update({x:snapped.x, y:snapped.y});
    return `${selfToken.name} retreats from the fray.`;
  }

  static _findFlankPosition(self, target) {
    // Find nearest ally to target
    const allies = canvas?.tokens?.placeables?.filter(t => t.id !== self.id && !t.actor?.hasPlayerOwner);
    if (!allies?.length) return null;

    let nearest = null; let minD = Infinity;
    for (const a of allies) {
      const d = Math.hypot((a.document?.x||a.x) - target.x, (a.document?.y||a.y) - target.y);
      if (d < minD) { minD = d; nearest = a; }
    }
    if (!nearest) return null;

    // Position on opposite side of target from ally
    const ax = nearest.document?.x || nearest.x;
    const ay = nearest.document?.y || nearest.y;
    const flipX = target.x + (target.x - ax);
    const flipY = target.y + (target.y - ay);

    return { x: flipX, y: flipY };
  }

  static _findSafePosition(self, targetDest, maxDist) {
    // Ray-cast in small steps toward target, stop before first wall
    const steps = 20;
    const dx = targetDest.x - self.x;
    const dy = targetDest.y - self.y;
    const dist = Math.hypot(dx, dy);
    const stepDist = Math.min(dist / steps, maxDist / steps);

    for (let i = steps; i >= 1; i--) {
      const f = (i / steps) * Math.min(1, maxDist / (dist || 1));
      const px = self.x + dx * f;
      const py = self.y + dy * f;
      const hasCollision = CONFIG.Canvas.polygonBackends?.move?.testCollision ?
        CONFIG.Canvas.polygonBackends.move.testCollision({x:self.x,y:self.y}, {x:px,y:py}, {type:'move', mode:'any'})
        : false;
      if (!hasCollision) return {x:px, y:py};
    }
    return null;
  }

  static _getWeaponRange(weapon) {
    if (!weapon) return 5;
    const sys = weapon.system || {};
    const range = sys.range;
    if (range?.value) return parseInt(range.value) || 5;
    // Check for properties
    const props = sys.properties || [];
    if (props.includes('rch')) return 10;
    if (props.includes('thr')) return (sys.range?.long || 60);
    return 5;
  }

  static async _npcTakeTurnAction(actor, tokenDoc) {
    const enemies = this._findEnemies(actor, tokenDoc);
    const allies = this._findAllies(actor, tokenDoc);
    const hpPct = this._getHPPct(actor);
    const items = actor.items?.contents || [];
    const spells = items.filter(i => i.type === 'spell');
    const weapons = items.filter(i => i.type === 'weapon');
    const features = items.filter(i => i.type === 'feat');

    let action = null;
    let target = null;

    // Priority 1: Heal if critical
    const healSpell = spells.find(s => {
      const n = s.name.toLowerCase();
      return n.includes('cure') || n.includes('healing word') || n.includes('aid');
    });
    const woundedAlly = allies.find(a => this._getHPPct(a) < 0.3);
    if (hpPct < 0.25 && healSpell) {
      action = { type: 'spell', item: healSpell, target: actor };
    } else if (woundedAlly && healSpell && hpPct > 0.4) {
      action = { type: 'spell', item: healSpell, target: woundedAlly };
    }

    // Priority 2: Buff/debuff
    if (!action) {
      const buffSpell = spells.find(s => {
        const n = s.name.toLowerCase();
        return n.includes('haste') || n.includes('bless') || n.includes('shield of faith') || n.includes('bane');
      });
      if (buffSpell && hpPct > 0.3) {
        action = { type: 'spell', item: buffSpell, target: enemies[0] || allies[0] || actor };
      }
    }

    // Priority 3: Attack
    if (!action) {
      const weapon = weapons.find(w => w.system?.equipped !== false) || weapons[0] || features[0];
      if (weapon && enemies.length) {
        const sorted = enemies.slice().sort((a, b) => {
          const ha = a.system?.attributes?.hp || {}; const hb = b.system?.attributes?.hp || {};
          return (ha.value || 0) - (hb.value || 0);
        });
        target = sorted[0];
        action = { type: 'attack', item: weapon, target };
      }
    }

    // Priority 4: Dodge
    if (!action && hpPct < 0.25) action = { type: 'dodge' };

    // Execute
    if (!action) {
      await this._aiChat(`🎲 **${actor.name}** takes no action — no valid target.`, { speaker: ChatMessage.getSpeaker({ actor }) });
    } else if (action.type === 'spell') {
      await this._npcCastSpell(actor, action.item, action.target);
    } else if (action.type === 'attack') {
      await this._npcAttack(actor, action.item, action.target);
    } else if (action.type === 'dodge') {
      await this._aiChat(`🛡️ ${actor.name} takes the **Dodge** action.`, { speaker: ChatMessage.getSpeaker({ actor }) });
    }

    if (game.settings.get(MODULE_ID, 'autoAdvance') && game.combat?.combatant?.token?.id === tokenDoc?.id) {
      setTimeout(() => game.combat.nextTurn(), 800);
    }
  }

  static async _npcAttack(actor, weapon, target) {
    try {
      const item = typeof weapon === 'string' ? actor.items.getName(weapon) : weapon;
      if (!item) return { text: `${actor.name} has no weapon.` };
      // dnd5e v3+ activities
      const activity = item.system?.activities?.contents?.[0];
      if (activity && typeof activity.use === 'function') {
        await activity.use({}, { configure: false });
      } else {
        // legacy fallback: announce attack and roll
        const roll = await new Roll(`1d20 + ${this._getAtkBonus(actor, item)}`).evaluate();
        const flavor = `${actor.name} attacks ${target?.name || 'target'} with ${item.name}`;
        await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor });
      }
      return { text: `${actor.name} attacked with ${item.name}.` };
    } catch(e) {
      return { text: `Attack failed: ${e.message}` };
    }
  }

  static async _npcCastSpell(actor, spell, target) {
    try {
      const item = typeof spell === 'string' ? actor.items.getName(spell) : spell;
      if (!item) return { text: `${actor.name} doesn't know that spell.` };
      const activity = item.system?.activities?.contents?.[0];
      if (activity && typeof activity.use === 'function') {
        await activity.use({}, { configure: false });
      } else {
        const roll = await new Roll(item.system?.damage?.parts?.[0]?.[0] || '1d6').evaluate();
        await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `${actor.name} casts ${item.name} on ${target?.name || 'target'}.` });
      }
      return { text: `${actor.name} cast ${item.name}.` };
    } catch(e) {
      return { text: `Spell failed: ${e.message}` };
    }
  }

  static _findEnemies(actor, selfToken) {
    return canvas?.tokens?.placeables
      ?.filter(t => t.actor && t.actor.hasPlayerOwner && t.id !== selfToken?.id)
      ?.map(t => t.actor) || [];
  }
  static _findAllies(actor, selfToken) {
    return canvas?.tokens?.placeables
      ?.filter(t => t.actor && !t.actor.hasPlayerOwner && t.id !== selfToken?.id)
      ?.map(t => t.actor) || [];
  }
  static _getHPPct(actor) {
    const hp = actor?.system?.attributes?.hp || {};
    return (hp.value || 0) / (hp.max || 1);
  }
  static _getAtkBonus(actor, item) {
    const sys = item?.system || {};
    const ability = sys.ability || actor?.system?.attributes?.attackBonus || 'str';
    const mod = actor?.system?.abilities?.[ability]?.mod || 0;
    const prof = sys.prof?.multiplier ? (actor?.system?.attributes?.prof || 0) : 0;
    return mod + prof;
  }

  /* ═══════════════════════════════════════════════════════════════════
     COMMAND HANDLERS (Chat Hooks)
     ═══════════════════════════════════════════════════════════════════ */
  static _logCommand(cmd, userId) {
    console.log(`[AI Companion] /ai command from ${userId}: ${cmd}`);
  }

  static async _handleUserCommand(cmd, userId) {
    const lower = cmd.toLowerCase();

    // Direct action commands
    if (lower.startsWith('roll ')) { this._handleRollCommand(cmd.slice(5), userId); return; }
    if (lower.startsWith('cast ')) { this._handleCastCommand(cmd.slice(5), userId); return; }
    if (lower.startsWith('attack ')) { this._handleAttackCommand(cmd.slice(7), userId); return; }
    if (lower.startsWith('apply ')) { this._handleApplyCommand(cmd.slice(6), userId); return; }
    if (lower.startsWith('move ')) { this._handleMoveCommand(cmd.slice(5), userId); return; }
    if (lower.startsWith('initiative') || lower.startsWith('init')) {
      const actor = this.actor; if (!actor) { this._reply('Select a token first.'); return; }
      const combatant = game.combat?.combatants?.find(c => c.token?.actor?.id === actor.id);
      if (combatant) { await combatant.rollInitiative(); }
      else { this._reply(`${actor.name} is not in combat yet. Add them to the tracker first.`); }
      return;
    }

    // Help / knowledge query — route through existing response engine
    const actor = this.actor;
    let response = this._rulesQuery(lower, actor) || this._tacticalQuery(lower, actor)
                || this._loreQuery(lower, actor) || this._builderQuery(lower, actor)
                || this._genericQuery(cmd, actor);
    
    // If no local answer and AI proxy enabled, forward to proxy
    if (!response || (response && response.includes('your AI Companion'))) {
      const proxy = await this._callProxy(cmd);
      if (proxy) response = proxy;
    }

    this._reply(response);
  }

  static async _handleNPCCommand(cmd, userId) {
    const parts = cmd.split(' ');
    const npcName = parts[0];
    const action = parts.slice(1).join(' ').toLowerCase();
    const actor = game.actors.getName(npcName) || canvas?.tokens?.placeables?.find(t => t.name === npcName)?.actor;
    if (!actor) { this._reply(`NPC "${npcName}" not found. Use exact name.`); return; }

    const token = canvas?.tokens?.placeables?.find(t => t.actor?.id === actor.id);

    if (action.includes('attack') || action.includes('hit')) {
      const targetName = action.replace(/attack|hit/, '').trim();
      const target = game.actors.getName(targetName) || canvas?.tokens?.placeables?.find(t => t.name === targetName)?.actor;
      const weapon = actor.items?.find(i => i.type === 'weapon');
      await this._npcAttack(actor, weapon, target);
    } else if (action.includes('cast')) {
      const spellName = action.replace(/cast/, '').trim();
      const spell = actor.items?.find(i => i.type === 'spell' && i.name.toLowerCase().includes(spellName));
      if (spell) await this._npcCastSpell(actor, spell, null);
      else this._reply(`${actor.name} doesn't have a spell matching "${spellName}".`);
    } else if (action.includes('move') || action.includes('go')) {
      this._reply(`NPC movement not yet implemented via chat command. Drag the token manually.`);
    } else {
      this._reply(`Unclear command for **${actor.name}**. Try: attack [target], cast [spell], or describe the action.`);
    }
  }

  static async _handleEffectCommand(cmd, userId) {
    const parts = cmd.split(' on ');
    const condition = parts[0].trim().toLowerCase();
    const targetName = (parts[1] || '').trim();
    let targetActor = this.actor;
    if (targetName) targetActor = game.actors.getName(targetName) || canvas?.tokens?.placeables?.find(t => t.name === targetName)?.actor;
    if (!targetActor) { this._reply(`Target "${targetName}" not found.`); return; }

    const result = await this._applyCondition(condition, targetActor);
    this._reply(result);
  }

  static async _handleRollCommand(cmd, userId) {
    const parts = cmd.split(' ');
    const actorName = parts[0];
    let actor = game.actors.getName(actorName);
    if (!actor) actor = this.actor;
    if (!actor) { this._reply('No actor found. Select a token or specify a name.'); return; }

    const rollType = parts[1]?.toLowerCase();
    const ability = parts[2]?.toLowerCase();

    if (rollType === 'attack') {
      const weapon = actor.items?.find(i => i.type === 'weapon');
      await this._npcAttack(actor, weapon, null);
    } else if (rollType === 'save') {
      await actor.rollAbilitySave(ability || 'dex');
    } else if (rollType === 'skill') {
      const skillKey = Object.keys(CONFIG.DND5E?.skills || {}).find(k => k.startsWith(ability?.slice(0,3)));
      if (skillKey) await actor.rollSkill(skillKey);
      else this._reply(`Unknown skill "${ability}".`);
    } else if (rollType === 'initiative' || rollType === 'init') {
      const combatant = game.combat?.combatants?.find(c => c.token?.actor?.id === actor.id);
      if (combatant) await combatant.rollInitiative();
      else this._reply(`${actor.name} is not in combat. Add them first.`);
    } else {
      const formula = cmd; // try as raw formula
      const roll = await new Roll(formula, actor.getRollData()).evaluate();
      await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }) });
    }
  }

  static async _handleCastCommand(cmd, userId) {
    const actor = this.actor;
    if (!actor) { this._reply('Select a token first.'); return; }
    const spellName = cmd.toLowerCase().trim();
    const spell = actor.items?.find(i => i.type === 'spell' && i.name.toLowerCase().includes(spellName));
    if (!spell) { this._reply(`${actor.name} doesn't have "${spellName}".`); return; }
    await this._npcCastSpell(actor, spell, null);
  }

  static async _handleAttackCommand(cmd, userId) {
    const actor = this.actor;
    if (!actor) { this._reply('Select a token first.'); return; }
    const weapon = actor.items?.find(i => i.type === 'weapon' && i.name.toLowerCase().includes(cmd.trim().toLowerCase())) || actor.items?.find(i => i.type === 'weapon');
    if (!weapon) { this._reply(`${actor.name} has no weapon.`); return; }
    const activity = weapon.system?.activities?.contents?.[0];
    if (activity && typeof activity.use === 'function') await activity.use({}, { configure: false });
    else {
      const roll = await new Roll(`1d20 + ${this._getAtkBonus(actor, weapon)}`).evaluate();
      await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `${actor.name} attacks with ${weapon.name}` });
    }
  }

  static async _handleApplyCommand(cmd, userId) {
    const parts = cmd.split(' to ');
    const condition = parts[0].trim().toLowerCase();
    let actor = this.actor;
    if (parts[1]) {
      actor = game.actors.getName(parts[1].trim()) || canvas?.tokens?.placeables?.find(t => t.name === parts[1].trim())?.actor;
    }
    if (!actor) { this._reply('No target found.'); return; }
    const res = await this._applyCondition(condition, actor);
    this._reply(res);
  }

  static async _handleMoveCommand(cmd, userId) {
    this._reply('Token movement via chat command is not yet implemented. Drag the token on the canvas.');
  }

  /* ═══════════════════════════════════════════════════════════════════
     GM ASSIST — Scan narration for conditions and apply them
     ═══════════════════════════════════════════════════════════════════ */
  static async _scanGMNarration(message, userId) {
    const content = (message.content || '').toLowerCase();
    const conditions = Object.keys(KB.conditions).filter(c => !c.startsWith('exhaustion'));
    const matched = [];
    for (const cond of conditions) {
      if (content.includes(cond)) matched.push(cond);
    }
    // Also check for exhaustion mentions
    if (/exhausted?|exhaustion/.test(content)) matched.push('exhaustion1');

    if (!matched.length) return;

    // Try to find an actor mentioned near the condition
    const tokens = canvas?.tokens?.placeables || [];
    let target = null;
    for (const token of tokens) {
      if (content.includes(token.name.toLowerCase())) { target = token.actor; break; }
    }
    // Default to selected or GM's target
    if (!target && game.user.targets?.size) {
      target = game.user.targets.first().actor;
    }
    if (!target && this.actor) target = this.actor;
    if (!target) return;

    const strict = game.settings.get(MODULE_ID, 'gmAssistStrict');
    if (strict) {
      // Post a button for the GM to confirm
      this._aiChat(`📌 **GM Assist detected conditions** for **${target.name}**: ${matched.join(', ')}. \n[Accept] [Reject]`, { whisper: [userId] });
      return;
    }

    for (const cond of matched) {
      await this._applyCondition(cond, target);
    }
    this._aiChat(`✅ Applied conditions to **${target.name}**: ${matched.join(', ')}`, { whisper: [userId] });
  }

  static async _applyCondition(condition, actor) {
    const condKey = condition.replace(/ /g, '');
    if (!KB.conditions[condition]) return `Unknown condition: **${condition}**`;

    // Use Foundry's built-in status effect toggles if possible
    const tokenDoc = actor.getActiveTokens()[0]?.document;
    if (tokenDoc) {
      try {
        await tokenDoc.toggleActiveEffect({ id: condition, name: condition }, { active: true });
        return `✅ Applied **${condition}** to **${actor.name}**.`;
      } catch(e) {
        // Fall through to manual effect
      }
    }

    // Manual active effect fallback
    const effectData = {
      name: `AI: ${condition}`,
      icon: `icons/svg/${condition}.svg`,
      origin: actor.uuid,
      duration: { rounds: 10, startRound: game.combat?.round ?? 0 },
      statuses: [condition],
      disabled: false
    };
    try {
      await actor.createEmbeddedDocuments('ActiveEffect', [effectData]);
      return `✅ Created effect **${condition}** on **${actor.name}**.`;
    } catch(e) {
      return `⚠️ Failed to apply ${condition}: ${e.message}`;
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     COMBAT REACTIONS — Damage dealt notifications
     ═══════════════════════════════════════════════════════════════════ */
  static async _onDamageDealt(message, userId) {
    if (!game.settings.get(MODULE_ID, 'playerAssist')) return;
    const rolls = message.rolls || [];
    if (!rolls.length) return;
    const total = rolls[0].total || 0;
    const actor = message.speaker?.token?.actor || message.speaker?.actor;
    if (!actor) return;

    // Suggest tactical reaction
    if (total > 40) {
      this._aiChat(`💥 **Massive damage!** ${actor?.name || 'Target'} took **${total}** — check if concentration breaks (CON save DC ${Math.max(10, Math.floor(total / 2))}).`, { whisper: [game.userId] });
    }
  }

  /* ── AI Proxy call ─────────────────────────────────────────────── */
  static async _callProxy(prompt) {
    if (!game.settings.get(MODULE_ID, 'apiEnabled')) return null;
    const endpoint = game.settings.get(MODULE_ID, 'apiEndpoint');
    if (!endpoint) return null;
    const key = game.settings.get(MODULE_ID, 'apiKey');
    const model = game.settings.get(MODULE_ID, 'apiModel');

    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { 'Authorization': `Bearer ${key}` } : {})
        },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] })
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      return data.choices?.[0]?.message?.content || data.content || data.response || null;
    } catch(e) {
      return null;
    }
  }

  /* ── Chat helper ───────────────────────────────────────────────── */
  static async _aiChat(content, { speaker = null, whisper = [] } = {}) {
    const name = game.settings.get(MODULE_ID, 'aiName') || 'AI-GM';
    const aliasSpeaker = speaker ?? ChatMessage.getSpeaker({ alias: name });
    const chatData = {
      user: game.userId,
      speaker: aliasSpeaker,
      content: `<p>${content}</p>`,
      type: CONST.CHAT_MESSAGE_TYPES.OTHER,
      whisper: whisper.length ? whisper.map(u => typeof u === 'string' ? u : u.id) : []
    };
    await ChatMessage.create(chatData);
  }

  static async _reply(text) {
    const reply = `<div class="ai-response">${text}</div>`;
    const msg = await ChatMessage.create({
      user: game.userId,
      speaker: ChatMessage.getSpeaker({ alias: game.settings.get(MODULE_ID, 'aiName') || 'AI-GM' }),
      content: reply,
      type: CONST.CHAT_MESSAGE_TYPES.OTHER
    });
    // Also push to panel
    this._pushAI(text);
    return msg;
  }

  /* ═══════════════════════════════════════════════════════════════════
     MODE RESPONSES (unchanged from v1 + expanded)
     ═══════════════════════════════════════════════════════════════════ */
  static _rulesQuery(lower, actor) {
    // 1. Spell lookups by name (5etools)
    const spellMatch = lower.match(/(?:about|what is|lookup|cast|use)\s+([a-z][a-z'\-/ ]{1,30})/);
    if (spellMatch) {
      const name = spellMatch[1].trim().replace(/\bspell\b/,'').trim()
        .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const data = KB.lookupSpell(name);
      if (data) return KB.formatSpell(name);
    }
    // 2. Monster lookups
    const monsterMatch = lower.match(/(?:about|what is|stats for|tell me about)\s+([a-z][a-z'\-/ ]{1,30})/);
    if (monsterMatch) {
      const name = monsterMatch[1].trim().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const data = KB.lookupMonster(name);
      if (data) return KB.summarizeMonster(name);
    }
    // 3. Item lookups
    const itemMatch = lower.match(/(?:about|what is|stats for)\s+([a-z][a-z'\-/ ]{1,30})/);
    if (itemMatch) {
      const name = itemMatch[1].trim().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const data = KB.lookupItem(name);
      if (data) return KB.formatItem(name);
    }
    // 4. Condition lookups (5etools conditions)
    for (const [key, desc] of Object.entries(KB.conditions)) {
      if (lower.includes(key.toLowerCase()) || lower.includes(key.toLowerCase().replace('ed','')) || lower.includes(key.toLowerCase().replace('ing',''))) return desc;
    }
    // 5. Action lookups (5etools)
    for (const [key, desc] of Object.entries(KB.actions)) {
      if (lower.includes(key.toLowerCase())) return desc;
    }
    // 6. Skill lookups (5etools)
    for (const [key, desc] of Object.entries(KB.skills)) {
      if (lower.includes(key.toLowerCase())) return desc;
    }
    // 7. Legacy rules
    for (const [key, desc] of Object.entries(KB.rules)) {
      if (lower.includes(key.replace('_',' '))) return desc;
    }
    if (/advantage|disadvantage/.test(lower)) return KB.rules.advantage + '\n\n' + KB.rules.disadvantage;
    if (/cover/.test(lower)) return KB.rules.cover;
    if (/death saves?|dying|0 hp|zero hp/.test(lower)) return KB.rules.death_saves;
    if (/opportunity attack|attack of opportunity/.test(lower)) return KB.rules.opportunity;
    if (/concentration|conc/.test(lower)) return KB.conditions.Concentration || KB.concentration;
    if (/short rest|long rest/.test(lower)) return KB.rules.resting;
    if (/grapple|shove|trip/.test(lower)) return KB.rules.grapple + '\n\n' + KB.rules.shove;
    if (/dodge|dash|disengage|hide|ready|help/.test(lower)) {
      for (const [k,v] of Object.entries(KB.rules)) if (lower.includes(k)) return v;
    }
    if (actor) {
      const effects = actor.effects?.filter(e => !e.disabled) || [];
      for (const e of effects) {
        const name = (e.name || e.label || '').toLowerCase();
        for (const [key, desc] of Object.entries(KB.conditions)) {
          if (name.includes(key.toLowerCase())) return `You're currently affected by: ${desc}\n\n*Tip: Ask "How do I end ${key}?" for removal advice.*`;
        }
      }
    }
    return null;
  }

  static _tacticalQuery(lower, actor) {
    for (const [key, desc] of Object.entries(KB.tactics)) {
      if (lower.includes(key.replace('_',' '))) return desc;
    }
    if (actor) {
      const sys = actor.system || {};
      const hp = sys.attributes?.hp || {};
      const hpPct = (hp.value || 0) / (hp.max || 1);
      if (game.combat && game.combat.started) {
        const combatant = game.combat.combatant;
        const isTurn = combatant?.token?.id === this.token?.id;
        if (isTurn) {
          let advice = "It's your turn!\n\n";
          const actions = [];
          if (hpPct < 0.25) actions.push("⚠️ You're below 25% HP. Consider: **Dodge**, **Disengage** to safety, or use **Healing Word** (bonus action) if available.");
          if (hpPct < 0.5) actions.push("⚡ You're bloodied. Consider positioning behind allies or using **Dodge** if low on healing.");
          // Use 5etools spell knowledge to suggest relevant prepared spells
          for (const item of actor.items?.filter(i => i.type === 'spell') || []) {
            const sname = item.name;
            const kbSpell = KB.lookupSpell(sname);
            if (!kbSpell) continue;
            // Suggest key spells by type
            if (['Shield', 'Absorb Elements', 'Counterspell', 'Silvery Barbs'].includes(sname)) {
              actions.push(`🛡️ You have **${sname}** prepared — save your reaction for it. ${kbSpell.l ? `(Lv ${kbSpell.l})` : ''}`);
            } else if (['Healing Word', 'Mass Healing Word', 'Prayer of Healing'].includes(sname)) {
              actions.push(`💚 **${sname}** is a bonus action — great for picking up downed allies.`);
            } else if (['Fireball', 'Lightning Bolt', 'Cone of Cold', 'Synaptic Static'].includes(sname)) {
              actions.push(`💥 **${sname}** ready — look for clustered enemies. ${kbSpell.dmg?.length ? `(${kbSpell.dmg.join('/')})` : ''}`);
            } else if (['Hold Person', 'Hypnotic Pattern', 'Web', 'Entangle', 'Faerie Fire', 'Bless', 'Bane', 'Silence', 'Spirit Guardians'].includes(sname)) {
              actions.push(`✨ **${sname}** — strong crowd control. ${kbSpell.st?.length ? `Save: ${kbSpell.st.join('/')}` : ''}`);
            }
          }
          if (actions.length === 0) advice += "Focus fire with your strongest attacks and protect your action economy!";
          else advice += actions.join('\n\n');
          return advice;
        }
      }
      if (hpPct <= 0) return "💀 You're unconscious! Roll **death saves** (d20, 10+ = success, 3 successes = stable, 3 failures = dead).";
    }
    return null;
  }

  static _loreQuery(lower, actor) {
    if (/deity|god|temple|shrine/.test(lower)) return KB.lore.deities;
    if (/plane|cosmology|outer|inner/.test(lower)) return KB.lore.planes;
    if (/monster|creature|beast|dragon|undead/.test(lower)) return KB.lore.monsters;
    if (/city|town|region|location|place/.test(lower)) return KB.lore.cities;
    if (/spell|magic|arcane|divine/.test(lower)) return KB.lore.magic;
    return null;
  }

  static _builderQuery(lower, actor) {
    if (/build|optimis|min-max|level up|feat|asi/.test(lower)) {
      let reply = "**Character Building Tips**:\n\n";
      if (actor) {
        const cls = actor.items?.find(i => i.type==='class');
        const lvl = cls?.system?.levels || 1;
        reply += `You're a **${cls?.name || 'Unknown'} ${lvl}**.\n\n`;
        const className = cls?.name?.toLowerCase() || '';
        if (className.includes('fighter')) reply += "- **Feats**: Sentinel, GWM, Lucky. **ASI**: Str/Dex → Con.";
        else if (className.includes('wizard')) reply += "- **Feats**: War Caster, Lucky, Resilient(Con). **ASI**: Int max first.";
        else if (className.includes('cleric')) reply += "- **Feats**: War Caster, Resilient(Con), Healer. **ASI**: Wis max.";
        else if (className.includes('paladin')) reply += "- **Feats**: Sentinel, GWM, Polearm Master. **ASI**: Str or Cha.";
        else if (className.includes('rogue')) reply += "- **Feats**: Lucky, Sharpshooter. **ASI**: Dex max.";
        else reply += "- Max primary attack stat (Str/Dex/Int/Wis/Cha) first. Con to 14-16.";
      } else {
        reply += "- Max primary stat first. Con to 14-16. Feats: War Caster (casters), Lucky, Sentinel.";
      }
      return reply;
    }
    if (/background|story|flaw|ideal|bond/.test(lower)) {
      return "**Background Design** — Tie your flaw/ideal/bond into the campaign. Great backgrounds give the DM story levers. Backgrounds grant skill proficiencies, tools, languages, and a feature (e.g., Criminal Contact).";
    }
    if (/multiclass|dip|splash/.test(lower)) {
      return "**Multiclassing** — Requires 13 in new class's primary stat. Popular dips: Fighter 1-2 (Action Surge), Warlock 2 (Agonizing Blast), Paladin 2 (Divine Smite), Rogue 1 (Expertise).";
    }
    if (/weapon|armour|equipment|gear|buy/.test(lower)) {
      return "**Equipment Quick-Guide**:\n- Martial weapons > Simple (higher dice)\n- Heavy armor: Plate (AC 18, needs Str 15)\n- Shield: +2 AC — always worth it for casters\n- Healing potions, rope, ball bearings — essentials";
    }
    return null;
  }

  static _genericQuery(text, actor) {
    const lower = text.toLowerCase();
    if (this._contextItem) {
      const item = this._contextItem;
      const name = item.name || 'item';
      const type = item.type || 'item';
      const sys = item.system || {};
      if (/how|what|use|cast|when/.test(lower)) {
        let reply = `**${name}** (${type})\n\n`;
        if (type === 'spell') {
          const kbSpell = KB.lookupSpell(name);
          if (kbSpell) {
            reply += KB.formatSpell(name) + '\n\n';
            // Add tactical advice if available
            const adviceKey = Object.keys(KB.spell_advice).find(k => name.toLowerCase().includes(k));
            if (adviceKey) reply += KB.spell_advice[adviceKey] + '\n\n';
          } else {
            const lvl = sys.level || 0;
            const school = (sys.school || '').toUpperCase();
            const range = sys.range?.value || 'Self';
            reply += `Level ${lvl} ${school} spell | ${range}\n\n`;
          }
          reply += (sys.description?.value?.substring(0, 300) + '…') || '';
        } else if (type === 'weapon') {
          const kbItem = KB.lookupItem(name);
          if (kbItem) reply += KB.formatItem(name) + '\n';
          reply += `Deals ${sys.damage?.parts?.[0]?.[0] || 'unknown'} damage.`;
          if (sys.properties?.includes('finesse')) reply += ' **Finesse**: Use Dex for attack/damage.';
        } else {
          const kbItem = KB.lookupItem(name);
          if (kbItem) reply += KB.formatItem(name) + '\n';
          reply += sys.description?.value?.substring(0, 400) + '…' || 'No description.';
        }
        this._contextItem = null;
        return reply;
      }
    }
    const spellAdvice = this._spellAdvice(lower);
    if (spellAdvice) return spellAdvice;
    for (const [key, desc] of Object.entries(KB.conditions)) {
      if (lower.includes(key.replace('exhaustion', 'exhaust')) || lower.includes(key)) return desc + '\n\n*Ask "How do I end this?" for removal advice.*';
    }
    if (actor) {
      const sys = actor.system || {};
      const hp = sys.attributes?.hp || {};
      const hpPct = (hp.value || 0) / (hp.max || 1);
      let ctx = `You're controlling **${actor.name}** (`;
      const cls = actor.items?.find(i => i.type==='class');
      ctx += cls ? `${cls.name} ${cls.system?.levels || '?'}` : 'Unknown class';
      ctx += `). HP: ${hp.value}/${hp.max} (${Math.round(hpPct*100)}%).\n\n`;
      ctx += "Try asking about **conditions**, **spells**, **combat tactics**, or **rules**.";
      return ctx;
    }
    return "I'm your AI Companion! Ask me about **D&D 5e rules**, **combat tactics**, **spell advice**, **lore**, or **character building**. Select a token for contextual help.\n\n**New commands:** `/ai attack`, `/ai cast [spell]`, `/ai apply [condition]`, `/npc [name] attack [target]`, `/effect [condition] on [target]`.";
  }

  static _spellAdvice(spellName) {
    // Prefer 5etools enriched data
    for (const [key, advice] of Object.entries(KB.spell_advice)) {
      if (spellName.includes(key)) return advice;
    }
    // Fallback hardcoded (now mostly redundant)
    const db = {
      'fireball': "**Fireball** — 8d6 fire, 20-ft radius. Clustered enemies only.\n⚡ Open with it if enemies bunched.\n💡 Sculpt Spells (Evoker) protects allies. Empowered Evocation adds INT to damage.",
      'shield': "**Shield** — +5 AC until your next turn. Reaction.\n⚡ The best 1st-level spell. When hit by <5.\n💡 If you have low HP or are concentrating, Shield early and often.",
      'counterspell': "**Counterspell** — Reaction to interrupt a spell.\n⚡ Counter crowd control and healing spells.\n💡 Auto-success if cast at ≥ enemy slot level.",
      'healing word': "**Healing Word** — 1d4 + mod, bonus action, 60 ft.\n⚡ Picking up allies from 0 HP.\n💡 NEVER use Cure Wounds in combat unless Life Cleric.",
      'misty step': "**Misty Step** — Bonus action teleport 30 ft.\n⚡ Escape melee, cross gaps, reach high ground, flank.\n💡 No components — works in silence, while bound, underwater.",
      'eldritch blast': "**Eldritch Blast** — 1d10 force (scales to 4 beams). Best cantrip.\n⚡ Invocations: Agonizing Blast (+Cha), Repelling Blast (push 10 ft).\n💡 With Repelling Blast × 4, push 40 ft into Spike Growth for massive control.",
      'haste': "**Haste** — +2 AC, double speed, extra action. Concentration.\n⚡ Cast on your main damage dealer.\n💡 When concentration breaks, target is stunned for 1 round.",
    };
    for (const [name, advice] of Object.entries(db)) if (spellName.includes(name)) return advice;
    return null;
  }

  static onItemUsed(item) {
    if (!item) return;
    this._contextItem = item;
    const $sc = $('#aic-panel .aic-scroll, #aic-popout .aic-scroll');
    if ($sc.length && item.type === 'spell') this._pushSystem(`You cast **${item.name}**. Ask me "What does this do?" or "When should I cast this?"`);
  }

  static refresh() {
    const actor = this.actor;
    const $sc = $('#aic-panel .aic-scroll, #aic-popout .aic-scroll');
    if (!$sc.length) return;
    if (!$sc.find('.aic-context').length && actor) {
      const sys = actor.system || {};
      const hp = sys.attributes?.hp || {};
      const hpPct = Math.round((hp.value || 0) / (hp.max || 1) * 100);
      const cls = actor.items?.find(i => i.type==='class');
      $sc.prepend(`<div class="aic-context"><img src="${actor.img||'icons/svg/mystery-man.svg'}" alt=""><div><strong>${actor.name}</strong> — ${cls?.name || 'Unknown'} ${cls?.system?.levels || '?'} | HP ${hp.value}/${hp.max} (${hpPct}%)</div></div>`);
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════
   EXTENSION: AI-GM class methods
   ═══════════════════════════════════════════════════════════════════ */
AICompanion._npcTakeTurn = AICompanion._npcTakeTurn.bind(AICompanion);
AICompanion._npcTakeTurnAction = AICompanion._npcTakeTurnAction.bind(AICompanion);
AICompanion._npcMoveToTarget = AICompanion._npcMoveToTarget.bind(AICompanion);
AICompanion._npcRetreat = AICompanion._npcRetreat.bind(AICompanion);
AICompanion._findFlankPosition = AICompanion._findFlankPosition.bind(AICompanion);
AICompanion._findSafePosition = AICompanion._findSafePosition.bind(AICompanion);
AICompanion._getWeaponRange = AICompanion._getWeaponRange.bind(AICompanion);
AICompanion._npcAttack = AICompanion._npcAttack.bind(AICompanion);
AICompanion._npcCastSpell = AICompanion._npcCastSpell.bind(AICompanion);
AICompanion._applyCondition = AICompanion._applyCondition.bind(AICompanion);
AICompanion._scanGMNarration = AICompanion._scanGMNarration.bind(AICompanion);
AICompanion._onDamageDealt = AICompanion._onDamageDealt.bind(AICompanion);
AICompanion._handleUserCommand = AICompanion._handleUserCommand.bind(AICompanion);
AICompanion._handleNPCCommand = AICompanion._handleNPCCommand.bind(AICompanion);
AICompanion._handleEffectCommand = AICompanion._handleEffectCommand.bind(AICompanion);
AICompanion._handleRollCommand = AICompanion._handleRollCommand.bind(AICompanion);
AICompanion._handleCastCommand = AICompanion._handleCastCommand.bind(AICompanion);
AICompanion._handleAttackCommand = AICompanion._handleAttackCommand.bind(AICompanion);
AICompanion._handleApplyCommand = AICompanion._handleApplyCommand.bind(AICompanion);
AICompanion._handleMoveCommand = AICompanion._handleMoveCommand.bind(AICompanion);
AICompanion._callProxy = AICompanion._callProxy.bind(AICompanion);
AICompanion._aiChat = AICompanion._aiChat.bind(AICompanion);
AICompanion._reply = AICompanion._reply.bind(AICompanion);
AICompanion._logCommand = AICompanion._logCommand.bind(AICompanion);
AICompanion._findEnemies = AICompanion._findEnemies.bind(AICompanion);
AICompanion._findAllies = AICompanion._findAllies.bind(AICompanion);
AICompanion._getHPPct = AICompanion._getHPPct.bind(AICompanion);
AICompanion._getAtkBonus = AICompanion._getAtkBonus.bind(AICompanion);

/* ═══════════════════════════════════════════════════════════════════
   POPOUT APPLICATION
   ═══════════════════════════════════════════════════════════════════ */
class AICompanionPopout extends Application {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: 'aic-popout', title: 'AI Companion', template: 'modules/ai-companion/sidebar.html',
      width: 420, height: 700, resizable: true
    });
  }
  async getData() { return {}; }
  activateListeners(html) {
    super.activateListeners(html);
    setTimeout(() => AICompanion.refresh(), 50);
  }
  async close(options={}) {
    await game.settings.set(MODULE_ID, 'popoutOpen', false);
    return super.close(options);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   SETTINGS CONFIG DIALOG
   ═══════════════════════════════════════════════════════════════════ */
class AICompanionSettings extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      title: 'AI Companion Settings', id: 'aic-settings', template: 'modules/ai-companion/templates/settings.html',
      width: 440, height: 'auto'
    });
  }
  getData() {
    return Object.fromEntries(
      ['apiEnabled','apiEndpoint','apiKey','apiModel','npcAutopilot','gmAssist','gmAssistStrict',
       'playerAssist','autoLoot','aiName','aiAvatar','autoAdvance','lootTable'].map(k => [k, game.settings.get(MODULE_ID, k)])
    );
  }
  async _updateObject(event, formData) {
    for (const key of Object.keys(formData)) {
      await game.settings.set(MODULE_ID, key, formData[key]);
    }
    ui.notifications?.info?.('AI Companion settings saved.');
  }
}

window.AICompanion = AICompanion;
