const MODULE_ID = 'ai-companion';

/* ═══════════════════════════════════════════════════════════════════
   NPC AUTOPILOT v3.1 — Foundry VTT D&D 5e
   ═══════════════════════════════════════════════════════════════════ */

/* ─── Settings ──────────────────────────────────────────────────── */
Hooks.on('init', () => {
  game.settings.register(MODULE_ID, 'hudOpen',      { scope:'client', config:false, type:Boolean, default:false });
  game.settings.register(MODULE_ID, 'hudPosition',  { scope:'client', config:false, type:Object,  default:{top:80, right:10} });
  game.settings.register(MODULE_ID, 'hudSize',      { scope:'client', config:false, type:Object,  default:{width:360, height:520} });

  game.settings.register(MODULE_ID, 'npcAutopilot', { scope:'world', config:true, type:Boolean, default:false, name:'NPC Autopilot', hint:'AI automatically plays NPC turns in combat.' });
  game.settings.register(MODULE_ID, 'autoAdvance',  { scope:'world', config:true, type:Boolean, default:true,  name:'Auto-Advance Combat', hint:'Automatically end NPC turn and advance after autopilot action.' });
  game.settings.register(MODULE_ID, 'npcMovement',  { scope:'world', config:true, type:Boolean, default:true,  name:'NPC Movement', hint:'NPCs move within weapon range before attacking.' });
});

Hooks.on('ready', () => {
  if (game.settings.get(MODULE_ID, 'hudOpen')) NpcAutopilot.open();
});

Hooks.on('renderTokenHUD', (hud, html) => {
  const $html = html instanceof HTMLElement ? $(html) : html;
  let target = $html.find('.col.left');  if (!target.length) target = $html;
  target.append($('<div class="control-icon" title="NPC Autopilot"><i class="fas fa-robot"></i></div>')
    .on('click', () => NpcAutopilot.open()));
});

Hooks.on('updateCombat', (combat, changed) => {
  if (!game.settings.get(MODULE_ID, 'npcAutopilot')) return;
  if (!combat?.started || !game.user.isGM) return;
  if (changed.turn === undefined && changed.round === undefined) return;
  const c = combat.combatant;
  if (c?.token?.actor && !c.token.actor.hasPlayerOwner) {
    NpcAutopilot.takeTurn(c.token.actor, c.token);
  }
});

/* ═══════════════════════════════════════════════════════════════════
   MAIN CLASS
   ═══════════════════════════════════════════════════════════════════ */
class NpcAutopilot {
  static _busy = false;

  /* ── Panel ─────────────────────────────────────────────────────── */
  static async open() {
    let $el = $('#npc-ap-panel');
    if (!$el.length) {
      const pos = (await game.settings.get(MODULE_ID, 'hudPosition'));
      const sz  = (await game.settings.get(MODULE_ID, 'hudSize'));
      $('body').append(` <div id="npc-ap-panel" style="top:${pos.top}px;right:${pos.right}px;width:${sz.width}px;height:${sz.height}px;"> <div class="npc-ap-header"><span><i class="fas fa-robot"></i> NPC Autopilot</span><div class="npc-ap-actions"><i class="fas fa-sync" data-action="refresh"></i><i class="fas fa-times" data-action="close"></i></div></div> <div class="npc-ap-scroll"></div><div class="npc-ap-resize"></div></div>`);
      $el = $('#npc-ap-panel');
      this._bindDrag('#npc-ap-panel'); this._bindResize('#npc-ap-panel');
      $(document).off('click.npcd').on('click.npcd', '#npc-ap-panel [data-action]', function() {
        const a = $(this).data('action'); if (a==='close') NpcAutopilot.close(); if (a==='refresh') NpcAutopilot._renderPanel();
      });
      $(document).off('click.npcap').on('click.npcap', '[data-ap-action]', function() {
        const a = $(this).data('ap-action');
        if (a==='toggle-ap') { game.settings.set(MODULE_ID, 'npcAutopilot', !game.settings.get(MODULE_ID, 'npcAutopilot')); NpcAutopilot._renderPanel(); }
        if (a==='manual-turn') { const c=game.combat?.combatant; if(c?.token?.actor) NpcAutopilot.takeTurn(c.token.actor,c.token); }
      });
    }
    await game.settings.set(MODULE_ID, 'hudOpen', true);
    $el.show(); this._renderPanel();
  }
  static async close() { $('#npc-ap-panel').hide(); await game.settings.set(MODULE_ID, 'hudOpen', false); }

