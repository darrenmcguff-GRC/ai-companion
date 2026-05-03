const MODULE_ID = 'ai-companion';

/* ═══════════════════════════════════════════════════════════════════
   NPC AUTOPILOT v3.10.10 — Foundry VTT D&D 5e
   Unified attack path: always use activity.rollAttack with target AC
   injected up-front so dnd5e hit/miss cards render correctly.
   Soft dependency — safe without.
   Features: NPC Vision (LOS), Door Detection, Pathfinding,
   Last-Known Position tracking, AI-enhanced movement.
   ═══════════════════════════════════════════════════════════════════ */

/* ─── Settings ──────────────────────────────────────────────────── */
Hooks.on('init', () => {
  game.settings.register(MODULE_ID, 'hudOpen',      { scope:'client', config:false, type:Boolean, default:false });
  game.settings.register(MODULE_ID, 'hudPosition',  { scope:'client', config:false, type:Object,  default:{top:80, right:10} });
  game.settings.register(MODULE_ID, 'hudSize',      { scope:'client', config:false, type:Object,  default:{width:380, height:560} });

  game.settings.register(MODULE_ID, 'npcAutopilot', { scope:'world', config:true, type:Boolean, default:false, name:'NPC Autopilot Master Switch', hint:'Global on/off. Individual NPCs can be toggled separately.' });
  game.settings.register(MODULE_ID, 'autoAdvance',  { scope:'world', config:true, type:Boolean, default:true,  name:'Auto-Advance Combat', hint:'Automatically end NPC turn after autopilot.' });
  game.settings.register(MODULE_ID, 'npcMovement',  { scope:'world', config:true, type:Boolean, default:true,  name:'NPC Movement', hint:'NPCs move within weapon range before attacking.' });
  game.settings.register(MODULE_ID, 'npcAutopilotFastRoll', { scope:'world', config:true, type:Boolean, default:true, name:'NPC Autopilot Fast-Roll Mode', hint:'When ON, attack & damage rolls happen automatically with NO prompts.' });

  game.settings.register(MODULE_ID, 'turnDelayMs', { scope:'world', config:true, type:Number, default:1200, name:'Turn Step Delay (ms)', hint:'Base delay between each step of an NPC turn (movement, attack, etc). Increase for slower, more dramatic pacing.' });
  game.settings.register(MODULE_ID, 'interTurnDelayMs', { scope:'world', config:true, type:Number, default:10000, name:'Inter-Turn Pause (ms)', hint:'Pause before advancing to the next combatant. Default 10,000ms = 10 seconds.' });

  game.settings.register(MODULE_ID, 'narrativeMode',   { scope:'world', config:true, type:Boolean, default:false, name:'Narrative Mode', hint:'NPC Autopilot describes actions narratively instead of rolling.' });
  game.settings.register(MODULE_ID, 'reactionsEnabled',{ scope:'world', config:true, type:Boolean, default:true,  name:'NPC Reactions', hint:'Enable auto-reactions like Shield and Opportunity Attacks.'});
  game.settings.register(MODULE_ID, 'legendaryEnabled',{ scope:'world', config:true, type:Boolean, default:true,  name:'Legendary Actions', hint:'Enable legendary actions for NPCs.'});
  game.settings.register(MODULE_ID, 'ollamaEnabled', { scope:'world', config:true, type:Boolean, default:false, name:'AI Narration', hint:'Use Ollama Bridge for dynamic combat narration.'});
  game.settings.register(MODULE_ID, 'ollamaNarrateTarget', { scope:'world', config:true, type:Boolean, default:true, name:'Narrate Target Lock', hint:'AI narrates when an NPC picks a target.'});
  game.settings.register(MODULE_ID, 'ollamaNarrateAction', { scope:'world', config:true, type:Boolean, default:true, name:'Narrate Attack/Miss', hint:'AI narrates attack/miss results.'});
  game.settings.register(MODULE_ID, 'ollamaNarrateKill', { scope:'world', config:true, type:Boolean, default:true, name:'Narrate Kills', hint:'AI narrates when an NPC drops a target to 0 HP.'});
  game.settings.register(MODULE_ID, 'ollamaNarrateRound', { scope:'world', config:true, type:Boolean, default:true, name:'Narrate Round Start', hint:'AI narrates scene-setting each new round.'});
  game.settings.register(MODULE_ID, 'ollamaTemperature', { scope:'world', config:true, type:Number, default:0.7, name:'AI Temperature', hint:'Narration creativity: 0.0 deterministic, 1.0 very creative.'});
  game.settings.register(MODULE_ID, 'ollamaNarrateDelay', { scope:'world', config:true, type:Number, default:800, name:'Narration Pause (ms)', hint:'Pause after AI narration before continuing.'});
  game.settings.register(MODULE_ID, 'dropThrownWeapons', { scope:'world', config:true, type:Boolean, default:false, name:'Drop Thrown Weapons', hint:'When an NPC throws a weapon (dagger, javelin, handaxe, etc), reduce quantity by 1 and drop a loot token on the map.'});
  game.settings.register(MODULE_ID, 'npcVision',       { scope:'world', config:true, type:Boolean, default:true,  name:'NPC Vision (LOS)', hint:'NPCs only target enemies they can see (line-of-sight). Falling back to last-known-position for hidden foes.'});
  game.settings.register(MODULE_ID, 'npcDoorAware',    { scope:'world', config:true, type:Boolean, default:true,  name:'NPC Door Detection', hint:'NPCs detect and open doors when pathfinding to targets.'});
  game.settings.register(MODULE_ID, 'npcPathfinding',  { scope:'world', config:true, type:Boolean, default:true,  name:'NPC Wall Pathfinding', hint:'NPCs navigate around walls and obstacles using pathfinding.'});
});

Hooks.on('ready', () => {
  if (game.settings.get(MODULE_ID, 'hudOpen')) NpcAutopilot.open();
  NpcAutopilot._setupReactions();
  NpcAutopilot._setupLegendaryActions();
  NpcAutopilot._setupKillNarration();
});

Hooks.on('renderTokenHUD', (hud, html) => {
  const $h = html instanceof HTMLElement ? $(html) : html;
  let col = $h.find('.col.left'); if (!col.length) col = $h;
  col.append($('<div class="control-icon" title="NPC Autopilot"><i class="fas fa-robot"></i></div>')
    .on('click', () => NpcAutopilot.open()));
});

Hooks.on('updateCombat', (combat, changed) => {
  if (!combat?.started || !game.user.isGM) return;
  if (changed.turn === undefined && changed.round === undefined) return;
  if (changed.round !== undefined) {
    NpcAutopilot._resetTargetCounts();
    NpcAutopilot._ollamaNarrateRound(combat);
  }
  const c = combat.combatant;
  if (!c?.token?.actor || c.token.actor.hasPlayerOwner) return;
  if (c.token?.actor) c.token.actor.setFlag(MODULE_ID, 'reactionSpent', false).catch(()=>{});
  if (changed.round !== undefined) {
    for(const cc of combat.combatants) {
      const a = cc.token?.actor;
      if(a && !a.hasPlayerOwner) a.setFlag(MODULE_ID, 'legendarySpent', false).catch(()=>{});
    }
  }
  if (!NpcAutopilot.isEnabled(c.token.actor)) return;
  if (NpcAutopilot._isPaused(c.token.actor)) return;
  NpcAutopilot.takeTurn(c.token.actor, c.token);
});

/* Combat deleted → clear last-known positions so memory doesn't persist between encounters */
Hooks.on('deleteCombat', () => {
  NpcAutopilot._lastKnownPositions = new Map();
  NpcAutopilot._log('last-known positions cleared (combat deleted)');
});

/* ═══════════════════════════════════════════════════════════════════
   MAIN CLASS
   ═══════════════════════════════════════════════════════════════════ */
class NpcAutopilot {
  static _busy = false;
  static _pausedActorId = null;
  static _lastCombatantId = null;

  /* ── static tactic catalogue ── */
  static _TACTICS = {
    assassin:     { preferWounded: true,  prefersMelee: false, positioning: 'mid',        retreatThreshold: 0.10, healAllyThreshold: 0, spellPreference: ['damage','mobility','control'] },
    bruiser:      { preferWounded: false, prefersMelee: true,  positioning: 'charge',     retreatThreshold: 0.00, healAllyThreshold: 0, spellPreference: ['damage','control','buff'] },
    controller:   { preferWounded: false, prefersMelee: false, positioning: 'hang_back',  retreatThreshold: 0.20, healAllyThreshold: 0, spellPreference: ['control','damage','buff'] },
    flying:       { preferWounded: false, prefersMelee: false, positioning: 'hang_back',  retreatThreshold: 0.15, healAllyThreshold: 0, spellPreference: ['damage','mobility','control'] },
    healer:       { preferWounded: false, prefersMelee: false, positioning: 'mid',        retreatThreshold: 0.25, healAllyThreshold: 0.40, bonusHealAlly: true, spellPreference: ['heal','buff','control'] },
    skirmisher:   { preferWounded: false, prefersMelee: true,  positioning: 'flank',      retreatThreshold: 0.15, healAllyThreshold: 0, spellPreference: ['damage','mobility','control'] },
    sniper:       { preferWounded: true,  prefersMelee: false, positioning: 'hang_back',  retreatThreshold: 0.10, healAllyThreshold: 0, spellPreference: ['damage','control','mobility'] },
    barbarian:    { preferWounded: false, prefersMelee: true,  positioning: 'charge',     retreatThreshold: 0.05, healAllyThreshold: 0, spellPreference: ['damage','buff','control'] },
    bard:         { preferWounded: false, prefersMelee: false, positioning: 'mid',        retreatThreshold: 0.20, healAllyThreshold: 0.30, spellPreference: ['buff','heal','control','damage'] },
    cleric:       { preferWounded: false, prefersMelee: false, positioning: 'mid',        retreatThreshold: 0.20, healAllyThreshold: 0.40, bonusHealAlly: true, spellPreference: ['heal','buff','damage','control'] },
    druid:        { preferWounded: false, prefersMelee: false, positioning: 'mid',        retreatThreshold: 0.20, healAllyThreshold: 0.30, spellPreference: ['heal','control','damage','buff'] },
    fighter:      { preferWounded: false, prefersMelee: true,  positioning: 'charge',     retreatThreshold: 0.10, healAllyThreshold: 0, spellPreference: ['damage','control','buff'] },
    monk:         { preferWounded: false, prefersMelee: true,  positioning: 'flank',      retreatThreshold: 0.15, healAllyThreshold: 0, spellPreference: ['damage','control','mobility'] },
    paladin:      { preferWounded: false, prefersMelee: true,  positioning: 'charge',     retreatThreshold: 0.10, healAllyThreshold: 0.30, spellPreference: ['damage','heal','buff','smite'] },
    ranger:       { preferWounded: true,  prefersMelee: false, positioning: 'mid',        retreatThreshold: 0.15, healAllyThreshold: 0, spellPreference: ['damage','control','mobility'] },
    rogue:        { preferWounded: true,  prefersMelee: true,  positioning: 'flank',      retreatThreshold: 0.15, healAllyThreshold: 0, spellPreference: ['damage','mobility','control'] },
    sorcerer:     { preferWounded: false, prefersMelee: false, positioning: 'hang_back',  retreatThreshold: 0.25, healAllyThreshold: 0, spellPreference: ['damage','control','buff'] },
    warlock:      { preferWounded: true,  prefersMelee: false, positioning: 'hang_back',  retreatThreshold: 0.20, healAllyThreshold: 0, spellPreference: ['damage','control','buff'] },
    wizard:       { preferWounded: false, prefersMelee: false, positioning: 'hang_back',  retreatThreshold: 0.30, healAllyThreshold: 0, spellPreference: ['damage','control','buff'] },
    default:      { preferWounded: false, prefersMelee: false, positioning: 'charge',     retreatThreshold: 0.20, healAllyThreshold: 0, spellPreference: ['damage','control'] },
  };

  static isEnabled(actor) {
    const perActor = actor.getFlag(MODULE_ID, 'autopilot');
    if (perActor === false) return false;
    if (perActor === true)  return true;
    return game.settings.get(MODULE_ID, 'npcAutopilot');
  }
  static async setEnabled(actor, val) {
    await actor.setFlag(MODULE_ID, 'autopilot', val);
    this._renderPanel();
  }

  /* ── Archetype detection ── */
  static _detectArchetype(actor) {
    const name = (actor.name || '').toLowerCase();
    const traits = (actor.system?.traits?.size || '').toLowerCase();
    const items = actor.items?.contents || [];
    const monsterTypes = (actor.system?.details?.type?.value || '').toLowerCase();

    // Monster trait keyword map
    const traitMap = [
      { keys: /assassin|skulker|sneak attack|shadow/i,     arch: 'assassin' },
      { keys: /brute|tank|heavy|juggernaut|regeneration/i,  arch: 'bruiser' },
      { keys: /mage slayer|counterspell|grappler|taunt/i,  arch: 'controller' },
      { keys: /fly|hover|wings/i,                            arch: 'flying' },
      { keys: /healer|life domain|channel divinity.*heal/i, arch: 'healer' },
      { keys: /skirmisher|mobile|evasion|swashbuckler/i,     arch: 'skirmisher' },
      { keys: /sniper|sharpshooter|crossbow expert/i,       arch: 'sniper' },
    ];
    for (const t of traitMap) {
      if (t.keys.test(name) || t.keys.test(traits) || t.keys.test(monsterTypes)) return t.arch;
    }

    // Class-level detection from items
    for (const i of items) {
      const n = (i.name || '').toLowerCase();
      if (/barbarian|berserker|rage/.test(n)) return 'barbarian';
      if (/bard|college of/.test(n)) return 'bard';
      if (/cleric|life domain|death domain/.test(n)) return 'cleric';
      if (/druid|circle of/.test(n)) return 'druid';
      if (/fighter|battle master|champion/.test(n)) return 'fighter';
      if (/monk|way of/.test(n)) return 'monk';
      if (/paladin|oath of/.test(n)) return 'paladin';
      if (/ranger|hunter|beast master/.test(n)) return 'ranger';
      if (/rogue|thief|assassin|arcane trickster/.test(n)) return 'rogue';
      if (/sorcerer|draconic|wild magic/.test(n)) return 'sorcerer';
      if (/warlock|pact of/.test(n)) return 'warlock';
      if (/wizard|school of/.test(n)) return 'wizard';
    }

    // Size-based fallback
    if (/tiny|small/.test(traits) && / ranged|bow|crossbow|sling|dart/i.test(name)) return 'sniper';
    if (/huge|gargantuan/.test(traits)) return 'bruiser';

    // Name-based keyword fallbacks
    if (/archer|sharpshooter|crossbow/.test(name)) return 'sniper';
    if (/mage|wizard|sorcerer|warlock|druid|cleric|bard/.test(name)) return 'controller';
    if (/thug|brute|ogre|troll|giant|golem|beast/.test(name)) return 'bruiser';

    return 'default';
  }

  static _getTactics(actor) {
    const arch = this._detectArchetype(actor);
    const t = this._TACTICS[arch] || this._TACTICS.default;
    return { arch, ...t };
  }

