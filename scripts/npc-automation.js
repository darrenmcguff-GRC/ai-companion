const MODULE_ID = 'ai-companion';

/* ════════════ NPC AUTOPILOT ENGINE v2.1 ═══════════════════════
   5etools stat-block driven tactics
   ═══════════════════════════════════════════════════════════════ */

Object.assign(globalThis.AICompanion, {

  /* ── Public entry ── */
  async _npcTakeTurn(actor, tokenDoc) {
    if (this._npcTurnInProgress) return;
    this._npcTurnInProgress = true;
    try {
      const doMove = game.settings.get(MODULE_ID, 'npcMovement');
      const kb = this._getKBMonster(actor);
      const state = this._buildCombatState(actor, tokenDoc, kb);

      let moveLog = '';
      if (doMove && tokenDoc) {
        moveLog = await this._npcTacticalMove(actor, tokenDoc, state);
        if (moveLog) {
          await this._aiChat(`🏃 ${moveLog}`, { speaker: ChatMessage.getSpeaker({ actor }) });
          await new Promise(r => setTimeout(r, 300));
        }
      }

      // Choose action using stat-block knowledge
      const actionPlan = kb ? this._planFromKB(state, kb) : this._planFallback(state);
      await this._executePlan(actor, tokenDoc, actionPlan, state);

      if (game.settings.get(MODULE_ID, 'autoAdvance') && game.combat?.combatant?.token?.id === tokenDoc?.id) {
        setTimeout(() => game.combat.nextTurn(), 800);
      }
    } catch (err) {
      console.error('[AI Companion] NPC autopilot error:', err);
      this._aiChat(`⚠️ Autopilot error: ${err.message}`, { whisper: [game.userId] });
    } finally {
      this._npcTurnInProgress = false;
    }
  },

  /* ── Match actor to KB monster ── */
  _getKBMonster(actor) {
    if (!actor?.name) return null;
    // Exact match first
    if (KB.monsters[actor.name]) return KB.monsters[actor.name];
    // Substring match
    const lower = actor.name.toLowerCase();
    for (const [k, v] of Object.entries(KB.monsters)) {
      if (lower.includes(k.toLowerCase()) || k.toLowerCase().includes(lower)) return v;
    }
    return null;
  },

  /* ── Build tactical state snapshot ── */
  _buildCombatState(actor, tokenDoc, kb) {
    const enemies = this._findEnemies(actor, tokenDoc);
    const allies = this._findAllies(actor, tokenDoc);
    const hpPct = this._getHPPct(actor);
    const items = actor.items?.contents || [];

    // Cluster detection for AoE targeting
    let maxCluster = 0;
    let clusterCenter = null;
    if (tokenDoc && canvas?.grid) {
      const enemyTokens = enemies.map(a => a.getActiveTokens()[0]).filter(Boolean);
      for (let i = 0; i < enemyTokens.length; i++) {
        let count = 0;
        let cx = 0, cy = 0;
        for (let j = 0; j < enemyTokens.length; j++) {
          if (i === j) continue;
          const d = Math.hypot(enemyTokens[i].x - enemyTokens[j].x, enemyTokens[i].y - enemyTokens[j].y);
          const ft = d / (canvas.grid.size || 1) * (canvas.grid.distance || 5);
          if (ft <= 25) { count++; cx += enemyTokens[j].x; cy += enemyTokens[j].y; }
        }
        if (count > maxCluster) { maxCluster = count; clusterCenter = { x: cx / count, y: cy / count }; }
      }
    }

    // Track simulated cooldowns for recharge / per-day abilities (in-memory, not registered setting)
    const cdKey = `npcCD_${actor.id}`;
    const cooldowns = AICompanion._npcCooldowns?.[cdKey] || {};

    return {
      actor, tokenDoc, kb, enemies, allies, hpPct, items,
      spells: items.filter(i => i.type === 'spell'),
      weapons: items.filter(i => i.type === 'weapon'),
      features: items.filter(i => i.type === 'feat'),
      clusterCount: maxCluster + 1, // including the reference token
      clusterCenter,
      cooldowns,
      cdKey,
    };
  },

  /* ═══════════════════════════════════════════════════════════════
     TACTICAL MOVEMENT ENGINE
     ═══════════════════════════════════════════════════════════════ */
  async _npcTacticalMove(actor, tokenDoc, state) {
    const { enemies, allies, hpPct, tokenDoc: td } = state;
    if (!enemies.length) return '';

    // ── Trait-driven move overrides ──
    if (state.kb?.trt) {
      const nimble = state.kb.trt.find(t => /nimble escape|disengage.*hide/i.test(t.n));
      if (nimble && hpPct < 0.3) {
        // Bonus action disengage + hide before retreating
        return `${actor.name} ducks away with ${nimble.n}.`;
      }
      const fly = state.kb.sp?.includes('fly');
      if (fly && hpPct < 0.2) {
        return `${actor.name} takes to the air!`;
      }
    }

    // ── HP-based strategy ──
    if (hpPct < 0.2 && enemies.length >= 2) {
      return this._npcRetreat(tokenDoc, enemies);
    }

    // ── Target selection: focus lowest HP, or caster-looking token ──
    const sorted = enemies.slice().sort((a, b) => {
      const ha = a.system?.attributes?.hp || {}; const hb = b.system?.attributes?.hp || {};
      return (ha.value || 0) - (hb.value || 0);
    });
    const targetActor = sorted[0];
    const targetToken = targetActor?.getActiveTokens()[0];
    if (!targetToken) return '';

    // ── Pick best attack vector from KB ──
    const weapon = this._chooseWeapon(state);
    if (!weapon) return '';

    const range = this._getWeaponRange(weapon);
    return this._npcMoveToTarget(tokenDoc, targetToken, weapon, range);
  },

  /* ── Find an equipped weapon or fallback ── */
  _chooseWeapon(state) {
    const { weapons, features, kb } = state;
    if (kb?.act) {
      // Prefer KB action that looks like a weapon attack
      const atk = kb.act.find(a => /melee|attack|hit|damage/i.test(a.n + ' ' + a.e));
      if (atk) {
        // Return a synthetic weapon object so _getWeaponRange / _npcAttack work
        const isRanged = /ranged|range\s+\d/i.test(atk.e);
        return {
          name: atk.n,
          type: 'weapon',
          system: {
            equipped: true,
            properties: { rch: /reach/i.test(atk.e) },
            range: isRanged ? { value: 80, long: 320 } : { value: 5 },
            damage: { parts: [['1d6', 'slashing']] },
            activities: { contents: [] },
          },
        };
      }
    }
    return weapons.find(w => w.system?.equipped !== false) || weapons[0] || features[0];
  },

  /* ═══════════════════════════════════════════════════════════════
     ACTION PLANNER — 5etools stat-block driven
     ═══════════════════════════════════════════════════════════════ */
  _planFromKB(state, kb) {
    const { actor, enemies, allies, hpPct, spells, weapons, features, clusterCount } = state;
    const plan = { moves: [], messages: [] };

    // ── Legendary creatures ──
    if (kb.leg?.length) {
      plan.messages.push(`👑 **Legendary Actions** available: ${kb.leg.map(l => l.n).join(', ')}.`);
    }

    // ── Special senses ──
    if (kb.sense) {
      const senses = Array.isArray(kb.sense) ? kb.sense.join(', ') : kb.sense;
      if (/blindsight|tremorsense|truesight/i.test(senses)) {
        plan.messages.push(`👁️ **Special senses**: ${senses}. Invisible/hidden targets may still be detected.`);
      }
    }

    // ── Breath / AoE / Recharge abilities ──
    if (kb.act) {
      const aoe = kb.act.filter(a => /breath|cone|line|cloud|aura|area|circle|burst|blast|radius|shower/i.test(a.e));
      const recharge = kb.act.filter(a => /@{recharge}|recharge|recharge \d/i.test(a.n + ' ' + a.e));
      const multi = kb.act.find(a => /^multiattack/i.test(a.n));
      const frightful = kb.act.find(a => /frightful presence/i.test(a.n));

      // Frightful Presence first (setup)
      if (frightful) {
        plan.moves.push({ type: 'ability', name: frightful.n, desc: frightful.e, priority: 10 });
      }

      // Recharge ability (breath weapon etc) — try to use if clustered enemies
      if (recharge.length && clusterCount >= 2) {
        // Simulate recharge tracking (not perfect, but we guess it's available)
        const breath = recharge[0];
        plan.moves.push({ type: 'ability', name: breath.n, desc: breath.e, priority: 9, aoe: true });
      }

      // Multiattack if available
      if (multi && enemies.length) {
        plan.moves.push({ type: 'multiattack', name: multi.n, desc: multi.e, priority: 7, target: this._pickTarget(state) });
      }
    }

    // ── Reaction awareness ──
    if (kb.rct?.length) {
      const reacts = kb.rct.map(r => r.n);
      if (reacts.some(r => /parry|redirect|shield|counterspell|reaction/i.test(r))) {
        plan.messages.push(`⚡ **Reaction ready**: ${reacts.join(', ')}.`);
      }
    }

    // ── Traits that modify behaviour ──
    if (kb.trt) {
      const pack = kb.trt.find(t => /pack tactics/i.test(t.n));
      if (pack) plan.messages.push(`🐺 **Pack Tactics**: Advantage on attacks if an ally is within 5 ft of target.`);
      const sneak = kb.trt.find(t => /sneak attack/i.test(t.n));
      if (sneak) plan.messages.push(`🗡️ **Sneak Attack**: +${sneak.e.match(/\d+d\d+/)?.[0] || '?'} damage when you have advantage.`);
      const pounce = kb.trt.find(t => /pounce|charge|trampling|trample/i.test(t.n));
      if (pounce) plan.messages.push(`🐆 **${pounce.n}**: Move 20+ ft straight for bonus damage / knock Prone.`);
      const amorphous = kb.trt.find(t => /amorphous|incorporeal|ethereal/i.test(t.n));
      if (amorphous) plan.messages.push(`🌀 **${amorphous.n}**: Move through 1-inch gaps / walls.`);
    }

    // ── Fallback attack if no moves yet ──
    if (!plan.moves.length && enemies.length) {
      const weapon = this._chooseWeapon(state);
      const target = this._pickTarget(state);
      if (weapon) plan.moves.push({ type: 'attack', item: weapon, target, priority: 5 });
    }

    // ── Defensive fallback ──
    if (!plan.moves.length) {
      plan.moves.push({ type: 'dodge', priority: 1 });
    }

    // Sort by priority descending
    plan.moves.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    return plan;
  },

  /* ── Fallback planner when no KB match ── */
  _planFallback(state) {
    const { actor, enemies, allies, hpPct, spells, weapons, features } = state;
    const plan = { moves: [], messages: [] };

    // Heal
    const healSpell = spells.find(s => /cure|healing word|aid/i.test(s.name));
    if (hpPct < 0.25 && healSpell) {
      plan.moves.push({ type: 'spell', item: healSpell, target: actor, priority: 10 });
    } else {
      const woundedAlly = allies.find(a => this._getHPPct(a) < 0.3);
      if (woundedAlly && healSpell && hpPct > 0.4) {
        plan.moves.push({ type: 'spell', item: healSpell, target: woundedAlly, priority: 9 });
      }
    }

    // Buff
    if (!plan.moves.length) {
      const buff = spells.find(s => /haste|bless|shield of faith|bane|faerie fire|web|hold person/i.test(s.name));
      if (buff && hpPct > 0.3) {
        plan.moves.push({ type: 'spell', item: buff, target: enemies[0] || allies[0] || actor, priority: 7 });
      }
    }

    // Attack
    if (!plan.moves.length && enemies.length) {
      const weapon = weapons.find(w => w.system?.equipped !== false) || weapons[0] || features[0];
      if (weapon) plan.moves.push({ type: 'attack', item: weapon, target: enemies[0], priority: 5 });
    }

    // Dodge
    if (!plan.moves.length) plan.moves.push({ type: 'dodge', priority: 1 });
    plan.moves.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    return plan;
  },

  /* ── Pick the best target based on threat / HP ── */
  _pickTarget(state) {
    const { enemies } = state;
    if (!enemies.length) return null;
    // Focus lowest HP first
    return enemies.slice().sort((a, b) => {
      const ha = a.system?.attributes?.hp || {}; const hb = b.system?.attributes?.hp || {};
      return (ha.value || 0) - (hb.value || 0);
    })[0];
  },

  /* ═══════════════════════════════════════════════════════════════
     EXECUTION — carry out the top plan move
     ═══════════════════════════════════════════════════════════════ */
  async _executePlan(actor, tokenDoc, plan, state) {
    const top = plan.moves[0];
    if (!top) {
      await this._aiChat(`🎲 **${actor.name}** takes no action — no valid target.`, { speaker: ChatMessage.getSpeaker({ actor }) });
      return;
    }

    // Emit all info messages
    for (const msg of plan.messages || []) {
      await this._aiChat(msg, { whisper: [game.userId] });
    }

    if (top.type === 'ability') {
      await this._npcUseAbility(actor, top, state);
    } else if (top.type === 'multiattack') {
      await this._npcMultiAttack(actor, top, state);
    } else if (top.type === 'spell') {
      await this._npcCastSpell(actor, top.item, top.target);
    } else if (top.type === 'attack') {
      await this._npcAttack(actor, top.item, top.target);
    } else if (top.type === 'dodge') {
      await this._aiChat(`🛡️ ${actor.name} takes the **Dodge** action.`, { speaker: ChatMessage.getSpeaker({ actor }) });
    }
  },

  async _npcUseAbility(actor, ability, state) {
    // Track cooldowns
    const cdKey = state.cdKey;
    const cooldowns = { ...state.cooldowns };
    if (/@{recharge}|recharge/i.test(ability.name)) {
      cooldowns[ability.name] = game.combat.round + 1;
      if (!AICompanion._npcCooldowns) AICompanion._npcCooldowns = {};
      AICompanion._npcCooldowns[cdKey] = cooldowns;
    }
    await this._aiChat(`🔥 **${actor.name}** uses **${ability.name}**!\n> ${ability.desc}`, { speaker: ChatMessage.getSpeaker({ actor }) });
  },

  async _npcMultiAttack(actor, top, state) {
    const target = top.target;
    await this._aiChat(`⚔️ **${actor.name}** uses **${top.name}** on **${target?.name || 'target'}**!\n> ${top.desc}`, { speaker: ChatMessage.getSpeaker({ actor }) });
    // Attempt physical attacks via equipped weapon if available
    const weapon = this._chooseWeapon(state);
    if (weapon && target) await this._npcAttack(actor, weapon, target);
  },

  /* ═══════════════════════════════════════════════════════════════
     MOVEMENT HELPER (unchanged core + range fix)
     ═══════════════════════════════════════════════════════════════ */
  async _npcMoveToTarget(selfToken, targetToken, weapon, overrideRange) {
    if (!selfToken || !targetToken || !canvas?.grid) return '';
    const self = selfToken.document || selfToken;
    const target = targetToken.document || targetToken;
    const range = overrideRange || this._getWeaponRange(weapon);
    const gridDist = canvas.grid.distance || 5;
    const rangePx = (range / gridDist) * canvas.grid.size;
    const rangeSq = rangePx * rangePx;

    const dx = self.x - target.x; const dy = self.y - target.y;
    const distSq = dx * dx + dy * dy;
    if (distSq <= rangeSq) return '';

    const speed = selfToken.actor?.system?.attributes?.movement?.walk || 30;
    const maxDistPx = (speed / gridDist) * canvas.grid.size;

    // Try flanking first
    let dest = this._findFlankPosition(self, target);
    if (!dest) {
      const angle = Math.atan2(target.y - self.y, target.x - self.x);
      const approachDist = Math.sqrt(rangeSq) * 0.8;
      const totalDist = Math.sqrt(distSq);
      const moveDist = Math.min(maxDistPx, totalDist - approachDist);
      if (moveDist <= 0) return '';
      dest = { x: self.x + Math.cos(angle) * moveDist, y: self.y + Math.sin(angle) * moveDist };
    }

    const snapped = canvas.grid.getSnappedPoint
      ? canvas.grid.getSnappedPoint({ x: dest.x, y: dest.y }, { mode: CONST.GRID_SNAPPING_MODES.CENTER })
      : { x: dest.x, y: dest.y };

    const hasCollision = CONFIG.Canvas.polygonBackends?.move?.testCollision
      ? CONFIG.Canvas.polygonBackends.move.testCollision({ x: self.x, y: self.y }, snapped, { type: 'move', mode: 'any' })
      : false;

    if (hasCollision) {
      const safe = this._findSafePosition(self, snapped, maxDistPx);
      if (safe) { await self.update({ x: safe.x, y: safe.y }); return `${selfToken.name} manoeuvres closer.`; }
      return '';
    }
    await self.update({ x: snapped.x, y: snapped.y });
    return `${selfToken.name} advances toward ${targetToken.name}.`;
  },

  async _npcRetreat(selfToken, enemies) {
    if (!selfToken || !canvas?.grid) return '';
    const self = selfToken.document || selfToken;
    const speed = selfToken.actor?.system?.attributes?.movement?.walk || 30;
    const gridDist = canvas.grid.distance || 5;
    const maxDistPx = (speed / gridDist) * canvas.grid.size;

    let ex = 0, ey = 0, count = 0;
    for (const e of enemies) {
      const t = e?.getActiveTokens?.()[0];
      if (t) { ex += (t.document?.x || t.x); ey += (t.document?.y || t.y); count++; }
    }
    if (!count) return '';
    ex /= count; ey /= count;

    const angle = Math.atan2(self.y - ey, self.x - ex);
    const dest = { x: self.x + Math.cos(angle) * maxDistPx, y: self.y + Math.sin(angle) * maxDistPx };
    const snapped = canvas.grid.getSnappedPoint
      ? canvas.grid.getSnappedPoint({ x: dest.x, y: dest.y }, { mode: CONST.GRID_SNAPPING_MODES.CENTER })
      : dest;

    const hasCollision = CONFIG.Canvas.polygonBackends?.move?.testCollision
      ? CONFIG.Canvas.polygonBackends.move.testCollision({ x: self.x, y: self.y }, snapped, { type: 'move', mode: 'any' })
      : false;

    if (hasCollision) {
      const safe = this._findSafePosition(self, snapped, maxDistPx);
      if (safe) { await self.update({ x: safe.x, y: safe.y }); return `${selfToken.name} falls back cautiously.`; }
      return `${selfToken.name} holds position.`;
    }
    await self.update({ x: snapped.x, y: snapped.y });
    return `${selfToken.name} retreats from the fray.`;
  },

  _findFlankPosition(self, target) {
    const allies = canvas?.tokens?.placeables?.filter(t => t.id !== self.id && !t.actor?.hasPlayerOwner);
    if (!allies?.length) return null;
    let nearest = null, minD = Infinity;
    for (const a of allies) {
      const d = Math.hypot((a.document?.x || a.x) - target.x, (a.document?.y || a.y) - target.y);
      if (d < minD) { minD = d; nearest = a; }
    }
    if (!nearest) return null;
    const ax = nearest.document?.x || nearest.x;
    const ay = nearest.document?.y || nearest.y;
    return { x: target.x + (target.x - ax), y: target.y + (target.y - ay) };
  },

  _findSafePosition(self, targetDest, maxDist) {
    const steps = 20;
    const dx = targetDest.x - self.x;
    const dy = targetDest.y - self.y;
    const dist = Math.hypot(dx, dy) || 1;
    for (let i = steps; i >= 1; i--) {
      const f = (i / steps) * Math.min(1, maxDist / dist);
      const px = self.x + dx * f;
      const py = self.y + dy * f;
      const hasCollision = CONFIG.Canvas.polygonBackends?.move?.testCollision
        ? CONFIG.Canvas.polygonBackends.move.testCollision({ x: self.x, y: self.y }, { x: px, y: py }, { type: 'move', mode: 'any' })
        : false;
      if (!hasCollision) return { x: px, y: py };
    }
    return null;
  },

  _getWeaponRange(weapon) {
    if (!weapon) return 5;
    const sys = weapon.system || {};
    if (sys.range?.value) return parseInt(sys.range.value) || 5;
    const props = sys.properties || [];
    if (props.includes?.('rch') || sys.properties?.rch) return 10;
    if (props.includes?.('thr') || sys.properties?.thr) return (sys.range?.long || 60);
    return 5;
  },

  async _npcAttack(actor, weapon, target) {
    try {
      const item = typeof weapon === 'string' ? actor.items.getName(weapon) : weapon;
      if (!item) return;
      const activity = item.system?.activities?.contents?.[0];
      if (activity && typeof activity.use === 'function') {
        await activity.use({}, { configure: false });
      } else {
        const roll = await new Roll(`1d20 + ${this._getAtkBonus(actor, item)}`).evaluate();
        const flavor = `${actor.name} attacks ${target?.name || 'target'} with ${item.name}`;
        await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor });
      }
    } catch (e) {
      console.warn('[AI Companion] Attack error:', e);
    }
  },

  async _npcCastSpell(actor, spell, target) {
    try {
      const item = typeof spell === 'string' ? actor.items.getName(spell) : spell;
      if (!item) return;
      const activity = item.system?.activities?.contents?.[0];
      if (activity && typeof activity.use === 'function') {
        await activity.use({}, { configure: false });
      } else {
        const roll = await new Roll(item.system?.damage?.parts?.[0]?.[0] || '1d6').evaluate();
        await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `${actor.name} casts ${item.name} on ${target?.name || 'target'}.` });
      }
    } catch (e) {
      console.warn('[AI Companion] Spell cast error:', e);
    }
  },

  _findEnemies(actor, selfToken) {
    return canvas?.tokens?.placeables
      ?.filter(t => t.actor && t.actor.hasPlayerOwner && t.id !== selfToken?.id)
      ?.map(t => t.actor) || [];
  },

  _findAllies(actor, selfToken) {
    return canvas?.tokens?.placeables
      ?.filter(t => t.actor && !t.actor.hasPlayerOwner && t.id !== selfToken?.id)
      ?.map(t => t.actor) || [];
  },

  _getHPPct(actor) {
    const hp = actor?.system?.attributes?.hp || {};
    return (hp.value || 0) / (hp.max || 1);
  },

  _getAtkBonus(actor, item) {
    const sys = item?.system || {};
    const ability = sys.ability || actor?.system?.attributes?.attackBonus || 'str';
    const mod = actor?.system?.abilities?.[ability]?.mod || 0;
    const prof = sys.prof?.multiplier ? (actor?.system?.attributes?.prof || 0) : 0;
    return mod + prof;
  },

});

/* Method bindings */
['_npcTakeTurn','_npcTacticalMove','_npcMoveToTarget','_npcRetreat','_npcAttack','_npcCastSpell',
 '_getKBMonster','_buildCombatState','_planFromKB','_planFallback','_chooseWeapon','_pickTarget',
 '_executePlan','_npcUseAbility','_npcMultiAttack',
 '_findFlankPosition','_findSafePosition','_getWeaponRange',
 '_findEnemies','_findAllies','_getHPPct','_getAtkBonus'
].forEach(m => AICompanion[m] = AICompanion[m].bind(AICompanion));
