/**
 * An ok/cancel any of our surfaces draws itself.
 *
 * No Owlbear modal, and no nesting question to answer: a confirmation is just DOM. That is worth
 * stating because "can we open a dialog from inside a modal" looks like a platform question and is
 * not one here.
 *
 * ## It carries its own styles, which is what let it leave the workspace — 2026-09-13
 *
 * It lived under `workspace/` and drew its buttons with the workspace's `.chip` classes, so it was a
 * shared-looking component that only one page could actually use. The panel needed it — *Clear
 * everything* is the most destructive control in the extension — and the choice was to copy thirty
 * lines of CSS into the second page or to make the component whole. Copied CSS is the thing this
 * project keeps finding at the bottom of its drift bugs.
 *
 * **The colours read the host page's variables with the workspace's own values as fallbacks.** The
 * workspace defines none of `--bg`, `--text` or `--dim`, so it gets exactly the dialog it had; the
 * panel defines all three from Owlbear's theme, so the dialog matches the room a GM is sitting in.
 * One definition, two looks, and neither page has a copy to keep in step.
 *
 * ## Used sparingly, and only where §8 requires it
 *
 * A dialog is a bad way to make a boundary visible — it appears *after* the GM has committed to the
 * gesture, and one that appears often trains them to dismiss it. So the boundary is shown first by
 * disabling what would cross it and saying why; this is the second half, for the deliberate action
 * they went looking for. Two uses, both irreversible: deriving the graph, and discarding it.
 *
 * ## Escape and the way out
 *
 * Cancel is the default: Escape resolves false, and so does clicking the backdrop. The shell's own
 * Escape handler closes the workspace, so this stops the event while it is up — otherwise answering
 * a question about discarding work would also dismiss the sheet.
 */

const HOST_ID = "confirm";
const STYLE_ID = "confirm-style";

/**
 * The dialog's own stylesheet, injected once per page.
 *
 * Every rule is scoped under `#confirm`, so nothing here can reach the page around it — this is a
 * component arriving on a surface it does not own, and the two it arrives on style their buttons
 * completely differently.
 */
const STYLES = `
#confirm {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  background: rgba(6, 7, 16, 0.72);
}
#confirm.reveal {
  place-items: end center;
  background: rgba(6, 7, 16, 0.28);
}
#confirm.reveal .confirm-panel { margin-bottom: 4.5rem; }
#confirm .confirm-panel {
  max-width: 30rem;
  margin: 1rem;
  padding: 1rem 1.15rem;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 0.5rem;
  background: var(--bg, #14162a);
  color: var(--text, #e8e9f5);
  box-shadow: 0 1.5rem 3rem rgba(0, 0, 0, 0.55);
}
#confirm h2 { margin: 0 0 0.5rem; font-size: 0.95rem; }
#confirm p { margin: 0 0 0.6rem; font-size: 0.8rem; line-height: 1.45; color: var(--dim, #c8ccdf); }
#confirm .confirm-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  margin-top: 0.9rem;
}
#confirm .confirm-actions button {
  padding: 0.4rem 0.65rem;
  border-radius: 0.35rem;
  border: 1px solid rgba(187, 153, 255, 0.45);
  background: rgba(34, 26, 58, 0.92);
  color: var(--text, #e8e9f5);
  font: inherit;
  cursor: pointer;
}
#confirm .confirm-actions button:hover { background: #2c2250; }
#confirm .confirm-actions button.destructive {
  border-color: rgba(255, 212, 121, 0.75);
  color: #ffd479;
}
`;

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.append(style);
}

export interface ConfirmOptions {
  readonly title: string;
  /** Paragraphs. Plain text: every caller interpolates counts, and none of them wants markup. */
  readonly body: readonly string[];
  readonly confirmLabel: string;
  /** Marks the confirming button as the destructive one, which is what colours it. */
  readonly destructive?: boolean;
  /**
   * Keep what is behind this legible, because the answer is back there.
   *
   * The regenerate question draws the walls it would destroy **on the map**, and the ordinary
   * backdrop is 72% of near-black over exactly that — so the picture the dialog is pointing at
   * would be the one thing the dialog hid. This lightens the backdrop and moves the panel out
   * of the middle, which is where a map's interesting part usually is.
   *
   * **Not the default**, and the dimming it gives up is doing real work everywhere else: a
   * modal that does not look modal is one a GM answers without reading.
   */
  readonly reveal?: boolean;
}

/**
 * Ask, and resolve to what they chose.
 *
 * Resolves `false` for every way out that is not the confirm button, because the cost of a wrong
 * `false` is one repeated gesture and the cost of a wrong `true` is the GM's work.
 */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  const existing = document.getElementById(HOST_ID);
  // A second dialog while one is up would leave the first unresolved and its promise dangling.
  if (existing) existing.remove();

  ensureStyles();
  return new Promise<boolean>((resolve) => {
    const host = document.createElement("div");
    host.id = HOST_ID;
    // A class rather than inline styles, so the two rules it switches on stay beside the ones they
    // override and a reader of the stylesheet can see the whole of what "reveal" means in one place.
    if (options.reveal) host.classList.add("reveal");

    const panel = document.createElement("div");
    panel.className = "confirm-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");

    const heading = document.createElement("h2");
    heading.textContent = options.title;
    panel.append(heading);

    for (const paragraph of options.body) {
      const p = document.createElement("p");
      // `textContent`, not `innerHTML`: these carry counts and a map's name, and a map's name is
      // GM-editable text from the scene.
      p.textContent = paragraph;
      panel.append(p);
    }

    const actions = document.createElement("div");
    actions.className = "confirm-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";

    const confirm = document.createElement("button");
    confirm.type = "button";
    // Its own class, not the workspace's `chip urgent`: the styles come with the component now.
    if (options.destructive) confirm.className = "destructive";
    confirm.textContent = options.confirmLabel;

    actions.append(cancel, confirm);
    panel.append(actions);
    host.append(panel);

    let settled = false;
    const finish = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener("keydown", onKey, true);
      host.remove();
      resolve(answer);
    };

    function onKey(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      // Captured and stopped: on the workspace the shell closes the whole surface on Escape, and
      // answering a question about discarding work must not also dismiss the sheet. Harmless on a
      // page with no such handler, which is what the panel is.
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(false);
    }

    cancel.addEventListener("click", () => finish(false));
    confirm.addEventListener("click", () => finish(true));
    host.addEventListener("click", (event) => {
      if (event.target === host) finish(false);
    });
    window.addEventListener("keydown", onKey, true);

    document.body.append(host);
    // Focused so Escape and the keyboard reach the dialog rather than whatever was focused behind
    // it, and so the destructive button is not what a stray Return presses.
    cancel.focus();
  });
}
