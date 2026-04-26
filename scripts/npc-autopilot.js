const MODULE_ID = 'ai-companion';

/* ═══════════════════════════════════════════════════════════════════
   NPC AUTOPILOT — Foundry VTT D&D 5e
   Automatically moves, attacks, and advances turns for NPCs.
   ═══════════════════════════════════════════════════════════════════ */

/* ─── Settings ──────────────────────────────────────────────────── */
Hooks.on('init', () => {
  game.settings.register(MODULE_ID, 'hudOpen',        { scope:'client', config:false, type:Boolean, default:false });
  game.settings.register(MODULE_ID, 'hudPosition',    { scope:'client', config:false, type:Object,  default:{top:80, right:10} });
  game.settings.register(MODULE_ID, 'hudSize',        { scope:'client', config:false, type:Object,  default:{width:360, height:520} });

  // World settings
  game.settings.register(MODULE_ID, 'npcAutopilot',   { scope:'world', config:true, type:Boolean, default:false, name:'NPC Autopilot', hint:'AI automatically plays NPC turns in combat.' });
  game.settings.register(MODULE_ID, 'autoAdvance',    { scope:'world', config:true, type:Boolean, default:true,  name:'Auto-Advance Combat', hint:'Automatically end NPC turn and advance after autopilot action.' });
  game.settings.register(MODULE_ID, 'npcMovement',    { scope:'world', config:true, type:Boolean, default:true,  name:'NPC Movement', hint:'NPCs move within weapon range before attacking. Disable for static NPCs.' });

  // Hidden state
  game.settings.register(MODULE_ID, 'npcBrain',       { scope:'world', config:false, type:Object, default:{} });
});

/* ─── Ready ─────────────────────────────────────────────────────── */
Hooks.on('ready', () => {
  if (game.settings.get(MODULE_ID, 'hudOpen')) NpcAutopilot.open();
});

/* ─── Token HUD button ─────────────────────────────────────────── */
Hooks.on('renderTokenHUD', (hud, html) => {
  const $html = html instanceof HTMLElement ? $(html) : html;
  let target = $html.find('.col.left');
  if (!target.length) target = $html;
  const btn = $('<div class="control-icon" title="Open NPC Autopilot"><i class="fas fa-robot"></i></div>');
  btn.on('click', () => { NpcAutopilot.open(); });
  target.append(btn);
});

/* ─── Combat turn hook ───────────────────────────────────────────── */
Hooks.on('updateCombat', (combat, changed, options, userId) => {
  if (!game.settings.get(MODULE_ID, 'npcAutopilot')) return;
  if (!combat?.started) return;
  if (!game.user.isGM) return;
  if (changed.turn === undefined && changed.round === undefined) return;

  const combatant = combat.combatant;
  if (!combatant?.token?.actor) return;
  if (combatant.token.actor.hasPlayerOwner) return;

  NpcAutopilot.takeTurn(combatant.token.actor, combatant.token);
});

/* ═══════════════════════════════════════════════════════════════════
   MAIN CLASS — Npc Autopilot
   ═══════════════════════════════════════════════════════════════════ */
