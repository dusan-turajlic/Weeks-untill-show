"use client";

/*
 * App shell: the hamburger menu, the Projection / Meal-plan tabs, and the
 * clear-data confirm modal — the stable chrome from index.html's <body>. The
 * heavy views are split into their own components. Rendering is gated on
 * `ready` so nothing paints until the client has hydrated state from
 * URL/localStorage/IndexedDB (avoids SSR/client mismatch).
 */

import React, { useEffect, useRef, useState } from "react";
import { AppProvider, useApp } from "@/components/store";
import ProjectionView from "@/components/ProjectionView";
import MealView from "@/components/MealView";
import { BuildProvider } from "@/components/BuildProvider";

function Menu({ onClear }: { onClear: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);
  return (
    <div className="menuWrap" ref={wrapRef}>
      <button
        className="menuBtn"
        type="button"
        aria-label="Menu"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
      </button>
      <div className="menu" role="menu" hidden={!open}>
        <button type="button" className="danger" role="menuitem" onClick={() => { setOpen(false); onClear(); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" /></svg>
          Clear local data
        </button>
      </div>
    </div>
  );
}

function ConfirmClearModal({ open, onCancel, onConfirm }: { open: boolean; onCancel: () => void; onConfirm: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);
  return (
    <div className="modal" hidden={!open} onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
        <h2 id="confirmTitle">Clear local data?</h2>
        <p>This permanently deletes your weight history and settings stored on this device. This can&apos;t be undone.</p>
        <div className="actions">
          <button type="button" className="mbtn cancel" onClick={onCancel}>Cancel</button>
          <button type="button" className="mbtn confirm" onClick={onConfirm}>Clear data</button>
        </div>
      </div>
    </div>
  );
}

function Shell() {
  const app = useApp();
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!app.ready) {
    // Minimal placeholder until client hydration fills real state.
    return <div className="wrap" />;
  }

  const meal = app.tab === "meal";
  return (
    <div className="wrap">
      <Menu onClear={() => setConfirmOpen(true)} />

      <div className="maintabs" role="tablist">
        <button type="button" role="tab" aria-selected={!meal} className={!meal ? "on" : undefined} onClick={() => app.setTab("projection")}>Projection</button>
        <button type="button" role="tab" aria-selected={meal} className={meal ? "on" : undefined} onClick={() => app.setTab("meal")}>Meal plan</button>
      </div>

      <div hidden={meal}><ProjectionView /></div>
      <div hidden={!meal}><MealView /></div>

      <ConfirmClearModal
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => { setConfirmOpen(false); app.clearAllData(); }}
      />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <BuildProvider>
        <Shell />
      </BuildProvider>
    </AppProvider>
  );
}