  static _bindDrag(sel) { /* simplified */ const $el=$(sel); let d=false,sx,sy,sl,st; $el.find('.npc-ap-header').on('mousedown.npcd',e=>{if(e.target.closest('.npc-ap-actions'))return;d=true;sx=e.clientX;sy=e.clientY;const o=$el.offset();sl=o.left;st=o.top;e.preventDefault();}); const onMove=e=>{if(d)$el.css({left:Math.max(0,sl+e.clientX-sx),top:Math.max(0,st+e.clientY-sy),right:'auto'});}; const onUp=()=>{if(d){const o=$el.offset();game.settings.set(MODULE_ID,'hudPosition',{top:Math.round(o.top),left:Math.round(o.left)});}d=false;}; $(document).off('mousemove.npcd mouseup.npcd').on('mousemove.npcd',onMove).on('mouseup.npcd',onUp);}
  static _bindResize(sel) { const $el=$(sel); let r=false,sx,sy,sw,sh; $el.find('.npc-ap-resize').on('mousedown.npcr',e=>{r=true;sx=e.clientX;sy=e.clientY;sw=$el.outerWidth();sh=$el.outerHeight();e.preventDefault();}); const onMove=e=>{if(r)$el.css({width:Math.max(280,sw+e.clientX-sx),height:Math.max(280,sh+e.clientY-sy)});}; const onUp=()=>{if(r)game.settings.set(MODULE_ID,'hudSize',{width:Math.round($el.outerWidth()),height:Math.round($el.outerHeight())});r=false;}; $(document).off('mousemove.npcr mouseup.npcr').on('mousemove.npcr',onMove).on('mouseup.npcr',onUp);}

  static _renderPanel() {
    const $sc = $('#npc-ap-panel .npc-ap-scroll'); if (!$sc.length) return;
    const on = game.settings.get(MODULE_ID, 'npcAutopilot');
    const combat = game.combat; const active=combat?.started;
    const cur = combat?.combatant; const ct=cur?.token; const ca=ct?.actor; const isNPC=ca&&!ca.hasPlayerOwner;
    let html = `<div class="npc-ap-status-row">
      <span class="npc-ap-toggle ${on?'on':'off'}" data-ap-action="toggle-ap"><i class="fas fa-power-off"></i> ${on?'ON':'OFF'}</span>
      <span class="npc-ap-combat-status">${active?'🎲 Round '+(combat.round||1)+', Turn '+((combat.turn||0)+1):'No combat'}</span></div>`;
    if (ct) { const hp=ca?.system?.attributes?.hp||{}; const p=Math.round((hp.value||0)/(hp.max||1)*100); const c=p>50?'#4ade80':p>25?'#facc15':'#f87171';
      html+=`<div class="npc-ap-card"><img src="${ct.texture?.src||ca?.img||'icons/svg/mystery-man.svg'}">
        <div class="npc-ap-info"><div class="npc-ap-name">${ct.name||ca?.name||'?'}</div>
        <div class="npc-ap-meta">${isNPC?'NPC':'Player'} | HP <span style="color:${c};font-weight:700">${hp.value||0}/${hp.max||'?'}</span> (${p}%)</div>
        <div class="npc-ap-hpbar"><div style="width:${p}%;background:${c}"></div></div></div>
        ${isNPC&&on?'<div class="npc-ap-badge">🤖 AI</div>':''}</div>`; }
    if (active) { const npcs=combat.combatants.filter(c=>c.token?.actor&&!c.token.actor.hasPlayerOwner); if (npcs.length) {
      html+=`<div class="npc-ap-list"><div class="npc-ap-section">NPCs (${npcs.length})</div>`;
      for (const c of npcs) { const a=c.token?.actor; const h=a?.system?.attributes?.hp||{}; const p=Math.round((h.value||0)/(h.max||1)*100); const col=p>50?'#4ade80':p>25?'#facc15':'#f87171';
        html+=`<div class="npc-ap-item ${c.token?.id===ct?.id?'current':''}"><img src="${c.token?.texture?.src||a?.img||'icons/svg/mystery-man.svg'}"><div class="npc-ap-item-name">${c.name}</div><div class="npc-ap-item-hpbar"><div style="width:${p}%;background:${col}"></div></div><div class="npc-ap-item-hp" style="color:${col}">${p}%</div></div>`; }
      html+=`</div>`; }}
    html+=`<div class="npc-ap-controls">${isNPC&&active?`<button class="npc-ap-btn" data-ap-action="manual-turn"><i class="fas fa-play"></i> Take Turn for ${ct.name}</button>`:''}</div>`;
    $sc.html(html);
  }

