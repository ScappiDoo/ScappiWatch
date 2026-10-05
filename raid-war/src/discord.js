import { discordTs } from './time.js';

/**
 * Turns log events into short Discord posts. Times use Discord timestamp tags so
 * every player sees their own local time. `send` is whatever posts to the raid
 * log channel (a webhook, a bot client, or a test array).
 */
export class DiscordFeed {
  constructor({ log, send }) {
    this.send = send;
    log.subscribe((e) => {
      const text = this.format(e);
      if (text) send(text.slice(0, 1990));
    });
  }

  format(e) {
    const d = e.data, t = (ms) => `${discordTs(ms, 'F')} (${discordTs(ms, 'R')})`;
    switch (e.type) {
      case 'war_declared':
        return `⚔️ **War ${e.warId}**: **${d.attackerId}** declares war on **${d.targetId}**.\nReason: ${d.reason}\nWar goal: ${d.goalTiles.length} tiles (fixed, it can only shrink).\nFirst raid: ${t(d.firstRaidAt)} in the target's home window.`;
      case 'raid_start':
        return `🐎 **Raid ${e.raidId}** has begun (war ${e.warId}). It ends ${t(d.setup.endMs)}.`;
      case 'loot_delivered':
        return `💰 Raid ${e.raidId}: **${d.accountId}** delivered ${d.points} points to the camp.`;
      case 'loot_recovered':
        return `🛡️ Raid ${e.raidId}: **${d.accountId}** took back ${d.amount} points of loot.`;
      case 'raid_cancelled':
        return `🚫 War ${e.warId}: raid cancelled (${d.reason.replaceAll('_', ' ')}).`;
      case 'raid_end': {
        const who = d.winner === 'attacker' ? 'The raiders win' : 'The defenders win';
        return `🏁 Raid ${e.raidId} is over. ${who}: raiders ${d.score.attacker}, defenders ${d.score.defender}. Kills: ${d.stats.kills.attacker} / ${d.stats.kills.defender}.`;
      }
      case 'land_change':
        return `🏴 War ${e.warId}: ${d.tiles.length} tiles pass from **${d.from}** to **${d.to}**. Players on that land have until ${t(d.graceUntil)} to move their items.`;
      case 'tribute_paid':
        return `🪙 War ${e.warId}: **${d.payer}** paid ${d.amount} in tribute to **${d.receiver}**. The war is over, no land changes hands.`;
      case 'surrender':
        return `🏳️ War ${e.warId}: the ${d.side} surrenders.`;
      case 'war_ended':
        return `📜 War ${e.warId} has ended (${d.reason.replaceAll('_', ' ')}). Raids won: raiders ${d.wins.attacker}, defenders ${d.wins.defender}.`;
      case 'war_result_undone':
        return `⚖️ War ${e.warId}: staff undid the result (two staff agreed). Raid IDs: ${d.raidIds.join(', ')}.`;
      default:
        return null;
    }
  }
}
