/** Posts feed messages to a Discord webhook, one at a time, honouring rate-limit replies. */
export function createWebhookSender(url, { fetchFn = fetch, minGapMs = 1000, onError = (e) => console.warn('[discord]', e.message) } = {}) {
  const queue = [];
  let busy = false;
  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const content = queue.shift();
      try {
        const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
        if (res.status === 429) {
          const wait = Number((await res.json().catch(() => ({}))).retry_after) || 1;
          queue.unshift(content);
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }
        if (!res.ok) onError(new Error(`webhook answered ${res.status}`));
      } catch (e) { onError(e); }
      await new Promise((r) => setTimeout(r, minGapMs));
    }
    busy = false;
  }
  return (text) => { if (queue.length < 200) queue.push(text); pump(); };
}