  /* ═══════════════════════════════════════════════════════════════════
     TAKE TURN — entry point
     ═══════════════════════════════════════════════════════════════════ */
  static async takeTurn(actor, tokenDoc) {
    if (this._busy) return;
    this._busy = true;
    try {
      const enemies = this._findEnemies(actor, tokenDoc);
      const allies  = this._findAllies (actor, tokenDoc);
      const hpPct = this._getHPPct(actor);
      const state = { actor, tokenDoc, enemies, allies, hpPct };

      this._log(`${actor.name} turn start — ${enemies.length} enemies, ${allies.length} allies, HP ${Math.round(hpPct*100)}%`);

      // ── Movement ──
      if (game.settings.get(MODULE_ID, 'npcMovement') && tokenDoc) {
        let moveLog = '';
        if (hpPct < 0.2 && enemies.length >= 2) {
          moveLog = await this._npcRetreat(tokenDoc, enemies);
        } else if (enemies.length) {
          const targetActor = this._pickTarget(enemies);
          const targetToken = targetActor?.getActiveTokens?.()[0];
          const weapon = this._bestWeapon(actor);
          if (targetToken && weapon) moveLog = await this._npcMoveToTarget(tokenDoc, targetToken, weapon);
        }
        if (moveLog) { await this._say(`🏃 ${moveLog}`, actor); await this._wait(400); }
      }

      // ── Action ──
      await this._chooseAndExecute(state);

      // ── Advance turn ──
      if (game.settings.get(MODULE_ID, 'autoAdvance') && game.combat?.combatant?.token?.id===tokenDoc?.id) {
        setTimeout(() => game.combat?.nextTurn?.(), 800);
      }
      this._renderPanel();
    } catch (err) {
      console.error('[NPC Autopilot] turn error:', err);
      await this._say(`⚠️ ${err.message}`, actor, {whisper:true});
    } finally {
      this._busy = false;
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     TACTICAL DECISION ENGINE
     ═══════════════════════════════════════════════════════════════════ */
  static async _chooseAndExecute(state) {
    const { actor, enemies, allies, hpPct } = state;
    let plan = null;

    // 1. Self-heal if critical
    const heal = this._findSpell(actor, /cure wounds|healing word|aid/i);
    const woundedAlly = allies.find(a => this._getHPPct(a) < 0.3);
    if (hpPct < 0.25 && heal) plan = { type:'spell', item:heal, target:actor, desc:`casts ${heal.name} on self` };
    else if (woundedAlly && heal && hpPct > 0.4) plan = { type:'spell', item:heal, target:woundedAlly, desc:`casts ${heal.name} on ${woundedAlly.name}` };

    // 2. Buff / debuff
    if (!plan) {
      const buff = this._findSpell(actor, /haste|bless|shield of faith|bane|faerie fire|web|hold person|sleep|entangle|faerie/i);
      if (buff && hpPct > 0.3) plan = { type:'spell', item:buff, target:enemies[0]||actor, desc:`casts ${buff.name}` };
    }

    // 3. Multiattack / breath / special feature
    if (!plan) {
      const multi = this._findFeature(actor, /multiattack|extra attack/i);
      if (multi && enemies.length) plan = { type:'feature', item:multi, target:this._pickTarget(enemies), desc:`uses ${multi.name}` };
    }

    // 4. Ranged attack if in range?
    if (!plan && enemies.length) {
      const target = this._pickTarget(enemies);
      const weapon = this._bestWeapon(actor, 'ranged');
      if (weapon) plan = { type:'attack', item:weapon, target, desc:`attacks ${target.name} with ${weapon.name}` };
    }

    // 5. Melee attack (fallback)
    if (!plan && enemies.length) {
      const target = this._pickTarget(enemies);
      const weapon = this._bestWeapon(actor, 'melee') || this._bestWeapon(actor);
      if (weapon) plan = { type:'attack', item:weapon, target, desc:`attacks ${target.name} with ${weapon.name}` };
    }

    // 6. Dodge if nothing else
    if (!plan && hpPct < 0.25) plan = { type:'dodge', desc:'takes the Dodge action' };

    // Execute
    if (!plan) {
      await this._say(`🎲 **${actor.name}** takes no action.`, actor);
      return;
    }

    if (plan.type === 'spell') await this._useItem(actor, plan.item, plan.target);
    else if (plan.type === 'feature') await this._useItem(actor, plan.item, plan.target);
    else if (plan.type === 'attack') await this._npcAttack(actor, plan.item, plan.target);
    else if (plan.type === 'dodge') await this._say(`🛡️ ${actor.name} takes the **Dodge** action.`, actor);
  }

  /* ═══════════════════════════════════════════════════════════════════
     ACTIONS — roll an item with proper targeting
     ═══════════════════════════════════════════════════════════════════ */
  static async _npcAttack(actor, item, target) {
    if (!item) return this._say(`⚠️ ${actor.name} has no weapon.`, actor);
    const targetToken = this._getTargetToken(target);
    const oldTargets = new Set(game.user.targets);

    try {
      // Temporarily target the PC so the dnd5e system sees it
      if (targetToken?.document) {
        game.user.targets.clear();
        game.user.targets.add(targetToken.document);
      }

      // ── dnd5e v4+ Activities ──
      const acts = item.system?.activities;
      const activity = this._firstActivity(acts);
      if (activity && typeof activity.use === 'function') {
        await activity.use({ configure:false, createMessage:true });
        return;
      }

      // ── dnd5e v3 item.use ──
      if (typeof item.use === 'function') {
        await item.use();
        return;
      }

      // ── Legacy rollAttack / rollDamage ──
      if (typeof item.rollAttack === 'function') {
        await item.rollAttack({ event: null, targetActors: target ? [target] : [] });
        return;
      }

      // ── Fallback manual roll ──
      const bonus = this._getAtkBonus(actor, item);
      const roll = await new Roll(`1d20 + ${bonus}`).evaluate();
      const flavor = `${actor.name} attacks ${target?.name||'target'} with ${item.name}`;
      await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor });
    } catch (e) {
      console.warn('[NPC Autopilot] attack error:', e);
      await this._say(`⚠️ ${actor.name}'s ${item.name} attack failed: ${e.message}`, actor, {whisper:true});
    } finally {
      // restore targets
      game.user.targets.clear();
      for (const t of oldTargets) game.user.targets.add(t);
    }
  }

