const MODULE_ID = 'ai-companion';

/* ═══════════════ GM ASSIST v2.0 ═══════════════════════════ */
Object.assign(globalThis.AICompanion, {
  async _scanGMNarration(message, userId) {
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

  async _applyCondition(condition, actor) {
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

  async _onDamageDealt(message, userId) {
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

  async _callProxy(prompt) {
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

  async _aiChat(content, { speaker = null, whisper = [] } = {}) {
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

  async _reply(text) {
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

}});

/* Method bindings */
AICompanion._scanGMNarration = AICompanion._scanGMNarration.bind(AICompanion);
AICompanion._applyCondition = AICompanion._applyCondition.bind(AICompanion);
AICompanion._onDamageDealt = AICompanion._onDamageDealt.bind(AICompanion);
AICompanion._callProxy = AICompanion._callProxy.bind(AICompanion);
AICompanion._aiChat = AICompanion._aiChat.bind(AICompanion);
AICompanion._reply = AICompanion._reply.bind(AICompanion);