  /* ── Panel ── */
  static async open() {
    let $el = $('#npc-ap-panel');
    if (!$el.length) {
      const pos = (await game.settings.get(MODULE_ID, 'hudPosition'));
      const sz  = (await game.settings.get(MODULE_ID, 'hudSize'));
      $('body').append(`
        <div id="npc-ap-panel" style="top:${pos.top}px;right:${pos.right}px;width:${sz.width}px;height:${sz.height}px;">
          <div class="npc-ap-header"><span><i class="fas fa-robot"></i> NPC Autopilot</span>
            <div class="npc-ap-actions"><i class="fas fa-sync" data-action="refresh"></i><i class="fas fa-times" data-action="close"></i></div></div>
          <div class="npc-ap-scroll"></div><div class="npc-ap-resize"></div></div>`);
      $el = $('#npc-ap-panel');
      this._bindDrag('#npc-ap-panel'); this._bindResize('#npc-ap-panel');
      $(document).off('click.npcd').on('click.npcd', '#npc-ap-panel [data-action]', function() {
        const a=$(this).data('action'); if(a==='close')NpcAutopilot.close(); if(a==='refresh')NpcAutopilot._renderPanel();
      });
      $(document).off('click.npcap').on('click.npcap', '[data-ap-action]', function() {
        const a=$(this).data('ap-action');
        if(a==='toggle-global'){ game.settings.set(MODULE_ID,'npcAutopilot',!game.settings.get(MODULE_ID,'npcAutopilot')); NpcAutopilot._renderPanel(); }
        if(a==='toggle-fast'){ game.settings.set(MODULE_ID,'npcAutopilotFastRoll',!game.settings.get(MODULE_ID,'npcAutopilotFastRoll')); NpcAutopilot._renderPanel(); }
        if(a==='toggle-narrative'){ game.settings.set(MODULE_ID,'narrativeMode',!game.settings.get(MODULE_ID,'narrativeMode')); NpcAutopilot._renderPanel(); }
        if(a==='toggle-reactions'){ game.settings.set(MODULE_ID,'reactionsEnabled',!game.settings.get(MODULE_ID,'reactionsEnabled')); NpcAutopilot._renderPanel(); }
        if(a==='toggle-legendary'){ game.settings.set(MODULE_ID,'legendaryEnabled',!game.settings.get(MODULE_ID,'legendaryEnabled')); NpcAutopilot._renderPanel(); }
        if(a==='toggle-ollama'){ game.settings.set(MODULE_ID,'ollamaEnabled',!game.settings.get(MODULE_ID,'ollamaEnabled')); NpcAutopilot._renderPanel(); }
        if(a==='toggle-vision'){ game.settings.set(MODULE_ID,'npcVision',!game.settings.get(MODULE_ID,'npcVision')); NpcAutopilot._renderPanel(); }
        if(a==='toggle-doors'){ game.settings.set(MODULE_ID,'npcDoorAware',!game.settings.get(MODULE_ID,'npcDoorAware')); NpcAutopilot._renderPanel(); }
        if(a==='toggle-pathfinding'){ game.settings.set(MODULE_ID,'npcPathfinding',!game.settings.get(MODULE_ID,'npcPathfinding')); NpcAutopilot._renderPanel(); }
        if(a==='manual-turn'){ const c=game.combat?.combatant; if(c?.token?.actor) NpcAutopilot.takeTurn(c.token.actor,c.token); }
        if(a==='toggle-npc'){ const id=$(this).data('actor-id'); const a2=game.actors.get(id); if(a2) NpcAutopilot.setEnabled(a2, $(this).is(':checked')); }
        if(a==='override-npc'){ const id=$(this).data('actor-id'); const a2=game.actors.get(id); if(a2) NpcAutopilot._openActorOverride(a2); }
      });
    }
    await game.settings.set(MODULE_ID,'hudOpen',true);
    $el.show(); this._renderPanel();
  }
  static async close() { $('#npc-ap-panel').hide(); await game.settings.set(MODULE_ID,'hudOpen',false); }
  static _bindDrag(sel) { const $el=$(sel); let d=false,sx,sy,sl,st; $el.find('.npc-ap-header').on('mousedown.npcd',e=>{if(e.target.closest('.npc-ap-actions'))return;d=true;sx=e.clientX;sy=e.clientY;const o=$el.offset();sl=o.left;st=o.top;e.preventDefault();}); const onMove=e=>{if(d)$el.css({left:Math.max(0,sl+e.clientX-sx),top:Math.max(0,st+e.clientY-sy),right:'auto'});}; const onUp=()=>{if(d){const o=$el.offset();game.settings.set(MODULE_ID,'hudPosition',{top:Math.round(o.top),left:Math.round(o.left)});}d=false;}; $(document).off('mousemove.npcd mouseup.npcd').on('mousemove.npcd',onMove).on('mouseup.npcd',onUp);}
  static _bindResize(sel) { const $el=$(sel); let r=false,sx,sy,sw,sh; $el.find('.npc-ap-resize').on('mousedown.npcr',e=>{r=true;sx=e.clientX;sy=e.clientY;sw=$el.outerWidth();sh=$el.outerHeight();e.preventDefault();}); const onMove=e=>{if(r)$el.css({width:Math.max(280,sw+e.clientX-sx),height:Math.max(280,sh+e.clientY-sy)});}; const onUp=()=>{if(r)game.settings.set(MODULE_ID,'hudSize',{width:Math.round($el.outerWidth()),height:Math.round($el.outerHeight())});r=false;}; $(document).off('mousemove.npcr mouseup.npcr').on('mousemove.npcr',onMove).on('mouseup.npcr',onUp);}

  static _renderPanel() {
    const $sc=$('#npc-ap-panel .npc-ap-scroll'); if(!$sc.length)return;
    const globalOn=game.settings.get(MODULE_ID,'npcAutopilot');
    const fastRoll=game.settings.get(MODULE_ID,'npcAutopilotFastRoll');
    const narrative=game.settings.get(MODULE_ID,'narrativeMode');
    const reactions=game.settings.get(MODULE_ID,'reactionsEnabled');
    const legendary=game.settings.get(MODULE_ID,'legendaryEnabled');
    const ollamaOn=game.settings.get(MODULE_ID,'ollamaEnabled');
    const visionOn=game.settings.get(MODULE_ID,'npcVision');
    const doorOn=game.settings.get(MODULE_ID,'npcDoorAware');
    const pathOn=game.settings.get(MODULE_ID,'npcPathfinding');
    const combat=game.combat; const active=combat?.started;
    const cur=combat?.combatant; const ct=cur?.token; const ca=ct?.actor; const isNPC=ca&&!ca.hasPlayerOwner;
    const currentArch = ca ? this._detectArchetype(ca) : '';
    let html=`<div class="npc-ap-status-row">
      <span class="npc-ap-toggle ${globalOn?'on':'off'}" data-ap-action="toggle-global"><i class="fas fa-power-off"></i> ${globalOn?'ON':'OFF'}</span>
      <span class="npc-ap-toggle ${fastRoll?'on':'off'}" data-ap-action="toggle-fast"><i class="fas fa-forward"></i> ${fastRoll?'FAST':'SLOW'}</span>
      <span class="npc-ap-toggle ${narrative?'on':'off'}" data-ap-action="toggle-narrative"><i class="fas fa-book"></i> ${narrative?'NARR':'STD'}</span>
      <span class="npc-ap-toggle ${reactions?'on':'off'}" data-ap-action="toggle-reactions"><i class="fas fa-shield-alt"></i> ${reactions?'REACT':'NONE'}</span>
      <span class="npc-ap-toggle ${legendary?'on':'off'}" data-ap-action="toggle-legendary"><i class="fas fa-dragon"></i> ${legendary?'LEG':'NONE'}</span>
      <span class="npc-ap-toggle ${ollamaOn?'on':'off'}" data-ap-action="toggle-ollama" title="AI Narration via Ollama Bridge"><i class="fas fa-brain"></i> ${ollamaOn?'AI':'OFF'}</span>
      <span class="npc-ap-toggle ${visionOn?'on':'off'}" data-ap-action="toggle-vision" title="NPC Vision / Line of Sight"><i class="fas fa-eye"></i> ${visionOn?'LOS':'NO-LOS'}</span>
      <span class="npc-ap-toggle ${doorOn?'on':'off'}" data-ap-action="toggle-doors" title="NPC Door Detection / Opening"><i class="fas fa-door-open"></i> ${doorOn?'DOORS':'NO-DR'}</span>
      <span class="npc-ap-toggle ${pathOn?'on':'off'}" data-ap-action="toggle-pathfinding" title="NPC Wall Pathfinding"><i class="fas fa-route"></i> ${pathOn?'PATH':'NO-PF'}</span></div>`;
    html+=`<div class="npc-ap-combat-status" style="text-align:center;padding:4px;font-size:12px;">${active?'🎲 Round '+(combat.round||1)+', Turn '+((combat.turn||0)+1):'No combat'}</div>`;
    if(ct){ const hp=ca?.system?.attributes?.hp||{}; const p=Math.round((hp.value||0)/(hp.max||1)*100); const c=p>50?'#4ade80':p>25?'#facc15':'#f87171';
      html+=`<div class="npc-ap-card"><img src="${ct.texture?.src||ca?.img||'icons/svg/mystery-man.svg'}">
        <div class="npc-ap-info"><div class="npc-ap-name">${ct.name||ca?.name||'?'}</div>
        <div class="npc-ap-meta">${isNPC?'NPC':'Player'}${currentArch?' · '+currentArch:''} | HP <span style="color:${c};font-weight:700">${hp.value||0}/${hp.max||'?'}</span> (${p}%)</div>
        <div class="npc-ap-hpbar"><div style="width:${p}%;background:${c}"></div></div></div>
        ${isNPC&&globalOn?'<div class="npc-ap-badge">🤖</div>':''}</div>`; }
    if(active){ const npcs=combat.combatants.filter(c=>c.token?.actor&&!c.token.actor.hasPlayerOwner); if(npcs.length){
      html+=`<div class="npc-ap-list"><div class="npc-ap-section">NPCs in Combat (${npcs.length})</div>`;
      for(const c of npcs){ const a=c.token.actor; const en=this.isEnabled(a); const h=a?.system?.attributes?.hp||{}; const p=Math.round((h.value||0)/(h.max||1)*100); const col=p>50?'#4ade80':p>25?'#facc15':'#f87171'; const arch=this._detectArchetype(a); const paused=this._pausedActorId===a.id;
        html+=`<div class="npc-ap-item ${c.token?.id===ct?.id?'current':''} ${paused?'paused':''}">
          <input type="checkbox" class="npc-ap-check" data-ap-action="toggle-npc" data-actor-id="${a.id}" ${en?'checked':''} title="Toggle autopilot for ${a.name}">
          <i class="fas fa-cog npc-ap-gear" data-ap-action="override-npc" data-actor-id="${a.id}" style="cursor:pointer;margin:0 4px;" title="Override"></i>
          <img src="${c.token?.texture?.src||a?.img||'icons/svg/mystery-man.svg'}">
          <div class="npc-ap-item-name">${paused?'⏸️ ':''}${c.name}${arch!=='default'?' <small style="opacity:.7">('+arch+')</small>':''}</div>
          <div class="npc-ap-item-hpbar"><div style="width:${p}%;background:${col}"></div></div>
          <div class="npc-ap-item-hp" style="color:${col}">${p}%</div></div>`; }
      html+=`</div>`; }}
    html+=`<div class="npc-ap-controls">${isNPC&&active?`<button class="npc-ap-btn" data-ap-action="manual-turn"><i class="fas fa-play"></i> Take Turn for ${ct.name}</button>`:''}</div>`;
    $sc.html(html);
  }

  /* ═══════════════════════════════════════════════════════════════════
     TAKE TURN
     ═══════════════════════════════════════════════════════════════════ */
  static async takeTurn(actor, tokenDoc) {
    if(this._busy)return; this._busy=true;
    try{
      if(this._isPaused(actor)){ this._busy=false; return; }
      await this._resetCastTracker(actor);
      await actor.setFlag(MODULE_ID, 'reactionSpent', false);
      const refreshed = canvas.tokens.get(tokenDoc.id);
      if(refreshed) tokenDoc = refreshed.document || refreshed;

      const tactics = this._getTactics(actor);
      const ov = this._getOverrides(actor);
      let enemyTokens=this._findEnemyTokens(tokenDoc);
      const allyTokens =this._findAllyTokens(tokenDoc);
      const hpPct=this._getHPPct(actor);

      if(ov.blacklist?.length) enemyTokens = enemyTokens.filter(t=>!ov.blacklist.includes(t.id));

      /* -- NPC Vision: filter to visible enemies, remember last-known positions -- */
      const visionEnabled = game.settings.get(MODULE_ID, 'npcVision');
      let visibleEnemyTokens = visionEnabled ? this._visibleEnemies(tokenDoc, enemyTokens) : enemyTokens;
      if(visionEnabled) for(const t of visibleEnemyTokens) this._rememberPosition(tokenDoc, t);

      this._log(`${actor.name} turn start — ${enemyTokens.length} PCs (${visibleEnemyTokens.length} visible), ${allyTokens.length} allies, HP ${Math.round(hpPct*100)}%, arch=${tactics.arch}`);

      const items = actor.items?.contents || [];

      /* Target selection: prefer visible enemies; fall back to last-known positions */
      let targetToken = null;
      let isTargetFromMemory = false;
      if(visibleEnemyTokens.length){
        targetToken = this._pickTarget(visibleEnemyTokens, tokenDoc, actor, tactics);
      } else if(enemyTokens.length && visionEnabled){
        const nearest = enemyTokens
          .map(t => ({token: t, dist: this._tokenDistanceFt(tokenDoc, t)}))
          .sort((a,b) => a.dist - b.dist);
        for(const e of nearest){
          const lkp = this._getLastKnownPosition(tokenDoc.id || tokenDoc._id, e.token.id);
          if(lkp){
            targetToken = e.token;
            isTargetFromMemory = true;
            this._log('target from memory: ' + targetToken.name + ' (last seen at [' + lkp.x + ',' + lkp.y + '])');
            break;
          }
        }
        if(!targetToken){
          this._log('no memory either; 0 visible — skipping');
          targetToken = null;
        }
      } else {
        targetToken = enemyTokens.length ? this._pickTarget(enemyTokens, tokenDoc, actor, tactics) : null;
      }
      if(ov.forceTarget){
        const forced = canvas.tokens.get(ov.forceTarget);
        if(forced && enemyTokens.find(t=>t.id===forced.id)) targetToken = forced;
      }
      this._log(`locked target: ${targetToken?.name||'none'} (${visibleEnemyTokens.length} visible, ${enemyTokens.length} total)`);
      if(targetToken) this._incrementTargetCount(targetToken);

      /* personality intro */
      if(targetToken){
        await this._say(`🎯 ${this._personalityLine(actor, 'targetSelect', {target: targetToken.name})}`, actor);
      } else {
        await this._say(`🔍 ${actor.name} searches — no target located.`, actor);
      }
      /* AI narration on target lock */
      await this._ollamaNarrateTarget(actor, targetToken, tactics, enemyTokens.length, allyTokens.length);
      this._ollamaLogEvent(`${actor.name} targets ${targetToken?.name}`);
      await this._stepDelay();

      let moveBudgetFt = 0;
      let moveMsg = '';
      if(game.settings.get(MODULE_ID,'npcMovement') && tokenDoc && targetToken && !ov.noMove){
        let moveRes={msg:'', movedFt:0};
        if(hpPct < tactics.retreatThreshold && enemyTokens.length>=2){
          moveRes=await this._npcRetreat(tokenDoc, enemyTokens);
          if(moveRes.movedFt>0) moveRes.msg=`${tokenDoc.name} Disengages and retreats from danger.`;
        } else {
          /* ── caster-aware movement ── */
          let moveTool, desiredRange;
          const hasRangedSpell = items.some(i=>i.type==='spell' && this._spellAvailable(actor,i) && this._getSpellRange(i) > 20);
          const isCaster = ['controller','sorcerer','wizard','warlock','bard','druid','cleric','flying'].includes(tactics?.arch);
          if(isCaster && hasRangedSpell){
            const availSpells = items.filter(i=>i.type==='spell' && this._spellAvailable(actor,i));
            let bestSpellRange = 0;
            for(const sp of availSpells){
              const sr = this._getSpellRange(sp);
              if(sr > bestSpellRange && sr <= 120) bestSpellRange = sr;
            }
            desiredRange = bestSpellRange > 0 ? bestSpellRange : 60;
            moveTool = { name:'spell', system:{range:{value:desiredRange},target:{}} };
          } else {
            moveTool = this._bestWeaponForRange(actor, this._tokenDistanceFt(tokenDoc, targetToken), {prefersMelee:tactics.prefersMelee});
          }
          if(moveTool){
            try{
              moveRes = await this._npcMoveToTarget(tokenDoc, targetToken, moveTool, {tactics, desiredRange, fromMemory: isTargetFromMemory});
            }catch(e){ this._log(`move error: ${e.message}`); moveRes={msg:'', movedFt:0}; }
          }
        }
        moveMsg = moveRes.msg || '';
        moveBudgetFt = Math.max(0, this._getSpeed(actor) - (moveRes.movedFt || 0));
        if(moveMsg){
          await this._say(`🏃 ${this._personalityLine(actor, 'move', {target: targetToken?.name})}\n${moveMsg}`, actor);
          await this._stepDelay();
        }
      }

      const movedRefreshed = canvas.tokens.get(tokenDoc.id);
      if(movedRefreshed) tokenDoc = movedRefreshed.document || movedRefreshed;
      enemyTokens=this._findEnemyTokens(tokenDoc);
      if(ov.blacklist?.length) enemyTokens = enemyTokens.filter(t=>!ov.blacklist.includes(t.id));
      visibleEnemyTokens = visionEnabled ? this._visibleEnemies(tokenDoc, enemyTokens) : enemyTokens;

      let finalTarget = targetToken;
      if(finalTarget && !enemyTokens.find(t=>t.id===finalTarget.id)){
        finalTarget = enemyTokens.length ? this._pickTarget(enemyTokens, tokenDoc, actor, tactics) : null;
        this._log(`target died; re-picked: ${finalTarget?.name||'none'}`);
        if(finalTarget) this._incrementTargetCount(finalTarget);
      }

      await this._executeFullTurn(actor, tokenDoc, enemyTokens, allyTokens, hpPct, finalTarget, moveBudgetFt, tactics, ov);

      if(game.settings.get(MODULE_ID,'autoAdvance')&&game.combat?.combatant?.token?.id===tokenDoc?.id){
        setTimeout(()=>game.combat?.nextTurn?.(), game.settings.get(MODULE_ID,'interTurnDelayMs') || 10000);
      }
      this._renderPanel();
    }catch(err){console.error('[NPC Autopilot]',err); await this._say(`⚠️ ${err.message}`, actor, {whisper:true});}
    finally{this._busy=false;}
  }