  static async _useItem(actor, item, target) {
    if (!item) return;
    const targetToken = this._getTargetToken(target);
    const oldTargets = new Set(game.user.targets);

    try {
      if (targetToken?.document) {
        game.user.targets.clear();
        game.user.targets.add(targetToken.document);
      }

      const acts = item.system?.activities;
      const activity = this._firstActivity(acts);
      if (activity && typeof activity.use === 'function') {
        await activity.use({ configure:false, createMessage:true });
        return;
      }

      if (typeof item.use === 'function') {
        await item.use();
        return;
      }

      if (typeof item.rollAttack === 'function') {
        await item.rollAttack({ event: null });
        return;
      }

      // Final fallback: just create a chat card
      await this._say(`🔥 **${actor.name}** uses **${item.name}** on **${target?.name||'target'}**!`, actor);
    } catch (e) {
      console.warn('[NPC Autopilot] useItem error:', e);
      await this._say(`⚠️ ${actor.name} could not use ${item.name}: ${e.message}`, actor, {whisper:true});
    } finally {
      game.user.targets.clear();
      for (const t of oldTargets) game.user.targets.add(t);
    }
  }

  static async _npcCastSpell(actor, spell, target) {
    return this._useItem(actor, spell, target);
  }

  /* ── dnd5e v3/v4 activity detector ── */
  static _firstActivity(activities) {
    if (!activities) return null;
    // v4: Map-like collection
    if (typeof activities.get === 'function') {
      if (typeof activities.values === 'function') {
        const first = activities.values().next().value;
        if (first) return first;
      }
      const keys = activities.keys ? Array.from(activities.keys()) : Object.keys(activities);
      if (keys.length) return activities.get(keys[0]);
    }
    // v3: Collection with .contents
    if (Array.isArray(activities?.contents)) return activities.contents[0];
    // Raw object
    if (typeof activities === 'object') {
      const vals = Object.values(activities).filter(v => v && typeof v.use === 'function');
      if (vals.length) return vals[0];
    }
    return null;
  }

