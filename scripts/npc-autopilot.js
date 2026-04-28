const MODULE_ID = 'ai-companion';

/* ═══════════════════════════════════════════════════════════════════
   NPC AUTOPILOT v3.6.0 — Foundry VTT D&D 5e
   Archetype-aware tactics, spread targeting, sticky multiattack,
   shared movement budget, native attack rolls, optional Midi-QOL.
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
});

Hooks.on('ready', () => {
  if (game.settings.get(MODULE_ID, 'hudOpen')) NpcAutopilot.open();
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
  if (changed.round !== undefined) NpcAutopilot._resetTargetCounts();
  const c = combat.combatant;
  if (!c?.token?.actor || c.token.actor.hasPlayerOwner) return;
  if (!NpcAutopilot.isEnabled(c.token.actor)) return;
  NpcAutopilot.takeTurn(c.token.actor, c.token);
});

/* ═══════════════════════════════════════════════════════════════════
   MAIN CLASS
   ═══════════════════════════════════════════════════════════════════ */
class NpcAutopilot {
  static _busy = false;

  /* ── static tactic catalogue ── */
  static _TACTICS = {
    // Monster type archetypes
    assassin:     { preferWounded: true,  prefersMelee: false, positioning: 'mid',        retreatThreshold: 0.10, healAllyThreshold: 0 },
    bruiser:      { preferWounded: false, prefersMelee: true,  positioning: 'charge',     retreatThreshold: 0.00, healAllyThreshold: 0 },
    controller:   { preferWounded: false, prefersMelee: false, positioning: 'hang_back',  retreatThreshold: 0.20, healAllyThreshold: 0 },
    flying:       { preferWounded: false, prefersMelee: false, positioning: 'hang_back',  retreatThreshold: 0.15, healAllyThreshold: 0 },
    healer:       { preferWounded: false, prefersMelee: false, positioning: 'mid',        retreatThreshold: 0.25, healAllyThreshold: 0.40, bonusHealAlly: true },
    skirmisher:   { preferWounded: false, prefersMelee: true,  positioning: 'flank',      retreatThreshold: 0.15, healAllyThreshold: 0 },
    sniper:       { preferWounded: true,  prefersMelee: false, positioning: 'hang_back',  retreatThreshold: 0.10, healAllyThreshold: 0 },
    // Player-class archetypes (NPCs with class levels)
    barbarian:    { preferWounded: false, prefersMelee: true,  positioning: 'charge',     retreatThreshold: 0.05, healAllyThreshold: 0 },
    bard:         { preferWounded: false, prefersMelee: false, positioning: 'mid',        retreatThreshold: 0.20, healAllyThreshold: 0.30 },
    cleric:       { preferWounded: false, prefersMelee: false, positioning: 'mid',        retreatThreshold: 0.20, healAllyThreshold: 0.40, bonusHealAlly: true },
    druid:        { preferWounded: false, prefersMelee: false, positioning: 'mid',        retreatThreshold: 0.20, healAllyThreshold: 0.30 },
    fighter:      { preferWounded: false, prefersMelee: true,  positioning: 'charge',     retreatThreshold: 0.10, healAllyThreshold: 0 },
    monk:         { preferWounded: false, prefersMelee: true,  positioning: 'flank',      retreatThreshold: 0.15, healAllyThreshold: 0 },
    paladin:      { preferWounded: false, prefersMelee: true,  positioning: 'charge',     retreatThreshold: 0.10, healAllyThreshold: 0.30 },
    ranger:       { preferWounded: true,  prefersMelee: false, positioning: 'mid',        retreatThreshold: 0.15, healAllyThreshold: 0 },
    rogue:        { preferWounded: true,  prefersMelee: true,  positioning: 'flank',      retreatThreshold: 0.15, healAllyThreshold: 0 },
    sorcerer:     { preferWounded: false, prefersMelee: false, positioning: 'hang_back',  retreatThreshold: 0.25, healAllyThreshold: 0 },
    warlock:      { preferWounded: true,  prefersMelee: false, positioning: 'hang_back',  retreatThreshold: 0.20, healAllyThreshold: 0 },
    wizard:       { preferWounded: false, prefersMelee: false, positioning: 'hang_back',  retreatThreshold: 0.30, healAllyThreshold: 0 },
    // Fallback
    default:      { preferWounded: false, prefersMelee: false, positioning: 'charge',     retreatThreshold: 0.20, healAllyThreshold: 0 },
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

  /* ── Panel (unchanged) ── */
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
        if(a==='manual-turn'){ const c=game.combat?.combatant; if(c?.token?.actor) NpcAutopilot.takeTurn(c.token.actor,c.token); }
        if(a==='toggle-npc'){ const id=$(this).data('actor-id'); const a2=game.actors.get(id); if(a2) NpcAutopilot.setEnabled(a2, $(this).is(':checked')); }
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
    const combat=game.combat; const active=combat?.started;
    const cur=combat?.combatant; const ct=cur?.token; const ca=ct?.actor; const isNPC=ca&&!ca.hasPlayerOwner;
    const currentArch = ca ? this._detectArchetype(ca) : '';
    let html=`<div class="npc-ap-status-row">
      <span class="npc-ap-toggle ${globalOn?'on':'off'}" data-ap-action="toggle-global"><i class="fas fa-power-off"></i> ${globalOn?'ON':'OFF'}</span>
      <span class="npc-ap-toggle ${fastRoll?'on':'off'}" data-ap-action="toggle-fast"><i class="fas fa-forward"></i> ${fastRoll?'FAST':'SLOW'}</span>
      <span class="npc-ap-combat-status">${active?'🎲 Round '+(combat.round||1)+', Turn '+((combat.turn||0)+1):'No combat'}</span></div>`;
    if(ct){ const hp=ca?.system?.attributes?.hp||{}; const p=Math.round((hp.value||0)/(hp.max||1)*100); const c=p>50?'#4ade80':p>25?'#facc15':'#f87171';
      html+=`<div class="npc-ap-card"><img src="${ct.texture?.src||ca?.img||'icons/svg/mystery-man.svg'}">
        <div class="npc-ap-info"><div class="npc-ap-name">${ct.name||ca?.name||'?'}</div>
        <div class="npc-ap-meta">${isNPC?'NPC':'Player'}${currentArch?' · '+currentArch:''} | HP <span style="color:${c};font-weight:700">${hp.value||0}/${hp.max||'?'}</span> (${p}%)</div>
        <div class="npc-ap-hpbar"><div style="width:${p}%;background:${c}"></div></div></div>
        ${isNPC&&globalOn?'<div class="npc-ap-badge">🤖</div>':''}</div>`; }
    if(active){ const npcs=combat.combatants.filter(c=>c.token?.actor&&!c.token.actor.hasPlayerOwner); if(npcs.length){
      html+=`<div class="npc-ap-list"><div class="npc-ap-section">NPCs in Combat (${npcs.length})</div>`;
      for(const c of npcs){ const a=c.token.actor; const en=this.isEnabled(a); const h=a?.system?.attributes?.hp||{}; const p=Math.round((h.value||0)/(h.max||1)*100); const col=p>50?'#4ade80':p>25?'#facc15':'#f87171'; const arch=this._detectArchetype(a);
        html+=`<div class="npc-ap-item ${c.token?.id===ct?.id?'current':''}">
          <input type="checkbox" class="npc-ap-check" data-ap-action="toggle-npc" data-actor-id="${a.id}" ${en?'checked':''} title="Toggle autopilot for ${a.name}">
          <img src="${c.token?.texture?.src||a?.img||'icons/svg/mystery-man.svg'}">
          <div class="npc-ap-item-name">${c.name}${arch!=='default'?' <small style="opacity:.7">('+arch+')</small>':''}</div>
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
      const refreshed = canvas.tokens.get(tokenDoc.id);
      if(refreshed) tokenDoc = refreshed.document || refreshed;

      const tactics = this._getTactics(actor);
      let enemyTokens=this._findEnemyTokens(tokenDoc);
      const allyTokens =this._findAllyTokens(tokenDoc);
      const hpPct=this._getHPPct(actor);
      this._log(`${actor.name} turn start — ${enemyTokens.length} PCs, ${allyTokens.length} allies, HP ${Math.round(hpPct*100)}%, arch=${tactics.arch}`);

      let targetToken = enemyTokens.length ? this._pickTarget(enemyTokens, tokenDoc, actor, tactics) : null;
      this._log(`locked target: ${targetToken?.name||'none'} (${enemyTokens.length} enemies)`);
      if(targetToken) this._incrementTargetCount(targetToken);

      let moveBudgetFt = 0;
      let moveMsg = '';
      if(game.settings.get(MODULE_ID,'npcMovement') && tokenDoc && targetToken){
        let moveRes={msg:'', movedFt:0};
        if(hpPct < tactics.retreatThreshold && enemyTokens.length>=2){
          moveRes=await this._npcRetreat(tokenDoc, enemyTokens);
        } else {
          const weapon=this._bestWeaponForRange(actor, this._tokenDistanceFt(tokenDoc, targetToken), {prefersMelee:tactics.prefersMelee});
          if(weapon){
            moveRes = await this._npcMoveToTarget(tokenDoc, targetToken, weapon, {tactics});
          }
        }
        moveMsg = moveRes.msg || '';
        moveBudgetFt = Math.max(0, (actor.system?.attributes?.movement?.walk || 30) - (moveRes.movedFt || 0));
        if(moveMsg){await this._say(`🏃 ${moveMsg}`, actor); await this._wait(400);}
      }

      const movedRefreshed = canvas.tokens.get(tokenDoc.id);
      if(movedRefreshed) tokenDoc = movedRefreshed.document || movedRefreshed;
      enemyTokens=this._findEnemyTokens(tokenDoc);

      let finalTarget = targetToken;
      if(finalTarget && !enemyTokens.find(t=>t.id===finalTarget.id)){
        finalTarget = enemyTokens.length ? this._pickTarget(enemyTokens, tokenDoc, actor, tactics) : null;
        this._log(`target died; re-picked: ${finalTarget?.name||'none'}`);
        if(finalTarget) this._incrementTargetCount(finalTarget);
      }

      await this._executeFullTurn(actor, tokenDoc, enemyTokens, allyTokens, hpPct, finalTarget, moveBudgetFt, tactics);

      if(game.settings.get(MODULE_ID,'autoAdvance')&&game.combat?.combatant?.token?.id===tokenDoc?.id){
        setTimeout(()=>game.combat?.nextTurn?.(), 800);
      }
      this._renderPanel();
    }catch(err){console.error('[NPC Autopilot]',err); await this._say(`⚠️ ${err.message}`, actor, {whisper:true});}
    finally{this._busy=false;}
  }

  /* ═══════════════════════════════════════════════════════════════════
     FULL TURN — heals, attacks, dodge (tactic-aware)
     ═══════════════════════════════════════════════════════════════════ */
  static async _executeFullTurn(actor, tokenDoc, enemyTokens, allyTokens, hpPct, targetToken, moveBudgetFt=0, tactics) {
    this._log(`_executeFullTurn: ${actor.name} — ${enemyTokens.length} enemies, HP ${Math.round(hpPct*100)}%, target=${targetToken?.name||'none'}, moveLeft=${moveBudgetFt}, arch=${tactics?.arch||'default'}`);
    const items = actor.items?.contents || [];
    const moveBudget = { ft: moveBudgetFt };
    let bonusUsed = false;

    // ── Bonus Action: heal ally first (healer archetypes) ──
    if((tactics?.healAllyThreshold > 0) && allyTokens.length){
      const woundedAlly = allyTokens
        .map(t=>{const h=t.actor?.system?.attributes?.hp||{}; return{token:t, pct:(h.value||0)/Math.max(1,h.max||1)};})
        .filter(a=>a.pct < tactics.healAllyThreshold)
        .sort((a,b)=>a.pct-b.pct)[0];
      if(woundedAlly){
        const baHeal = this._findSpell(actor,/(healing word|cure wounds|lesser restoration)/i);
        if(baHeal){ await this._useItem(actor, baHeal, woundedAlly.token.actor, tokenDoc); bonusUsed=true; await this._wait(600); }
      }
    }

    // ── Bonus Action: heal self if critical and no ally healed ──
    if(!bonusUsed && hpPct < 0.3){
      const baHeal=this._findSpell(actor,/(healing word|cure wounds)/i);
      if(baHeal){ await this._useItem(actor,baHeal,actor,tokenDoc); bonusUsed=true; await this._wait(600); }
    }

    // ── Action: multiattack or best single attack ──
    const didMulti = await this._doMultiattack(actor, enemyTokens, items, tokenDoc, moveBudget, targetToken, tactics);
    this._log(`multiattack returned: ${didMulti}`);

    if(!didMulti && targetToken){
      const dist = this._tokenDistanceFt(tokenDoc, targetToken);
      const weapon = this._bestWeaponForRange(actor, dist, {prefersMelee:tactics?.prefersMelee});
      this._log(`single attack: dist ${Math.round(dist)}ft, weapon=${weapon?.name||'none'}`);
      let attackWeapon = weapon;
      if(attackWeapon && dist > this._getWeaponRange(attackWeapon) + 3 && moveBudget.ft > 0){
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
        await this._wait(600);
      } else if(attackWeapon) {
        await this._say(`⚠️ ${actor.name} is ${Math.round(finalDist)} ft from ${targetToken.name}, beyond ${attackWeapon.name}'s reach.`, actor, {whisper:true});
      }
    }

    // ── Bonus Action: off-hand (Two-Weapon Fighting) ──
    if(!bonusUsed && targetToken){
      const dist = this._tokenDistanceFt(tokenDoc, targetToken);
      const mainWeapon = this._bestWeaponForRange(actor, dist, {prefersMelee:tactics?.prefersMelee});
      const offHand = this._bestWeaponForRange(actor, dist, {excludeMain:true, prefersMelee:tactics?.prefersMelee});
      if(offHand && offHand.id !== mainWeapon?.id && this._isWeaponLight(mainWeapon) && this._isWeaponLight(offHand) && dist <= this._getWeaponRange(offHand) + 3){
        await this._npcAttack(actor, offHand, targetToken, tokenDoc);
        await this._wait(600);
      }
    }

    // ── Dodge / Defensive Action ──
    if(!didMulti && !targetToken){
      if(tactics?.positioning === 'hang_back'){
        // Casters already staying back — no need to dodge loudly
      } else if(hpPct < (tactics?.retreatThreshold || 0.20)){
        await this._say(`🛡️ ${actor.name} takes the **Dodge** action.`, actor);
      }
    }
  }

  static _isWeaponLight(weapon){
    if(!weapon)return false;
    const props=weapon.system?.properties||[];
    if(Array.isArray(props))return props.includes('lgt')||props.includes('light');
    if(typeof props==='object'&&props!==null) return !!(props.lgt||props.light);
    return false;
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
            if(moveRes.msg) await this._say(`🏃 ${moveRes.msg}`, actor);
            await this._wait(300);
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
        await this._wait(700);
      } else {
        await this._say(`⚠️ ${actor.name}'s ${weapon.name} out of range (${Math.round(dist)}>${range} ft).`, actor, {whisper:true});
      }
      lastWeapon=weapon;
    }
    return attacksPerformed > 0;
  }

  static _wordToNum(w){ const map={one:1,two:2,three:3,four:4,five:5}; const n=parseInt(w); return isNaN(n)?(map[w?.toLowerCase()]||1):n; }

  /* ═══════════════════════════════════════════════════════════════════
     ATTACK / USE ITEM
     ═══════════════════════════════════════════════════════════════════ */
  static async _npcAttack(actor, item, targetToken, selfToken) {
    if(!item){ await this._say(`⚠️ ${actor.name} has no weapon.`, actor, {whisper:true}); return; }
    if(!targetToken){ await this._say(`⚠️ ${actor.name} has no target.`, actor, {whisper:true}); return; }

    const dist = this._tokenDistanceFt(selfToken, targetToken);
    const range = this._getWeaponRange(item);
    this._log(`${actor.name} → ${targetToken.name} (${Math.round(dist)}ft, range ${range}ft, item "${item.name}")`);

    if(dist > range + 3){
      await this._say(`⚠️ ${actor.name} is ${Math.round(dist)} ft from ${targetToken.name} — ${item.name} only reaches ${range} ft.`, actor, {whisper:true});
      return;
    }

    const fastRoll = game.settings.get(MODULE_ID, 'npcAutopilotFastRoll');
    const oldTargets = Array.from(game.user.targets).map(t=>t.id);
    const oldControlled = Array.from(canvas.tokens.controlled).map(t=>t.id);

    const mqol = game.modules.get("midi-qol")?.active ? globalThis.MidiQOL : null;
    let midiBackup = null;
    if(fastRoll && mqol?.configSettings){
      const cs = mqol.configSettings;
      midiBackup = {
        autoRollAttack: cs.autoRollAttack, autoRollDamage: cs.autoRollDamage,
        gmAutoAttack: cs.gmAutoAttack, gmAutoDamage: cs.gmAutoDamage,
        autoFastForward: [...(cs.autoFastForward||[])], gmAutoFastForward: [...(cs.gmAutoFastForward||[])]
      };
      cs.autoRollAttack = true;  cs.autoRollDamage = "onHit";
      cs.gmAutoAttack = true;    cs.gmAutoDamage = "onHit";
      for(const arr of [cs.autoFastForward, cs.gmAutoFastForward]){
        if(!Array.isArray(arr)) continue;
        if(!arr.includes("attack")) arr.push("attack");
        if(!arr.includes("damage")) arr.push("damage");
      }
      this._log(`midi-qol config bumped → autoRollAttack=true autoRollDamage=onHit fastForward=[attack,damage]`);
    }

    try{
      const tgt = targetToken.object || targetToken;
      const self = selfToken?.object || selfToken;
      if(tgt?.setTarget) tgt.setTarget(true, {user: game.user, releaseOthers: true});
      if(self?.control) self.control({releaseOthers: true});
      await this._wait(50);

      let executed = false;
      const activity = this._attackActivity(item);

      // PATH A: Midi-QOL
      if(!executed && mqol?.Workflow && activity && typeof activity.use === 'function'){
        try{ await activity.use({consume:false}, {configure:false}, {create:true}); executed=true; }
        catch(e1){}
      }
      // PATH B: dnd5e v5.3+ native
      if(!executed && activity && typeof activity.rollAttack === 'function'){
        try{
          const attackRolls = await activity.rollAttack(
            {event: null, target: targetToken.actor ? {ac: targetToken.actor.system?.attributes?.ac?.value || 10} : undefined},
            {configure: false}, {create: true}
          );
          if(attackRolls && attackRolls.length){
            const atk = attackRolls[0];
            const targetAC = targetToken.actor?.system?.attributes?.ac?.value || 10;
            const isHit = atk.total >= targetAC;
            const isCrit = atk.isCritical || false;
            if(isHit){
              const hitMsg = isCrit
                ? `💥 ${actor.name} lands a **critical hit** on ${targetToken.name} with ${item.name}! (Roll ${atk.total})`
                : `💥 ${actor.name} hits ${targetToken.name} with ${item.name}! (Roll ${atk.total})`;
              await this._say(hitMsg, actor);
              if(typeof activity.rollDamage === 'function'){
                await activity.rollDamage({event: null, isCritical: isCrit}, {configure: false}, {create: true});
              }
            } else {
              await this._say(`❌ ${actor.name} attacks ${targetToken.name} and misses! (Rolled ${atk.total} vs AC ${targetAC})`, actor);
            }
          }
          executed = true;
        }catch(e2){}
      }
      // PATH C: dnd5e legacy item.use()
      if(!executed && typeof item.use === 'function'){
        try{ await item.use({configure:false, createMessage:true}); executed=true; }catch(e3){}
      }
      // PATH D: legacy rollAttack
      if(!executed && typeof item.rollAttack === 'function'){
        try{
          const atk = await item.rollAttack({event: null, fastForward: fastRoll});
          if(atk && atk.total !== undefined){
            const targetAC = targetToken.actor?.system?.attributes?.ac?.value || 10;
            if(atk.total >= targetAC){
              await this._say(`💥 ${actor.name} hits ${targetToken.name} with ${item.name}! (Attack roll ${atk.total})`, actor);
              if(typeof item.rollDamage === 'function') await item.rollDamage({event: null, fastForward: fastRoll});
            } else {
              await this._say(`❌ ${actor.name} attacks ${targetToken.name} and misses! (Rolled ${atk.total} vs AC ${targetAC})`, actor);
            }
          }
          executed = true;
        }catch(e4){}
      }
      // PATH E: manual
      if(!executed){
        try{
          const bonus = this._getAtkBonus(actor, item);
          const roll = await new Roll(`1d20 + ${bonus}`).evaluate();
          await roll.toMessage({ speaker: ChatMessage.getSpeaker({actor}), flavor: `${actor.name} attacks ${targetToken.name} with ${item.name}` });
        }catch(e5){}
      }

    }catch(err){ console.error('[NPC Autopilot] attack fatal error', err); }
    finally{
      if(midiBackup && mqol?.configSettings){
        const cs = mqol.configSettings;
        cs.autoRollAttack = midiBackup.autoRollAttack; cs.autoRollDamage = midiBackup.autoRollDamage;
        cs.gmAutoAttack = midiBackup.gmAutoAttack; cs.gmAutoDamage = midiBackup.gmAutoDamage;
        cs.autoFastForward = midiBackup.autoFastForward; cs.gmAutoFastForward = midiBackup.gmAutoFastForward;
        this._log(`midi-qol config restored`);
      }
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
      await this._wait(50);

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
        await this._say(`🔥 **${actor.name}** uses **${item.name}** on **${targetToken?.name||'target'}**!`, actor);
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
      let score = (targetCount*50) + (dist*1.2) + (jitter*30);
      if(preferWounded){
        // heavily favour wounded targets so NPCs finish off PCs
        score -= (1 - hpPct)*80;
      } else {
        // standard spread targeting
        score += (hpPct*25);
      }
      return{token:t, score};
    });
    scored.sort((a,b)=>a.score-b.score);
    return scored[0].token;
  }

  static _getTargetedCountThisRound(token){
    if(!game.combat) return 0;
    const counts = game.combat.getFlag(MODULE_ID, 'targetCounts') || {};
    return counts[token.id] || 0;
  }
  static _incrementTargetCount(token){
    if(!game.combat || !token) return;
    const counts = foundry.utils.duplicate(game.combat.getFlag(MODULE_ID, 'targetCounts') || {});
    counts[token.id] = (counts[token.id] || 0) + 1;
    game.combat.setFlag(MODULE_ID, 'targetCounts', counts).catch(()=>{});
  }
  static _resetTargetCounts(){
    if(!game.combat) return;
    game.combat.unsetFlag(MODULE_ID, 'targetCounts').catch(()=>{});
  }

  /* ═══════════════════════════════════════════════════════════════════
    MOVEMENT (tactic-aware positioning)
    ═══════════════════════════════════════════════════════════════════ */
  static async _npcMoveToTarget(selfToken, targetToken, weapon, opts={}){
    if(!selfToken||!targetToken||!canvas?.grid)return'';
    const self=selfToken.document||selfToken;
    const target=targetToken.document||targetToken;
    const gridDist=canvas.grid.distance||5;
    const gridPx=canvas.grid.size||50;
    const distFt=this._tokenDistanceFt(selfToken, targetToken);
    const speedFt=opts.maxMoveFt ?? selfToken.actor?.system?.attributes?.movement?.walk ?? 30;
    const range=this._getWeaponRange(weapon);
    const tactics = opts.tactics || {};

    // Stand-off based on positioning tactic
    let standOffFt;
    const pos = tactics.positioning || 'charge';
    if(range<=10){
      standOffFt = 5; // melee always closes to 5 ft
    } else {
      if(pos==='hang_back'){
        // Casters / snipers — stay at max effective range but within weapon
        standOffFt = Math.max(15, Math.min(range - 5, distFt - 5));
      } else if(pos==='mid'){
        // Bards, clerics, druids — mid-range for spells and backup melee
        standOffFt = Math.max(10, Math.min(range*0.5, distFt - 5));
      } else if(pos==='flank'){
        // Rogues, skirmishers — close but not necessarily charging to adjacent
        standOffFt = Math.max(5, Math.min(range, distFt - 5));
      } else {
        // charge / default — close as much as possible
        standOffFt=Math.min(distFt-5, Math.max(range*0.5, Math.min(range-5, speedFt)));
        if(standOffFt<5) standOffFt=5;
      }
      if(standOffFt>distFt) standOffFt=distFt-5;
      if(distFt<=range && distFt>=5 && ((distFt<=range*0.75 && distFt>=10))) return {msg:'', movedFt:0};
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
    const hit=CONFIG.Canvas.polygonBackends?.move?.testCollision?CONFIG.Canvas.polygonBackends.move.testCollision({x:self.x,y:self.y}, snapped, {type:'move',mode:'any'}):false;
    const movedFt=Math.round((Math.hypot(snapped.x-self.x, snapped.y-self.y)/gridPx)*gridDist);

    if(hit){
      const safe=this._findSafePosition(self,snapped,maxMovePx);
      if(safe){
        const safeMoved=Math.round((Math.hypot(safe.x-self.x, safe.y-self.y)/gridPx)*gridDist);
        await self.update({x:safe.x,y:safe.y});
        return {msg:`${selfToken.name} manoeuvres closer.`, movedFt:safeMoved};
      }
      return {msg:'', movedFt:0};
    }
    await self.update({x:snapped.x,y:snapped.y});
    return {msg:`${selfToken.name} advances toward ${targetToken.name}.`, movedFt};
  }

  static async _npcRetreat(selfToken, enemyTokens){
    if(!selfToken||!canvas?.grid)return {msg:'', movedFt:0};
    const self=selfToken.document||selfToken;
    const speedFt=selfToken.actor?.system?.attributes?.movement?.walk||30;
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
      const safe=this._findSafePosition(self,snapped,maxPx);
      if(safe){ await self.update({x:safe.x,y:safe.y}); return {msg:`${selfToken.name} falls back cautiously.`, movedFt:Math.round((Math.hypot(safe.x-self.x, safe.y-self.y)/gridPx)*gd)}; }
      return {msg:`${selfToken.name} holds position.`, movedFt:0};
    }
    await self.update({x:snapped.x,y:snapped.y});
    return {msg:`${selfToken.name} retreats from the fray.`, movedFt};
  }

  static _findFlankPosition(self,target,maxDist){
    const allies=canvas?.tokens?.placeables?.filter(t=>t.id!==self.id&&t.actor?.type==='npc');
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

  static _findSafePosition(self,targetDest,maxDist){
    const steps=20; const dx=targetDest.x-self.x, dy=targetDest.y-self.y; const dist=Math.hypot(dx,dy)||1;
    for(let i=steps;i>=1;i--){
      const f=(i/steps)*Math.min(1,maxDist/dist);
      const px=self.x+dx*f, py=self.y+dy*f;
      const hit=CONFIG.Canvas.polygonBackends?.move?.testCollision?CONFIG.Canvas.polygonBackends.move.testCollision({x:self.x,y:self.y},{x:px,y:py},{type:'move',mode:'any'}):false;
      if(!hit)return{x:px,y:py};
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

  /* ═══════════════════════════════════════════════════════════════════
    HELPERS
    ═══════════════════════════════════════════════════════════════════ */
  static _findEnemyTokens(selfToken){
    if(!canvas?.tokens)return[];
    return canvas.tokens.placeables.filter(t=>{ if(t.id===selfToken?.id)return false; const a=t.actor; return a&&a.type==='character'; });
  }
  static _findAllyTokens(selfToken){
    if(!canvas?.tokens)return[];
    return canvas.tokens.placeables.filter(t=>{ if(t.id===selfToken?.id)return false; const a=t.actor; return a&&a.type==='npc'; });
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
}

globalThis.NpcAutopilot=NpcAutopilot;
