const MODULE_ID = 'ai-companion';

/* ═══════════════════════════════════════════════════════════════════
   NPC AUTOPILOT v3.5.4 — Foundry VTT D&D 5e
   Full-turn automation with per-NPC toggles, proper targeting,
   range checks, weapon appropriateness, native attack/damage rolling,
   and optional Midi-QOL integration.

   v3.5.4 changes:
   • Sticky target: NPC picks ONE target at turn start and commits to it.
   • Fixed movement distance enforcement: tracks remaining move budget.
   • Action economy overhaul: NPCs do Move + Action (multiattack/single)
     + Bonus Action (heal/off-hand) in a single turn.
   • Off-hand only fires when BOTH weapons are light (Two-Weapon Fighting).
   ═══════════════════════════════════════════════════════════════════ */

/* ─── Settings ──────────────────────────────────────────────────── */
Hooks.on('init', () => {
  game.settings.register(MODULE_ID, 'hudOpen',      { scope:'client', config:false, type:Boolean, default:false });
  game.settings.register(MODULE_ID, 'hudPosition',  { scope:'client', config:false, type:Object,  default:{top:80, right:10} });
  game.settings.register(MODULE_ID, 'hudSize',      { scope:'client', config:false, type:Object,  default:{width:380, height:560} });

  game.settings.register(MODULE_ID, 'npcAutopilot', { scope:'world', config:true, type:Boolean, default:false, name:'NPC Autopilot Master Switch', hint:'Global on/off. Individual NPCs can be toggled separately.' });
  game.settings.register(MODULE_ID, 'autoAdvance',  { scope:'world', config:true, type:Boolean, default:true,  name:'Auto-Advance Combat', hint:'Automatically end NPC turn after autopilot.' });
  game.settings.register(MODULE_ID, 'npcMovement',  { scope:'world', config:true, type:Boolean, default:true,  name:'NPC Movement', hint:'NPCs move within weapon range before attacking.' });
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
  // Reset targeting counts at the top of every new round before anyone acts
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

  /* ── Panel ───────────────────────────────────────────────────── */
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
    const combat=game.combat; const active=combat?.started;
    const cur=combat?.combatant; const ct=cur?.token; const ca=ct?.actor; const isNPC=ca&&!ca.hasPlayerOwner;
    let html=`<div class="npc-ap-status-row">
      <span class="npc-ap-toggle ${globalOn?'on':'off'}" data-ap-action="toggle-global"><i class="fas fa-power-off"></i> ${globalOn?'ON':'OFF'}</span>
      <span class="npc-ap-combat-status">${active?'🎲 Round '+(combat.round||1)+', Turn '+((combat.turn||0)+1):'No combat'}</span></div>`;
    if(ct){ const hp=ca?.system?.attributes?.hp||{}; const p=Math.round((hp.value||0)/(hp.max||1)*100); const c=p>50?'#4ade80':p>25?'#facc15':'#f87171';
      html+=`<div class="npc-ap-card"><img src="${ct.texture?.src||ca?.img||'icons/svg/mystery-man.svg'}">
        <div class="npc-ap-info"><div class="npc-ap-name">${ct.name||ca?.name||'?'}</div>
        <div class="npc-ap-meta">${isNPC?'NPC':'Player'} | HP <span style="color:${c};font-weight:700">${hp.value||0}/${hp.max||'?'}</span> (${p}%)</div>
        <div class="npc-ap-hpbar"><div style="width:${p}%;background:${c}"></div></div></div>
        ${isNPC&&globalOn?'<div class="npc-ap-badge">🤖</div>':''}</div>`; }
    if(active){ const npcs=combat.combatants.filter(c=>c.token?.actor&&!c.token.actor.hasPlayerOwner); if(npcs.length){
      html+=`<div class="npc-ap-list"><div class="npc-ap-section">NPCs in Combat (${npcs.length})</div>`;
      for(const c of npcs){ const a=c.token.actor; const en=this.isEnabled(a); const h=a?.system?.attributes?.hp||{}; const p=Math.round((h.value||0)/(h.max||1)*100); const col=p>50?'#4ade80':p>25?'#facc15':'#f87171';
        html+=`<div class="npc-ap-item ${c.token?.id===ct?.id?'current':''}">
          <input type="checkbox" class="npc-ap-check" data-ap-action="toggle-npc" data-actor-id="${a.id}" ${en?'checked':''} title="Toggle autopilot for ${a.name}">
          <img src="${c.token?.texture?.src||a?.img||'icons/svg/mystery-man.svg'}">
          <div class="npc-ap-item-name">${c.name}</div>
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
      // Refresh token document from canvas to ensure latest position
      const refreshed = canvas.tokens.get(tokenDoc.id);
      if(refreshed) tokenDoc = refreshed.document || refreshed;

      let enemyTokens=this._findEnemyTokens(tokenDoc);
      const allyTokens =this._findAllyTokens(tokenDoc);
      const hpPct=this._getHPPct(actor);
      this._log(`${actor.name} turn start — ${enemyTokens.length} PCs, ${allyTokens.length} allies, HP ${Math.round(hpPct*100)}%`);

      // ── Pick target ONCE at the start of the turn (sticky) ──
      let targetToken = enemyTokens.length ? this._pickTarget(enemyTokens, tokenDoc, actor) : null;
      this._log(`locked target: ${targetToken?.name||'none'} (${enemyTokens.length} enemies)`);
      if(targetToken) this._incrementTargetCount(targetToken);

      // ── Move ──
      let moveBudgetFt = 0;
      let moveMsg = '';
      if(game.settings.get(MODULE_ID,'npcMovement') && tokenDoc && targetToken){
        let moveRes={msg:'', movedFt:0};
        if(hpPct<0.2&&enemyTokens.length>=2) moveRes=await this._npcRetreat(tokenDoc, enemyTokens);
        else {
          const weapon=this._bestWeaponForRange(actor, this._tokenDistanceFt(tokenDoc, targetToken));
          if(weapon){
            moveRes = await this._npcMoveToTarget(tokenDoc, targetToken, weapon);
          }
        }
        moveMsg = moveRes.msg || '';
        moveBudgetFt = Math.max(0, (actor.system?.attributes?.movement?.walk || 30) - (moveRes.movedFt || 0));
        if(moveMsg){await this._say(`🏃 ${moveMsg}`, actor); await this._wait(400);}
      }

      // ── Refresh token position after movement ──
      const movedRefreshed = canvas.tokens.get(tokenDoc.id);
      if(movedRefreshed) tokenDoc = movedRefreshed.document || movedRefreshed;
      enemyTokens=this._findEnemyTokens(tokenDoc);

      // If our locked target died during movement, pick a new one but do NOT move again
      let finalTarget = targetToken;
      if(finalTarget && !enemyTokens.find(t=>t.id===finalTarget.id)){
        finalTarget = enemyTokens.length ? this._pickTarget(enemyTokens, tokenDoc, actor) : null;
        this._log(`target died; re-picked: ${finalTarget?.name||'none'}`);
        if(finalTarget) this._incrementTargetCount(finalTarget);
      }

      // ── Full action economy (uses the SAME target we moved toward) ──
      await this._executeFullTurn(actor, tokenDoc, enemyTokens, allyTokens, hpPct, finalTarget, moveBudgetFt);

      // ── Advance ──
      if(game.settings.get(MODULE_ID,'autoAdvance')&&game.combat?.combatant?.token?.id===tokenDoc?.id){
        setTimeout(()=>game.combat?.nextTurn?.(), 800);
      }
      this._renderPanel();
    }catch(err){console.error('[NPC Autopilot]',err); await this._say(`⚠️ ${err.message}`, actor, {whisper:true});}
    finally{this._busy=false;}
  }

  /* ═══════════════════════════════════════════════════════════════════
     FULL TURN — heals, attacks (multiattack, all weapons), dodge
     ═══════════════════════════════════════════════════════════════════ */
  static async _executeFullTurn(actor, tokenDoc, enemyTokens, allyTokens, hpPct, targetToken, moveBudgetFt=0) {
    this._log(`_executeFullTurn: ${actor.name} — ${enemyTokens.length} enemies, HP ${Math.round(hpPct*100)}%, target=${targetToken?.name||'none'}, moveLeft=${moveBudgetFt}`);
    const items = actor.items?.contents || [];

    // ── Bonus Action pool ──
    let bonusUsed = false;

    // ── Bonus Action: heal self if critical ──
    if(hpPct<0.3){
      const baHeal=this._findSpell(actor,/(healing word|cure wounds)/i);
      this._log(`heal check: ${baHeal ? baHeal.name : 'none found'}`);
      if(baHeal){ await this._useItem(actor,baHeal,actor,tokenDoc); bonusUsed=true; await this._wait(600); }
    }

    // ── Action: multiattack or best single attack ──
    const didMulti=await this._doMultiattack(actor, enemyTokens, items, tokenDoc, moveBudgetFt);
    this._log(`multiattack returned: ${didMulti}`);

    if(!didMulti && targetToken){
      const dist = this._tokenDistanceFt(tokenDoc, targetToken);
      const weapon = this._bestWeaponForRange(actor, dist);
      this._log(`single attack: dist ${Math.round(dist)}ft, weapon=${weapon?.name||'none'}, range=${weapon ? this._getWeaponRange(weapon) : 'n/a'}`);
      let attackWeapon = weapon;
      let attackTarget = targetToken;

      // ── If chosen weapon out of range but movement remains, try to close ──
      if(attackWeapon && dist > this._getWeaponRange(attackWeapon) + 3 && moveBudgetFt > 0){
        const moveRes = await this._npcMoveToTarget(tokenDoc, targetToken, attackWeapon, {maxMoveFt: moveBudgetFt});
        if(moveRes.movedFt){
          moveBudgetFt -= moveRes.movedFt;
          // refresh token reference
          const refreshed = canvas.tokens.get(tokenDoc.id);
          if(refreshed) tokenDoc = refreshed.document || refreshed;
        }
      }
      const finalDist = this._tokenDistanceFt(tokenDoc, attackTarget);
      if(attackWeapon && finalDist <= this._getWeaponRange(attackWeapon) + 3){
        await this._npcAttack(actor, attackWeapon, attackTarget, tokenDoc);
        await this._wait(600);
      } else if(attackWeapon) {
        await this._say(`⚠️ ${actor.name} is ${Math.round(finalDist)} ft from ${attackTarget.name}, beyond ${attackWeapon.name}'s ${this._getWeaponRange(attackWeapon)} ft reach.`, actor, {whisper:true});
      } else {
        await this._say(`⚠️ ${actor.name} has no usable weapon.`, actor, {whisper:true});
      }
    } else if(!didMulti && !targetToken) {
      this._log(`no multiattack and no target token — skipping attack`);
    } else {
      this._log(`multiattack succeeded; skipping single attack`);
    }

    // ── Bonus Action: off-hand (Two-Weapon Fighting) ──
    // Rules: BOTH weapons must be light, attack must have been made with Action,
    //        and bonus action has not been used yet.
    if(!bonusUsed && targetToken){
      const dist = this._tokenDistanceFt(tokenDoc, targetToken);
      const mainWeapon = this._bestWeaponForRange(actor, dist);
      const offHand = this._bestWeaponForRange(actor, dist, {excludeMain:true});
      const mainIsLight = this._isWeaponLight(mainWeapon);
      const offIsLight = this._isWeaponLight(offHand);
      this._log(`off-hand check: offHand=${offHand?.name||'none'}, main=${mainWeapon?.name||'none'}, mainLight=${mainIsLight}, offLight=${offIsLight}`);
      if(offHand && offHand.id !== mainWeapon?.id && mainIsLight && offIsLight && dist <= this._getWeaponRange(offHand) + 3){
        await this._npcAttack(actor, offHand, targetToken, tokenDoc);
        await this._wait(600);
      }
    }

    // ── Dodge as last resort if wounded and nothing happened ──
    if(!didMulti && !targetToken && hpPct<0.25){
      await this._say(`🛡️ ${actor.name} takes the **Dodge** action.`, actor);
    }
  }

  static _isWeaponLight(weapon){
    if(!weapon)return false;
    const props=weapon.system?.properties||[];
    if(Array.isArray(props))return props.includes('lgt')||props.includes('light');
    if(typeof props==='object'&&props!==null) return !!(props.lgt||props.light);
    return false;
  }

  /* ── Multiattack: parse feat description and roll ALL attacks ── */
  static async _doMultiattack(actor, enemyTokens, items, selfToken, moveBudgetFt=0) {
    const multi = items.find(i=>i.type==='feat'&&/multiattack/i.test(i.name));
    if(!multi) return false;

    // ── Strip HTML tags before parsing ──
    let rawDesc = multi.system?.description?.value || '';
    const desc = rawDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    this._log(`Multiattack: "${desc.slice(0,120)}"`);

    // Map all usable attack items by name
    const weaponMap={};
    for(const it of items){
      if(!this._hasAttackActivity(it)) continue;
      if(it.type==='feat'&&/multiattack/i.test(it.name)) continue;
      weaponMap[it.name.toLowerCase()]=it;
      weaponMap[it.name.toLowerCase().replace(/\s+/g,'')]=it;
    }

    const attacks=[];

    // ── Pattern A: "N attacks with its weapon" ──
    let m;
    const rxA = /(?:makes\s+)?(\w+|\d+)\s+(?:\w+\s+)?attack[s]?\s+(?:with\s+(?:its\s+|their\s+|a\s+)?)?([\w\s]+?)(?:\.|,|\s+and\s|\s+using\s|\s+attacks?\b|\s+each\b)/gi;
    while((m=rxA.exec(desc))!==null){
      const count=this._wordToNum(m[1]);
      const rawName=m[2].trim().replace(/^(?:its\s|their\s|a\s)/, '');
      let matched=weaponMap[rawName.toLowerCase()];
      if(!matched) matched=weaponMap[rawName.toLowerCase().replace(/\s+/g,'')];
      if(!matched){
        const rl=rawName.toLowerCase().replace(/\s+/g,'');
        for(const [k,v] of Object.entries(weaponMap)){ if(k.includes(rl)||rl.includes(k)){matched=v;break;} }
      }
      if(matched) for(let i=0;i<count;i++) attacks.push(matched);
    }

    // ── Pattern B: "using scimitar or shortbow"  →  parse weapon list ──
    if(!attacks.length){
      const rxB = /(?:using|with|or)\s+([\w\s,]+?)\s+(?:in any combination|in any order|alternatively)/i;
      const bm = desc.match(rxB);
      if(bm){
        const parts = bm[1].split(/\s+or\s+|,\s+/);
        for(const p of parts){
          const raw = p.trim();
          if(!raw) continue;
          let matched = weaponMap[raw.toLowerCase()];
          if(!matched) matched = weaponMap[raw.toLowerCase().replace(/\s+/g,'')];
          if(!matched){
            const rl = raw.toLowerCase().replace(/\s+/g,'');
            for(const [k,v] of Object.entries(weaponMap)){ if(k.includes(rl)||rl.includes(k)){matched=v;break;} }
          }
          if(matched) attacks.push(matched);
        }
      }
    }

    // ── Pattern C: explicit weapon names anywhere in description ──
    if(!attacks.length){
      for(const it of items){
        if(it.type==='feat'&&/multiattack/i.test(it.name)) continue;
        if(!this._hasAttackActivity(it)) continue;
        const n=it.name.toLowerCase();
        if(desc.includes(n)) attacks.push(it);
      }
    }

    if(!attacks.length) return false;

    // Multiattack says "makes two attacks" — if pattern A gave a count, honour it;
    // otherwise default to 2 attacks with the first matched weapon.
    let finalTarget=this._pickTarget(enemyTokens, selfToken, actor); // stays sticky for all attacks
    let finalAttacks = attacks;
    if(finalAttacks.length === 1 && attacks.length < 2){
      finalAttacks = [attacks[0], attacks[0]]; // two swings with same weapon
    }

    let attacksPerformed = 0;
    let lastWeapon=null;
    for(const weapon of finalAttacks){
      const weaponChanged = lastWeapon && lastWeapon.id !== weapon.id;
      let target = finalTarget;

      // ── If the weapon we want to use is out of range, try to move closer ──
      if(weaponChanged){
        const dist = this._tokenDistanceFt(selfToken, finalTarget);
        const range = this._getWeaponRange(weapon);
        if(finalTarget && dist > range+3 && moveBudgetFt > 0){
          const moveRes = await this._npcMoveToTarget(selfToken, finalTarget, weapon, {maxMoveFt: moveBudgetFt});
          if(moveRes.movedFt){
            moveBudgetFt -= moveRes.movedFt;
            if(moveRes.msg) await this._say(`🏃 ${moveRes.msg}`, actor);
            await this._wait(300);
            // Refresh token reference after move
            const refreshed = canvas.tokens.get(selfToken.id);
            if(refreshed) selfToken = refreshed.document || refreshed;
          }
        }
        // After (optional) move, re-check range
        const newDist = this._tokenDistanceFt(selfToken, finalTarget);
        if(finalTarget && newDist > this._getWeaponRange(weapon)+3){
          const inRange=enemyTokens.filter(t=>{
            const d=this._tokenDistanceFt(selfToken,t); return d<=this._getWeaponRange(weapon)+3;
          });
          target = inRange.length ? this._pickTarget(inRange, selfToken, actor) : this._pickTarget(enemyTokens, selfToken, actor);
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
    if(attacksPerformed === 0) return false;
    return true;
  }

  static _wordToNum(w){ const map={one:1,two:2,three:3,four:4,five:5}; const n=parseInt(w); return isNaN(n)?(map[w?.toLowerCase()]||1):n; }

  /* ═══════════════════════════════════════════════════════════════════
     ATTACK / USE ITEM — per-attempt fallback chain with full logging
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

    // Save current GM state
    const oldTargets = Array.from(game.user.targets).map(t=>t.id);
    const oldControlled = Array.from(canvas.tokens.controlled).map(t=>t.id);

    try{
      // ── Set canvas target & selection for dnd5e context ──
      const tgt = targetToken.object || targetToken;
      const self = selfToken?.object || selfToken;
      if(tgt?.setTarget) tgt.setTarget(true, {user: game.user, releaseOthers: true});
      if(self?.control) self.control({releaseOthers: true});
      await this._wait(50); // brief moment for canvas to register target

      let executed = false;

      // ═════ PATH 1: Midi-QOL (if installed) ═════
      if(!executed && game.modules.get("midi-qol")?.active && globalThis.MidiQOL?.Workflow){
        const act = this._attackActivity(item) || this._firstActivity(item);
        if(act && typeof act.use === 'function'){
          this._log(`→ PATH 1: Midi-QOL activity.use() for ${item.name}`);
          try{
            await act.use({
              configureDialog: false,
              createMessage: true,
              midiOptions: {
                workflowOptions: {
                  autoRollAttack: true,
                  autoRollDamage: "onHit",
                  fastForwardAttack: true,
                  fastForwardDamage: true,
                  targetConfirmation: "none"
                }
              }
            });
            this._log(`✓ PATH 1 succeeded`);
            executed = true;
          }catch(e1){ this._log(`✗ PATH 1 (Midi-QOL) failed: ${e1.message}`); }
        }
      }

      // ═════ PATH 2: dnd5e v4 activity.use() — native ═════
      if(!executed){
        const activity = this._attackActivity(item);
        if(activity && typeof activity.use === 'function'){
          this._log(`→ PATH 2: dnd5e v4 activity.use() type=${activity.type||'?'} name=${activity.name||'?'}`);
          const isAttackActivity = activity.type === 'attack' || activity.name?.toLowerCase()?.includes('attack');
          try{
            // For attack activities: just create the card, then let PATH 4 handle the actual roll
            let msgConfig = { create: isAttackActivity ? false : true };
            await activity.use(
              { consume: false },
              { configure: false },
              msgConfig
            );
            this._log(`✓ PATH 2 (v4 canonical) ${isAttackActivity ? 'prepared' : 'succeeded'}`);
            if(!isAttackActivity) executed = true;
          }catch(e2){
            this._log(`✗ PATH 2a failed: ${e2.message}`);
            try{
              await activity.use({
                configureDialog: false,
                createMessage: !isAttackActivity,
                consume: false
              });
              this._log(`✓ PATH 2b (flat config) succeeded`);
              if(!isAttackActivity) executed = true;
            }catch(e3){ this._log(`✗ PATH 2b failed: ${e3.message}`); }
          }
        } else {
          this._log(`→ No valid activity found for ${item.name}; skipping PATH 2`);
        }
      }

      // ═════ PATH 3: dnd5e legacy item.use() ═════
      if(!executed && typeof item.use === 'function'){
        this._log(`→ PATH 3: legacy item.use() for ${item.name}`);
        try{
          await item.use({configure:false, createMessage:true});
          this._log(`✓ PATH 3 succeeded`);
          executed = true;
        }catch(e4){ this._log(`✗ PATH 3 failed: ${e4.message}`); }
      }

      // ═════ PATH 3.5: dnd5e v4 activity rollAttack / rollDamage ═════
      if(!executed){
        const activity = this._attackActivity(item);
        if(activity && typeof activity.rollAttack === 'function'){
          this._log(`→ PATH 3.5: dnd5e v4 activity.rollAttack for ${item.name}`);
          try{
            const atk = await activity.rollAttack?.({event: null, fastForward: true});
            if(!atk || atk.total === undefined){
              await this._say(`❌ ${actor.name} attacks ${targetToken.name} but the attack roll failed.`, actor);
            } else {
              const targetAC = targetToken.actor?.system?.attributes?.ac?.value || 10;
              if(atk.total < targetAC){
                await this._say(`❌ ${actor.name} attacks ${targetToken.name} and misses! (Rolled ${atk.total} vs AC ${targetAC})`, actor);
              } else {
                await this._say(`💥 ${actor.name} hits ${targetToken.name} with ${item.name}! (Attack roll ${atk.total})`, actor);
                if(typeof activity.rollDamage === 'function'){
                  const dmg = await activity.rollDamage?.({event: null, fastForward: true});
                  if(dmg?.total !== undefined){
                    const hp = targetToken.actor?.system?.attributes?.hp;
                    if(hp){ const newHP = Math.max(0, hp.value - dmg.total); await targetToken.actor.update({"system.attributes.hp.value": newHP}); }
                  }
                }
              }
            }
            executed = true;
          }catch(raErr){ this._log(`✗ PATH 3.5 failed: ${raErr.message}`); }
        }
      }

      // ═════ PATH 4: dnd5e legacy item.rollAttack() / rollDamage() ═════
      if(!executed && typeof item.rollAttack === 'function'){
        this._log(`→ PATH 4: legacy item.rollAttack() for ${item.name}`);
        try{
          const atk = await item.rollAttack({event: null, fastForward: true});
          if(!atk || atk.total === undefined){
            await this._say(`❌ ${actor.name} attacks ${targetToken.name} but the attack roll failed.`, actor);
          } else {
            const targetAC = targetToken.actor?.system?.attributes?.ac?.value || 10;
            if(atk.total < targetAC){
              await this._say(`❌ ${actor.name} attacks ${targetToken.name} and misses! (Rolled ${atk.total} vs AC ${targetAC})`, actor);
            } else {
              await this._say(`💥 ${actor.name} hits ${targetToken.name} with ${item.name}! (Attack roll ${atk.total})`, actor);
              if(typeof item.rollDamage === 'function'){
                const dmg = await item.rollDamage({event: null, fastForward: true});
                if(dmg?.total !== undefined){
                  const hp = targetToken.actor?.system?.attributes?.hp;
                  if(hp){ const newHP = Math.max(0, hp.value - dmg.total); await targetToken.actor.update({"system.attributes.hp.value": newHP}); }
                }
              }
            }
          }
          executed = true;
        }catch(e5){ this._log(`✗ PATH 4 failed: ${e5.message}`); }
      }

      // ═════ PATH 5: manual die roll ═════
      if(!executed){
        this._log(`→ PATH 5: manual roll fallback for ${item.name}`);
        try{
          const bonus = this._getAtkBonus(actor, item);
          const roll = await new Roll(`1d20 + ${bonus}`).evaluate();
          await roll.toMessage({
            speaker: ChatMessage.getSpeaker({actor}),
            flavor: `${actor.name} attacks ${targetToken.name} with ${item.name}`
          });
          this._log(`✓ PATH 5 (manual) succeeded`);
        }catch(e6){ this._log(`✗ PATH 5 failed: ${e6.message}`); }
      }

    }catch(err){
      console.error('[NPC Autopilot] attack fatal error', err);
      await this._say(`⚠️ ${item.name} fatal error: ${err.message}`, actor, {whisper:true});
    }finally{
      // Restore targets
      if(game.user.updateTokenTargets){
        game.user.updateTokenTargets(oldTargets);
      } else {
        for(const t of Array.from(game.user.targets)){ const p=t.object||t; if(p.setTarget) p.setTarget(false,{user:game.user}); }
        for(const id of oldTargets){ const to=canvas.tokens.get(id); if(to?.setTarget) to.setTarget(true,{user:game.user}); }
      }
      // Restore selection
      for(const t of Array.from(canvas.tokens.controlled)){ const p=t.object||t; if(p.release) p.release(); }
      for(const id of oldControlled){ const to=canvas.tokens.get(id); if(to?.control) to.control({releaseOthers:false}); }
    }
  }

  static async _useItem(actor, item, targetToken, selfToken) {
    if(!item) return;
    this._log(`_useItem: ${actor.name} → ${item.name}`);
    const oldTargets = Array.from(game.user.targets).map(t=>t.id);
    const oldControlled = Array.from(canvas.tokens.controlled).map(t=>t.id);

    try{
      if(targetToken){
        const tgt=targetToken.object||targetToken;
        if(tgt.setTarget) tgt.setTarget(true,{user:game.user,releaseOthers:true});
      }
      const self=selfToken?.object||selfToken;
      if(self?.control) self.control({releaseOthers:true});
      await this._wait(50);

      let executed = false;

      // PATH 1: Midi-QOL
      if(game.modules.get("midi-qol")?.active && globalThis.MidiQOL?.Workflow){
        const activity = this._firstActivity(item);
        if(activity && typeof activity.use === 'function'){
          try{
            await activity.use({ configureDialog: false, createMessage: true });
            this._log(`_useItem PATH 1 (Midi) ok`);
            executed = true;
          }catch(e){ this._log(`_useItem PATH 1 failed: ${e.message}`); }
        }
      }

      // PATH 2: dnd5e v4 activity.use()
      if(!executed){
        const activity=this._firstActivity(item);
        if(activity && typeof activity.use==='function'){
          try{
            await activity.use({consume:false},{configure:false},{create:true});
            this._log(`_useItem PATH 2 (v4) ok`);
            executed = true;
          }catch(e1){
            this._log(`_useItem PATH 2a failed: ${e1.message}`);
            try{
              await activity.use({configureDialog:false,createMessage:true,consume:false});
              this._log(`_useItem PATH 2b ok`);
              executed = true;
            }catch(e2){ this._log(`_useItem PATH 2b failed: ${e2.message}`); }
          }
        }
      }

      // PATH 3: legacy item.use()
      if(!executed && typeof item.use==='function'){
        try{
          await item.use({configure:false, createMessage:true});
          this._log(`_useItem PATH 3 (legacy) ok`);
          executed = true;
        }catch(e){ this._log(`_useItem PATH 3 failed: ${e.message}`); }
      }

      if(!executed){
        this._log(`_useItem: no path succeeded for ${item.name}`);
        await this._say(`🔥 **${actor.name}** uses **${item.name}** on **${targetToken?.name||'target'}**!`, actor);
      }

    }catch(err){
      console.error('[NPC Autopilot] useItem error', err);
    }finally{
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

  /* ── Weapon selection based on actual distance ── */
  static _bestWeaponForRange(actor, distFt, opts={}){
    const items=actor.items?.contents||[];
    let cands=items.filter(i=>
      (['weapon','equipment'].includes(i.type)||(i.type==='feat'&&!/multiattack/i.test(i.name)))
      &&this._hasAttackActivity(i)
    );
    if(!cands.length) cands=items.filter(i=>i.type==='feat'&&this._hasAttackActivity(i)
      &&/attack|hit|strike|claw|bite|tail|slam|tentacle|horn|gore|punch|kick|stab/i.test(i.name));
    if(!cands.length) return items.find(i=>i.type==='weapon')||items.find(i=>i.type==='feat'&&this._hasAttackActivity(i));

    if(distFt!==undefined){
      if(distFt<=10){ // Melee
        const melee=cands.filter(w=>this._getWeaponRange(w)<=10);
        if(melee.length) cands=melee;
      } else { // Ranged
        const ranged=cands.filter(w=>this._getWeaponRange(w)>10);
        if(ranged.length) cands=ranged;
      }
    }

    if(opts.excludeMain&&cands.length>1){
      const main=this._bestWeaponForRange(actor, distFt);
      const alt=cands.find(w=>w.id!==main?.id);
      if(alt) cands=[alt];
    }
    return cands[0];
  }

  static _findSpell(actor,rx){ return(actor.items?.contents||[]).find(i=>i.type==='spell'&&rx.test(i.name)); }

  static _pickTarget(enemyTokens, selfToken=null, actor=null){
    if(!enemyTokens.length)return null;
    if(enemyTokens.length===1)return enemyTokens[0];

    // Build scored list: prefer wounded but spread love across targets this round
    // Use selfToken.id (not actor.id) so linked tokens sharing an actor still diverge.
    const scored = enemyTokens.map(t=>{
      const hp = t.actor?.system?.attributes?.hp||{};
      const hpPct = (hp.value||0)/Math.max(1,hp.max||1);
      const dist = selfToken ? this._tokenDistanceFt(selfToken, t) : 30;
      const targetCount = this._getTargetedCountThisRound(t);
      // Per-round jitter so NPCs rotate targets as the fight evolves
      const jitter = this._hashFloat(selfToken?.id||actor?.id||'', (t.id||'')+(game.combat?.round||0));
      // Heavily penalise targets already chosen this round (50 pts per pick)
      // and give a 30-pt random spread so tied scores break differently per token.
      const score = (hpPct*25) + (dist*1.2) + (targetCount*50) + (jitter*30);
      return{token:t, score};
    });
    scored.sort((a,b)=>a.score-b.score);
    return scored[0].token;
  }

  /* Track how many times a token was chosen as a target this combat round */
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

  /* Deterministic pseudo-random float [0,1) from two strings */
  static _hashFloat(s1,s2){
    let h=0;
    const str=(s1||'')+(s2||'');
    for(let i=0;i<str.length;i++){ h=((h<<5)-h)+str.charCodeAt(i); h|=0; }
    return(Math.abs(h)%10001)/10001;
  }

  /* ═══════════════════════════════════════════════════════════════════
    MOVEMENT
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

    // Determine ideal stand-off distance:
    //  - Melee (range <=10 ft): close to 5 ft
    //  - Ranged (range >10 ft): stay at just within range, but at least 5 ft if possible
    let standOffFt;
    if(range<=10){
      standOffFt=5; // melee — get right next to them
    } else {
      // ranged — close to half range (optimal accuracy) if possible, but stay at least 5 ft away
      standOffFt=Math.min(distFt-5, Math.max(range*0.5, Math.min(range-5, speedFt)));
      if(standOffFt<5) standOffFt=5;
      if(standOffFt>distFt) standOffFt=distFt-5;
      // If already within range and range is decently usable, don't move
      if(distFt<=range && distFt>=5 && ((distFt<=range*0.75 && distFt>=10))) return {msg:'', movedFt:0};
    }

    // If already at desired stand-off range, no move
    if(distFt<=standOffFt+2) return {msg:'', movedFt:0};

    const standOffPx=(standOffFt/gridDist)*gridPx;
    const maxMovePx=(speedFt/gridDist)*gridPx;

    const dx=self.x-target.x, dy=self.y-target.y;
    const totalPx=Math.hypot(dx,dy);
    if(totalPx<=standOffPx) return {msg:'', movedFt:0};

    const angle=Math.atan2(target.y-self.y, target.x-self.x);
    const movePx=Math.min(maxMovePx, totalPx-standOffPx);
    if(movePx<=0) return {msg:'', movedFt:0};

    // Try to flank first (but only if the flank point is within our move budget)
    let dest=this._findFlankPosition(self, target, movePx);
    if(!dest) dest={x:self.x+Math.cos(angle)*movePx, y:self.y+Math.sin(angle)*movePx};
    else {
      // Ensure the flank point doesn't overshoot our budget from current position
      const flankDist=Math.hypot(dest.x-self.x, dest.y-self.y);
      if(flankDist > movePx) dest = {x:self.x+Math.cos(angle)*movePx, y:self.y+Math.sin(angle)*movePx};
      // Clamp destination so it doesn't overshoot target (we want stand-off, not 0 distance)
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
    for(const t of enemyTokens){
      const td=t.document||t;
      ex+=td.x; ey+=td.y; c++;
    }
    if(!c)return {msg:'', movedFt:0};
    ex/=c; ey/=c;
    const angle=Math.atan2(self.y-ey, self.x-ex);
    const dest={x:self.x+Math.cos(angle)*maxPx, y:self.y+Math.sin(angle)*maxPx};
    const snapped=canvas.grid.getSnappedPoint?canvas.grid.getSnappedPoint({x:dest.x,y:dest.y},{mode:CONST.GRID_SNAPPING_MODES.CENTER}):dest;
    const movedFt=Math.round((Math.hypot(snapped.x-self.x, snapped.y-self.y)/gridPx)*gd);
    const hit=CONFIG.Canvas.polygonBackends?.move?.testCollision?CONFIG.Canvas.polygonBackends.move.testCollision({x:self.x,y:self.y}, snapped, {type:'move',mode:'any'}):false;
    if(hit){
      const safe=this._findSafePosition(self,snapped,maxPx);
      if(safe){
        const safeMoved=Math.round((Math.hypot(safe.x-self.x, safe.y-self.y)/gridPx)*gd);
        await self.update({x:safe.x,y:safe.y});
        return {msg:`${selfToken.name} falls back cautiously.`, movedFt:safeMoved};
      }
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
    // Only return if the flank point is within our movement budget
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
    // v4: look at attack activity range first
    const act=this._attackActivity(item);
    if(act?.range){
      if(act.range.value)return parseInt(act.range.value)||5;
      if(act.range.reach)return 10;
      if(act.range.long)return parseInt(act.range.long)||60;
    }
    // v3
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
    try{
      if(canvas.grid.measureDistance)return canvas.grid.measureDistance({x:ad.x,y:ad.y},{x:bd.x,y:bd.y});
    }catch(e){}
    const dx=(ad.x-bd.x)/(canvas.grid.size||1)*(canvas.grid.distance||5);
    const dy=(ad.y-bd.y)/(canvas.grid.size||1)*(canvas.grid.distance||5);
    return Math.sqrt(dx*dx+dy*dy);
  }

  /* ═══════════════════════════════════════════════════════════════════
    HELPERS
    ═══════════════════════════════════════════════════════════════════ */
  // Find PCs (type 'character') — never NPC allies
  static _findEnemyTokens(selfToken){
    if(!canvas?.tokens)return[];
    return canvas.tokens.placeables.filter(t=>{
      if(t.id===selfToken?.id)return false;
      const a=t.actor;
      return a&&a.type==='character';
    });
  }
  // Find NPC allies (type 'npc') — never PCs
  static _findAllyTokens(selfToken){
    if(!canvas?.tokens)return[];
    return canvas.tokens.placeables.filter(t=>{
      if(t.id===selfToken?.id)return false;
      const a=t.actor;
      return a&&a.type==='npc';
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
  static async _say(content,actor,opts={}){
    const msgType = CONST.CHAT_MESSAGE_TYPES?.OTHER ?? 0;
    await ChatMessage.create({
      user:game.userId,
      speaker:ChatMessage.getSpeaker({actor}),
      content:`<p>${content}</p>`,
      type:msgType,
      whisper:opts.whisper?[game.userId]:[]
    });
  }
  static _log(m){console.log(`%c[NPC Autopilot] ${m}`,'color:#8b5cf6;font-weight:bold');}
  static _wait(ms){return new Promise(r=>setTimeout(r,ms));}
}

globalThis.NpcAutopilot=NpcAutopilot;