  /* ── Best weapon / item selector ── */
  static _bestWeapon(actor, preference) {
    const items = actor.items?.contents || [];
    let candidates = items.filter(i => ['weapon','equipment'].includes(i.type));
    if (!candidates.length) candidates = items.filter(i => i.type==='feat' && /attack|hit|damage|strike|claw|bite|tail|tentacle|slam/i.test(i.name));
    if (!candidates.length) candidates = items.filter(i => i.type==='feat');
    if (preference === 'ranged') return candidates.find(w => this._getWeaponRange(w) > 15) || candidates[0];
    if (preference === 'melee')  return candidates.find(w => this._getWeaponRange(w) <= 10) || candidates[0];
    return candidates[0];
  }

  static _findSpell(actor, regex) {
    return (actor.items?.contents||[]).find(i => i.type==='spell' && regex.test(i.name));
  }
  static _findFeature(actor, regex) {
    return (actor.items?.contents||[]).find(i => i.type==='feat' && regex.test(i.name));
  }

  static _pickTarget(enemies) {
    if (!enemies.length) return null;
    return enemies.slice().sort((a,b) => {
      const ha=a.system?.attributes?.hp||{}, hb=b.system?.attributes?.hp||{};
      return (ha.value||0)-(hb.value||0);
    })[0];
  }

  static _getTargetToken(targetActor) {
    if (!targetActor) return null;
    const tokens = targetActor.getActiveTokens?.();
    return tokens?.[0] || null;
  }