  /* ═══════════════════════════════════════════════════════════════════
     FULL TURN — spellcasting, action economy, heals, attacks, dodge
     ═══════════════════════════════════════════════════════════════════ */
  static async _executeFullTurn(actor, tokenDoc, enemyTokens, allyTokens, hpPct, targetToken, moveBudgetFt=0, tactics, overrides={}) {
    this._log(`_executeFullTurn: ${actor.name} — ${enemyTokens.length} enemies, HP ${Math.round(hpPct*100)}%, target=${targetToken?.name||'none'}, moveLeft=${moveBudgetFt}, arch=${tactics?.arch||'default'}`);
    /* ── LOS re-check: if vision is ON and target is behind walls, don't attack ── */
    const visionCheck = game.settings.get(MODULE_ID, 'npcVision');
    if(visionCheck && targetToken){
      const visibleNow = this._visibleEnemies(tokenDoc, [targetToken]);
      if(visibleNow.length === 0){
        this._log(`target ${targetToken.name} not visible — skipping attacks (can still search)`);
        targetToken = null;
      }
    }
    const items = actor.items?.contents || [];
    const moveBudget = { ft: moveBudgetFt };
    let bonusUsed = false;
    let actionUsed = false;
    const ov = overrides || {};

    if(ov.forceArch && this._TACTICS[ov.forceArch]){
      Object.assign(tactics, this._TACTICS[ov.forceArch]);
      tactics.arch = ov.forceArch;
    }
    if(ov.forceTarget){
      const forced = canvas.tokens.get(ov.forceTarget);
      if(forced && !forced.actor?.hasPlayerOwner) targetToken = forced;
    }

    // ── Spellcasting (before weapon attacks) ──
    if(!ov.noSpells){
      const bestSpell = await this._pickBestSpell(actor, enemyTokens, allyTokens, tokenDoc, tactics, moveBudget);
      if(bestSpell?.spell){
        await this._castSpell(bestSpell.spell, bestSpell.target, tokenDoc);
        this._ollamaLogEvent(`${actor.name} cast ${bestSpell.spell.name} on ${bestSpell.target?.name||'self'}`);
        actionUsed = true;
        await this._stepDelay();
        if(this._isAoESpell(bestSpell.spell)){
          enemyTokens = this._findEnemyTokens(tokenDoc);
          if(ov.blacklist?.length) enemyTokens = enemyTokens.filter(t=>!ov.blacklist.includes(t.id));
        }
      }
    }

    // ── Action: Dash to close gap when target is beyond remaining movement ──
    if(!actionUsed && targetToken && !ov.noMove){
      const dist = this._tokenDistanceFt(tokenDoc, targetToken);
      const weapon = this._bestWeaponForRange(actor, dist, {prefersMelee: tactics?.prefersMelee});
      const weaponRange = weapon ? this._getWeaponRange(weapon) : 5;
      const needsToMove = dist > weaponRange + 3;
      const canReachWithDash = dist <= moveBudget.ft + this._getSpeed(actor) + weaponRange + 3;
      const remainingNotEnough = moveBudget.ft < dist - weaponRange - 3;

      if(needsToMove && canReachWithDash && remainingNotEnough){
        const dashRes = await this._actionDash(actor, tokenDoc, targetToken, moveBudget);
        if(dashRes.movedFt > 0){
          /* Dash effectively grants extra speed; subtract what we actually moved */
          moveBudget.ft = Math.max(0, moveBudget.ft + this._getSpeed(actor) - dashRes.movedFt);
          actionUsed = true;
          await this._stepDelay();
          const refreshed = canvas.tokens.get(tokenDoc.id);
          if(refreshed) tokenDoc = refreshed.document || refreshed;
          enemyTokens = this._findEnemyTokens(tokenDoc);
          if(ov.blacklist?.length) enemyTokens = enemyTokens.filter(t=>!ov.blacklist.includes(t.id));
        }
      }
    }

    // Shove/Grapple for controllers/bruisers when adjacent
    if(!actionUsed && targetToken && !ov.noGrapple){
      const dist = this._tokenDistanceFt(tokenDoc, targetToken);
      const isBruiser = ['controller','bruiser','fighter','barbarian','monk'].includes(tactics?.arch);
      if(isBruiser && dist <= 7){
        const grappled = await this._doShoveOrGrapple(actor, tokenDoc, targetToken);
        if(grappled) actionUsed = true;
        await this._stepDelay();
      }
    }

    // ── Bonus Action: heal ally first (healer archetypes) ──
    if((tactics?.healAllyThreshold > 0) && allyTokens.length && !bonusUsed){
      const woundedAlly = allyTokens
        .map(t=>{const h=t.actor?.system?.attributes?.hp||{}; return{token:t, pct:(h.value||0)/Math.max(1,h.max||1)};})
        .filter(a=>a.pct < tactics.healAllyThreshold)
        .sort((a,b)=>a.pct-b.pct)[0];
      if(woundedAlly){
        const baHeal = this._findBestHealSpell(actor) || this._findSpell(actor,/(healing word|cure wounds|lesser restoration)/i);
        if(baHeal){ await this._say(`🩹 ${this._personalityLine(actor, 'heal')}`, actor); await this._useItem(actor, baHeal, woundedAlly.token.actor, tokenDoc); bonusUsed=true; await this._stepDelay(); }
      }
    }

    // ── Bonus Action: heal self if critical and no ally healed ──
    if(!bonusUsed && hpPct < 0.3){
      const baHeal = this._findBestHealSpell(actor) || this._findSpell(actor,/(healing word|cure wounds)/i);
      if(baHeal){ await this._say(`🩹 ${this._personalityLine(actor, 'heal')}`, actor); await this._useItem(actor,baHeal,actor,tokenDoc); bonusUsed=true; await this._stepDelay(); }
    }

    // ── Action: multiattack or best single attack ──
    if(!actionUsed){
      const didMulti = await this._doMultiattack(actor, enemyTokens, items, tokenDoc, moveBudget, targetToken, tactics);
      this._log(`multiattack returned: ${didMulti}`);
      if(didMulti) actionUsed = true;

      if(!didMulti && targetToken){
        const dist = this._tokenDistanceFt(tokenDoc, targetToken);
        const weapon = this._bestWeaponForRange(actor, dist, {prefersMelee:tactics?.prefersMelee});
        this._log(`single attack: dist ${Math.round(dist)}ft, weapon=${weapon?.name||'none'}`);
        let attackWeapon = weapon;
        if(attackWeapon && dist > this._getWeaponRange(attackWeapon) + 3 && moveBudget.ft > 0 && !ov.noMove){
          const moveRes = await this._npcMoveToTarget(tokenDoc, targetToken, attackWeapon, {maxMoveFt: moveBudget.ft, tactics});
          if(moveRes.movedFt){
            moveBudget.ft -= moveRes.movedFt;
            const refreshed = canvas.tokens.get(tokenDoc.id);
            if(refreshed) tokenDoc = refreshed.document || refreshed;
          }
        }
        const finalDist = this._tokenDistanceFt(tokenDoc, targetToken);
        if(attackWeapon && finalDist <= this._getWeaponRange(attackWeapon) + 3){
          await this._npcAttack(actor, attackWeapon, targetToken, tokenDoc);
          actionUsed = true;
          await this._stepDelay();
        } else if(attackWeapon) {
          await this._say(`⚠️ ${actor.name} is ${Math.round(finalDist)} ft from ${targetToken.name}, beyond ${attackWeapon.name}'s reach.`, actor, {whisper:true});
        }
      }
    }

    // ── Bonus Action: off-hand (Two-Weapon Fighting) ──
    if(!bonusUsed && !ov.noOffhand && targetToken){
      const dist = this._tokenDistanceFt(tokenDoc, targetToken);
      const mainWeapon = this._bestWeaponForRange(actor, dist, {prefersMelee:tactics?.prefersMelee});
      const offHand = this._bestWeaponForRange(actor, dist, {excludeMain:true, prefersMelee:tactics?.prefersMelee});
      if(offHand && offHand.id !== mainWeapon?.id && this._isWeaponLight(mainWeapon) && this._isWeaponLight(offHand) && dist <= this._getWeaponRange(offHand) + 3){
        await this._npcAttack(actor, offHand, targetToken, tokenDoc);
        await this._stepDelay();
      }
    }

    // ── Post-Action Movement: reposition if movement remains ──
    if(moveBudget.ft > 0 && targetToken && !ov.noMove){
      const dist = this._tokenDistanceFt(tokenDoc, targetToken);
      /* casters/back-liners: step back if too close */
      const shouldBackOff = ['controller','sorcerer','wizard','warlock','bard','cleric','druid','sniper','flying'].includes(tactics?.arch);
      if(shouldBackOff && dist < 20 && dist > 5){
        const backFt = Math.min(moveBudget.ft, 15);
        if(backFt > 0){
          const backRes = await this._npcMoveAway(tokenDoc, targetToken, backFt);
          if(backRes.movedFt > 0){
            moveBudget.ft -= backRes.movedFt;
            await this._say(`🏃 ${this._personalityLine(actor, 'move')}
${backRes.msg}`, actor);
            await this._stepDelay();
          }
        }
      }
      /* melee fighters: close to 5 ft if further than needed */
      else if(!shouldBackOff && dist > 7 && dist <= 30){
        const weapon = this._bestWeaponForRange(actor, dist, {prefersMelee:true});
        if(weapon && dist > this._getWeaponRange(weapon) + 3){
          const closeRes = await this._npcMoveToTarget(tokenDoc, targetToken, weapon, {maxMoveFt: moveBudget.ft, tactics});
          if(closeRes.movedFt > 0){
            moveBudget.ft -= closeRes.movedFt;
            await this._say(`🏃 ${this._personalityLine(actor, 'move')}
${closeRes.msg}`, actor);
            await this._stepDelay();
          }
        }
      }
    }

    // ── Dodge when wounded and no target or no action used ──
    if(!actionUsed && hpPct < (tactics?.retreatThreshold || 0.20) && (!targetToken || tactics?.positioning !== 'charge')){
      await this._doDodge(actor);
      actionUsed = true;
    }

    // ── Help action when near ally and no enemies ──
    if(!actionUsed && !enemyTokens.length && allyTokens.length){
      await this._doHelp(actor, tokenDoc, allyTokens);
      actionUsed = true;
    }

    // ── Object interaction: quaff potion randomly ──
    if(Math.random() < 0.15 && hpPct < 0.5){
      await this._quaffPotion(actor);
    }
  }

  static _isWeaponLight(weapon){
    if(!weapon)return false;
    const props=weapon.system?.properties||[];
    if(Array.isArray(props))return props.includes('lgt')||props.includes('light');
    if(typeof props==='object'&&props!==null) return !!(props.lgt||props.light);
    return false;
  }

  static _isWeaponThrown(weapon){
    if(!weapon) return false;
    /* dnd5e stores the Thrown property in system.properties (varies by version)
       or in the attack activity's properties. Also check weapon.name for
       common thrown weapons as a robust fallback.
       
       dnd5e formats: "thr" or "thrown" as array strings, object keys, or Map keys.
       dnd5e 3.x may store properties as null on system but available on activities. */
    
    /* 1. Check attack activity properties (most reliable across versions) */
    const act = this._attackActivity(weapon);
    if(act?.range?.long && !act?.range?.reach) {
      /* A pure ranged weapon (bow, crossbow) has long range but no reach.
         A thrown melee weapon has both reach/value AND long range. */
      if(!act.range.value) return false;
    }
    if(act?.properties) {
      if(this._checkThrownProperty(act.properties)) return true;
    }
    
    /* 2. Check system.properties */  
    const sysProps = weapon.system?.properties;
    if(sysProps && this._checkThrownProperty(sysProps)) return true;
    
    /* 3. Check identification.identified.properties (dnd5e 3.x deferred) */
    const idProps = foundry.utils.getProperty(weapon.system, 'identification.identified.properties');
    if(idProps && this._checkThrownProperty(idProps)) return true;
    
    /* 4. Weapon name fallback for common thrown melee weapons */
    const name = (weapon.name || '').toLowerCase();
    if(/^(?:dagger|javelin|spear|trident|handaxe|light hammer|dart|net|throwing)/i.test(name)) return true;
    
    return false;
  }
  
  static _checkThrownProperty(props){
    /* ES6 Map format (dnd5e 3.x) */
    if(props instanceof Map){
      if(props.has('thr') || props.has('thrown')) return true;
      for(const [key, val] of props.entries()){
        if(/^thr(?:own)?$/i.test(key)) return true;
        if(val && typeof val === 'object'){
          const id = val.id || val.name || val._id || '';
          if(/^thr(?:own)?$/i.test(id)) return true;
        }
      }
      return false;
    }
    /* Array format */
    if(Array.isArray(props)){
      return props.some(p => {
        if(typeof p === 'string') return /^thr(?:own)?$/i.test(p);
        if(p && typeof p === 'object'){
          const id = p.id || p.name || '';
          return /^thr(?:own)?$/i.test(id);
        }
        return false;
      });
    }
    /* Object format */
    if(typeof props === 'object'){
      for(const key of Object.keys(props)){
        if(/^thr(?:own)?$/i.test(key)){
          const val = props[key];
          if(val === true || val === 1 || val === 'true') return true;
          if(val && typeof val === 'object'){
            const id = val.id || val.name || '';
            if(/^thr(?:own)?$/i.test(id)) return true;
          }
        }
        /* Check values for object-with-id format */
        if(props[key] && typeof props[key] === 'object'){
          const id = props[key].id || props[key].name || '';
          if(/^thr(?:own)?$/i.test(id)) return true;
        }
      }
      return false;
    }
    return false;
  }

  /* ═══════════════════════════════════════════════════════════════════
     THROWN WEAPON DROPS (native — no ItemPiles dependency)
     When an NPC throws a weapon, reduce quantity by 1 and spawn
     a loot token on the map at the target's location.
     ═══════════════════════════════════════════════════════════════════ */
  static async _dropThrownWeapon(actor, item, selfToken, targetToken, hit){
    const setting = game.settings.get(MODULE_ID, 'dropThrownWeapons');
    this._log(`_dropThrownWeapon: setting=${setting}, item=${item?.name}, thrown=${this._isWeaponThrown(item)}`);
    if(!setting) return;
    if(!item || !selfToken || !targetToken) return;
    if(!this._isWeaponThrown(item)) return;

    /* 1. Reduce quantity on the NPC, or remove if last one */
    let qty = item.system?.quantity ?? 1;
    if(qty > 1){
      await item.update({'system.quantity': qty - 1}).catch(()=>{});
      this._log(`${actor.name} threw ${item.name}; ${qty-1} remaining.`);
    } else {
      await actor.deleteEmbeddedDocuments('Item', [item.id]).catch(()=>{});
      this._log(`${actor.name} threw their last ${item.name}.`);
    }

    /* 2. Figure drop position: near target on hit, short scatter on miss */
    const grid = canvas.grid;
    const gridDist = grid?.distance || 5;
    const gridPx = grid?.size || 50;
    let dropX, dropY;
    const targetDoc = targetToken.document || targetToken;
    const selfDoc = selfToken.document || selfToken;
    if(hit){
      dropX = targetDoc.x;
      dropY = targetDoc.y;
    } else {
      /* Scatter short of target */
      const dx = targetDoc.x - selfDoc.x;
      const dy = targetDoc.y - selfDoc.y;
      const frac = 0.5 + (Math.random() * 0.3); /* 50-80% of the way */
      dropX = selfDoc.x + dx * frac;
      dropY = selfDoc.y + dy * frac;
    }

    /* 3. Snap to grid */
    let snapped;
    if(grid.getSnappedPoint){
      snapped = grid.getSnappedPoint({x: dropX, y: dropY}, {mode: CONST.GRID_SNAPPING_MODES.CENTER});
    } else {
      snapped = {x: Math.round(dropX / gridPx) * gridPx, y: Math.round(dropY / gridPx) * gridPx};
    }

    /* 4. Create / fetch the loot-pile actor */
    let pileActor = await this._getOrCreateLootActor();
    if(!pileActor) return;

    /* 5. Build token data: item image, name, small scale */
    const itemImg = item.img || item.texture?.src || 'icons/weapons/daggers/dagger-simple-blue-grey.webp';
    this._log(`_dropThrownWeapon: creating token at [${snapped.x},${snapped.y}] img=${itemImg}`);
    const tokenData = await pileActor.getTokenDocument({
      x: snapped.x, y: snapped.y,
      name: item.name,
      'texture.src': itemImg,
      'texture.scaleX': 0.8, 'texture.scaleY': 0.8,
      width: 1, height: 1,
      actorLink: false,
      vision: false,
      displayName: 50,
      elevation: targetDoc.elevation ?? 0
    });
    this._log(`_dropThrownWeapon: got tokenDocument, placing...`);

    /* 6. Place token on current scene */
    const scene = canvas.scene;
    if(!scene) return;
    const [placed] = await scene.createEmbeddedDocuments('Token', [tokenData.toObject()]);
    if(!placed) return;

    /* 7. Add the item to the synthetic actor (with full data so it can be picked up) */
    const itemData = item.toObject ? item.toObject() : foundry.utils.duplicate(item);
    itemData.system.quantity = 1; /* just the one thrown */
    await placed.actor.createEmbeddedDocuments('Item', [itemData]).catch(()=>{});

    this._log(`Dropped ${item.name} at [${snapped.x}, ${snapped.y}] → token ${placed.name}`);
  }

  static async _getOrCreateLootActor(){
    const cacheKey = '_lootActorId';
    let actor = game.actors.get(this[cacheKey]);
    if(actor) return actor;

    /* Find existing loot actor by name */
    actor = game.actors.find(a => a.name === 'Dropped Weapons' && a.type === 'npc');
    if(actor){
      this[cacheKey] = actor.id;
      return actor;
    }

    /* Create a minimal loot-bearer NPC */
    actor = await Actor.create({
      name: 'Dropped Weapons',
      type: 'npc',
      img: 'icons/svg/item-bag.svg',
      prototypeToken: {
        actorLink: false,
        bar1: {attribute: ''},
        vision: false,
        displayName: 50
      }
    }, {displaySheet: false});
    if(actor){
      this[cacheKey] = actor.id;
      this._log(`Created loot actor: Dropped Weapons (${actor.id})`);
    }
    return actor;
  }

