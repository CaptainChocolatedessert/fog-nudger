/**
 * An ok/cancel the workspace draws itself.
 *
 * No Owlbear modal, and no nesting question to answer: the workspace already owns its whole surface
 * and all of its input, so a confirmation is just DOM. That is worth stating because "can we open a
 * dialog from inside a modal" looks like a platform question and is not one here.
 *
 * ## Used sparingly, and only where §8 requires it
 *
 * A dialog is a bad way to make a boundary visible — it appears *after* the GM has committed to the
 * gesture, and one that appears often trains them to dismiss it. So the boundary is shown first by
 * disabling what would cross it and saying why; this is the second half, for the deliberate action
 * they went looking for. Two uses, both irreversible: freezing the graph, and discarding it.
 *
 * ## Escape and the way out
 *
 * Cancel is the default: Escape resolves false, and so does clicking the backdrop. The shell's own
 * Escape handler closes the workspace, so this stops the event while it is up — otherwise answering
 * a question about discarding work would also dismiss the sheet.
 */

const HOST_ID = "confirm";

export interface ConfirmOptions {
  readonly title: string;
  /** Paragraphs. Plain text: every caller interpolates counts, and none of them wants markup. */
  readonly body: readonly string[];
  readonly confirmLabel: string;
  /** Marks the confirming button as the destructive one, which is what colours it. */
  readonly destructive?: boolean;
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

  return new Promise<boolean>((resolve) => {
    const host = document.createElement("div");
    host.id = HOST_ID;

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
    cancel.className = "chip";
    cancel.textContent = "Cancel";

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = options.destructive ? "chip urgent" : "chip";
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
      // Captured and stopped: the shell closes the workspace on Escape, and answering a question
      // about discarding work must not also dismiss the sheet.
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
