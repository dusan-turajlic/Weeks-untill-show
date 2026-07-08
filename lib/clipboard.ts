/*
 * Clipboard copy with a legacy fallback — ported from index.html's
 * copyText()/legacyCopy(). Client-only (uses navigator/document).
 */
export function copyText(text: string, done: (ok: boolean) => void): void {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => done(true),
      () => legacyCopy(text, done)
    );
  } else {
    legacyCopy(text, done);
  }
}

function legacyCopy(text: string, done: (ok: boolean) => void): void {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    done(ok);
  } catch {
    done(false);
  }
}