  /* ── Multiattack ── */
  static async _doMultiattack(actor, enemyTokens, items, selfToken, moveBudget, stickyTarget, tactics) {
    const multi = items.find(i=>i.type==='feat'&&/multiattack/i.test(i.name));
    if(!multi) return false;

    let rawDesc = multi.system?.description?.value || '';
    const desc = rawDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    this._log(`Multiattack: "${desc.slice(0,120)}"`);

    const weaponMap={};
    for(const it of items){
      if(!this._hasAttackActivity(it)) continue;
      if(it.type==='feat'&&/multiattack/i.test(it.name)) continue;
      weaponMap[it.name.toLowerCase()]=it;
      weaponMap[it.name.toLowerCase().replace(/\s+/g,'')]=it;
    }

    const attacks=[];
    let m;
    const rxA = /(?:makes\s+)?(\w+|\d+)\s+(?:\w+\s+)?attack[s]?\s+(?:with\s+(?:its\s+|their\s+|a\s+)?)?([\w\s]+?)(?:\.|,|\s+and\s|\s+using\s|\s+attacks?\b|\s+each\b)/gi;
    while((m=rxA.exec(desc))!==null){
      const count=this._wordToNum(m[1]);
      const rawName=m[2].trim().replace(/^(?:its\s|their\s|a\s)/, '');
      let matched=weaponMap[rawName.toLowerCase()];
      if(!matched) matched=weaponMap[rawName.toLowerCase().replace(/\s+/g,'')];
      if(!matched){ const rl=rawName.toLowerCase().replace(/\s+/g,''); for(const [k,v] of Object.entries(weaponMap)){ if(k.includes(rl)||rl.includes(k)){matched=v;break;} } }
      if(matched) for(let i=0;i<count;i++) attacks.push(matched);
    }

    if(!attacks.length){
      const rxB = /(?:using|with|or)\s+([\w\s,]+?)\s+(?:in any combination|in any order|alternatively)/i;
      const bm = desc.match(rxB);
      if(bm){
        for(const p of bm[1].split(/\s+or\s+|,\s+/)){
          const raw=p.trim(); if(!raw) continue;
          let matched = weaponMap[raw.toLowerCase()];
          if(!matched) matched = weaponMap[raw.toLowerCase().replace(/\s+/g,'')];
          if(!matched){ const rl=raw.toLowerCase().replace(/\s+/g,''); for(const [k,v] of Object.entries(weaponMap)){ if(k.includes(rl)||rl.includes(k)){matched=v;break;} } }
          if(matched) attacks.push(matched);
        }
      }
    }

    if(!attacks.length){
      for(const it of items){
        if(it.type==='feat'&&/multiattack/i.test(it.name)) continue;
        if(!this._hasAttackActivity(it)) continue;
        if(desc.includes(it.name.toLowerCase())) attacks.push(it);
      }
    }

    if(!attacks.length) return false;

    let finalTarget = stickyTarget;
    let finalAttacks = attacks;
    if(finalAttacks.length === 1 && attacks.length < 2){
      finalAttacks = [attacks[0], attacks[0]];
    }

    let attacksPerformed = 0;
    let lastWeapon=null;
    for(const weapon of finalAttacks){
      if(!finalTarget) { lastWeapon=weapon; continue; }
      const weaponChanged = lastWeapon && lastWeapon.id !== weapon.id;
      let target = finalTarget;

      if(weaponChanged){
        const dist = this._tokenDistanceFt(selfToken, finalTarget);
        const range = this._getWeaponRange(weapon);
        if(finalTarget && dist > range+3 && moveBudget.ft > 0){
          const moveRes = await this._npcMoveToTarget(selfToken, finalTarget, weapon, {maxMoveFt: moveBudget.ft, tactics});
          if(moveRes.movedFt){
            moveBudget.ft -= moveRes.movedFt;
            if(moveRes.msg){ await this._say(`🏃 ${this._personalityLine(actor, 'move')}
${moveRes.msg}`, actor); await this._stepDelay(); }
            await this._stepDelay();
            const refreshed = canvas.tokens.get(selfToken.id);
            if(refreshed) selfToken = refreshed.document || refreshed;
          }
        }
        const newDist = this._tokenDistanceFt(selfToken, finalTarget);
        if(finalTarget && newDist > this._getWeaponRange(weapon)+3){
          const inRange=enemyTokens.filter(t=>{ const d=this._tokenDistanceFt(selfToken,t); return d<=this._getWeaponRange(weapon)+3; });
          target = inRange.length ? this._pickTarget(inRange, selfToken, actor, tactics) : this._pickTarget(enemyTokens, selfToken, actor, tactics);
        }
      }
      if(!target) { lastWeapon=weapon; continue; }

      const dist=this._tokenDistanceFt(selfToken, target);
      const range=this._getWeaponRange(weapon);
      if(dist <= range + 3){
        await this._npcAttack(actor, weapon, target, selfToken);
        attacksPerformed++;
        await this._stepDelay();
      } else {
        await this._say(`⚠️ ${actor.name}'s ${weapon.name} out of range (${Math.round(dist)}>${range} ft).`, actor, {whisper:true});
      }
      lastWeapon=weapon;
    }
    return attacksPerformed > 0;
  }

  static _wordToNum(w){ const map={one:1,two:2,three:3,four:4,five:5}; const n=parseInt(w); return isNaN(n)?(map[w?.toLowerCase()]||1):n; }

  static _getSpeed(actor) {
    const mov = actor.system?.attributes?.movement || {};
    if(mov.fly) return mov.fly;
    if(mov.swim) return mov.swim;
    if(mov.climb) return mov.climb;
    if(mov.walk) return mov.walk;
    if(mov.burrow) return mov.burrow;
    return 30;
  }

  /* ═══════════════════════════════════════════════════════════════════
     ATTACK / USE ITEM
     ═══════════════════════════════════════════════════════════════════ */
  static async _npcAttack(actor, item, targetToken, selfToken) {
    if(!item){ await this._say(`⚠️ ${actor.name} has no weapon.`, actor, {whisper:true}); return; }
    if(!targetToken){ await this._say(`⚠️ ${actor.name} has no target.`, actor, {whisper:true}); return; }

    const dist = this._tokenDistanceFt(selfToken, targetToken);
    const range = this._getWeaponRange(item);
    this._log(`${actor.name} → ${targetToken.name} (${Math.round(dist)}ft, range ${range}ft, item "${item.name}")`);
    await actor.setFlag(MODULE_ID, 'lastAttackWeapon', item.name).catch(()=>{});

    if(dist > range + 3){
      await this._say(`⚠️ ${actor.name} is ${Math.round(dist)} ft from ${targetToken.name} — ${item.name} only reaches ${range} ft.`, actor, {whisper:true});
      return;
    }

    /* ── Disadvantage within 5 ft: swap to melee if possible, else abort ── */
    if(dist <= 7 && !this._isWeaponThrown(item) && range > 10){
      const meleeAlt = this._bestWeaponForRange(actor, dist, {prefersMelee:true});
      if(meleeAlt && this._getWeaponRange(meleeAlt) <= 10){
        item = meleeAlt;
        this._log(`switched to ${item.name} to avoid ranged-in-melee disadvantage`);
      } else {
        await this._say(`⚠️ ${actor.name} is too close to use ${item.name} without disadvantage (no melee weapon available).`, actor, {whisper:true});
        return;
      }
    }

    const fastRoll = game.settings.get(MODULE_ID, 'npcAutopilotFastRoll');
    const oldTargets = Array.from(game.user.targets).map(t=>t.id);
    const oldControlled = Array.from(canvas.tokens.controlled).map(t=>t.id);

    try{
      const tgt = targetToken.object || targetToken;
      const self = selfToken?.object || selfToken;
      if(tgt?.setTarget) tgt.setTarget(true, {user: game.user, releaseOthers: true});
      if(self?.control) self.control({releaseOthers: true});
      await this._stepDelay();

      let isHit = true; /* default for paths where we can't determine hit/miss */

      /* ── Unified attack path: always use activity.rollAttack so target AC is known up-front ── */
      const activity = this._attackActivity(item);
      if(activity && typeof activity.rollAttack === 'function'){
        try{
          const targetAC = targetToken?.actor?.system?.attributes?.ac?.value || 10;
          const attackRolls = await activity.rollAttack(
            /* inject target AC so dnd5e renders correct hit/miss styling on the card */
            {event: null, target: targetToken.actor ? {value: targetAC} : undefined},
            {configure: false}, {create: true}
          );
          if(attackRolls && attackRolls.length){
            const atk = attackRolls[0];
            isHit = atk.total >= targetAC;
            const isCrit = atk.isCritical || false;
            if(isHit){
              if(isCrit){
                await this._say(`💥 ${this._personalityLine(actor, 'crit', {target: targetToken.name})}
**Critical hit!** (Roll ${atk.total})`, actor);
              }else{
                await this._say(`💥 ${this._personalityLine(actor, 'attack', {target: targetToken.name})}
(Roll ${atk.total})`, actor);
              }
              await this._ollamaNarrateAction(actor, targetToken, item, 'hit');
              this._ollamaLogEvent(`${actor.name} hit ${targetToken.name} with ${item.name}`);
              await this._stepDelay();
              if(typeof activity.rollDamage === 'function'){
                await activity.rollDamage({event: null, isCritical: isCrit}, {configure: false}, {create: true});
              }
            } else {
              await this._say(`❌ ${this._personalityLine(actor, 'miss', {target: targetToken.name})}
(Rolled ${atk.total} vs AC ${targetAC})`, actor);
              await this._ollamaNarrateAction(actor, targetToken, item, 'miss');
              this._ollamaLogEvent(`${actor.name} missed ${targetToken.name} with ${item.name}`);
              await this._stepDelay();
            }
          }
        }catch(e1){ this._log(`activity.rollAttack error: ${e1.message}`); }
      }
      /* Fallback C: legacy item.use() */
      else if(typeof item.use === 'function'){
        try{ await item.use({configure:false, createMessage:true}); }catch(e2){}
      }
      /* Fallback D: legacy rollAttack */
      else if(typeof item.rollAttack === 'function'){
        try{
          const atk = await item.rollAttack({event: null, fastForward: fastRoll});
          if(atk && atk.total !== undefined){
            const targetAC = targetToken.actor?.system?.attributes?.ac?.value || 10;
            isHit = atk.total >= targetAC;
            if(isHit){
              await this._say(`💥 ${this._personalityLine(actor, 'attack', {target: targetToken.name})}\\n(Attack roll ${atk.total})`, actor);
              await this._stepDelay();
              if(typeof item.rollDamage === 'function') await item.rollDamage({event: null, fastForward: fastRoll});
            } else {
              await this._say(`❌ ${this._personalityLine(actor, 'miss', {target: targetToken.name})}
(Rolled ${atk.total} vs AC ${targetAC})`, actor);
              await this._stepDelay();
            }
          }
        }catch(e3){}
      }
      /* Fallback E: manual roll */
      else {
        try{
          const bonus = this._getAtkBonus(actor, item);
          const roll = await new Roll(`1d20 + ${bonus}`).evaluate();
          await roll.toMessage({ speaker: ChatMessage.getSpeaker({actor}), flavor: `${actor.name} attacks ${targetToken.name} with ${item.name}` });
        }catch(e4){}
      }

      /* ── Drop thrown weapon if applicable ── */
      await this._dropThrownWeapon(actor, item, selfToken, targetToken, isHit);

    }catch(err){ console.error('[NPC Autopilot] attack fatal error', err); }
    finally{
      if(game.user.updateTokenTargets) game.user.updateTokenTargets(oldTargets);
      else {
        for(const t of Array.from(game.user.targets)){ const p=t.object||t; if(p.setTarget) p.setTarget(false,{user:game.user}); }
        for(const id of oldTargets){ const to=canvas.tokens.get(id); if(to?.setTarget) to.setTarget(true,{user:game.user}); }
      }
      for(const t of Array.from(canvas.tokens.controlled)){ const p=t.object||t; if(p.release) p.release(); }
      for(const id of oldControlled){ const to=canvas.tokens.get(id); if(to?.control) to.control({releaseOthers:false}); }
    }
  }

  static async _useItem(actor, item, targetToken, selfToken) {
    if(!item) return;
    this._log(`_useItem: ${actor.name} → ${item.name}`);

    /* consume spell if applicable */
    if(item.type === 'spell'){
      const level = item.system?.level ?? 0;
      if(level > 0){
        const slots = actor.system?.spells;
        const slotKey = 'spell'+level;
        if(slots?.[slotKey]?.value > 0){
          await actor.update({ [`system.spells.${slotKey}.value`]: Math.max(0, slots[slotKey].value - 1) });
        }
      }
      if(typeof item.system?.uses?.value === 'number' && item.system.uses.value > 0){
        await item.update({ 'system.uses.value': Math.max(0, item.system.uses.value - 1) });
      }
      this._trackSpellCast(actor, item);
    }
    const oldTargets = Array.from(game.user.targets).map(t=>t.id);
    const oldControlled = Array.from(canvas.tokens.controlled).map(t=>t.id);

    const fastRoll = game.settings.get(MODULE_ID, 'npcAutopilotFastRoll');
    const mqol = game.modules.get("midi-qol")?.active ? globalThis.MidiQOL : null;
    let midiBackup = null;
    if(fastRoll && mqol?.configSettings){
      const cs = mqol.configSettings;
      midiBackup = {
        autoRollAttack: cs.autoRollAttack, autoRollDamage: cs.autoRollDamage,
        gmAutoAttack: cs.gmAutoAttack, gmAutoDamage: cs.gmAutoDamage,
        autoFastForward: [...(cs.autoFastForward||[])], gmAutoFastForward: [...(cs.gmAutoFastForward||[])]
      };
      cs.autoRollAttack = true;  cs.autoRollDamage = "always";
      cs.gmAutoAttack = true;    cs.gmAutoDamage = "always";
      for(const arr of [cs.autoFastForward, cs.gmAutoFastForward]){
        if(!Array.isArray(arr)) continue;
        if(!arr.includes("attack")) arr.push("attack");
        if(!arr.includes("damage")) arr.push("damage");
      }
    }

    try{
      if(targetToken){ const tgt=targetToken.object||targetToken; if(tgt.setTarget) tgt.setTarget(true,{user:game.user,releaseOthers:true}); }
      const self=selfToken?.object||selfToken;
      if(self?.control) self.control({releaseOthers:true});
      await this._stepDelay();

      let executed = false;
      const activity = this._firstActivity(item);

      if(mqol?.Workflow && activity && typeof activity.use === 'function'){
        try{ await activity.use({consume:false},{configure:false},{create:true}); executed=true; }catch(e){}
      }
      if(!executed && activity && typeof activity.use === 'function'){
        try{ await activity.use({consume:false},{configure:false},{create:true}); executed=true; }
        catch(e1){ try{ await activity.use({configureDialog:false,createMessage:true,consume:false}); executed=true; }catch(e2){} }
      }
      if(!executed && typeof item.use === 'function'){
        try{ await item.use({configure:false, createMessage:true}); executed=true; }catch(e){}
      }
      if(!executed){
        const isHeal = /heal|cure|restoration|aid|prayer/i.test(item.name);
        await this._say(`${isHeal ? '🩹' : '🔥'} **${actor.name}** ${isHeal ? this._personalityLine(actor, 'heal') : 'unleashes **' + item.name + '** on **' + (targetToken?.name||'target') + '**!'}`, actor);
        await this._stepDelay();
      }
    }catch(err){ console.error('[NPC Autopilot] useItem error', err); }
    finally{
      if(midiBackup && mqol?.configSettings){
        const cs = mqol.configSettings;
        cs.autoRollAttack = midiBackup.autoRollAttack;   cs.autoRollDamage = midiBackup.autoRollDamage;
        cs.gmAutoAttack = midiBackup.gmAutoAttack;       cs.gmAutoDamage = midiBackup.gmAutoDamage;
        cs.autoFastForward = midiBackup.autoFastForward; cs.gmAutoFastForward = midiBackup.gmAutoFastForward;
      }
      if(game.user.updateTokenTargets) game.user.updateTokenTargets(oldTargets);
      for(const t of Array.from(canvas.tokens.controlled)){ const p=t.object||t; if(p.release) p.release(); }
      for(const id of oldControlled){ const to=canvas.tokens.get(id); if(to?.control) to.control({releaseOthers:false}); }
    }
  }

  /* ── Activity extractors ── */
  static _allActivities(item){
    const a=item.system?.activities; if(!a)return[];
    const out=[];
    if(typeof a.values==='function'){ for(const v of a.values()) out.push(v); }
    else if(typeof a.forEach==='function'){ a.forEach(v=>out.push(v)); }
    else if(Array.isArray(a?.contents)) out.push(...a.contents.filter(Boolean));
    else out.push(...Object.values(a).filter(v=>v&&(typeof v.use==='function'||v.constructor?.name?.includes('Activity'))));
    return out;
  }
  static _firstActivity(item){ return this._allActivities(item)[0]||null; }
  static _attackActivity(item){
    const acts=this._allActivities(item);
    return acts.find(a=>a.type==='attack'||a.constructor?.name?.includes('Attack')||/attack|strike|damage|hit/i.test(a.name))
      ||acts.find(a=>typeof a.use==='function')
      ||null;
  }
  static _hasAttackActivity(item){ return !!this._attackActivity(item); }