class NpcAutopilot {
  static _npcTurnInProgress = false;
  static _npcCooldowns = {};
  static _lastTokenId = null;

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
    this._refreshTimer = setTimeout(() => this._renderPanel(), 50);
  }

  /* ── Open / close panel ──────────────────────────────────────── */
  static async open() {
    let $el = $('#npc-ap-panel');
    if (!$el.length) {
      const pos = await game.settings.get(MODULE_ID, 'hudPosition');
      const sz  = await game.settings.get(MODULE_ID, 'hudSize');
      $('body').append(`
        <div id="npc-ap-panel" style="top:${pos.top}px;right:${pos.right}px;width:${sz.width}px;height:${sz.height}px;">
          <div class="npc-ap-header">
            <span><i class="fas fa-robot"></i> NPC Autopilot</span>
            <div class="npc-ap-actions">
              <i class="fas fa-sync" data-action="refresh" title="Refresh"></i>
              <i class="fas fa-times" data-action="close" title="Close"></i>
            </div>
          </div>
          <div class="npc-ap-scroll"></div>
          <div class="npc-ap-resize"></div>
        </div>`);
      $el = $('#npc-ap-panel');
      this._bindDrag('#npc-ap-panel');
      this._bindResize('#npc-ap-panel');
      this._bindPanelEvents();
    }
    await game.settings.set(MODULE_ID, 'hudOpen', true);
    $el.show();
    this._renderPanel();
  }

  static async close() { $('#npc-ap-panel').hide(); await game.settings.set(MODULE_ID, 'hudOpen', false); }

  static _bindDrag(sel) {
    const $el = $(sel); let dragging=false, sx, sy, sl, st;
    $el.find('.npc-ap-header').on('mousedown.npcdrag', (e) => {
      if (e.target.closest('.npc-ap-actions')) return;
      dragging=true; sx=e.clientX; sy=e.clientY;
      const off=$el.offset(); sl=off.left; st=off.top;
      e.preventDefault();
    });
    const onMove=(e)=>{ if(dragging) $el.css({left:Math.max(0,sl+e.clientX-sx), top:Math.max(0,st+e.clientY-sy), right:'auto'}); };
    const onUp=()=>{ if(dragging){ const o=$el.offset(); game.settings.set(MODULE_ID, 'hudPosition',{top:Math.round(o.top),left:Math.round(o.left)}); } dragging=false; };
    $(document).off('mousemove.npcdrag mouseup.npcdrag')
      .on('mousemove.npcdrag', onMove).on('mouseup.npcdrag', onUp);
  }
  static _bindResize(sel) {
    const $el = $(sel); let resizing=false, sx, sy, sw, sh;
    $el.find('.npc-ap-resize').on('mousedown.npcresize', (e)=>{ resizing=true; sx=e.clientX; sy=e.clientY; sw=$el.outerWidth(); sh=$el.outerHeight(); e.preventDefault(); });
    const onMove=(e)=>{ if(resizing) $el.css({width:Math.max(280,sw+e.clientX-sx), height:Math.max(280,sh+e.clientY-sy)}); };
    const onUp=()=>{ if(resizing) game.settings.set(MODULE_ID, 'hudSize',{width:Math.round($el.outerWidth()),height:Math.round($el.outerHeight())}); resizing=false; };
    $(document).off('mousemove.npcresize mouseup.npcresize')
      .on('mousemove.npcresize', onMove).on('mouseup.npcresize', onUp);
  }
  static _bindPanelEvents() {
    $('#npc-ap-panel [data-action]').off('click.npcd').on('click.npcd', async function() {
      const action = $(this).data('action');
      if (action==='close') NpcAutopilot.close();
      if (action==='refresh') NpcAutopilot._renderPanel();
    });
    $(document).off('click.npcap-toggle').on('click.npcap-toggle', '[data-ap-action]', function(e) {
      const action = $(this).data('ap-action');
      if (action==='toggle-ap') {
        const now = !game.settings.get(MODULE_ID, 'npcAutopilot');
        game.settings.set(MODULE_ID, 'npcAutopilot', now);
        NpcAutopilot._renderPanel();
      }
      if (action==='manual-turn') {
        const c = game.combat?.combatant;
        if (c?.token?.actor) NpcAutopilot.takeTurn(c.token.actor, c.token);
      }
    });
  }

  /* ── Panel rendering ───────────────────────────────────────────── */
  static _renderPanel() {
    const $sc = $('#npc-ap-panel .npc-ap-scroll');
    if (!$sc.length) return;

    const autopilotOn = game.settings.get(MODULE_ID, 'npcAutopilot');
    const combat = game.combat;
    const active = combat?.started || false;
    const current = combat?.combatant;
    const currentToken = current?.token;
    const currentActor = currentToken?.actor;
    const isNPC = currentActor && !currentActor.hasPlayerOwner;

    let html = `
      <div class="npc-ap-status-row">
        <span class="npc-ap-toggle ${autopilotOn ? 'on' : 'off'}" data-ap-action="toggle-ap">
          <i class="fas fa-power-off"></i> ${autopilotOn ? 'ON' : 'OFF'}
        </span>
        <span class="npc-ap-combat-status">${active ? '🎲 Round '+(combat.round||1)+', Turn '+((combat.turn||0)+1) : 'No combat'}</span>
      </div>`;

    if (currentToken) {
      const hp = currentActor?.system?.attributes?.hp || {};
      const hpPct = Math.round((hp.value||0)/(hp.max||1)*100);
      const hpColor = hpPct>50?'#4ade80':hpPct>25?'#facc15':'#f87171';
      html += `
        <div class="npc-ap-card">
          <img src="${currentToken.texture?.src || currentActor?.img || 'icons/svg/mystery-man.svg'}">
          <div class="npc-ap-info">
            <div class="npc-ap-name">${currentToken.name||currentActor?.name||'?'}</div>
            <div class="npc-ap-meta">${isNPC?'NPC':'Player'} | HP <span style="color:${hpColor};font-weight:700;">${hp.value||0}/${hp.max||'?'}</span> (${hpPct}%)</div>
            <div class="npc-ap-hpbar"><div style="width:${hpPct}%;background:${hpColor};"></div></div>
          </div>
          ${isNPC&&autopilotOn?'<div class="npc-ap-badge">🤖 AI</div>':''}
        </div>`;
    }

    if (active) {
      const npcs = combat.combatants.filter(c => c.token?.actor && !c.token.actor.hasPlayerOwner);
      if (npcs.length) {
        html += `<div class="npc-ap-list"><div class="npc-ap-section">NPCs (${npcs.length})</div>`;
        for (const c of npcs) {
          const a = c.token?.actor;
          const h = a?.system?.attributes?.hp || {};
          const p = Math.round((h.value||0)/(h.max||1)*100);
          const col = p>50?'#4ade80':p>25?'#facc15':'#f87171';
          html += `
            <div class="npc-ap-item ${c.token?.id===currentToken?.id?'current':''}">
              <img src="${c.token?.texture?.src||a?.img||'icons/svg/mystery-man.svg'}">
              <div class="npc-ap-item-name">${c.name}</div>
              <div class="npc-ap-item-hpbar"><div style="width:${p}%;background:${col};"></div></div>
              <div class="npc-ap-item-hp" style="color:${col};">${p}%</div>
            </div>`;
        }
        html += `</div>`;
      }
    }

    html += `
      <div class="npc-ap-controls">
        ${isNPC&&active?`<button class="npc-ap-btn" data-ap-action="manual-turn"><i class="fas fa-play"></i> Take Turn for ${currentToken.name}</button>`:''}
      </div>`;

    $sc.html(html);
  }

  /* ═══════════════════════════════════════════════════════════════════
     AUTOPILOT ENGINE
     ═══════════════════════════════════════════════════════════════════ */
  static async takeTurn(actor, tokenDoc) {
    if (this._npcTurnInProgress) return;
    this._npcTurnInProgress = true;
    try {
      const doMove = game.settings.get(MODULE_ID, 'npcMovement');

      // ── Movement Phase ──
      let moveLog = '';
      if (doMove && tokenDoc) {
        const enemies = this._findEnemies(actor, tokenDoc);
        const hpPct = this._getHPPct(actor);

        if (hpPct < 0.2 && enemies.length >= 2) {
          moveLog = await this._npcRetreat(tokenDoc, enemies);
        } else if (enemies.length) {
          const sorted = enemies.slice().sort((a,b)=>{
            const ha=a.system?.attributes?.hp||{}, hb=b.system?.attributes?.hp||{};
            return (ha.value||0)-(hb.value||0);
          });
          const targetActor = sorted[0];
          const targetToken = targetActor?.getActiveTokens?.()[0];
          const weapon = actor.items?.find(i=>i.type==='weapon'&&i.system?.equipped!==false)||actor.items?.find(i=>i.type==='weapon');
          if (targetToken && weapon) moveLog = await this._npcMoveToTarget(tokenDoc, targetToken, weapon);
        }
      }
      if (moveLog) {
        await this._chat(`🏃 ${moveLog}`, { speaker: ChatMessage.getSpeaker({ actor }) });
        await new Promise(r=>setTimeout(r, 300));
      }

      // ── Action Phase ──
      await this._executeAction(actor, tokenDoc);

      // ── Advance ──
      if (game.settings.get(MODULE_ID, 'autoAdvance') && game.combat?.combatant?.token?.id===tokenDoc?.id) {
        setTimeout(()=>game.combat.nextTurn(), 800);
      }

      this._renderPanel();
    } catch (err) {
      console.error('[NPC Autopilot] error:', err);
      this._chat(`⚠️ Autopilot error: ${err.message}`, { whisper: [game.userId] });
    } finally {
      this._npcTurnInProgress = false;
    }
  }

  static async _executeAction(actor, tokenDoc) {
    const enemies = this._findEnemies(actor, tokenDoc);
    const allies  = this._findAllies(actor, tokenDoc);
    const hpPct   = this._getHPPct(actor);
    const items   = actor.items?.contents || [];
    const spells  = items.filter(i=>i.type==='spell');
    const weapons = items.filter(i=>i.type==='weapon');
    const features= items.filter(i=>i.type==='feat');

    let action = null;

    // Priority 1: heal self or wounded ally
    const healSpell = spells.find(s=>/cure|healing word|aid/i.test(s.name));
    const woundedAlly = allies.find(a=>this._getHPPct(a)<0.3);
    if (hpPct<0.25 && healSpell) action={type:'spell', item:healSpell, target:actor};
    else if (woundedAlly && healSpell && hpPct>0.4) action={type:'spell', item:healSpell, target:woundedAlly};

    // Priority 2: buff/debuff
    if (!action) {
      const buff = spells.find(s=>/haste|bless|shield of faith|bane|faerie fire|web|hold person/i.test(s.name));
      if (buff && hpPct>0.3) action={type:'spell', item:buff, target:enemies[0]||allies[0]||actor};
    }

    // Priority 3: attack
    if (!action && enemies.length) {
      const weapon = weapons.find(w=>w.system?.equipped!==false)||weapons[0]||features[0];
      if (weapon) {
        const sorted = enemies.slice().sort((a,b)=>{
          const ha=a.system?.attributes?.hp||{}, hb=b.system?.attributes?.hp||{};
          return (ha.value||0)-(hb.value||0);
        });
        action={type:'attack', item:weapon, target:sorted[0]};
      }
    }

    // Priority 4: dodge if critical
    if (!action && hpPct<0.25) action={type:'dodge'};

    // Execute
    if (!action) {
      await this._chat(`🎲 **${actor.name}** takes no action.`, { speaker: ChatMessage.getSpeaker({ actor }) });
    } else if (action.type==='spell') {
      await this._npcCastSpell(actor, action.item, action.target);
    } else if (action.type==='attack') {
      await this._npcAttack(actor, action.item, action.target);
    } else if (action.type==='dodge') {
      await this._chat(`🛡️ ${actor.name} takes the **Dodge** action.`, { speaker: ChatMessage.getSpeaker({ actor }) });
    }
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

    const dx = self.x - target.x, dy = self.y - target.y;
    const distSq = dx*dx + dy*dy;
    if (distSq <= rangeSq) return '';

    const speed = selfToken.actor?.system?.attributes?.movement?.walk || 30;
    const maxDistPx = (speed / gridDist) * canvas.grid.size;

    // Try flanking position
    let dest = this._findFlankPosition(self, target);
    if (!dest) {
      const angle = Math.atan2(target.y-self.y, target.x-self.x);
      const approach = Math.sqrt(rangeSq)*0.8;
      const total = Math.sqrt(distSq);
      const moveDist = Math.min(maxDistPx, total-approach);
      if (moveDist <= 0) return '';
      dest = { x:self.x+Math.cos(angle)*moveDist, y:self.y+Math.sin(angle)*moveDist };
    }

    const snapped = canvas.grid.getSnappedPoint
      ? canvas.grid.getSnappedPoint({x:dest.x,y:dest.y}, {mode:CONST.GRID_SNAPPING_MODES.CENTER})
      : dest;

    const hasCollision = CONFIG.Canvas.polygonBackends?.move?.testCollision
      ? CONFIG.Canvas.polygonBackends.move.testCollision({x:self.x,y:self.y}, snapped, {type:'move', mode:'any'})
      : false;

    if (hasCollision) {
      const safe = this._findSafePosition(self, snapped, maxDistPx);
      if (safe) { await self.update({x:safe.x,y:safe.y}); return `${selfToken.name} manoeuvres closer.`; }
      return '';
    }
    await self.update({x:snapped.x,y:snapped.y});
    return `${selfToken.name} advances toward ${targetToken.name}.`;
  }

  static async _npcRetreat(selfToken, enemies) {
    if (!selfToken || !canvas?.grid) return '';
    const self   = selfToken.document || selfToken;
    const speed  = selfToken.actor?.system?.attributes?.movement?.walk || 30;
    const gridDist = canvas.grid.distance || 5;
    const maxDistPx = (speed / gridDist) * canvas.grid.size;

    let ex=0, ey=0, count=0;
    for (const e of enemies) {
      const t = e?.getActiveTokens?.()[0];
      if (t) { ex += (t.document?.x||t.x); ey += (t.document?.y||t.y); count++; }
    }
    if (!count) return '';
    ex/=count; ey/=count;

    const angle = Math.atan2(self.y-ey, self.x-ex);
    const dest = { x:self.x+Math.cos(angle)*maxDistPx, y:self.y+Math.sin(angle)*maxDistPx };
    const snapped = canvas.grid.getSnappedPoint
      ? canvas.grid.getSnappedPoint({x:dest.x,y:dest.y}, {mode:CONST.GRID_SNAPPING_MODES.CENTER})
      : dest;

    const hasCollision = CONFIG.Canvas.polygonBackends?.move?.testCollision
      ? CONFIG.Canvas.polygonBackends.move.testCollision({x:self.x,y:self.y}, snapped, {type:'move', mode:'any'})
      : false;

    if (hasCollision) {
      const safe = this._findSafePosition(self, snapped, maxDistPx);
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
      if (d < minD) { minD=d; nearest=a; }
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
      const hasCollision = CONFIG.Canvas.polygonBackends?.move?.testCollision
        ? CONFIG.Canvas.polygonBackends.move.testCollision({x:self.x,y:self.y}, {x:px,y:py}, {type:'move', mode:'any'})
        : false;
      if (!hasCollision) return {x:px,y:py};
    }
    return null;
  }

  static _getWeaponRange(weapon) {
    if (!weapon) return 5;
    const sys=weapon.system||{};
    if (sys.range?.value) return parseInt(sys.range.value)||5;
    const props=sys.properties||[];
    if (props.includes?.('rch')||sys.properties?.rch) return 10;
    if (props.includes?.('thr')||sys.properties?.thr) return (sys.range?.long||60);
    return 5;
  }

  /* ═══════════════════════════════════════════════════════════════════
     ACTIONS
     ═══════════════════════════════════════════════════════════════════ */
  static async _npcAttack(actor, weapon, target) {
    try {
      const item = typeof weapon==='string'?actor.items.getName(weapon):weapon;
      if (!item) return;
      const activity = item.system?.activities?.contents?.[0];
      if (activity && typeof activity.use==='function') {
        await activity.use({}, {configure:false});
      } else {
        const roll = await new Roll(`1d20 + ${this._getAtkBonus(actor,item)}`).evaluate();
        const flavor = `${actor.name} attacks ${target?.name||'target'} with ${item.name}`;
        await roll.toMessage({ speaker:ChatMessage.getSpeaker({actor}), flavor });
      }
    } catch(e) { console.warn('[NPC Autopilot] attack error:', e); }
  }

  static async _npcCastSpell(actor, spell, target) {
    try {
      const item = typeof spell==='string'?actor.items.getName(spell):spell;
      if (!item) return;
      const activity = item.system?.activities?.contents?.[0];
      if (activity && typeof activity.use==='function') {
        await activity.use({}, {configure:false});
      } else {
        const roll = await new Roll(item.system?.damage?.parts?.[0]?.[0]||'1d6').evaluate();
        await roll.toMessage({ speaker:ChatMessage.getSpeaker({actor}), flavor:`${actor.name} casts ${item.name} on ${target?.name||'target'}.` });
      }
    } catch(e) { console.warn('[NPC Autopilot] spell error:', e); }
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
  static async _chat(content, {speaker=null, whisper=[]}={}) {
    const chatData={
      user:game.userId,
      speaker:speaker??ChatMessage.getSpeaker({alias:'NPC Autopilot'}),
      content:`<p>${content}</p>`,
      type:CONST.CHAT_MESSAGE_TYPES.OTHER,
      whisper:whisper.length?whisper.map(u=>typeof u==='string'?u:u.id):[]
    };
    await ChatMessage.create(chatData);
  }
}

/* Make available globally */
globalThis.NpcAutopilot = NpcAutopilot;
