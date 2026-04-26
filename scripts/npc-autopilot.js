const MODULE_ID = 'ai-companion';

/* ═══════════════════════════════════════════════════════════════════
   NPC AUTOPILOT v3.2 — Foundry VTT D&D 5e
   Full-turn automation with per-NPC toggles.
   ═══════════════════════════════════════════════════════════════════ */

/* ─── Settings ──────────────────────────────────────────────────── */
Hooks.on('init', () => {
  game.settings.register(MODULE_ID, 'hudOpen',      { scope:'client', config:false, type:Boolean, default:false });
  game.settings.register(MODULE_ID, 'hudPosition',  { scope:'client', config:false, type:Object,  default:{top:80, right:10} });
  game.settings.register(MODULE_ID, 'hudSize',      { scope:'client', config:false, type:Object,  default:{width:380, height:560} });

  game.settings.register(MODULE_ID, 'npcAutopilot', { scope:'world', config:true, type:Boolean, default:false, name:'NPC Autopilot Master Switch', hint:'Global on/off. Individual NPCs can still be toggled separately.' });
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
    .on('click', ()=>NpcAutopilot.open()));
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

  /* ── Is autopilot enabled for this actor? ────────────────────── */
  static isEnabled(actor) {
    const perActor = actor.getFlag(MODULE_ID, 'autopilot');
    if (perActor === false) return false;
    if (perActor === true)  return true;
    return game.settings.get(MODULE_ID, 'npcAutopilot'); // fallback to global
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
     TAKE TURN — orchestrates movement then full action economy
     ═══════════════════════════════════════════════════════════════════ */
  static async takeTurn(actor, tokenDoc) {
    if(this._busy)return; this._busy=true;
    try{
      const enemies=this._findEnemies(actor,tokenDoc);
      const allies =this._findAllies (actor,tokenDoc);
      const hpPct=this._getHPPct(actor);
      this._log(`${actor.name} turn — ${enemies.length} enemies, HP ${Math.round(hpPct*100)}%`);

      // ── Move ──
      if(game.settings.get(MODULE_ID,'npcMovement')&&tokenDoc){
        let move='';
        if(hpPct<0.2&&enemies.length>=2) move=await this._npcRetreat(tokenDoc,enemies);
        else if(enemies.length){
          const tActor=this._pickTarget(enemies);
          const tToken=tActor?.getActiveTokens?.()[0];
          const weapon=this._bestWeapon(actor);
          if(tToken&&weapon) move=await this._npcMoveToTarget(tokenDoc,tToken,weapon);
        }
        if(move){await this._say(`🏃 ${move}`,actor); await this._wait(400);}
      }

      // ── Full action economy ──
      await this._executeFullTurn(actor, tokenDoc, enemies, allies, hpPct);

      // ── Advance ──
      if(game.settings.get(MODULE_ID,'autoAdvance')&&game.combat?.combatant?.token?.id===tokenDoc?.id){
        setTimeout(()=>game.combat?.nextTurn?.(),800);
      }
      this._renderPanel();
    }catch(err){console.error('[NPC Autopilot]',err); await this._say(`⚠️ ${err.message}`,actor,{whisper:true});}
    finally{this._busy=false;}
  }

  /* ═══════════════════════════════════════════════════════════════════
     FULL TURN — heals, attacks (multiattack, all weapons), spells, dodge
     ═══════════════════════════════════════════════════════════════════ */
  static async _executeFullTurn(actor, tokenDoc, enemies, allies, hpPct) {
    const items = actor.items?.contents || [];

    // ── Bonus Action: heal self if critical ──
    if(hpPct<0.3){
      const baHeal=this._findSpell(actor,/(healing word|mass healing word|cure wounds)/i);
      if(baHeal){ await this._useItem(actor,baHeal,actor); await this._wait(600); }
    }

    // ── Action: multiattack or best weapon ──
    const didMulti=await this._doMultiattack(actor,enemies,items);
    if(!didMulti && enemies.length){
      const weapon=this._bestWeapon(actor);
      if(weapon){ await this._npcAttack(actor,weapon,this._pickTarget(enemies)); await this._wait(600); }
    }

    // ── Bonus Action: off-hand attack ──
    const offHand=this._bestWeapon(actor,'offhand');
    if(offHand && enemies.length){
      await this._npcAttack(actor,offHand,this._pickTarget(enemies));
      await this._wait(600);
    }

    // ── Fallback dodge if nothing happened and wounded ──
    if(!didMulti && hpPct<0.25){
      await this._say(`🛡️ ${actor.name} takes the **Dodge** action.`,actor);
    }
  }

  /* ── Multiattack: parse feat description and roll ALL attacks ── */
  static async _doMultiattack(actor, enemies, items) {
    const multi=items.find(i=>i.type==='feat'&&/multiattack/i.test(i.name));
    if(!multi) return false;
    const desc=(multi.system?.description?.value||'').toLowerCase();
    this._log(`Multiattack: ${multi.name} — "${desc.slice(0,80)}"`);

    // Build a map of item name -> item for quick lookup
    const itemMap={};
    for(const it of items){ itemMap[it.name.toLowerCase()]=it; }

    // Extract attack lines: "one with its scimitar", "two claw attacks", etc.
    const attacks=[];
    const rx=/\b(one|two|three|four|five|\d+)\b[\s\w]*\b(with\s+(?:its\s+)?)?([\w\s]+?)\b(?:attacks?|strike|bite|claw|slam|tentacle|tail|horn|gore)/gi;
    let m;
    while((m=rx.exec(desc))!==null){
      const rawCount=m[1]; const rawName=m[3]?.trim();
      const count=this._wordToNum(rawCount);
      // Find matching item by name or partial match
      let matched=null;
      const rl=rawName.toLowerCase();
      if(itemMap[rl]) matched=itemMap[rl];
      else { for(const [n,it] of Object.entries(itemMap)){ if(n.includes(rl)||rl.includes(n)){ matched=it; break; }} }
      if(matched) for(let i=0;i<count;i++) attacks.push(matched);
    }

    // Fallback: if description just mentions weapon names without "X attacks" pattern
    if(!attacks.length){
      for(const it of items){
        if(it.type==='feat'&&/multiattack/i.test(it.name)) continue;
        const n=it.name.toLowerCase();
        if(desc.includes(n) && this._hasAttackActivity(it)){ attacks.push(it); }
      }
    }

    if(!attacks.length) return false;

    // Roll each attack against the weakest enemy
    for(const weapon of attacks){
      const target=this._pickTarget(enemies);
      await this._npcAttack(actor,weapon,target);
      await this._wait(700);
    }
    return true;
  }

  static _wordToNum(w){ const map={one:1,two:2,three:3,four:4,five:5}; const n=parseInt(w); return isNaN(n)?(map[w?.toLowerCase()]||1):n; }
  static _hasAttackActivity(item){ return !!this._attackActivity(item); }

  /* ═══════════════════════════════════════════════════════════════════
     ATTACK SPELL FEATURE — roll with proper targeting
     ═══════════════════════════════════════════════════════════════════ */
  static async _npcAttack(actor, item, target) {
    if(!item){ await this._say(`⚠️ ${actor.name} has no weapon.`,actor,{whisper:true}); return; }
    const targetToken=this._getTargetToken(target);
    const oldTargets=new Set(game.user.targets);

    try{
      if(targetToken?.document){ game.user.targets.clear(); game.user.targets.add(targetToken.document); }

      // 1. dnd5e v4 activity
      const acts=item.system?.activities;
      const activity=this._attackActivity(item);
      if(activity&&typeof activity.use==='function'){
        await activity.use({configure:false, createMessage:true});
        return;
      }
      // 2. v3 item.use()
      if(typeof item.use==='function'){ await item.use(); return; }
      // 3. Legacy rollAttack
      if(typeof item.rollAttack==='function'){ await item.rollAttack({event:null}); return; }
      // 4. Fallback manual
      const bonus=this._getAtkBonus(actor,item);
      const roll=await new Roll(`1d20+${bonus}`).evaluate();
      await roll.toMessage({speaker:ChatMessage.getSpeaker({actor}),flavor:`${actor.name} attacks ${target?.name||'target'} with ${item.name}`});
    }catch(e){
      console.warn('[NPC Autopilot] attack error',e);
      await this._say(`⚠️ ${item.name} failed: ${e.message}`,actor,{whisper:true});
    }finally{
      game.user.targets.clear(); for(const t of oldTargets) game.user.targets.add(t);
    }
  }

  static async _useItem(actor, item, target) {
    if(!item)return;
    const targetToken=this._getTargetToken(target);
    const oldTargets=new Set(game.user.targets);
    try{
      if(targetToken?.document){ game.user.targets.clear(); game.user.targets.add(targetToken.document); }
      const activity=this._firstActivity(item);
      if(activity&&typeof activity.use==='function'){
        await activity.use({configure:false, createMessage:true}); return;
      }
      if(typeof item.use==='function'){ await item.use(); return; }
      if(typeof item.rollAttack==='function'){ await item.rollAttack({event:null}); return; }
      await this._say(`🔥 **${actor.name}** uses **${item.name}** on **${target?.name||'target'}**!`,actor);
    }catch(e){
      console.warn('[NPC Autopilot] useItem error',e);
    }finally{
      game.user.targets.clear(); for(const t of oldTargets) game.user.targets.add(t);
    }
  }

  /* ── Activity extractors ── */
  static _allActivities(item){
    const a=item.system?.activities; if(!a) return[];
    const out=[];
    if(typeof a.values==='function'){ for(const v of a.values()) out.push(v); }
    else if(typeof a.forEach==='function'){ a.forEach(v=>out.push(v)); }
    else if(Array.isArray(a?.contents)) out.push(...a.contents.filter(Boolean));
    else out.push(...Object.values(a).filter(v=>v&&v instanceof foundry.dnd5e?.documents?.activity?.Activity || v?.constructor?.name?.includes('Activity')));
    return out;
  }
  static _firstActivity(item){ return this._allActivities(item)[0]||null; }
  static _attackActivity(item){
    const acts=this._allActivities(item);
    // Prefer activities explicitly named/typed as attack
    return acts.find(a=>a.type==='attack'||a.constructor?.name?.includes('Attack')||/attack|strike|damage|hit/i.test(a.name))
      ||acts.find(a=>typeof a.use==='function') // any usable as last resort
      ||null;
  }

  /* ── Selectors ── */
  static _bestWeapon(actor, pref){
    const items=actor.items?.contents||[];
    // Multiattack features are handled separately, skip here
    let cands=items.filter(i=>['weapon','equipment'].includes(i.type)&&this._hasAttackActivity(i));
    if(!cands.length) cands=items.filter(i=>i.type==='feat'&&!/multiattack/i.test(i.name)&&this._hasAttackActivity(i)
      &&/attack|hit|strike|claw|bite|tail|slam|tentacle|horn|gore|punch|kick|stab/i.test(i.name));
    if(!cands.length) return items.find(i=>i.type==='weapon')||items.find(i=>i.type==='feat'&&this._hasAttackActivity(i));
    if(pref==='ranged') return cands.find(w=>this._getWeaponRange(w)>15)||cands[0];
    if(pref==='offhand'){
      const main=this._bestWeapon(actor);
      return cands.find(w=>w.id!==main?.id&&this._getWeaponRange(w)<=10)||cands[0];
    }
    return cands[0];
  }
  static _findSpell(actor,rx){ return(actor.items?.contents||[]).find(i=>i.type==='spell'&&rx.test(i.name)); }
  static _pickTarget(enemies){
    if(!enemies.length)return null;
    return enemies.slice().sort((a,b)=>{
      const ha=a.system?.attributes?.hp||{},hb=b.system?.attributes?.hp||{};
      return(ha.value||0)-(hb.value||0);
    })[0];
  }
  static _getTargetToken(actor){ const t=actor?.getActiveTokens?.(); return t?.[0]||null; }

  /* ═══════════════════════════════════════════════════════════════════
    MOVEMENT
    ═══════════════════════════════════════════════════════════════════ */
  static async _npcMoveToTarget(selfToken,targetToken,weapon){
    if(!selfToken||!targetToken||!canvas?.grid) return'';
    const self=selfToken.document||selfToken;
    const target=targetToken.document||targetToken;
    const range=this._getWeaponRange(weapon);
    const gridDist=canvas.grid.distance||5;
    const rangePx=(range/gridDist)*canvas.grid.size;
    const rangeSq=rangePx*rangePx;
    const dx=self.x-target.x,dy=self.y-target.y;
    if(dx*dx+dy*dy<=rangeSq) return'';
    const speed=selfToken.actor?.system?.attributes?.movement?.walk||30;
    const maxPx=(speed/gridDist)*canvas.grid.size;
    let dest=this._findFlankPosition(self,target);
    if(!dest){
      const angle=Math.atan2(target.y-self.y,target.x-self.x);
      const total=Math.hypot(dx,dy);
      const move=Math.min(maxPx,total-Math.sqrt(rangeSq)*0.8);
      if(move<=0)return'';
      dest={x:self.x+Math.cos(angle)*move,y:self.y+Math.sin(angle)*move};
    }
    const snapped=canvas.grid.getSnappedPoint?canvas.grid.getSnappedPoint({x:dest.x,y:dest.y},{mode:CONST.GRID_SNAPPING_MODES.CENTER}):dest;
    const hit=CONFIG.Canvas.polygonBackends?.move?.testCollision?CONFIG.Canvas.polygonBackends.move.testCollision({x:self.x,y:self.y},snapped,{type:'move',mode:'any'}):false;
    if(hit){
      const safe=this._findSafePosition(self,snapped,maxPx);
      if(safe){await self.update({x:safe.x,y:safe.y});return`${selfToken.name} manoeuvres closer.`;}
      return'';
    }
    await self.update({x:snapped.x,y:snapped.y});
    return`${selfToken.name} advances toward ${targetToken.name}.`;
  }
  static async _npcRetreat(selfToken,enemies){
    if(!selfToken||!canvas?.grid)return'';
    const self=selfToken.document||selfToken;
    const speed=selfToken.actor?.system?.attributes?.movement?.walk||30;
    const gd=canvas.grid.distance||5;
    const maxPx=(speed/gd)*canvas.grid.size;
    let ex=0,ey=0,c=0;
    for(const e of enemies){const t=e?.getActiveTokens?.()[0];if(t){ex+=(t.document?.x||t.x);ey+=(t.document?.y||t.y);c++;}}
    if(!c)return'';
    ex/=c;ey/=c;
    const angle=Math.atan2(self.y-ey,self.x-ex);
    const dest={x:self.x+Math.cos(angle)*maxPx,y:self.y+Math.sin(angle)*maxPx};
    const snapped=canvas.grid.getSnappedPoint?canvas.grid.getSnappedPoint({x:dest.x,y:dest.y},{mode:CONST.GRID_SNAPPING_MODES.CENTER}):dest;
    const hit=CONFIG.Canvas.polygonBackends?.move?.testCollision?CONFIG.Canvas.polygonBackends.move.testCollision({x:self.x,y:self.y},snapped,{type:'move',mode:'any'}):false;
    if(hit){const safe=this._findSafePosition(self,snapped,maxPx);if(safe){await self.update({x:safe.x,y:safe.y});return`${selfToken.name} falls back cautiously.`;}return`${selfToken.name} holds position.`;}
    await self.update({x:snapped.x,y:snapped.y});
    return`${selfToken.name} retreats from the fray.`;
  }
  static _findFlankPosition(self,target){
    const allies=canvas?.tokens?.placeables?.filter(t=>t.id!==self.id&&!t.actor?.hasPlayerOwner);
    if(!allies?.length)return null;
    let nearest=null,minD=Infinity;
    for(const a of allies){const d=Math.hypot((a.document?.x||a.x)-target.x,(a.document?.y||a.y)-target.y);if(d<minD){minD=d;nearest=a;}}
    if(!nearest)return null;
    const ax=nearest.document?.x||nearest.x,ay=nearest.document?.y||nearest.y;
    return{x:target.x+(target.x-ax),y:target.y+(target.y-ay)};
  }
  static _findSafePosition(self,targetDest,maxDist){
    const steps=20; const dx=targetDest.x-self.x,dy=targetDest.y-self.y; const dist=Math.hypot(dx,dy)||1;
    for(let i=steps;i>=1;i--){
      const f=(i/steps)*Math.min(1,maxDist/dist);
      const px=self.x+dx*f,py=self.y+dy*f;
      const hit=CONFIG.Canvas.polygonBackends?.move?.testCollision?CONFIG.Canvas.polygonBackends.move.testCollision({x:self.x,y:self.y},{x:px,y:py},{type:'move',mode:'any'}):false;
      if(!hit)return{x:px,y:py};
    }
    return null;
  }
  static _getWeaponRange(weapon){
    if(!weapon)return 5;const sys=weapon.system||{};
    if(sys.range?.value)return parseInt(sys.range.value)||5;
    const props=sys.properties||[];
    if(props.includes?.('rch')||sys.properties?.rch)return 10;
    if(props.includes?.('thr')||sys.properties?.thr)return sys.range?.long||60;
    return 5;
  }

  /* ═══════════════════════════════════════════════════════════════════
    HELPERS
    ═══════════════════════════════════════════════════════════════════ */
  static _findEnemies(actor,selfToken){return canvas?.tokens?.placeables?.filter(t=>t.actor&&t.actor.hasPlayerOwner&&t.id!==selfToken?.id)?.map(t=>t.actor)||[];}
  static _findAllies(actor,selfToken){return canvas?.tokens?.placeables?.filter(t=>t.actor&&!t.actor.hasPlayerOwner&&t.id!==selfToken?.id)?.map(t=>t.actor)||[];}
  static _getHPPct(actor){const hp=actor?.system?.attributes?.hp||{};return(hp.value||0)/(hp.max||1);}
  static _getAtkBonus(actor,item){const sys=item?.system||{};const ab=sys.ability||actor?.system?.attributes?.attackBonus||'str';const mod=actor?.system?.abilities?.[ab]?.mod||0;const prof=sys.prof?.multiplier?(actor?.system?.attributes?.prof||0):0;return mod+prof;}
  static async _say(content,actor,opts={}){await ChatMessage.create({user:game.userId,speaker:ChatMessage.getSpeaker({actor}),content:`<p>${content}</p>`,type:CONST.CHAT_MESSAGE_TYPES.OTHER,whisper:opts.whisper?[game.userId]:[]});}
  static _log(m){console.log(`%c[NPC Autopilot] ${m}`,'color:#8b5cf6;font-weight:bold');}
  static _wait(ms){return new Promise(r=>setTimeout(r,ms));}
}

globalThis.NpcAutopilot=NpcAutopilot;