  /* ═══════════════════════════════════════════════════════════════════
     MOVEMENT
     ═══════════════════════════════════════════════════════════════════ */
  static async _npcMoveToTarget(selfToken, targetToken, weapon) {
    if (!selfToken || !targetToken || !canvas?.grid) return '';
    const self   = selfToken.document || selfToken;
    const target = targetToken.document || targetToken;
    const range  = this._getWeaponRange(weapon);
    const gridDist = canvas.grid.distance || 5;
    const rangePx  = (range / gridDist) * canvas.grid.size;
    const rangeSq  = rangePx * rangePx;

    const dx=self.x-target.x, dy=self.y-target.y;
    if (dx*dx+dy*dy <= rangeSq) return '';

    const speed = selfToken.actor?.system?.attributes?.movement?.walk || 30;
    const maxPx = (speed / gridDist) * canvas.grid.size;

    let dest = this._findFlankPosition(self, target);
    if (!dest) {
      const angle = Math.atan2(target.y-self.y, target.x-self.x);
      const total = Math.hypot(dx,dy);
      const moveDist = Math.min(maxPx, total - Math.sqrt(rangeSq)*0.8);
      if (moveDist <= 0) return '';
      dest = { x:self.x+Math.cos(angle)*moveDist, y:self.y+Math.sin(angle)*moveDist };
    }

    const snapped = canvas.grid.getSnappedPoint
      ? canvas.grid.getSnappedPoint({x:dest.x,y:dest.y}, {mode:CONST.GRID_SNAPPING_MODES.CENTER})
      : dest;

    const hitWall = CONFIG.Canvas.polygonBackends?.move?.testCollision
      ? CONFIG.Canvas.polygonBackends.move.testCollision({x:self.x,y:self.y}, snapped, {type:'move', mode:'any'})
      : false;

    if (hitWall) {
      const safe = this._findSafePosition(self, snapped, maxPx);
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
    const maxPx = (speed / gridDist) * canvas.grid.size;

    let ex=0, ey=0, count=0;
    for (const e of enemies) {
      const t = e?.getActiveTokens?.()[0];
      if (t) { ex+=(t.document?.x||t.x); ey+=(t.document?.y||t.y); count++; }
    }
    if (!count) return '';
    ex/=count; ey/=count;

    const angle = Math.atan2(self.y-ey, self.x-ex);
    const dest = { x:self.x+Math.cos(angle)*maxPx, y:self.y+Math.sin(angle)*maxPx };
    const snapped = canvas.grid.getSnappedPoint
      ? canvas.grid.getSnappedPoint({x:dest.x,y:dest.y}, {mode:CONST.GRID_SNAPPING_MODES.CENTER})
      : dest;

    const hitWall = CONFIG.Canvas.polygonBackends?.move?.testCollision
      ? CONFIG.Canvas.polygonBackends.move.testCollision({x:self.x,y:self.y}, snapped, {type:'move', mode:'any'})
      : false;

    if (hitWall) {
      const safe = this._findSafePosition(self, snapped, maxPx);
      if (safe) { await self.update({x:safe.x,y:safe.y}); return `${selfToken.name} falls back cautiously.`; }
      return `${selfToken.name} holds position.`;
    }
    await self.update({x:snapped.x,y:snapped.y});
    return `${selfToken.name} retreats from the fray.`;
  }

  static _findFlankPosition(self, target) {
    const allies = canvas?.tokens?.placeables?.filter(t=>t.id!==self.id && !t.actor?.hasPlayerOwner);
    if (!allies?.length) return null;
    let nearest=null, minD=Infinity;
    for (const a of allies) {
      const d = Math.hypot((a.document?.x||a.x)-target.x, (a.document?.y||a.y)-target.y);
      if (d<minD) { minD=d; nearest=a; }
    }
    if (!nearest) return null;
    const ax=nearest.document?.x||nearest.x, ay=nearest.document?.y||nearest.y;
    return { x:target.x+(target.x-ax), y:target.y+(target.y-ay) };
  }

  static _findSafePosition(self, targetDest, maxDist) {
    const steps=20;
    const dx=targetDest.x-self.x, dy=targetDest.y-self.y;
    const dist=Math.hypot(dx,dy)||1;
    for (let i=steps; i>=1; i--) {
      const f=(i/steps)*Math.min(1, maxDist/dist);
      const px=self.x+dx*f, py=self.y+dy*f;
      const hit = CONFIG.Canvas.polygonBackends?.move?.testCollision
        ? CONFIG.Canvas.polygonBackends.move.testCollision({x:self.x,y:self.y}, {x:px,y:py}, {type:'move', mode:'any'})
        : false;
      if (!hit) return {x:px,y:py};
    }
    return null;
  }

  static _getWeaponRange(weapon) {
    if (!weapon) return 5;
    const sys = weapon.system || {};
    if (sys.range?.value) return parseInt(sys.range.value) || 5;
    const props = sys.properties || [];
    if (props.includes?.('rch')||sys.properties?.rch) return 10;
    if (props.includes?.('thr')||sys.properties?.thr) return sys.range?.long||60;
    // Detect natural weapons (claw, bite etc typically 5 ft)
    return 5;
  }

  /* ═══════════════════════════════════════════════════════════════════
     HELPERS
     ═══════════════════════════════════════════════════════════════════ */
  static _findEnemies(actor, selfToken) {
    return canvas?.tokens?.placeables
      ?.filter(t=>t.actor && t.actor.hasPlayerOwner && t.id!==selfToken?.id)
      ?.map(t=>t.actor) || [];
  }
  static _findAllies(actor, selfToken) {
    return canvas?.tokens?.placeables
      ?.filter(t=>t.actor && !t.actor.hasPlayerOwner && t.id!==selfToken?.id)
      ?.map(t=>t.actor) || [];
  }
  static _getHPPct(actor) {
    const hp=actor?.system?.attributes?.hp||{};
    return (hp.value||0)/(hp.max||1);
  }
  static _getAtkBonus(actor, item) {
    const sys=item?.system||{};
    const ability=sys.ability||actor?.system?.attributes?.attackBonus||'str';
    const mod=actor?.system?.abilities?.[ability]?.mod||0;
    const prof=sys.prof?.multiplier?(actor?.system?.attributes?.prof||0):0;
    return mod+prof;
  }
  static async _say(content, actor, {whisper=false}={}) {
    await ChatMessage.create({
      user: game.userId,
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<p>${content}</p>`,
      type: CONST.CHAT_MESSAGE_TYPES.OTHER,
      whisper: whisper ? [game.userId] : []
    });
  }
  static _log(msg) { console.log(`%c[NPC Autopilot] ${msg}`, 'color:#8b5cf6;font-weight:bold'); }
  static _wait(ms) { return new Promise(r=>setTimeout(r,ms)); }
}

globalThis.NpcAutopilot = NpcAutopilot;
