/**
 * Chatbot: the conversational front door to the capability catalog.
 *
 * It is a driver over the API, not a second product. It has no knowledge of any flow,
 * no list of intents, and no way to touch the target app except by asking the server to
 * invoke a capability a human already approved — so everything it can do is exactly what
 * the Agent catalog tab lists, and revoking one takes it away mid-conversation.
 *
 * Three things it deliberately shows rather than hides:
 *   - WHICH capability was chosen, and the arguments the model filled in.
 *   - The four-way outcome, in the same badge the Runs table uses.
 *   - A link to the run's evidence, because a confirmation number with no run behind it
 *     is the exact thing this whole system exists to not be.
 *
 * Scoped to the sidebar's selected app: the tool list it is offered comes back narrowed
 * server-side, so it cannot reach a capability recorded against a different target.
 *
 * API: POST /api/chat (server-sent events), GET /api/catalog?app_id=.
 */

import { hasSelection, onSelectedApp, selectedAppId } from '/global/selected-app.js';
import { esc, getJson } from '/global/helpers.js';

/** Outcome → the card's accent. The badge itself reuses the global status palette. */
const TONE = {
  SUCCESS: 'done',
  BUSINESS_OUTCOME: 'answer',
  RECOVERABLE: 'recovered',
  HARD_FAILURE: 'broken',
};

const scrollToEnd = (thread) => { thread.scrollTop = thread.scrollHeight; };

/** Arguments as chips — one per key the model filled in. */
const argsHtml = (input) => {
  const pairs = Object.entries(input ?? {});
  if (!pairs.length) return '';
  return `<div class="chat-args">${pairs
    .map(([k, v]) => `<span class="chat-arg mono"><b>${esc(k)}</b><span>${esc(v)}</span></span>`)
    .join('')}</div>`;
};

/** The typed result, as data. Objects and arrays are shown as JSON rather than flattened. */
const outputsHtml = (outputs) => {
  const pairs = Object.entries(outputs ?? {});
  if (!pairs.length) return '';
  return `<dl class="chat-outputs">${pairs
    .map(([k, v]) => {
      const shown = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—');
      return `<dt class="mono">${esc(k)}</dt><dd>${esc(shown)}</dd>`;
    })
    .join('')}</dl>`;
};

/** The finished state of a capability card: what came back, and where the evidence is. */
function resultHtml(result) {
  if (result.refused) {
    return `
      <div class="chat-note bad">${esc(result.error)}</div>
      <div class="chat-call-foot"><span class="chat-run">Nothing ran — the gate refused before the browser opened.</span></div>`;
  }
  if (result.error) return `<div class="chat-note bad">${esc(result.error)}</div>`;

  const note = result.business_outcome
    ? `<div class="chat-note">${esc(result.business_outcome.detail ?? result.business_outcome.name ?? '')}</div>`
    : result.failure
      ? `<div class="chat-note bad">Stopped at ${esc(result.failure.step)}: ${esc(result.failure.reason)}</div>`
      : '';

  const recovered = result.recoveries?.length
    ? `<div class="chat-note">Cleared on the way: ${esc(result.recoveries.join(', '))}</div>`
    : '';

  return `
    ${outputsHtml(result.outputs)}
    ${note}
    ${recovered}
    <div class="chat-call-foot">
      <a class="chat-report" target="_blank" rel="noopener"
         href="/report.html?run=${encodeURIComponent(result.run_id)}">Open the run report ↗</a>
      <span class="chat-run mono">${esc(result.run_id)}</span>
    </div>`;
}

