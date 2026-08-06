/** Open the authenticated server-side native file chooser. */
export async function pickWorkbenchPath({ token, purpose, currentPath = "" }) {
  if (!token) throw new Error("Connect to Motion before choosing a location.");
  const response = await fetch("/workbench/select-path", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ purpose, currentPath })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) {
    const message = body?.error?.message;
    throw new Error(typeof message === "string" && message ? message : "The system file chooser could not be opened.");
  }
  return body.cancelled === true ? null : body.path;
}

/** Read the machine path retained behind a human-facing location display. */
export function readWorkbenchPath(display) {
  return typeof display?.dataset?.path === "string" ? display.dataset.path.trim() : "";
}

/** Show a friendly folder/file name while retaining the exact path for engine calls. */
export function showWorkbenchPath(display, path, emptyLabel = "No location selected", selectedLabel = "") {
  const selected = typeof path === "string" ? path.trim() : "";
  display.dataset.path = selected;
  display.dataset.empty = selected ? "false" : "true";
  display.title = selected;
  if (!selected) {
    display.textContent = emptyLabel;
    return;
  }
  const parts = selected.replace(/[\\/]+$/, "").split(/[\\/]/);
  display.textContent = selectedLabel || parts.at(-1) || selected;
}
