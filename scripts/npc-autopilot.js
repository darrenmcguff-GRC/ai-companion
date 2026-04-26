const MODULE_ID = 'ai-companion';

/* ═══════════════════════════════════════════════════════════════════
   NPC AUTOPILOT v3.3 — Foundry VTT D&D 5e
   Full-turn automation with per-NPC toggles, proper targeting,
   range checks, and weapon appropriateness.
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
      const enemyTokens=this._findEnemyTokens(tokenDoc);
      const allyTokens =this._findAllyTokens(tokenDoc);
      const hpPct=this._getHPPct(actor);
      this._log(`${actor.name} turn — ${enemyTokens.length} PCs, ${allyTokens.length} allies, HP ${Math.round(hpPct*100)}%`);

      // Determine target and best weapon BEFORE movement so we move to correct range
      let targetToken = enemyTokens.length ? this._pickTarget(enemyTokens) : null;

      // ── Move ──
      if(game.settings.get(MODULE_ID,'npcMovement') && tokenDoc && targetToken){
        let move='';
        if(hpPct<0.2&&enemyTokens.length>=2) move=await this._npcRetreat(tokenDoc, enemyTokens);
        else {
          const weapon=this._bestWeaponForRange(actor, this._tokenDistanceFt(tokenDoc, targetToken));
          if(weapon) move=await this._npcMoveToTarget(tokenDoc, targetToken, weapon);
        }
        if(move){await this._say(`🏃 ${move}`, actor); await this._wait(400);}
      }

      // ── Re-evaluate target after movement (closest PC) ──
      targetToken = enemyTokens.length ? this._pickTarget(enemyTokens) : null;

      // ── Full action economy ──
      await this._executeFullTurn(actor, tokenDoc, enemyTokens, allyTokens, hpPct, targetToken);

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
  static async _executeFullTurn(actor, tokenDoc, enemyTokens, allyTokens, hpPct, targetToken) {
    const items = actor.items?.contents || [];

    // ── Bonus Action: heal self if critical ──
    if(hpPct<0.3){
      const baHeal=this._findSpell(actor,/(healing word|mass healing word|cure wounds)/i);
      if(baHeal){ await this._useItem(actor,baHeal,actor,tokenDoc); await this._wait(600); }
    }

    // ── Action: multiattack or best single attack ──
    const didMulti=await this._doMultiattack(actor, enemyTokens, items, tokenDoc);

    if(!didMulti && targetToken){
      const dist = this._tokenDistanceFt(tokenDoc, targetToken);
      const weapon = this._bestWeaponForRange(actor, dist);
      if(weapon && dist <= this._getWeaponRange(weapon) + 3){
        await this._npcAttack(actor, weapon, targetToken, tokenDoc);
        await this._wait(600);
      } else if(weapon) {
        await this._say(`⚠️ ${actor.name} is ${Math.round(dist)} ft from ${targetToken.name}, beyond ${weapon.name}'s ${this._getWeaponRange(weapon)} ft reach.`, actor, {whisper:true});
      }
    }

    // ── Bonus Action: off-hand if applicable ──
    if(targetToken){
      const dist = this._tokenDistanceFt(tokenDoc, targetToken);
      const offHand = this._bestWeaponForRange(actor, dist, {excludeMain:true});
      const mainWeapon = this._bestWeaponForRange(actor, dist);
      if(offHand && offHand.id !== mainWeapon?.id && dist <= this._getWeaponRange(offHand) + 3){
        await this._npcAttack(actor, offHand, targetToken, tokenDoc);
        await this._wait(600);
      }
    }

    // ── Dodge as last resort if wounded and nothing happened ──
    if(!didMulti && !targetToken && hpPct<0.25){
      await this._say(`🛡️ ${actor.name} takes the **Dodge** action.`, actor);
    }
  }

  /* ── Multiattack: parse feat description and roll ALL attacks ── */
  static async _doMultiattack(actor, enemyTokens, items, selfToken) {
    const multi = items.find(i=>i.type==='feat'&&/multiattack/i.test(i.name));
    if(!multi) return false;
    const desc=(multi.system?.description?.value||'').toLowerCase();
    this._log(`Multiattack: "${desc.slice(0,100)}"`);

    // Map all usable attack items by name
    const weaponMap={};
    for(const it of items){
      if(!this._hasAttackActivity(it)) continue;
      if(it.type==='feat'&&/multiattack/i.test(it.name)) continue;
      weaponMap[it.name.toLowerCase()]=it;
      weaponMap[it.name.toLowerCase().replace(/\s+/g,'')]=it;
    }

    const attacks=[];

    // Extract "N attacks with weapon" patterns
    let m;
    // Matches: "makes two attacks with its scimitar", "one attack with its shortsword", etc.
    const rx=/(?:makes\s+)?(\w+|\d+)\s+(?:\w+\s+)?attack[s]?\s+(?:with\s+(?:its\s+|their\s+|a\s+)?)?([\w\s]+?)(?:\.|,|\s+and|\s+or|attacks?|using)/gi;
    while((m=rx.exec(desc))!==null){
      const count=this._wordToNum(m[1]);
      const rawName=m[2].trim();
      let matched=weaponMap[rawName.toLowerCase()];
      if(!matched) matched=weaponMap[rawName.toLowerCase().replace(/\s+/g,'')];
      if(!matched){
        const rl=rawName.toLowerCase().replace(/\s+/g,'');
        for(const [k,v] of Object.entries(weaponMap)){ if(k.includes(rl)||rl.includes(k)){matched=v;break;} }
      }
      if(matched) for(let i=0;i<count;i++) attacks.push(matched);
    }

    // Fallback: any weapon-like feat mentioned by name in the description
    if(!attacks.length){
      for(const it of items){
        if(it.type==='feat'&&/multiattack/i.test(it.name)) continue;
        if(!this._hasAttackActivity(it)) continue;
        const n=it.name.toLowerCase();
        if(desc.includes(n)) attacks.push(it);
      }
    }

    if(!attacks.length) return false;

    for(const weapon of attacks){
      const target=this._pickTarget(enemyTokens);
      if(!target) continue;
      const dist=this._tokenDistanceFt(selfToken, target);
      const range=this._getWeaponRange(weapon);
      if(dist <= range + 3){
        await this._npcAttack(actor, weapon, target, selfToken);
        await this._wait(700);
      } else {
        await this._say(`⚠️ ${actor.name}'s ${weapon.name} out of range (${Math.round(dist)}>${range} ft).`, actor, {whisper:true});
      }
    }
    return true;
  }

  static _wordToNum(w){ const map={one:1,two:2,three:3,four:4,five:5}; const n=parseInt(w); return isNaN(n)?(map[w?.toLowerCase()]||1):n; }

  /* ═══════════════════════════════════════════════════════════════════
     ATTACK / USE ITEM — proper targeting + range validation
     ═══════════════════════════════════════════════════════════════════ */
  static async _npcAttack(actor, item, targetToken, selfToken) {
    if(!item){ await this._say(`⚠️ ${actor.name} has no weapon.`, actor, {whisper:true}); return; }
    if(!targetToken){ await this._say(`⚠️ ${actor.name} has no target.`, actor, {whisper:true}); return; }

    const dist = this._tokenDistanceFt(selfToken, targetToken);
    const range = this._getWeaponRange(item);
    if(dist > range + 3){
      await this._say(`⚠️ ${actor.name} is ${Math.round(dist)} ft from ${targetToken.name} — ${item.name} only reaches ${range} ft.`, actor, {whisper:true});
      return;
    }

    const oldTargetIds = Array.from(game.user.targets).map(t=>t.id);
    const oldControlledIds = Array.from(canvas.tokens.controlled).map(t=>t.id);

    try{
      // Target the defender
      const tgtP = targetToken.object || targetToken;
      if(tgtP.setTarget) tgtP.setTarget(true, {user: game.user, releaseOthers: true});
      // Select the attacker so dnd5e knows who is acting
      const selfP = selfToken?.object || selfToken;
      if(selfP?.control) selfP.control({releaseOthers: true});

      // v4 activity
      const activity = this._attackActivity(item);
      if(activity && typeof activity.use==='function'){
        await activity.use({configure:false, createMessage:true});
        return;
      }
      // v3 item.use()
      if(typeof item.use==='function'){ await item.use(); return; }
      // Legacy
      if(typeof item.rollAttack==='function'){ await item.rollAttack({event:null}); return; }
      // Manual
      const bonus=this._getAtkBonus(actor,item);
      const roll=await new Roll(`1d20+${bonus}`).evaluate();
      await roll.toMessage({speaker:ChatMessage.getSpeaker({actor}), flavor:`${actor.name} attacks ${targetToken.name} with ${item.name}`});
    }catch(e){
      console.warn('[NPC Autopilot] attack error', e);
      await this._say(`⚠️ ${item.name} failed: ${e.message}`, actor, {whisper:true});
    }finally{
      // Restore targets
      if(game.user.updateTokenTargets){
        game.user.updateTokenTargets(oldTargetIds);
      } else {
        for(const t of Array.from(game.user.targets)){ const p=t.object||t; if(p.setTarget) p.setTarget(false,{user:game.user}); }
        for(const id of oldTargetIds){ const t=canvas.tokens.get(id); if(t?.setTarget) t.setTarget(true,{user:game.user}); }
      }
      // Restore selection
      for(const t of Array.from(canvas.tokens.controlled)){ const p=t.object||t; if(p.release) p.release(); }
      for(const id of oldControlledIds){ const t=canvas.tokens.get(id); if(t?.control) t.control({releaseOthers:false}); }
    }
  }

  static async _useItem(actor, item, targetToken, selfToken) {
    if(!item)return;
    const oldTargetIds = Array.from(game.user.targets).map(t=>t.id);
    const oldControlledIds = Array.from(canvas.tokens.controlled).map(t=>t.id);
    try{
      if(targetToken){
        const tgtP=targetToken.object||targetToken;
        if(tgtP.setTarget) tgtP.setTarget(true,{user:game.user,releaseOthers:true});
      }
      const selfP=selfToken?.object||selfToken;
      if(selfP?.control) selfP.control({releaseOthers:true});

      const activity=this._firstActivity(item);
      if(activity&&typeof activity.use==='function'){
        await activity.use({configure:false, createMessage:true}); return;
      }
      if(typeof item.use==='function'){ await item.use(); return; }
      await this._say(`🔥 **${actor.name}** uses **${item.name}** on **${targetToken?.name||'target'}**!`, actor);
    }catch(e){
      console.warn('[NPC Autopilot] useItem error', e);
    }finally{
      if(game.user.updateTokenTargets) game.user.updateTokenTargets(oldTargetIds);
      for(const t of Array.from(canvas.tokens.controlled)){ const p=t.object||t; if(p.release) p.release(); }
      for(const id of oldControlledIds){ const t=canvas.tokens.get(id); if(t?.control) t.control({releaseOthers:false}); }
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

  static _pickTarget(enemyTokens){
    if(!enemyTokens.length)return null;
    return enemyTokens.slice().sort((a,b)=>{
      const ha=a.actor?.system?.attributes?.hp||{},hb=b.actor?.system?.attributes?.hp||{};
      return(ha.value||0)-(hb.value||0);
    })[0];
  }

  /* ═══════════════════════════════════════════════════════════════════
    MOVEMENT
    ═══════════════════════════════════════════════════════════════════ */
  static async _npcMoveToTarget(selfToken, targetToken, weapon){
    if(!selfToken||!targetToken||!canvas?.grid)return'';
    const self=selfToken.document||selfToken;
    const target=targetToken.document||targetToken;
    const range=this._getWeaponRange(weapon);
    const gridDist=canvas.grid.distance||5;
    const rangePx=(range/gridDist)*canvas.grid.size;
    const rangeSq=rangePx*rangePx;

    const dx=self.x-target.x, dy=self.y-target.y;
    if(dx*dx+dy*dy<=rangeSq) return'';

    const speed=selfToken.actor?.system?.attributes?.movement?.walk||30;
    const maxPx=(speed/gridDist)*canvas.grid.size;

    let dest=this._findFlankPosition(self, target);
    if(!dest){
      const angle=Math.atan2(target.y-self.y, target.x-self.x);
      const total=Math.hypot(dx,dy);
      const move=Math.min(maxPx, total-Math.sqrt(rangeSq)*0.8);
      if(move<=0)return'';
      dest={x:self.x+Math.cos(angle)*move, y:self.y+Math.sin(angle)*move};
    }
    const snapped=canvas.grid.getSnappedPoint?canvas.grid.getSnappedPoint({x:dest.x,y:dest.y},{mode:CONST.GRID_SNAPPING_MODES.CENTER}):dest;
    const hit=CONFIG.Canvas.polygonBackends?.move?.testCollision?CONFIG.Canvas.polygonBackends.move.testCollision({x:self.x,y:self.y}, snapped, {type:'move',mode:'any'}):false;
    if(hit){
      const safe=this._findSafePosition(self,snapped,maxPx);
      if(safe){await self.update({x:safe.x,y:safe.y});return`${selfToken.name} manoeuvres closer.`;}
      return'';
    }
    await self.update({x:snapped.x,y:snapped.y});
    return`${selfToken.name} advances toward ${targetToken.name}.`;
  }

  static async _npcRetreat(selfToken, enemyTokens){
    if(!selfToken||!canvas?.grid)return'';
    const self=selfToken.document||selfToken;
    const speed=selfToken.actor?.system?.attributes?.movement?.walk||30;
    const gd=canvas.grid.distance||5;
    const maxPx=(speed/gd)*canvas.grid.size;
    let ex=0,ey=0,c=0;
    for(const t of enemyTokens){
      const td=t.document||t;
      ex+=td.x; ey+=td.y; c++;
    }
    if(!c)return'';
    ex/=c; ey/=c;
    const angle=Math.atan2(self.y-ey, self.x-ex);
    const dest={x:self.x+Math.cos(angle)*maxPx, y:self.y+Math.sin(angle)*maxPx};
    const snapped=canvas.grid.getSnappedPoint?canvas.grid.getSnappedPoint({x:dest.x,y:dest.y},{mode:CONST.GRID_SNAPPING_MODES.CENTER}):dest;
    const hit=CONFIG.Canvas.polygonBackends?.move?.testCollision?CONFIG.Canvas.polygonBackends.move.testCollision({x:self.x,y:self.y}, snapped, {type:'move',mode:'any'}):false;
    if(hit){
      const safe=this._findSafePosition(self,snapped,maxPx);
      if(safe){await self.update({x:safe.x,y:safe.y});return`${selfToken.name} falls back cautiously.`;}
      return`${selfToken.name} holds position.`;
    }
    await self.update({x:snapped.x,y:snapped.y});
    return`${selfToken.name} retreats from the fray.`;
  }

  static _findFlankPosition(self,target){
    const allies=canvas?.tokens?.placeables?.filter(t=>t.id!==self.id&&t.actor?.type==='npc');
    if(!allies?.length)return null;
    let nearest=null,minD=Infinity;
    for(const a of allies){
      const d=Math.hypot((a.document?.x||a.x)-target.x,(a.document?.y||a.y)-target.y);
      if(d<minD){minD=d;nearest=a;}
    }
    if(!nearest)return null;
    const ax=nearest.document?.x||nearest.x, ay=nearest.document?.y||nearest.y;
    return{x:target.x+(target.x-ax), y:target.y+(target.y-ay)};
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
    await ChatMessage.create({user:game.userId,speaker:ChatMessage.getSpeaker({actor}),content:`<p>${content}</p>`,type:CONST.CHAT_MESSAGE_TYPES.OTHER,whisper:opts.whisper?[game.userId]:[]});
  }
  static _log(m){console.log(`%c[NPC Autopilot] ${m}`,'color:#8b5cf6;font-weight:bold');}
  static _wait(ms){return new Promise(r=>setTimeout(r,ms));}
}

globalThis.NpcAutopilot=NpcAutopilot;