export async function mount(root) {
  root.innerHTML = await (await fetch('/components/chatbot/chatbot.html')).text();

  const launcher = root.querySelector('[data-open]');
  const panel = root.querySelector('.chat-panel');
  const thread = root.querySelector('[data-thread]');
  const composer = root.querySelector('[data-composer]');
  const input = root.querySelector('[data-input]');
  const sendButton = root.querySelector('[data-send]');
  const scope = root.querySelector('[data-scope]');

  /** The transcript, in the shape the API wants. The server holds none of it. */
  let messages = [];
  let busy = false;

  const setBusy = (value) => {
    busy = value;
    sendButton.disabled = value;
    input.disabled = value;
  };

  const add = (html) => {
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    const node = wrap.firstElementChild;
    thread.append(node);
    scrollToEnd(thread);
    return node;
  };

  /**
   * The empty state, rebuilt whenever the conversation resets or the app changes.
   * Its suggestions come from the catalog rather than a hardcoded list, so they are
   * always things this app can actually be asked for.
   */
  async function renderEmpty() {
    const appId = selectedAppId();
    let entries = [];
    try {
      if (appId) entries = await getJson(`/api/catalog?app_id=${encodeURIComponent(appId)}`);
    } catch {
      /* the panel still opens; the first message will report the real problem */
    }

    scope.textContent = appId ? appId : '';
    thread.innerHTML = entries.length
      ? `<div class="chat-empty">
           <p>Ask in plain English.</p>
           <p class="chat-empty-sub">I pick a recorded capability, replay it against the app, and show you what came back — with the evidence behind it.</p>
           <div class="chat-suggestions">
             ${entries
               .slice(0, 3)
               .map((e) => `<button class="chat-suggestion" type="button" data-suggest="${esc(e.name)}">${esc(e.name)}</button>`)
               .join('')}
           </div>
         </div>`
      : `<div class="chat-empty">
           <p>No approved capabilities for this app.</p>
           <p class="chat-empty-sub">Record one above, then approve it in the Capabilities tab — until a human does that, I have nothing I am allowed to call.</p>
         </div>`;
  }

  /** Read the SSE body and hand each event to `onEvent`. */
  async function readStream(body, onEvent) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Frames are separated by a blank line; a partial one stays in the buffer.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try {
          onEvent(JSON.parse(line.slice(6)));
        } catch {
          /* a malformed frame is not worth killing the turn over */
        }
      }
    }
  }

  async function send(text) {
    if (!text.trim() || busy) return;
    if (thread.querySelector('.chat-empty')) thread.innerHTML = '';

    add(`<div class="chat-msg user">${esc(text)}</div>`);
    messages.push({ role: 'user', content: text });
    input.value = '';
    input.style.height = 'auto';
    setBusy(true);

    const dots = add('<div class="chat-dots"><i></i><i></i><i></i></div>');
    const cards = new Map(); // tool_use id → its card, so tool_end can find it

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages, app_id: selectedAppId() }),
      });

      if (!res.ok || !res.body) {
        const { error } = await res.json().catch(() => ({}));
        dots.remove();
        add(`<div class="chat-msg agent failed">${esc(error ?? res.statusText)}</div>`);
        return;
      }

      await readStream(res.body, (event) => {
        if (event.type === 'text') {
          dots.remove();
          add(`<div class="chat-msg agent">${esc(event.text)}</div>`);
        } else if (event.type === 'tool_start') {
          dots.remove();
          const card = add(`
            <div class="chat-call">
              <div class="chat-call-head">
                <span class="chat-call-name">${esc(event.name)}</span>
                ${event.risk_level ? `<span class="badge ${esc(event.risk_level)}">${esc(event.risk_level)}</span>` : ''}
              </div>
              ${argsHtml(event.input)}
              <div class="chat-running"><span>replaying…</span><span class="chat-bar"><i></i></span></div>
            </div>`);
          cards.set(event.id, card);
          // The Runs table and the live viewer poll, but a reader watching this panel
          // should not wait up to two seconds to see the row appear.
          window.dispatchEvent(new CustomEvent('run-started'));
        } else if (event.type === 'tool_end') {
          const card = cards.get(event.id);
          if (!card) return;
          const result = event.result ?? {};
          card.classList.add(result.refused ? 'refused' : TONE[result.outcome] ?? 'broken');
          card.querySelector('.chat-running')?.remove();
          const badge = result.refused
            ? '<span class="badge risk_refusal">refused</span>'
            : `<span class="badge ${esc(result.outcome ?? 'HARD_FAILURE')}">${esc(result.outcome ?? 'error')}</span>`;
          card.querySelector('.chat-call-head').insertAdjacentHTML('beforeend', badge);
          card.insertAdjacentHTML('beforeend', resultHtml(result));
          scrollToEnd(thread);
          window.dispatchEvent(new CustomEvent('replay-finished'));
        } else if (event.type === 'done') {
          // The server's transcript is authoritative: it holds the assistant's tool_use
          // blocks and their results, which the next turn cannot be coherent without.
          messages = event.messages ?? messages;
        } else if (event.type === 'error') {
          dots.remove();
          add(`<div class="chat-msg agent failed">${esc(event.error)}</div>`);
        }
      });
    } catch (err) {
      dots.remove();
      add(`<div class="chat-msg agent failed">${esc(err.message)}</div>`);
    } finally {
      dots.remove();
      setBusy(false);
      input.focus();
    }
  }

  const close = () => {
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    input.focus();
    scrollToEnd(thread);
  };

  // The launcher is the toggle, not just the way in: it stays on screen while the panel
  // is open, inverted, and the same click closes it again.
  launcher.addEventListener('click', () => (panel.hidden ? open() : close()));
  root.querySelector('[data-close]').addEventListener('click', close);
  root.querySelector('[data-clear]').addEventListener('click', () => {
    messages = [];
    renderEmpty();
  });

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    send(input.value);
  });

  // Enter sends, Shift+Enter is a newline — the convention every chat surface uses.
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send(input.value);
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
  });

  thread.addEventListener('click', (event) => {
    const suggestion = event.target.closest('[data-suggest]');
    if (!suggestion) return;
    input.value = suggestion.dataset.suggest;
    input.focus();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) close();
  });

  // A different app is a different set of capabilities, and half a conversation about
  // another target would be misleading rather than merely stale.
  onSelectedApp(() => {
    messages = [];
    if (hasSelection()) renderEmpty();
  });
  renderEmpty();
}