  /* ── Weapon selection (tactic-aware) ── */
  static _bestWeaponForRange(actor, distFt, opts={}){
    const items=actor.items?.contents||[];
    let cands=items.filter(i=>
      (['weapon','equipment'].includes(i.type)||(i.type==='feat'&&!/multiattack/i.test(i.name)))
      &&this._hasAttackActivity(i)
    );
    if(!cands.length) cands=items.filter(i=>i.type==='feat'&&this._hasAttackActivity(i)
      &&/attack|hit|strike|claw|bite|tail|slam|tentacle|horn|gore|punch|kick|stab/i.test(i.name));
    if(!cands.length) return items.find(i=>i.type==='weapon')||items.find(i=>i.type==='feat'&&this._hasAttackActivity(i));

    /* ── Ranged weapons are at disadvantage within 5 ft; exclude them unless thrown ── */
    if(distFt!==undefined && distFt <= 7){
      const meleeOk = cands.filter(w=>{
        const r=this._getWeaponRange(w);
        return r <= 10 || this._isWeaponThrown(w); /* reach melee, normal melee, or thrown */
      });
      if(meleeOk.length) cands = meleeOk;
    }

    if(opts.prefersMelee){
      const melee=cands.filter(w=>this._getWeaponRange(w)<=10);
      if(melee.length) cands=melee;
    }

    if(distFt!==undefined){
      if(distFt<=10){
        const melee=cands.filter(w=>this._getWeaponRange(w)<=10);
        if(melee.length) cands=melee;
      } else {
        const ranged=cands.filter(w=>this._getWeaponRange(w)>10);
        if(ranged.length) cands=ranged;
      }
    }

    if(opts.excludeMain&&cands.length>1){
      const main=this._bestWeaponForRange(actor, distFt, {prefersMelee:opts.prefersMelee});
      const alt=cands.find(w=>w.id!==main?.id);
      if(alt) cands=[alt];
    }
    return cands[0];
  }

  static _findSpell(actor,rx){ return(actor.items?.contents||[]).find(i=>i.type==='spell'&&rx.test(i.name)); }

  /* ── Tactical target selection ── */
  static _pickTarget(enemyTokens, selfToken=null, actor=null, tactics=null){
    if(!enemyTokens.length)return null;
    if(enemyTokens.length===1)return enemyTokens[0];

    const preferWounded = tactics?.preferWounded || false;
    const scored = enemyTokens.map(t=>{
      const hp = t.actor?.system?.attributes?.hp||{};
      const hpPct = (hp.value||0)/Math.max(1,hp.max||1);
      const dist = selfToken ? this._tokenDistanceFt(selfToken, t) : 30;
      const targetCount = this._getTargetedCountThisRound(t);
      const jitter = Math.random();
      let score = (dist*1.2) + (jitter*30);
      if(preferWounded){
        score -= (1 - hpPct)*100;
      } else {
        score += (hpPct*25);
      }
      score += (targetCount*200); /* heavily penalise pile-on */
      return{token:t, score};
    });
    scored.sort((a,b)=>a.score-b.score);
    return scored[0].token;
  }

  /* ── In-memory target tracking (eliminates async race conditions) ── */
  static _targetCounts = {};

  static _getTargetedCountThisRound(token){
    if(!token) return 0;
    return this._targetCounts[token.id] || 0;
  }
  static _incrementTargetCount(token){
    if(!token) return;
    this._targetCounts[token.id] = (this._targetCounts[token.id] || 0) + 1;
    /* async persistence to combat flag (non-blocking) */
    if(game.combat){
      const counts = foundry.utils.duplicate(game.combat.getFlag(MODULE_ID, 'targetCounts') || {});
      counts[token.id] = this._targetCounts[token.id];
      game.combat.setFlag(MODULE_ID, 'targetCounts', counts).catch(()=>{});
    }
  }
  static _resetTargetCounts(){
    this._targetCounts = {};
    if(!game.combat) return;
    game.combat.unsetFlag(MODULE_ID, 'targetCounts').catch(()=>{});
  }

  static _liveTokenDoc(token){
    if(!token) return null;
    const live = canvas.tokens?.get(token.id);
    return (live?.document || token?.document || token);
  }
  static async _safeUpdate(token, updates){
    const doc = this._liveTokenDoc(token);
    if(!doc){ console.warn('[NPC Autopilot] _safeUpdate: no live document'); return; }
    try{ await doc.update(updates); }catch(e){ console.warn('[NPC Autopilot] _safeUpdate failed:', e.message); }
  }
  static async _npcMoveToTarget(selfToken, targetToken, weapon, opts={}){
    if(!selfToken||!targetToken||!canvas?.grid)return{movedFt:0,msg:''};
    const self=selfToken.document||selfToken;
    const target=targetToken.document||targetToken;
    const gridDist=canvas.grid.distance||5;
    const gridPx=canvas.grid.size||50;
    const distFt=this._tokenDistanceFt(selfToken, targetToken);
    const speedFt=opts.maxMoveFt ?? selfToken.actor?.system?.attributes?.movement?.walk ?? 30;
    const range=this._getWeaponRange(weapon);
    const tactics = opts.tactics || {};
    const desiredRange = opts.desiredRange; /* caster override */

    let standOffFt;
    const pos = tactics.positioning || 'charge';
    if(desiredRange){
      standOffFt = Math.max(5, desiredRange * 0.6); /* close enough to cast, far enough to avoid melee */
    } else if(range<=5){
      standOffFt = 0; /* 5 ft weapons: close to adjacent */
    } else if(range===10){
      standOffFt = 5; /* reach weapons: stop at 5 ft (10 ft reach from there) */
    } else {
      if(pos==='hang_back'){
        standOffFt = Math.max(range * 0.4, 15);
      } else if(pos==='mid'){
        standOffFt = Math.max(range * 0.5, 10);
      } else if(pos==='flank'){
        standOffFt = Math.max(range * 0.4, 5);
      } else {
        standOffFt=Math.max(range*0.5, 10);
      }
      if(standOffFt > distFt-5) standOffFt=Math.max(0, distFt-5);
      if(distFt <= range && distFt >= standOffFt) return {msg:'', movedFt:0};
    }

    if(distFt<=standOffFt+2) return {msg:'', movedFt:0};

    const standOffPx=(standOffFt/gridDist)*gridPx;
    const maxMovePx=(speedFt/gridDist)*gridPx;

    const dx=self.x-target.x, dy=self.y-target.y;
    const totalPx=Math.hypot(dx,dy);
    if(totalPx<=standOffPx) return {msg:'', movedFt:0};

    const angle=Math.atan2(target.y-self.y, target.x-self.x);
    const movePx=Math.min(maxMovePx, totalPx-standOffPx);
    if(movePx<=0) return {msg:'', movedFt:0};

    let dest;
    if(pos==='flank' || pos==='skirmisher'){
      dest = this._findFlankPosition(self, target, movePx);
    }
    if(!dest) dest={x:self.x+Math.cos(angle)*movePx, y:self.y+Math.sin(angle)*movePx};
    else {
      const flankDist=Math.hypot(dest.x-self.x, dest.y-self.y);
      if(flankDist > movePx) dest = {x:self.x+Math.cos(angle)*movePx, y:self.y+Math.sin(angle)*movePx};
      const destDx=dest.x-target.x, destDy=dest.y-target.y;
      const destDistPx=Math.hypot(destDx,destDy);
      if(destDistPx<standOffPx){
        const shrink=(totalPx-standOffPx)/(totalPx||1);
        dest={x:self.x+dx*shrink, y:self.y+dy*shrink};
      }
    }

    const snapped=canvas.grid.getSnappedPoint?canvas.grid.getSnappedPoint({x:dest.x,y:dest.y},{mode:CONST.GRID_SNAPPING_MODES.CENTER}):dest;

    /* -- Door detection: try to open blocking doors before checking collision -- */
    if(game.settings.get(MODULE_ID, 'npcDoorAware')){
      const blockingDoor = this._findBlockingDoor({x:self.x,y:self.y}, snapped);
      if(blockingDoor){
        const opened = await this._tryOpenDoor(blockingDoor);
        if(opened){
          const snapped2=canvas.grid.getSnappedPoint?canvas.grid.getSnappedPoint({x:dest.x,y:dest.y},{mode:CONST.GRID_SNAPPING_MODES.CENTER}):dest;
          const hit2=CONFIG.Canvas.polygonBackends?.move?.testCollision?CONFIG.Canvas.polygonBackends.move.testCollision({x:self.x,y:self.y}, snapped2, {type:'move',mode:'any'}):false;
          if(!hit2){
            const movedFt2=Math.round((Math.hypot(snapped2.x-self.x, snapped2.y-self.y)/gridPx)*gridDist);
            await this._safeUpdate(selfToken, {x:snapped2.x,y:snapped2.y});
            return {msg:`${selfToken.name} opens a door and advances.`, movedFt:movedFt2};
          }
        }
      }
    }

    /* -- Pathfinding: try to navigate around walls -- */
    const hit=CONFIG.Canvas.polygonBackends?.move?.testCollision?CONFIG.Canvas.polygonBackends.move.testCollision({x:self.x,y:self.y}, snapped, {type:'move',mode:'any'}):false;

    if(hit && game.settings.get(MODULE_ID, 'npcPathfinding')){
      /* Use actual target center (always valid) for waypoint generation, not snapped (may be behind wall) */
      const targetCenter = {x: target.x + (target.width || 1) * gridPx / 2, y: target.y + (target.height || 1) * gridPx / 2};
      const waypoints = this._getPathwaypoints({x:self.x,y:self.y}, targetCenter);
      if(waypoints?.length){
        const pfResult = await this._moveAlongPath(selfToken, waypoints, targetCenter, maxMovePx, gridPx, gridDist);
        if(pfResult.movedFt > 0){
          const pfMsg = opts.fromMemory
            ? selfToken.name + ' investigates.'
            : selfToken.name + ' navigates around obstacles toward ' + targetToken.name + '.';
          return {msg: pfMsg, movedFt: pfResult.movedFt};
        }
      }
    }

    const movedFt=Math.round((Math.hypot(snapped.x-self.x, snapped.y-self.y)/gridPx)*gridDist);

    if(hit){
      const safe=this._findSafePosition(self,snapped,maxMovePx);
      if(safe){
        const safeMoved=Math.round((Math.hypot(safe.x-self.x, safe.y-self.y)/gridPx)*gridDist);
        await this._safeUpdate(selfToken, {x:safe.x,y:safe.y});
        return {msg:`${selfToken.name} manoeuvres closer.`, movedFt:safeMoved};
      }
      return {msg:'', movedFt:0};
    }
    await this._safeUpdate(selfToken, {x:snapped.x,y:snapped.y});
    return {msg:`${selfToken.name} advances toward ${targetToken.name}.`, movedFt};
  }

  static async _npcRetreat(selfToken, enemyTokens){
    if(!selfToken||!canvas?.grid)return {msg:'', movedFt:0};
    const self=selfToken.document||selfToken;
    const speedFt=this._getSpeed(selfToken.actor);
    const gd=canvas.grid.distance||5;
    const gridPx=canvas.grid.size||50;
    const maxPx=(speedFt/gd)*gridPx;
    let ex=0,ey=0,c=0;
    for(const t of enemyTokens){ const td=t.document||t; ex+=td.x; ey+=td.y; c++; }
    if(!c)return {msg:'', movedFt:0};
    ex/=c; ey/=c;
    const angle=Math.atan2(self.y-ey, self.x-ex);
    const dest={x:self.x+Math.cos(angle)*maxPx, y:self.y+Math.sin(angle)*maxPx};
    const snapped=canvas.grid.getSnappedPoint?canvas.grid.getSnappedPoint({x:dest.x,y:dest.y},{mode:CONST.GRID_SNAPPING_MODES.CENTER}):dest;
    const movedFt=Math.round((Math.hypot(snapped.x-self.x, snapped.y-self.y)/gridPx)*gd);
    const hit=CONFIG.Canvas.polygonBackends?.move?.testCollision?CONFIG.Canvas.polygonBackends.move.testCollision({x:self.x,y:self.y}, snapped, {type:'move',mode:'any'}):false;
    if(hit){
      /* Try pathfinding for retreat */
      if(game.settings.get(MODULE_ID, 'npcPathfinding')){
        const waypoints = this._getPathwaypoints({x:self.x,y:self.y}, {x:snapped.x,y:snapped.y});
        if(waypoints?.length){
          const pfResult = await this._moveAlongPath(selfToken, waypoints, null, maxPx, gridPx, gd);
          if(pfResult.movedFt > 0) return {msg:`${selfToken.name} retreats around obstacles.`, movedFt: pfResult.movedFt};
        }
      }
      const safe=this._findSafePosition(self,snapped,maxPx);
      if(safe){ await this._safeUpdate(selfToken, {x:safe.x,y:safe.y}); return {msg:`${selfToken.name} falls back cautiously.`, movedFt:Math.round((Math.hypot(safe.x-self.x, safe.y-self.y)/gridPx)*gd)}; }
      return {msg:`${selfToken.name} holds position.`, movedFt:0};
    }
    await this._safeUpdate(selfToken, {x:snapped.x,y:snapped.y});
    return {msg:`${selfToken.name} retreats from the fray.`, movedFt};
  }

  static async _npcMoveAway(selfToken, targetToken, maxFt){
    if(!selfToken||!targetToken||!canvas?.grid) return {msg:'', movedFt:0};
    const self=selfToken.document||selfToken;
    const target=targetToken.document||targetToken;
    const gd=canvas.grid.distance||5;
    const gridPx=canvas.grid.size||50;
    const maxPx=(maxFt/gd)*gridPx;

    const dx=self.x-target.x, dy=self.y-target.y;
    const distPx=Math.hypot(dx,dy)||1;
    const angle=Math.atan2(dy,dx);
    const movePx=Math.min(maxPx, distPx-gridPx); /* don't go past target position */
    if(movePx<=0) return {msg:'', movedFt:0};

    const dest={x:self.x+Math.cos(angle)*movePx, y:self.y+Math.sin(angle)*movePx};
    const snapped=canvas.grid.getSnappedPoint?canvas.grid.getSnappedPoint({x:dest.x,y:dest.y},{mode:CONST.GRID_SNAPPING_MODES.CENTER}):dest;
    const movedFt=Math.round((Math.hypot(snapped.x-self.x, snapped.y-self.y)/gridPx)*gd);
    if(movedFt<=0) return {msg:'', movedFt:0};

    await this._safeUpdate(selfToken, {x:snapped.x,y:snapped.y});
    return {msg:`${selfToken.name} withdraws to safer range.`, movedFt};
  }

  static _findFlankPosition(self,target,maxDist){
    const selfDisp = self.disposition || 0;
    const allies=canvas?.tokens?.placeables?.filter(t=>{
      if(t.id===(self.id||self._id)) return false;
      return (t.disposition || 0) === selfDisp && selfDisp !== 0;
    });
    if(!allies?.length)return null;
    let nearest=null,minD=Infinity;
    for(const a of allies){
      const d=Math.hypot((a.document?.x||a.x)-target.x,(a.document?.y||a.y)-target.y);
      if(d<minD){minD=d;nearest=a;}
    }
    if(!nearest)return null;
    const ax=nearest.document?.x||nearest.x, ay=nearest.document?.y||nearest.y;
    const fx=target.x+(target.x-ax), fy=target.y+(target.y-ay);
    const d=Math.hypot(fx-self.x, fy-self.y);
    if(maxDist!==undefined && d>maxDist) return null;
    return{x:fx, y:fy};
  }

  /* ── Pathfinding ──────────────────────────────────────────── */
  /* Find a waypoint around a wall by testing points along a perpendicular offset */
  static _getPathwaypoints(from, to){
    const gridSize = canvas.grid.size || 100;
    const dx = to.x - from.x, dy = to.y - from.y;
    const dist = Math.hypot(dx, dy) || 1;
    const nx = -dy / dist, ny = dx / dist; /* perpendicular unit vector */
    /* Generate waypoints at varying perpendicular offsets at multiple positions along the path */
    const offsets = [1.5, 2.5, 4, 6, 8, 10, 12].map(m => m * gridSize);
    const candidates = [];
    for(const off of offsets){
      for(const frac of [0.1, 0.25, 0.5, 0.75]){ /* near start, quarter, midpoint, three-quarter */
        const pt = {x: from.x + dx * frac, y: from.y + dy * frac};
        candidates.push({x: pt.x + nx * off, y: pt.y + ny * off});
        candidates.push({x: pt.x - nx * off, y: pt.y - ny * off});
      }
    }
    const waypoints = [];
    const tested = new Set();
    for(const pt of candidates){
      const key = Math.round(pt.x/50)+','+Math.round(pt.y/50);
      if(tested.has(key)) continue;
      tested.add(key);
      const hit1 = CONFIG.Canvas.polygonBackends?.move?.testCollision
        ? CONFIG.Canvas.polygonBackends.move.testCollision(from, pt, {type:'move',mode:'any'}) : false;
      if(hit1) continue;
      const hit2 = CONFIG.Canvas.polygonBackends?.move?.testCollision
        ? CONFIG.Canvas.polygonBackends.move.testCollision(pt, to, {type:'move',mode:'any'}) : false;
      if(hit2) continue;
      waypoints.push(pt);
    }
    /* Sort by total distance from + to, return top 3 for chaining */
    waypoints.sort((a,b) => {
      const da = Math.hypot(a.x-from.x, a.y-from.y) + Math.hypot(to.x-a.x, to.y-a.y);
      const db = Math.hypot(b.x-from.x, b.y-from.y) + Math.hypot(to.x-b.x, to.y-b.y);
      return da - db;
    });
    return waypoints.slice(0, 3);
  }

  static async _moveAlongPath(selfToken, waypoints, finalDest, maxMovePx, gridPx, gridDist){
    let totalMovedFt = 0;
    let cur = {x: selfToken.x || selfToken.document?.x || 0, y: selfToken.y || selfToken.document?.y || 0};
    this._log(`_moveAlongPath: ${waypoints.length} wps, max=${Math.round(maxMovePx)}px`);
    for(const wp of waypoints){
      const segDist = Math.hypot(wp.x - cur.x, wp.y - cur.y);
      if(segDist > maxMovePx) break;
      const hit = CONFIG.Canvas.polygonBackends?.move?.testCollision ? CONFIG.Canvas.polygonBackends.move.testCollision(cur, wp, {type:'move',mode:'any'}) : false;
      if(hit){ this._log(`_moveAlongPath: wp blocked (${Math.round(wp.x)},${Math.round(wp.y)})`); continue; }
      const snapped = canvas.grid.getSnappedPoint ? canvas.grid.getSnappedPoint({x:wp.x,y:wp.y},{mode:CONST.GRID_SNAPPING_MODES.CENTER}) : wp;
      await this._safeUpdate(selfToken, {x:snapped.x,y:snapped.y});
      const movedFt = Math.round((segDist / gridPx) * gridDist);
      totalMovedFt += movedFt;
      maxMovePx -= segDist;
      cur = snapped;
    }
    /* Final segment to destination, if movement remains and waypoints got us past the wall */
    if(finalDest && maxMovePx > 0){
      const lastDist = Math.hypot(finalDest.x - cur.x, finalDest.y - cur.y);
      if(lastDist < maxMovePx * 3){ /* only if we're close-ish */
        const hit = CONFIG.Canvas.polygonBackends?.move?.testCollision ? CONFIG.Canvas.polygonBackends.move.testCollision(cur, finalDest, {type:'move',mode:'any'}) : false;
        if(!hit && lastDist > 0){
          const snapped = canvas.grid.getSnappedPoint ? canvas.grid.getSnappedPoint({x:finalDest.x,y:finalDest.y},{mode:CONST.GRID_SNAPPING_MODES.CENTER}) : finalDest;
          await this._safeUpdate(selfToken, {x:snapped.x,y:snapped.y});
          const movedFt = Math.round((lastDist / gridPx) * gridDist);
          totalMovedFt += movedFt;
        }
      }
    }
    this._log(`_moveAlongPath: moved ${totalMovedFt}ft total`);
    return {movedFt: totalMovedFt};
  }

  static _findSafePosition(self, targetDest, maxDist){
    /* First try: slide along the direct path (original behaviour) */
    const steps=20; const dx=targetDest.x-self.x, dy=targetDest.y-self.y; const dist=Math.hypot(dx,dy)||1;
    for(let i=steps;i>=1;i--){
      const f=(i/steps)*Math.min(1,maxDist/dist);
      const px=self.x+dx*f, py=self.y+dy*f;
      const hit=CONFIG.Canvas.polygonBackends?.move?.testCollision?CONFIG.Canvas.polygonBackends.move.testCollision({x:self.x,y:self.y},{x:px,y:py},{type:'move',mode:'any'}):false;
      if(!hit)return{x:px,y:py};
    }
    /* Second try: perpendicular to the direct path (walk along wall face) */
    const nx=-dy/dist, ny=dx/dist; /* perpendicular unit */
    const gridSize=canvas.grid.size||100;
    for(let side=-1;side<=1;side+=2){
      for(let step=1;step<=5;step++){
        const off=step*gridSize*side;
        const px=self.x+nx*off, py=self.y+ny*off;
        const d=Math.hypot(px-self.x, py-self.y);
        if(maxDist!==undefined && d>maxDist) continue;
        const hit=CONFIG.Canvas.polygonBackends?.move?.testCollision?CONFIG.Canvas.polygonBackends.move.testCollision({x:self.x,y:self.y},{x:px,y:py},{type:'move',mode:'any'}):false;
        if(!hit) return{x:px,y:py};
      }
    }
    return null;
  }

  static _getWeaponRange(item){
    if(!item)return 5;
    const act=this._attackActivity(item);
    if(act?.range){
      if(act.range.value)return parseInt(act.range.value)||5;
      if(act.range.reach)return 10;
      if(act.range.long)return parseInt(act.range.long)||60;
    }
    const sys=item.system||{};
    if(sys.range?.value)return parseInt(sys.range.value)||5;
    if(sys.range?.long)return parseInt(sys.range.long)||60;
    const props=sys.properties||[];
    if(props.includes?.('rch')||sys.properties?.rch)return 10;
    if(props.includes?.('thr')||sys.properties?.thr)return sys.range?.long||60;
    return 5;
  }

  static _tokenDistanceFt(a,b){
    if(!canvas?.grid||!a||!b)return Infinity;
    const ad=a.document||a, bd=b.document||b;
    try{ if(canvas.grid.measureDistance)return canvas.grid.measureDistance({x:ad.x,y:ad.y},{x:bd.x,y:bd.y}); }catch(e){}
    const dx=(ad.x-bd.x)/(canvas.grid.size||1)*(canvas.grid.distance||5);
    const dy=(ad.y-bd.y)/(canvas.grid.size||1)*(canvas.grid.distance||5);
    return Math.sqrt(dx*dx+dy*dy);
  }

  /* ── NPC Vision / LOS methods ────────────────────────────────── */
  static _lastKnownPositions = new Map();

  static _visibleEnemies(selfToken, enemyTokens){
    if(!canvas?.walls || !canvas?.scene){ this._log('_visibleEnemies: no walls or scene'); return enemyTokens; }
    const selfDoc = selfToken.document || selfToken;
    if(selfDoc?.x === undefined && selfDoc?.y === undefined){ this._log('_visibleEnemies: no coords'); return enemyTokens; }
    const gs = canvas.grid.size || 100;
    const sx = (selfDoc.x ?? 0) + ((selfDoc.width ?? 1) * gs) / 2;
    const sy = (selfDoc.y ?? 0) + ((selfDoc.height ?? 1) * gs) / 2;
    this._log(`_visibleEnemies: from=(${Math.round(sx)},${Math.round(sy)}) ${selfDoc?.name||'?'}`);
    const visible = [];
    for(const t of enemyTokens){
      const tDoc = t.document || t;
      if(tDoc?.x === undefined) continue;
      const tx = (tDoc.x ?? 0) + ((tDoc.width ?? 1) * gs) / 2;
      const ty = (tDoc.y ?? 0) + ((tDoc.height ?? 1) * gs) / 2;
      try {
        const sightPoly = CONFIG.Canvas.polygonBackends.sight;
        const blocked = !sightPoly ? false : sightPoly.testCollision({x: sx, y: sy}, {x: tx, y: ty}, {mode: 'any', type: 'sight'});
        if(blocked){
          this._log(`_visibleEnemies: ${tDoc?.name||'?'} BLOCKED`);
          continue;
        }
        visible.push(t);
      } catch(e) {
        this._log(`_visibleEnemies: err ${tDoc?.name||'?'}: ${e.message?.substring(0,60)}`);
        continue;
      }
    }
    this._log(`_visibleEnemies: ${visible.length}/${enemyTokens.length} visible`);
    return visible;
  }

  static _rememberPosition(selfToken, targetToken){
    const sx = selfToken.document?.id || selfToken.id;
    const tx = targetToken.document?.x || targetToken.x;
    const ty = targetToken.document?.y || targetToken.y;
    const id = targetToken.document?.id || targetToken.id;
    if(!id || !sx) return;
    this._lastKnownPositions.set(sx + ':' + id, {x: tx, y: ty, scene: canvas.scene?.id, round: game.combat?.round || 0});
  }

  static _getLastKnownPosition(observerTokenId, tokenId){
    const pos = this._lastKnownPositions.get(observerTokenId + ':' + tokenId);
    if(!pos) return null;
    /* Purge positions from old scenes */
    if(pos.scene !== canvas.scene?.id) return null;
    return pos;
  }

  /* ── Door detection ──────────────────────────────────────────── */
  static _findBlockingDoor(fromPt, toPt){
    if(!canvas?.walls) return null;
    const dx = toPt.x - fromPt.x, dy = toPt.y - fromPt.y;
    const dist = Math.hypot(dx, dy);
    if(dist < 1) return null;
    const x1=fromPt.x, y1=fromPt.y, x2=toPt.x, y2=toPt.y;
    let best = null, bestDist = Infinity;
    for(const w of canvas.walls.placeables){
      if(!w.document?.door) continue;
      if(w.document?.ds !== 0) continue; /* closed */
      /* Wall segment A→B coordinates */
      const ax = w.document?.tX ?? w.tX, ay = w.document?.tY ?? w.tY;
      const bx = w.document?._tX ?? w._tX, by = w.document?._tY ?? w._tY;
      /* Line segment intersection test */
      const denom = (bx-ax)*(y1-y2) - (by-ay)*(x1-x2);
      if(Math.abs(denom) < 0.001) continue;
      const t = ((ax-x1)*(y1-y2) - (ay-y1)*(x1-x2)) / denom;
      const u = -((ax-x1)*(by-ay) - (ay-y1)*(bx-ax)) / denom;
      if(t>=0 && t<=1 && u>=0 && u<=1){
        const ix = ax + t*(bx-ax), iy = ay + t*(by-ay);
        const d = Math.hypot(ix-fromPt.x, iy-fromPt.y);
        if(d < bestDist){ best = w; bestDist = d; }
      }
    }
    return best;
  }

  static async _tryOpenDoor(doorWall){
    if(!doorWall?.document?.door) return false;
    try {
      await doorWall.document.update({ds: 1});
      return true;
    } catch(e) {
      this._log('failed to open door: ' + e.message);
      return false;
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
    HELPERS
    ═══════════════════════════════════════════════════════════════════ */
  /* ── Friendly NPC support: tokens with disposition determine side ── */
  static _findEnemyTokens(selfToken){
    if(!canvas?.tokens) return [];
    if(!selfToken) return [];
    const self = selfToken.object || selfToken;
    const myDisp = self.document?.disposition || self.disposition || 0;
    return canvas.tokens.placeables.filter(t => {
      if(t.id === selfToken?.id) return false;
      const disp = t.document?.disposition || t.disposition || 0;
      /* Friendly (+1) vs Hostile (-1) are enemies; Neutral matches nothing */
      if(myDisp === 1 && disp === -1) return true;
      if(myDisp === -1 && disp === 1) return true;
      /* Neutral treats anyone with opposite disposition as enemy; otherwise hostile to all non-neutral */
      if(myDisp === 0) return disp !== 0;
      return false;
    });
  }
  static _findAllyTokens(selfToken){
    if(!canvas?.tokens) return [];
    if(!selfToken) return [];
    const self = selfToken.object || selfToken;
    const myDisp = self.document?.disposition || self.disposition || 0;
    return canvas.tokens.placeables.filter(t => {
      if(t.id === selfToken?.id) return false;
      const disp = t.document?.disposition || t.disposition || 0;
      return disp === myDisp && myDisp !== 0;
    });
  }

  static _getHPPct(actor){
    const hp=actor?.system?.attributes?.hp||{};
    return(hp.value||0)/(hp.max||1);
  }
  static _getAtkBonus(actor,item){
    const sys=item?.system||{};
    const ability=sys.ability||actor?.system?.attributes?.attackBonus||'str';
    const mod=actor?.system?.abilities?.[ability]?.mod||0;
    const prof=sys.prof?.multiplier?(actor?.system?.attributes?.prof||0):0;
    return mod+prof;
  }
  /* ═══════════════════════════════════════════════════════════════════
     PERSONALITY — archetype-specific flavour lines
     ═══════════════════════════════════════════════════════════════════ */
  static _PERSONALITY = {
    assassin: {
      targetSelect: ["{name} slips through the shadows, eyes fixed on {target}…","{name} emerges from the gloom, blade hungry for {target}.","{name} smells weakness — {target} is the prey."],
      move: ["{name} glides forward like a knife through silk.","{name} prowls closer, silent as a grave.","{name} darts between cover, closing on {target}."],
      attack: ["{name} strikes from the dark!","{name} lunges with cruel precision!","{name} drives the blade home!"],
      miss: ["{name}'s blade whistles past {target}.","Shadows betray {name} — a hair's breadth miss.","{name} hisses in frustration, blade catching only air."],
      crit: ["{name} finds a vital seam — devastating!","{name}'s blade plunges into a gap in {target}'s armour!","A masterstroke from the shadows!"]
    },
    bruiser: {
      targetSelect: ["{name} cracks their knuckles and eyes {target}.","{name} spots {target} and grins savagely.","{name} chooses {target} — time to smash."],
      move: ["{name} lumbers forward, the ground shaking.","{name} charges like an avalanche of meat and steel!","{name} stomps closer, eager for violence."],
      attack: ["{name} brings down a crushing blow!","{name} swings with bone-breaking force!","{name} hammers {target} into the dirt!"],
      miss: ["{name} roars in frustration — a wild swing!","The blow could have felled a tree, but {target} ducks.","{name} misses, but the wind alone could knock a door off its hinges."],
      crit: ["{name} lands a thunderous blow that echoes across the battlefield!","{name} shatters bone and hope alike!","{target} crumples under the sheer brutality of it!"]
    },
    controller: {
      targetSelect: ["{name} surveys the battlefield and points a finger at {target}.","{name} decides {target} will make a fine puppet.","{name} marks {target} for magical discipline."],
      move: ["{name} drifts to a vantage point, robes swirling.","{name} steps back, weaving protective wards.","{name} repositions with eerie calm."],
      attack: ["{name} unleashes a bolt of arcane fury!","{name} hurls eldritch power at {target}!","Spellweaving erupts from {name}'s hands!"],
      miss: ["{name}'s spell fizzles — {target} shrugs it off.","Arcane energy crackles harmlessly around {target}.","{name} scowls as the shaping unravels."],
      crit: ["{name} cracks the weave with devastating precision!","{target} reels as raw magic tears through them!","A perfect arcane strike from {name}!"]
    },
    flying: {
      targetSelect: ["{name} circles overhead, choosing {target} from above.","{name} dives towards {target} with predatory focus.","From the clouds, {name} spots {target}."],
      move: ["{name} swoops through the air with terrifying grace.","{name} banks sharply, closing the distance.","Wings beat as {name} descends on {target}."],
      attack: ["{name} dives in for the kill!","{name} strikes from above like a thunderbolt!","{name} tears at {target} from the sky!"],
      miss: ["{name} screeches past {target}, talons closing on empty air.","{name} overshoots — a clumsy recovery.","The wind catches {name} wrong — a near-miss!"]
    },
    healer: {
      targetSelect: ["{name} looks to the wounded, choosing who needs aid most.","{name} turns away from the front line, seeking allies in need."],
      move: ["{name} hurries to a fallen comrade.","{name} weaves through battle to reach the wounded.","{name} slides into position to help."],
      attack: ["{name} lashes out with desperate resolve!","Even a healer's wrath has its limits — {name} attacks!","{name} channels divine fury against {target}!"],
      miss: ["{name} wavers — healing hands are not made for killing.","{name} winces as the blow misses."],
      heal: ["{name} calls down light upon the wounded!","{name}'s hands glow — wounds begin to close!","A prayer on {name}'s lips — and flesh knits together."]
    },
    skirmisher: {
      targetSelect: ["{name} bounces on their toes, sizing up {target}.","{name} locks eyes with {target} from across the melee."],
      move: ["{name} darts forward with impossible agility.","{name} weaves through the fray like a leaf on the wind.","{name} bounds towards {target} with reckless momentum."],
      attack: ["{name} strikes, then dances away!","{name} harries {target} with lightning thrusts!","{name} feints high and stabs low!"],
      miss: ["{name} overextends — the blow whistles past {target}.","Off balance! {name}'s blade finds nothing but air."]
    },
    sniper: {
      targetSelect: ["{name} lines up a shot on {target}.","{name} exhales slowly, crosshairs settling on {target}.","{name} marks {target} through the gloom."],
      move: ["{name} skirts the edge of the battlefield, maintaining line of sight.","{name} shifts to a better firing position.","{name} finds higher ground."],
      attack: ["{name} looses a deadly shot!","{name} fires with deadly calm!","{name}'s arrow streaks toward {target}!"],
      miss: ["{name} curses — the shot went wide.","A gust of wind betrays {name}'s aim.","{target} moves at the last second — a clean miss."]
    },
    barbarian: {
      targetSelect: ["{name} bellows and points at {target}!","{name}'s rage fixes on {target}.","{name} howls — {target} has drawn the beast's attention."],
      move: ["{name} charges with mindless fury!","{name} crashes forward like a living battering ram!","The ground trembles under {name}'s charge!"],
      attack: ["{name} hacks with savage abandon!","{name} unleashes a devastating rage-strike!","{name} roars and brings the weapon down!"],
      miss: ["{name} roars in impotent fury — a miss!","Blind rage costs {name} — the blow goes wide."]
    },
    bard: {
      targetSelect: ["{name} plucks a string and winks at {target}.","{name} improvises a cutting verse about {target}."],
      move: ["{name} struts across the battlefield with theatrical flair.","{name} dances between friends and foes alike."],
      attack: ["{name} strikes a dramatic chord — then strikes {target}!","{name} delivers a cutting remark… and a blade!"],
      miss: ["{name} fluffs the final note — a swing and a miss!","The crowd winces as {name}'s blade finds nothing."]
    },
    cleric: {
      targetSelect: ["{name} intones a prayer and fixes {target} with righteous fury.","{name} declares {target} unworthy — and prepares to prove it."],
      move: ["{name} advances with shield raised high.","{name} walks through danger as though wading through shallow water."],
      attack: ["{name} channels divine might into a smashing blow!","{name} brings holy wrath down upon {target}!"],
      miss: ["{name} falters — the gods demand better aim.","Faith alone cannot guide a wayward blade."]
    },
    druid: {
      targetSelect: ["{name}'s eyes flash with animal intensity — {target} is the prey.","{name} snarls, nature's fury aimed at {target}."],
      move: ["{name} shifts form and bounds forward.","Roots and vines part as {name} moves through the terrain."],
      attack: ["{name} strikes with the fury of the wild!","Teeth, claws, or thorns — {name} attacks {target}!"]
    },
    fighter: {
      targetSelect: ["{name} sets their jaw and faces {target}.","{name} raises their guard — {target} is the objective."],
      move: ["{name} advances with disciplined, measured strides.","{name} closes ground with textbook military precision."],
      attack: ["{name} strikes with soldier's discipline!","{name} executes a flawless attack routine!"],
      miss: ["{name} curses under their breath — a clean miss.","Discipline means nothing if the blade doesn't land."]
    },
    monk: {
      targetSelect: ["{name} bows briefly, focusing ki on {target}.","{name} stills their mind — {target} is the target."],
      move: ["{name} glides forward with effortless grace.","{name} seems to float across the ground."],
      attack: ["{name} strikes with a flurry of blows!","{name}'s fists blur with monastic speed!"],
      miss: ["{name} exhales — focus lost, the blow misses.","Even masters miss. {name} resets their stance."]
    },
    paladin: {
      targetSelect: ["{name} points their blade at {target} — a divine challenge.","{name} names {target} corrupt and prepares judgement."],
      move: ["{name} strides forward, armour gleaming.","{name} advances with unwavering purpose."],
      attack: ["{name} delivers a smiting blow!","Divine light flares as {name} strikes {target}!"]
    },
    ranger: {
      targetSelect: ["{name} tracks {target} like prey in the wild.","{name} nocks an arrow, eyes on {target}."],
      move: ["{name} slips through undergrowth, always watching {target}.","{name} finds the perfect ambush angle."],
      attack: ["{name} looses a hunter's shot!","{name} strikes with predatory precision!"]
    },
    rogue: {
      targetSelect: ["{name} sizes up {target} from the shadows.","{name} grins — {target} looks profitable."],
      move: ["{name} vanishes into a nearby shadow, reappearing closer.","{name} weaves through the crowd unseen."],
      attack: ["{name} strikes from the blind spot!","{name}'s blade finds a chink in {target}'s defences!"],
      miss: ["{name} curses — nearly had {target}.","A heartbeat too slow — {name} misses."]
    },
    sorcerer: {
      targetSelect: ["{name}'s eyes crackle with raw magic — {target} is in the blast zone.","{name} grins, wild energy gathering."],
      move: ["{name} drifts through chaos, barely touching the ground.","Arcane wind carries {name} to a safe vantage."],
      attack: ["{name} unleashes a torrent of raw power!","Magic erupts from {name} — barely controlled!"]
    },
    warlock: {
      targetSelect: ["{name}'s patron whispers: '{target}'.","{name}'s eyes turn black as they choose {target}."],
      move: ["{name} shifts through shadows not entirely of this world.","Eldritch mist swirls as {name} moves."],
      attack: ["{name} channels their patron's fury!","A blast of eldritch power from {name}!"]
    },
    wizard: {
      targetSelect: ["{name} consults a mental formula — {target} is the test subject.","{name} adjusts their spectacles: {target} is selected."],
      move: ["{name} backs away, muttering arcane equations.","{name} finds an angle with clear line of effect."],
      attack: ["{name} releases a calculated spell!","{name} completes the somatic gesture — destruction follows!"]
    },
    default: {
      targetSelect: ["{name} turns their attention to {target}.","{name} chooses {target} as their next opponent.","{name} locks eyes with {target}."],
      move: ["{name} advances.","{name} moves into position.","{name} closes the distance."],
      attack: ["{name} attacks {target}!","{name} strikes at {target}!","{name} swings at {target}!"],
      miss: ["{name} misses {target}.","{name}'s attack goes wide.","A near miss from {name}!"],
      crit: ["{name} lands a devastating blow!","A critical strike from {name}!"],
      heal: ["{name} tends to the wounded.","Healing light flows from {name}."]
    }
  };

  static _rand(arr){
    if(!arr?.length) return '';
    return arr[Math.floor(Math.random()*arr.length)];
  }

  static _personalityLine(actor, key, vars={}){
    const tactics = this._getTactics(actor);
    const arch = tactics?.arch || 'default';
    const lines = this._PERSONALITY[arch]?.[key] || this._PERSONALITY.default[key] || ['{name} acts.'];
    let line = this._rand(lines);
    const name = actor?.name || 'The creature';
    line = line.replace(/\{name\}/g, name).replace(/\{target\}/g, vars.target||'the foe');
    return line;
  }

  static _stepDelay(){
    return new Promise(r=>setTimeout(r, game.settings.get(MODULE_ID,'turnDelayMs') || 1200));
  }

  static async _say(content,actor,opts={}){
    await ChatMessage.create({
      user:game.userId,
      speaker:ChatMessage.getSpeaker({actor}),
      content:`<p>${content}</p>`,
      whisper:opts.whisper?[game.userId]:[]
    });
  }
  static _log(m){console.log(`%c[NPC Autopilot] ${m}`,'color:#8b5cf6;font-weight:bold');}
  static _wait(ms){return new Promise(r=>setTimeout(r,ms));}

  /* ═══════════════════════════════════════════════════════════════════
     OLLAMA BRIDGE INTEGRATION — soft dependency, safe if missing
     ═══════════════════════════════════════════════════════════════════ */
  static get _ollama() {
    return game.modules.get('ollama-bridge')?.api || globalThis.OllamaBridge || null;
  }
  static get _ollamaEnabled() {
    return game.settings.get(MODULE_ID, 'ollamaEnabled') && !!this._ollama;
  }

  /* Build a rich combat snapshot for AI prompts */
  static _ollamaBuildContext(actor, target, opts = {}) {
    const c = game.combat;
    if (!c?.started) return '';
    const scene = c.scene;
    const grid = scene?.grid?.distance || 5;

    /* Actor state */
    const aHp = actor.system?.attributes?.hp;
    const aPct = Math.round((aHp?.value || 0) / (aHp?.max || 1) * 100);
    const aWounded = aPct <= 25 ? 'critically wounded' : aPct <= 50 ? 'bloodied' : aPct <= 75 ? 'injured' : 'steady';
    const aConditions = actor.effects?.filter(e => !e.disabled).map(e => e.name).filter(n => !n.startsWith('(AE)')).slice(0, 4).join(', ') || '';
    const aToken = canvas.tokens.placeables.find(t => t.actor?.id === actor.id);
    const aWeapon = actor.items?.find(i => i.type === 'weapon' && i.system?.equipped);

    /* Target state */
    const tActor = target?.actor;
    const tHp = tActor?.system?.attributes?.hp;
    const tPct = tActor ? Math.round((tHp?.value || 0) / (tHp?.max || 1) * 100) : 0;
    const tWounded = tPct <= 25 ? 'critically wounded' : tPct <= 50 ? 'bloodied' : tPct <= 75 ? 'injured' : 'unharmed';
    const tConditions = tActor?.effects?.filter(e => !e.disabled).map(e => e.name).filter(n => !n.startsWith('(AE)')).slice(0, 4).join(', ') || '';

    /* Terrain / scene context */
    const terrain = [];
    if (scene?.name) terrain.push(`in ${scene.name}`);
    if (aToken && target) {
      try {
        const sightPoly = CONFIG.Canvas.polygonBackends?.sight;
        const hasWall = !sightPoly ? false : sightPoly.testCollision(aToken.center, target.center || aToken.center, { mode: 'any', type: 'sight' });
        terrain.push(hasWall ? 'obscured sightline' : 'clear sightline');
      } catch(e) { /* skip wall check */ }
    }

    /* Last 3 combat events for narrative continuity */
    const recent = (this._recentEvents || []).slice(-3).map(e => e.text).join('; ') || 'fighting continues';

    /* Nearby combatants (within 30ft) */
    const nearby = [];
    if (aToken) {
      for (const other of c.combatants) {
        if (!other.token?.actor || other.token.actor.id === actor.id) continue;
        const oTok = canvas.tokens.get(other.token.id);
        if (!oTok) continue;
        const dist = Math.round(this._tokenDistanceFt(aToken, oTok));
        if (dist <= 30) {
          const oHp = other.token.actor.system?.attributes?.hp;
          const oPct = Math.round((oHp?.value||0)/(oHp?.max||1)*100);
          nearby.push(`${other.token.actor.name} (${oPct}% HP, ${dist}ft ${dist<=5?'adjacent':dist<=15?'close':'nearby'})`);
        }
      }
    }

    /* Round / positioning */
    const parts = [
      `Round ${c.round || 1}, Turn ${c.turn + 1 || '?'}.`,
      `${actor.name} (${aPct}% HP, ${aWounded}${aConditions ? ', ' + aConditions : ''})`,
      `armed with ${aWeapon?.name || 'a weapon'}`,
      `${terrain.length ? terrain.join(', ') + '.' : ''}`,
      opts.action ? `is about to ${opts.action}.` : 'is acting.',
      `Target: ${target?.name || 'none'} (${tPct}% HP, ${tWounded}${tConditions ? ', ' + tConditions : ''}).`,
      nearby.length ? `Nearby: ${nearby.join('; ')}.` : '',
      `Recent events: ${recent}.`,
      `Reply in character. No meta-text. No OOC.`
    ];
    return parts.filter(Boolean).join('\n');
  }

  /* Track events for narrative continuity */
  static _recentEvents = [];
  static _ollamaLogEvent(text) {
    this._recentEvents = (this._recentEvents || []).slice(-5);
    this._recentEvents.push({ text, time: Date.now() });
  }

  /* AI: dramatic target lock narration */
  static async _ollamaNarrateTarget(actor, target, tactics, enemyCount, allyCount) {
    if (!this._ollamaEnabled || !game.settings.get(MODULE_ID, 'ollamaNarrateTarget') || !target) return;
    try {
      const temp = game.settings.get(MODULE_ID, 'ollamaTemperature') || 0.7;
      const ctx = this._ollamaBuildContext(actor, target, { action: 'choose a target' });
      const prompt = `${ctx}\n\nWrite one dramatic sentence describing ${actor.name} singling out ${target.name || 'the enemy'} — the tension before the first blow. Mention the weapon, the distance, or the look in their eyes. In voice only.`;
      const reply = await this._ollama.generate(prompt, { temperature: temp, timeout: 8000 });
      if (reply && reply.length > 5) {
        await ChatMessage.create({
          user: game.userId, speaker: ChatMessage.getSpeaker({actor}),
          content: `<div style="border-left:3px solid #8b5cf6;padding-left:8px;font-style:italic;">${reply.replace(/\n/g,'<br>')}</div>`
        });
        await this._wait(game.settings.get(MODULE_ID, 'ollamaNarrateDelay') || 800);
      }
    } catch(e) { this._log(`ollama target narrate: ${e.message}`); }
  }

  /* AI: action (hit/miss) narration */
  static async _ollamaNarrateAction(actor, target, weapon, result) {
    if (!this._ollamaEnabled || !game.settings.get(MODULE_ID, 'ollamaNarrateAction') || !target) return;
    try {
      const temp = game.settings.get(MODULE_ID, 'ollamaTemperature') || 0.7;
      const actionDesc = result === 'hit'
        ? `lands a ${weapon?.system?.damage?.parts?.[0]?.[1] || 'bloody'} blow with ${weapon?.name || 'a weapon'}`
        : `swings ${weapon?.name || 'a weapon'} but ${target.name || 'the target'} evades`;
      const ctx = this._ollamaBuildContext(actor, target, { action: actionDesc });
      const prompt = `${ctx}\n\nOne vivid cinematic sentence showing the ${result === 'hit' ? 'moment of impact — flesh, steel, pain' : 'narrow dodge — breath held, blade whistling past'}. In voice only.`;
      const reply = await this._ollama.generate(prompt, { temperature: temp, timeout: 8000 });
      if (reply && reply.length > 5) {
        await ChatMessage.create({
          user: game.userId, speaker: ChatMessage.getSpeaker({actor}),
          content: `<div style="border-left:3px solid ${result==='hit'?'#f87171':'#facc15'};padding-left:8px;font-style:italic;">${reply.replace(/\n/g,'<br>')}</div>`
        });
        await this._wait(game.settings.get(MODULE_ID, 'ollamaNarrateDelay') || 800);
      }
    } catch(e) { this._log(`ollama action narrate: ${e.message}`); }
  }

  /* AI: kill narration */
  static async _ollamaNarrateKill(actor, target, weapon) {
    if (!this._ollamaEnabled || !game.settings.get(MODULE_ID, 'ollamaNarrateKill') || !target) return;
    try {
      const temp = game.settings.get(MODULE_ID, 'ollamaTemperature') || 0.7;
      const ctx = this._ollamaBuildContext(actor, target, { action: `delivers the killing blow with ${weapon?.name || 'a decisive strike'}` });
      const prompt = `${ctx}\n\nOne dramatic cinematic sentence describing the death of ${target.name || 'the enemy'} — the silence after the last breath. In voice only.`;
      const reply = await this._ollama.generate(prompt, { temperature: temp, timeout: 8000 });
      if (reply && reply.length > 5) {
        await ChatMessage.create({
          user: game.userId, speaker: ChatMessage.getSpeaker({actor}),
          content: `<div style="border-left:3px solid #ef4444;padding-left:8px;font-style:italic;font-weight:bold;">${reply.replace(/\n/g,'<br>')}</div>`
        });
        await this._wait(game.settings.get(MODULE_ID, 'ollamaNarrateDelay') || 800);
      }
    } catch(e) { this._log(`ollama kill narrate: ${e.message}`); }
  }

  /* AI: round start scene setting */
  static async _ollamaNarrateRound(combat) {
    if (!this._ollamaEnabled || !game.settings.get(MODULE_ID, 'ollamaNarrateRound') || !combat?.started) return;
    try {
      const temp = game.settings.get(MODULE_ID, 'ollamaTemperature') || 0.7;
      const c = combat;
      const pcs = c.combatants.filter(cc => cc.token?.actor?.hasPlayerOwner).map(cc => {
        const a = cc.token.actor;
        const hp = a.system?.attributes?.hp;
        const pct = Math.round((hp?.value || 0) / Math.max(1, hp?.max || 1) * 100);
        return `${a.name} (${pct}%)`;
      });
      const npcs = c.combatants.filter(cc => cc.token?.actor && !cc.token.actor.hasPlayerOwner).map(cc => {
        const a = cc.token.actor;
        const hp = a.system?.attributes?.hp;
        const pct = Math.round((hp?.value || 0) / Math.max(1, hp?.max || 1) * 100);
        return `${a.name} (${pct}%)`;
      });
      const recent = (this._recentEvents || []).slice(-3).map(e => e.text).join('; ') || 'fighting continues';
      const scene = c.scene;
      const prompt = `Round ${c.round || 1}. PCs: ${pcs.join(', ') || 'none'}. Enemies: ${npcs.join(', ') || 'none'}. Scene: ${scene?.name || 'an unknown battlefield'}.\nRecent events: ${recent}.\n\nWrite one atmospheric cinematic sentence describing the current state of the fight — the smell, the light, the silence between blows. In voice only.`;
      const reply = await this._ollama.generate(prompt, { temperature: temp, timeout: 10000 });
      if (reply && reply.length > 5) {
        await ChatMessage.create({
          user: game.userId, speaker: { alias: 'Battle Narrator' },
          content: `<div style="border-left:3px solid #a78bfa;padding-left:8px;font-style:italic;opacity:.9;">${reply.replace(/\n/g,'<br>')}</div>`
        });
      }
    } catch(e) { this._log(`ollama round narrate: ${e.message}`); }
  }

  /* ═══════════════════════════════════════════════════════════════════
     GM OVERRIDES
     ═══════════════════════════════════════════════════════════════════ */
  static _getOverrides(actor) {
    const ov = actor.getFlag(MODULE_ID, 'apOverrides') || {};
    return {
      noSpells: !!ov.noSpells,
      noMove: !!ov.noMove,
      noGrapple: !!ov.noGrapple,
      noOffhand: !!ov.noOffhand,
      forceArch: ov.forceArch || null,
      forceTarget: ov.forceTarget || null,
      blacklist: Array.isArray(ov.blacklist) ? ov.blacklist : [],
    };
  }
  static _isPaused(actor) {
    return this._pausedActorId === actor.id;
  }

  static async _openActorOverride(actor) {
    const ov = this._getOverrides(actor);
    const arches = Object.keys(this._TACTICS);
    const currentArch = this._detectArchetype(actor);
    const isPaused = this._isPaused(actor);
    const token = canvas.tokens.placeables.find(t=>t.actor?.id===actor.id);
    const enemies = this._findEnemyTokens(token);
    const content = `
      <form>
        <div class="form-group"><label>Forced Archetype</label><select name="forceArch"><option value="">Auto (${currentArch})</option>${arches.map(a=>`<option value="${a}" ${ov.forceArch===a?'selected':''}>${a}</option>`).join('')}</select></div>
        <div class="form-group"><label>Force Target</label><select name="forceTarget"><option value="">Auto</option>${enemies.map(e=>`<option value="${e.id}" ${ov.forceTarget===e.id?'selected':''}>${e.name}</option>`).join('')}</select></div>
        <div class="form-group"><label>Blacklist Tokens (comma-separated IDs)</label><input type="text" name="blacklist" value="${ov.blacklist.join(',')}"></div>
        <hr>
        <div class="form-group"><label><input type="checkbox" name="noSpells" ${ov.noSpells?'checked':''}> No Spells</label></div>
        <div class="form-group"><label><input type="checkbox" name="noMove" ${ov.noMove?'checked':''}> No Movement</label></div>
        <div class="form-group"><label><input type="checkbox" name="noGrapple" ${ov.noGrapple?'checked':''}> No Grapple/Shove</label></div>
        <div class="form-group"><label><input type="checkbox" name="noOffhand" ${ov.noOffhand?'checked':''}> No Off-Hand</label></div>
      </form>
    `;
    new Dialog({
      title: `Override: ${actor.name}`,
      content,
      buttons: {
        save: {
          icon: '<i class="fas fa-save"></i>',
          label: 'Save',
          callback: async (html) => {
            const form = html[0].querySelector('form');
            const data = {
              forceArch: form.forceArch.value || null,
              forceTarget: form.forceTarget.value || null,
              blacklist: form.blacklist.value.split(',').map(s=>s.trim()).filter(Boolean),
              noSpells: form.noSpells.checked,
              noMove: form.noMove.checked,
              noGrapple: form.noGrapple.checked,
              noOffhand: form.noOffhand.checked,
            };
            await actor.setFlag(MODULE_ID, 'apOverrides', data);
            ui.notifications.info(`Overrides saved for ${actor.name}.`);
            this._renderPanel();
          }
        },
        pause: {
          icon: '<i class="fas fa-pause"></i>',
          label: isPaused ? 'Resume' : 'Pause',
          callback: async () => {
            this._pausedActorId = isPaused ? null : actor.id;
            ui.notifications.info(`${actor.name} autopilot ${isPaused?'resumed':'paused'}.`);
            this._renderPanel();
          }
        },
        close: { icon: '<i class="fas fa-times"></i>', label: 'Close' }
      },
      default: 'save'
    }).render(true);
  }

  /* ═══════════════════════════════════════════════════════════════════
     SPELLCASTING AI
     ═══════════════════════════════════════════════════════════════════ */
  static async _pickBestSpell(actor, enemyTokens, allyTokens, selfToken, tactics, moveBudget) {
    const items = actor.items?.contents || [];
    const prefs = tactics?.spellPreference || ['damage','control'];
    const spells = items.filter(i=>i.type==='spell' && this._spellAvailable(actor, i));
    if(!spells.length) return null;

    let best = null, bestScore = -Infinity;
    const alreadyCast = new Set(this._spellsCastThisTurn(actor));
    for(const spell of spells){
      const name = spell.name.toLowerCase();
      const level = spell.system?.level ?? 0;
      /* skip duplicates of leveled/limited spells */
      if(level > 0 && alreadyCast.has(spell.id)) continue;
      let categories = [];
      if(/heal|cure|restoration|aid|prayer of healing/i.test(name)) categories.push('heal');
      else if(/shield|mage armor|blur|mirror image|invisibility|fly|haste|bless|aid|enhance ability|heroism|protection/i.test(name)) categories.push('buff');
      else if(/fireball|lightning bolt|cone of cold|shatter|thunderwave|burning hands|ice knife|scorching ray|magic missile/i.test(name)) categories.push('damage');
      else if(/hold|stun|paralyze|slow|web|hypnotic|confusion|fear|charm|polymorph|banishment|counterspell|silence|black tentacles|gravity well/i.test(name)) categories.push('control');
      else if(/misty step|dimension door|teleport|fly|haste|jump|expeditious retreat|dash/i.test(name)) categories.push('mobility');
      else if(/inflict|smite|divine|blight|disintegrate|finger of death/i.test(name)) categories.push('smite');
      else if(/cantrip|ray of frost|fire bolt|shocking grasp|chill touch|eldritch blast|vicious mockery|sacred flame|toll the dead|minor illusion|prestidigitation|mage hand/i.test(name) || spell.system?.level === 0) categories.push('cantrip');
      else categories.push('damage');

      const concProps = spell.system?.properties || [];
      const isConcSpell = Array.isArray(concProps) ? concProps.includes('concentration') :
                         (concProps instanceof Set ? concProps.has('concentration') : spell.system?.components?.concentration);
      if(isConcSpell && actor.effects?.some(e=>(e.name||e.label||'').toLowerCase().includes('concentrating'))) continue;

      const prefIndex = Math.min(...categories.map(c=>prefs.indexOf(c)).filter(i=>i>=0));
      if(prefIndex === Infinity) continue;

      const range = this._getSpellRange(spell);
      let target = null, score = 0;
      if(categories.includes('heal')){
        target = this._findRescueTarget(allyTokens) || this._findBestBuffTarget(selfToken, allyTokens);
        if(target) score = 80 - prefIndex*20;
      } else if(categories.includes('buff')){
        target = this._findBestBuffTarget(selfToken, allyTokens) || selfToken;
        if(target) score = 70 - prefIndex*20;
      } else if(categories.includes('damage') || categories.includes('smite') || categories.includes('cantrip')){
        if(this._isAoESpell(spell)){
          target = this._findBestAoETarget(selfToken, enemyTokens, spell);
          if(target) score = 100 - prefIndex*20 + (target.cluster||0)*10;
        } else {
          target = this._pickTarget(enemyTokens, selfToken, actor, tactics);
          if(target){
            const dist = this._tokenDistanceFt(selfToken, target);
            if(dist <= range + 3) score = 90 - prefIndex*20 - dist*0.5;
          }
        }
      } else if(categories.includes('control')){
        target = this._pickTarget(enemyTokens, selfToken, actor, tactics);
        if(target){
          const dist = this._tokenDistanceFt(selfToken, target);
          if(dist <= range + 3) score = 85 - prefIndex*20 - dist*0.5;
        }
      } else if(categories.includes('mobility')){
        if(moveBudget.ft <= 0 && enemyTokens.length >= 2) {
          target = selfToken;
          score = 60 - prefIndex*20;
        }
      }

      if(target && score > bestScore){
        bestScore = score;
        best = {spell, target};
      }
    }
    return best;
  }

  static _spellAvailable(actor, spell) {
    const level = spell.system?.level ?? 0;
    if(level === 0) return true;
    const prep = spell.system?.preparation;
    if(prep?.mode === 'prepared' && !prep?.prepared) return false;
    /* check uses before anything else */
    if(typeof spell.system?.uses?.value === 'number'){
      if(spell.system.uses.value > 0) return true;
      if(spell.system.uses.max > 0 && spell.system.uses.value === 0) return false;
    }
    if(prep?.mode === 'always') return true;
    const slots = actor.system?.spells;
    if(slots){
      const slotKey = level === 0 ? 'spell0' : ('spell'+level);
      if(slots?.[slotKey]?.value > 0) return true;
      if(slots?.[slotKey]?.max > 0 && slots?.[slotKey]?.value === 0) return false;
    }
    return true;
  }

  static async _castSpell(spell, target, selfToken) {
    if(!spell) return;
    this._log(`Casting ${spell.name} on ${target?.name||'self'}`);
    if(selfToken?.actor){
      const isHeal = /heal|cure|restoration|aid|prayer/i.test(spell.name);
      const key = isHeal ? 'heal' : 'attack';
      await this._say(`${isHeal ? '🩹' : '🔥'} ${this._personalityLine(selfToken.actor, key, {target: target?.name})}`, selfToken.actor);
      await this._stepDelay();
    }
    if(target?.actor){
      await this._useItem(selfToken?.actor, spell, target.actor, selfToken);
    } else {
      await this._useItem(selfToken?.actor, spell, null, selfToken);
    }
  }

  static _getSpellRange(spell) {
    const sys = spell.system || {};
    if(sys.range?.value) return parseInt(sys.range.value) || 30;
    if(sys.target?.value) return parseInt(sys.target.value)*5 || 30;
    return 30;
  }

  static _findBestHealSpell(actor) {
    const rx = /(healing word|cure wounds|lesser restoration|prayer of healing|mass cure wounds|regenerate|heal)/i;
    const spells = (actor.items?.contents||[]).filter(i=>i.type==='spell' && rx.test(i.name) && this._spellAvailable(actor, i));
    if(!spells.length) return null;
    return spells.sort((a,b)=>(b.system?.level||0)-(a.system?.level||0))[0];
  }

  static _findBestAoETarget(selfToken, enemyTokens, spell) {
    if(!selfToken || !enemyTokens.length) return null;
    const radiusFt = (spell.system?.target?.value||0)*5 || 20;
    const range = this._getSpellRange(spell);
    let best = null, bestCount = 0;
    for(const t of enemyTokens){
      const d = this._tokenDistanceFt(selfToken, t);
      if(d > range + 3) continue;
      const cluster = enemyTokens.filter(e=>e.id!==t.id && this._tokenDistanceFt(t,e) <= radiusFt).length;
      if(cluster > bestCount){
        bestCount = cluster;
        best = t;
      }
    }
    if(best) best.cluster = bestCount;
    return best;
  }

  static _isAoESpell(spell) {
    const shape = (spell.system?.target?.type || '').toLowerCase();
    return ['sphere','cone','cube','cylinder','line','radius','square','wall'].includes(shape);
  }

  static _findBestBuffTarget(selfToken, allyTokens) {
    if(!allyTokens?.length) return null;
    const scored = allyTokens.map(t=>{
      const a = t.actor;
      const str = a?.system?.abilities?.str?.mod||0;
      const dex = a?.system?.abilities?.dex?.mod||0;
      const atk = a?.system?.attributes?.attackBonus||0;
      return {token:t, score: Math.max(str,dex)+atk};
    }).sort((a,b)=>b.score-a.score);
    return scored[0]?.token || null;
  }

  static _findRescueTarget(allyTokens) {
    return allyTokens.find(t=>{
      const hp = t.actor?.system?.attributes?.hp||{};
      return (hp.value||0)===0 && (hp.max||0)>0;
    }) || null;
  }

  static _canSneakAttack(selfToken, targetToken) {
    if(!selfToken || !targetToken) return false;
    const dist = this._tokenDistanceFt(selfToken, targetToken);
    if(dist > 7) return false;
    const selfDisp = (selfToken.disposition || (selfToken.document?.disposition) || 0);
    const adjacentAlly = canvas.tokens.placeables.find(t=>{
      if(t.id===selfToken.id) return false;
      if(t.id===targetToken.id) return false;
      const disp = t.disposition || (t.document?.disposition) || 0;
      /* adjacent ally = same disposition token within 5 ft of the target */
      if(disp !== selfDisp || disp === 0) return false;
      const d = this._tokenDistanceFt(t, targetToken);
      return d <= 7;
    });
    return !!adjacentAlly;
  }

  /* ═══════════════════════════════════════════════════════════════════
     SPELL TRACKING (prevents recasting same limited spell on same turn)
     ═══════════════════════════════════════════════════════════════════ */
  static _trackSpellCast(actor, spell) {
    const cast = actor.getFlag(MODULE_ID, 'spellsCastThisTurn') || [];
    cast.push(spell.id);
    actor.setFlag(MODULE_ID, 'spellsCastThisTurn', cast).catch(()=>{});
  }

  static _spellsCastThisTurn(actor) {
    return actor.getFlag(MODULE_ID, 'spellsCastThisTurn') || [];
  }

  static async _resetCastTracker(actor) {
    await actor.setFlag(MODULE_ID, 'spellsCastThisTurn', []).catch(()=>{});
  }

  /* ═══════════════════════════════════════════════════════════════════
     ACTION ECONOMY HELPERS
     ═══════════════════════════════════════════════════════════════════ */
  static async _actionDash(actor, tokenDoc, targetToken, moveBudget) {
    const speed = actor.system?.attributes?.movement?.walk || 30;
    await this._say(`🏃 ${this._personalityLine(actor, 'move')}
${actor.name} takes the **Dash** action.`, actor);
    const moveRes = await this._npcMoveToTarget(tokenDoc, targetToken, {name:'Dash'}, {maxMoveFt: speed});
    return { movedFt: moveRes.movedFt || 0 };
  }

  static async _doShoveOrGrapple(actor, tokenDoc, targetToken) {
    const items = actor.items?.contents||[];
    const grapple = items.find(i=>i.type==='feat' && /grapple/i.test(i.name));
    const shove = items.find(i=>i.type==='feat' && /shove/i.test(i.name));
    const feat = grapple || shove;
    if(feat){
      await this._useItem(actor, feat, targetToken.actor, tokenDoc);
      return true;
    }
    await this._say(`🤼 ${this._personalityLine(actor, 'attack', {target: targetToken.name})}
${actor.name} attempts to ${grapple?'grapple':'shove'} ${targetToken.name}!`, actor);
    return true;
  }

  static async _doDodge(actor) {
    await this._say(`🛡️ ${this._personalityLine(actor, 'move')}
${actor.name} takes the **Dodge** action.`, actor);
  }

  static async _doHelp(actor, tokenDoc, allyTokens) {
    const ally = allyTokens[0];
    if(!ally) return;
    await this._say(`🤝 ${this._personalityLine(actor, 'move')}
${actor.name} takes the **Help** action for ${ally.name}.`, actor);
  }

  static async _quaffPotion(actor) {
    const potion = actor.items.find(i=>/(potion of healing|healing potion|greater healing|superior healing|supreme healing)/i.test(i.name));
    if(potion){
      await this._useItem(actor, potion, actor, null);
      await this._say(`🧪 ${actor.name} quaffs a ${potion.name}.`, actor);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     REACTIONS
     ═══════════════════════════════════════════════════════════════════ */
  static _setupReactions() {
    if(!game.user.isGM) return;
    Hooks.on('midi-qol.preAttackRoll', async (workflow) => {
      if(!game.settings.get(MODULE_ID,'reactionsEnabled')) return;
      const actor = workflow.actor;
      if(!actor || actor.hasPlayerOwner) return;
      if(actor.getFlag(MODULE_ID,'reactionSpent')) return;
      if(!this.isEnabled(actor)) return;
      await this._checkReaction_Shield(workflow);
    });
    Hooks.on('updateToken', (tokenDoc, change) => {
      if(!game.settings.get(MODULE_ID,'reactionsEnabled')) return;
      // Opportunity Attack / Sentinel placeholder
    });
  }

  static async _checkReaction_Shield(workflow) {
    const targetActor = workflow.targets?.first()?.actor;
    if(!targetActor || targetActor.hasPlayerOwner) return;
    if(targetActor.getFlag(MODULE_ID,'reactionSpent')) return;
    const attackTotal = workflow.attackTotal;
    const targetAC = targetActor.system?.attributes?.ac?.value || 10;
    if(attackTotal === undefined || attackTotal < targetAC) return;
    const shield = targetActor.items.find(i=>i.type==='spell' && i.name==='Shield');
    if(!shield || !this._spellAvailable(targetActor, shield)) return;
    targetActor.setFlag(MODULE_ID,'reactionSpent', true);
    await this._useItem(targetActor, shield, null, null);
    await this._say(`🛡️ ${targetActor.name} casts **Shield** as a reaction!`, targetActor);
  }

  /* ═══════════════════════════════════════════════════════════════════
     LEGENDARY ACTIONS
     ═══════════════════════════════════════════════════════════════════ */
  static _setupLegendaryActions() {
    if(!game.user.isGM) return;
    Hooks.on('updateCombat', (combat, changed) => {
      if(!game.settings.get(MODULE_ID,'legendaryEnabled')) return;
      if(!combat?.started) return;
      if(changed.turn === undefined && changed.round === undefined) return;
      const prevId = this._lastCombatantId;
      this._lastCombatantId = combat.combatant?.id;
      if(!prevId) return;
      const prev = combat.combatants.get(prevId);
      if(!prev?.token?.actor || !prev.token.actor.hasPlayerOwner) return;
      this._legendaryHandler(combat, prev);
    });
  }

  static _setupKillNarration() {
    if(!game.user.isGM) return;
    Hooks.on('updateToken', async (tokenDoc, change) => {
      if(!NpcAutopilot._ollamaEnabled || !game.settings.get(MODULE_ID, 'ollamaNarrateKill')) return;
      const newHP = change.actorData?.system?.attributes?.hp?.value;
      if(newHP === undefined || newHP > 0) return;
      const actor = tokenDoc.actor; if(!actor || !actor.hasPlayerOwner) return;
      const combat = game.combat; if(!combat?.started) return;
      const attacker = combat.combatant?.token?.actor;
      if(!attacker || attacker.hasPlayerOwner) return;
      const lastWeapon = attacker.getFlag(MODULE_ID, 'lastAttackWeapon') || '';
      const weapon = attacker.items.find(i=>i.name===lastWeapon) || null;
      await NpcAutopilot._ollamaNarrateKill(attacker, tokenDoc.object||tokenDoc, weapon);
    });
  }

  static async _legendaryHandler(combat, prevCombatant) {
    for(const c of combat.combatants){
      const a = c.token?.actor;
      if(!a || a.hasPlayerOwner) continue;
      if(!this.isEnabled(a)) continue;
      if(a.getFlag(MODULE_ID,'legendarySpent')) continue;
      const legendary = a.items.filter(i=>i.type==='feat' && /legendary/i.test(i.name));
      if(!legendary.length) continue;
      for(const feat of legendary){
        if(feat.system?.uses?.value === 0) continue;
        const enemies = this._findEnemyTokens(c.token);
        if(!enemies.length) continue;
        const target = this._pickTarget(enemies, c.token, a, this._getTactics(a));
        if(!target) continue;
        await a.setFlag(MODULE_ID, 'legendarySpent', true).catch(()=>{});
        await this._useItem(a, feat, target.actor, c.token);
        await this._say(`⚔️ ${this._personalityLine(a, 'attack')}
${a.name} uses **${feat.name}**!`, a);
        await this._stepDelay();
        break;
      }
    }
  }
}

globalThis.NpcAutopilot=NpcAutopilot;
