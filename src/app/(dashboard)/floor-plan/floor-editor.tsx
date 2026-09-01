'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Armchair,
  Circle,
  Copy,
  DoorOpen,
  Flower2,
  Minus,
  Plus,
  RectangleHorizontal,
  RotateCw,
  Save,
  Trash2,
  Type,
  Undo2,
  Wine,
} from 'lucide-react';
import { saveFloorPlan, type ZonePayload } from '@/app/floor-actions';
import { FLOOR_H, FLOOR_W, type ElementKind, type TableShape } from '@/lib/types';

type TableDraft = ZonePayload['tables'][number];
type ElementDraft = ZonePayload['elements'][number];
type ZoneDraft = ZonePayload;

type Sel = { kind: 'table' | 'element'; id: string } | null;
type Drag = {
  mode: 'move' | 'resize';
  kind: 'table' | 'element';
  id: string;
  dx: number;
  dy: number;
};

const SNAP = 10;
const snap = (v: number) => Math.round(v / SNAP) * SNAP;
const uid = () => crypto.randomUUID();

const ELEMENT_DEFAULTS: Record<ElementKind, { w: number; h: number }> = {
  wall: { w: 220, h: 12 },
  bar: { w: 240, h: 70 },
  door: { w: 70, h: 14 },
  plant: { w: 40, h: 40 },
  label: { w: 140, h: 32 },
};

export default function FloorEditor({
  initialZones,
  labels,
}: {
  initialZones: ZoneDraft[];
  labels: Record<string, string>;
}) {
  const router = useRouter();
  const [zones, setZones] = useState<ZoneDraft[]>(() =>
    initialZones.length
      ? initialZones
      : [{ id: uid(), name: `${labels.zone} 1`, sort: 0, tables: [], elements: [] }]
  );
  const [zi, setZi] = useState(0);
  const [sel, setSel] = useState<Sel>(null);
  const [history, setHistory] = useState<ZoneDraft[][]>([]);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<'saved' | 'error' | null>(null);
  const [errMsg, setErrMsg] = useState('');
  const dragRef = useRef<Drag | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const zone = zones[Math.min(zi, zones.length - 1)];

  const pushHistory = useCallback(() => {
    setHistory((h) => [...h.slice(-49), structuredClone(zones)]);
  }, [zones]);

  const undo = () => {
    setHistory((h) => {
      if (!h.length) return h;
      setZones(h[h.length - 1]);
      setSel(null);
      return h.slice(0, -1);
    });
  };

  const mutateZone = (fn: (z: ZoneDraft) => void) => {
    setZones((zs) => {
      const next = zs.slice();
      const z = structuredClone(next[zi]);
      fn(z);
      next[zi] = z;
      return next;
    });
  };

  // --- creation -----------------------------------------------------------
  const nextTableName = () => {
    const nums = zones
      .flatMap((z) => z.tables)
      .map((t) => parseInt(t.name, 10))
      .filter((n) => Number.isFinite(n));
    return String((nums.length ? Math.max(...nums) : 0) + 1);
  };

  const addTable = (shape: TableShape) => {
    pushHistory();
    const t: TableDraft = {
      id: uid(),
      name: nextTableName(),
      seats: shape === 'round' ? 4 : 2,
      shape,
      x: snap(120 + (zone.tables.length % 6) * 110),
      y: snap(120 + Math.floor(zone.tables.length / 6) * 110),
      w: 80,
      h: 80,
      rotation: 0,
      combinable_group: null,
    };
    mutateZone((z) => z.tables.push(t));
    setSel({ kind: 'table', id: t.id });
  };

  const addElement = (kind: ElementKind) => {
    pushHistory();
    const d = ELEMENT_DEFAULTS[kind];
    const el: ElementDraft = {
      id: uid(),
      kind,
      label: kind === 'label' ? labels.text : kind === 'bar' ? labels.bar : null,
      x: snap(400),
      y: snap(80),
      w: d.w,
      h: d.h,
      rotation: 0,
    };
    mutateZone((z) => z.elements.push(el));
    setSel({ kind: 'element', id: el.id });
  };

  // --- selection helpers --------------------------------------------------
  const selTable = sel?.kind === 'table' ? zone.tables.find((t) => t.id === sel.id) : undefined;
  const selElement =
    sel?.kind === 'element' ? zone.elements.find((e) => e.id === sel.id) : undefined;

  const updateSel = (patch: Partial<TableDraft & ElementDraft>, withHistory = false) => {
    if (!sel) return;
    if (withHistory) pushHistory();
    mutateZone((z) => {
      const item =
        sel.kind === 'table'
          ? z.tables.find((t) => t.id === sel.id)
          : z.elements.find((e) => e.id === sel.id);
      if (item) Object.assign(item, patch);
    });
  };

  const deleteSel = () => {
    if (!sel) return;
    pushHistory();
    mutateZone((z) => {
      if (sel.kind === 'table') z.tables = z.tables.filter((t) => t.id !== sel.id);
      else z.elements = z.elements.filter((e) => e.id !== sel.id);
    });
    setSel(null);
  };

  const duplicateSel = () => {
    if (!sel) return;
    pushHistory();
    mutateZone((z) => {
      if (sel.kind === 'table') {
        const t = z.tables.find((x) => x.id === sel.id);
        if (t) {
          const copy = { ...t, id: uid(), name: nextTableName(), x: t.x + 30, y: t.y + 30 };
          z.tables.push(copy);
          setSel({ kind: 'table', id: copy.id });
        }
      } else {
        const e = z.elements.find((x) => x.id === sel.id);
        if (e) {
          const copy = { ...e, id: uid(), x: e.x + 30, y: e.y + 30 };
          z.elements.push(copy);
          setSel({ kind: 'element', id: copy.id });
        }
      }
    });
  };

  // --- pointer interactions ----------------------------------------------
  const toSvg = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) * FLOOR_W) / r.width,
      y: ((e.clientY - r.top) * FLOOR_H) / r.height,
    };
  };

  const startDrag = (
    e: React.PointerEvent,
    kind: 'table' | 'element',
    id: string,
    mode: 'move' | 'resize'
  ) => {
    e.stopPropagation();
    const p = toSvg(e);
    const item =
      kind === 'table'
        ? zone.tables.find((t) => t.id === id)
        : zone.elements.find((el) => el.id === id);
    if (!item) return;
    pushHistory();
    dragRef.current =
      mode === 'move'
        ? { mode, kind, id, dx: p.x - item.x, dy: p.y - item.y }
        : { mode, kind, id, dx: item.x, dy: item.y };
    setSel({ kind, id });
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const p = toSvg(e);
    mutateZone((z) => {
      const item =
        d.kind === 'table'
          ? z.tables.find((t) => t.id === d.id)
          : z.elements.find((el) => el.id === d.id);
      if (!item) return;
      if (d.mode === 'move') {
        item.x = snap(Math.min(FLOOR_W - item.w, Math.max(0, p.x - d.dx)));
        item.y = snap(Math.min(FLOOR_H - item.h, Math.max(0, p.y - d.dy)));
      } else {
        const linear =
          d.kind === 'element' &&
          'kind' in item &&
          (item.kind === 'wall' || item.kind === 'door');
        item.w = snap(Math.min(FLOOR_W - item.x, Math.max(30, p.x - item.x)));
        if (linear) {
          // Length-only: thickness always resets to the element's default,
          // which also heals walls/doors stretched before this fix.
          item.h = ELEMENT_DEFAULTS[(item as ElementDraft).kind].h;
        } else {
          item.h = snap(
            Math.min(FLOOR_H - item.y, Math.max(d.kind === 'element' ? 6 : 30, p.y - item.y))
          );
        }
      }
    });
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  // --- zones --------------------------------------------------------------
  const addZone = () => {
    pushHistory();
    const z: ZoneDraft = {
      id: uid(),
      name: `${labels.zone} ${zones.length + 1}`,
      sort: zones.length,
      tables: [],
      elements: [],
    };
    setZones((zs) => [...zs, z]);
    setZi(zones.length);
    setSel(null);
  };

  const deleteZone = () => {
    if (zones.length <= 1 || zone.tables.length || zone.elements.length) return;
    pushHistory();
    setZones((zs) => zs.filter((_, i) => i !== zi));
    setZi(0);
    setSel(null);
  };

  // --- save ---------------------------------------------------------------
  const save = async () => {
    setSaving(true);
    setFlash(null);
    const res = await saveFloorPlan(zones.map((z, i) => ({ ...z, sort: i })));
    setSaving(false);
    if (res.error) {
      setErrMsg(res.error);
      setFlash('error');
    } else {
      setFlash('saved');
      setTimeout(() => setFlash(null), 2500);
      router.refresh();
    }
  };

  // --- rendering ----------------------------------------------------------
  const toolBtn =
    'flex min-h-11 items-center gap-1.5 rounded-lg border border-linen bg-white px-3 py-2 text-xs font-semibold text-espresso/70 transition hover:border-caramel hover:text-espresso active:scale-95';
  const input =
    'w-full rounded-lg border border-linen bg-white px-2.5 py-2 text-sm text-espresso focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/30';

  return (
    <div>
      {/* zone tabs */}
      <div className="flex flex-wrap items-center gap-2">
        {zones.map((z, i) => (
          <button
            key={z.id}
            onClick={() => {
              setZi(i);
              setSel(null);
            }}
            className={`min-h-9 rounded-full px-4 py-1.5 text-sm font-medium transition ${
              i === zi ? 'bg-espresso text-cream shadow-card' : 'bg-white text-espresso/60 border border-linen hover:text-espresso'
            }`}
          >
            {z.name}
          </button>
        ))}
        <button onClick={addZone} aria-label={labels.addZone} className={toolBtn}>
          <Plus size={14} aria-hidden /> {labels.addZone}
        </button>
      </div>

      {/* toolbar */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button onClick={() => addTable('rect')} className={toolBtn}>
          <RectangleHorizontal size={14} aria-hidden /> {labels.addTable}
        </button>
        <button onClick={() => addTable('round')} className={toolBtn}>
          <Circle size={14} aria-hidden /> {labels.addRound}
        </button>
        <span aria-hidden className="mx-1 h-6 w-px bg-linen" />
        <button onClick={() => addElement('wall')} className={toolBtn}>
          <Minus size={14} aria-hidden /> {labels.wall}
        </button>
        <button onClick={() => addElement('bar')} className={toolBtn}>
          <Wine size={14} aria-hidden /> {labels.bar}
        </button>
        <button onClick={() => addElement('door')} className={toolBtn}>
          <DoorOpen size={14} aria-hidden /> {labels.door}
        </button>
        <button onClick={() => addElement('plant')} className={toolBtn}>
          <Flower2 size={14} aria-hidden /> {labels.plant}
        </button>
        <button onClick={() => addElement('label')} className={toolBtn}>
          <Type size={14} aria-hidden /> {labels.label}
        </button>
        <span aria-hidden className="mx-1 h-6 w-px bg-linen" />
        <button onClick={undo} disabled={!history.length} className={`${toolBtn} disabled:opacity-40`}>
          <Undo2 size={14} aria-hidden /> {labels.undo}
        </button>
        <button
          onClick={save}
          disabled={saving}
          className="ml-auto flex min-h-11 items-center gap-1.5 rounded-lg bg-espresso px-5 py-2 text-sm font-semibold text-cream transition hover:bg-terracotta active:scale-[0.98] disabled:opacity-50"
        >
          <Save size={15} aria-hidden />
          {labels.save}
        </button>
      </div>

      {flash === 'saved' && (
        <p className="mt-3 rounded-lg bg-leaf/10 px-4 py-2.5 text-sm text-leaf">{labels.saved}</p>
      )}
      {flash === 'error' && (
        <p role="alert" className="mt-3 rounded-lg bg-wine/10 px-4 py-2.5 text-sm text-wine">
          {errMsg}
        </p>
      )}

      {/* canvas */}
      <div className="mt-4 overflow-x-auto rounded-2xl border border-linen bg-white p-3 shadow-card">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${FLOOR_W} ${FLOOR_H}`}
          className="h-auto w-full min-w-175 cursor-default touch-none select-none rounded-xl"
          onPointerMove={onMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
          onPointerDown={() => setSel(null)}
        >
          <defs>
            <pattern id="tf-grid" width="50" height="50" patternUnits="userSpaceOnUse">
              <path d="M 50 0 L 0 0 0 50" fill="none" stroke="#ede8dc" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width={FLOOR_W} height={FLOOR_H} fill="#faf7ee" />
          <rect width={FLOOR_W} height={FLOOR_H} fill="url(#tf-grid)" />

          {zone.elements.map((el) => (
            <g
              key={el.id}
              transform={`translate(${el.x} ${el.y}) rotate(${el.rotation} ${el.w / 2} ${el.h / 2})`}
              onPointerDown={(e) => startDrag(e, 'element', el.id, 'move')}
              className="cursor-move"
            >
              {(el.kind === 'wall' || el.kind === 'door') && (
                <rect
                  x={-8}
                  y={el.h / 2 - 16}
                  width={el.w + 16}
                  height={32}
                  fill="transparent"
                />
              )}
              {el.kind === 'wall' && <rect width={el.w} height={el.h} rx={3} fill="#d6cbb2" />}
              {el.kind === 'bar' && (
                <>
                  <rect width={el.w} height={el.h} rx={10} fill="#ede8dc" stroke="#c9954a" strokeWidth={2} />
                  <text x={el.w / 2} y={el.h / 2 + 4} textAnchor="middle" fontSize={14} fill="#6b5f4b" fontWeight={600}>
                    {el.label ?? ''}
                  </text>
                </>
              )}
              {el.kind === 'door' && <rect width={el.w} height={el.h} rx={4} fill="#c9954a" />}
              {el.kind === 'plant' && (
                <>
                  <circle cx={el.w / 2} cy={el.h / 2} r={Math.min(el.w, el.h) / 2} fill="#4a7c4e" opacity={0.25} />
                  <circle cx={el.w / 2} cy={el.h / 2} r={Math.min(el.w, el.h) / 4} fill="#4a7c4e" opacity={0.6} />
                </>
              )}
              {el.kind === 'label' && (
                <>
                  <rect width={el.w} height={el.h} fill="transparent" />
                  <text x={el.w / 2} y={el.h / 2 + 5} textAnchor="middle" fontSize={16} fill="#8a7f6a" fontWeight={600} letterSpacing={1}>
                    {el.label ?? ''}
                  </text>
                </>
              )}
              {sel?.kind === 'element' && sel.id === el.id && (
                <>
                  <rect
                    x={-4}
                    y={-4}
                    width={el.w + 8}
                    height={el.h + 8}
                    fill="none"
                    stroke="#8c4225"
                    strokeWidth={2}
                    strokeDasharray="6 4"
                    rx={6}
                  />
                  {el.kind === 'wall' || el.kind === 'door' ? (
                    <rect
                      x={el.w - 4}
                      y={el.h / 2 - 11}
                      width={14}
                      height={22}
                      rx={4}
                      fill="#8c4225"
                      className="cursor-ew-resize"
                      onPointerDown={(e) => startDrag(e, 'element', el.id, 'resize')}
                    />
                  ) : (
                    <rect
                      x={el.w - 6}
                      y={el.h - 6}
                      width={14}
                      height={14}
                      rx={3}
                      fill="#8c4225"
                      className="cursor-nwse-resize"
                      onPointerDown={(e) => startDrag(e, 'element', el.id, 'resize')}
                    />
                  )}
                </>
              )}
            </g>
          ))}

          {zone.tables.map((t) => {
            const selected = sel?.kind === 'table' && sel.id === t.id;
            return (
              <g
                key={t.id}
                transform={`translate(${t.x} ${t.y}) rotate(${t.rotation} ${t.w / 2} ${t.h / 2})`}
                onPointerDown={(e) => startDrag(e, 'table', t.id, 'move')}
                className="cursor-move"
              >
                {t.shape === 'round' ? (
                  <ellipse
                    cx={t.w / 2}
                    cy={t.h / 2}
                    rx={t.w / 2}
                    ry={t.h / 2}
                    fill="#fff"
                    stroke={selected ? '#8c4225' : '#b8ab8d'}
                    strokeWidth={selected ? 3 : 2}
                  />
                ) : (
                  <rect
                    width={t.w}
                    height={t.h}
                    rx={12}
                    fill="#fff"
                    stroke={selected ? '#8c4225' : '#b8ab8d'}
                    strokeWidth={selected ? 3 : 2}
                  />
                )}
                <text
                  x={t.w / 2}
                  y={t.h / 2 - 2}
                  textAnchor="middle"
                  fontSize={17}
                  fontWeight={700}
                  fill="#1a1208"
                >
                  {t.name}
                </text>
                <text x={t.w / 2} y={t.h / 2 + 16} textAnchor="middle" fontSize={11} fill="#8a7f6a">
                  ⛁ {t.seats}
                </text>
                {t.combinable_group && (
                  <circle cx={10} cy={10} r={5} fill="#c9954a">
                    <title>{t.combinable_group}</title>
                  </circle>
                )}
                {selected && (
                  <rect
                    x={t.w - 6}
                    y={t.h - 6}
                    width={14}
                    height={14}
                    rx={3}
                    fill="#8c4225"
                    className="cursor-nwse-resize"
                    onPointerDown={(e) => startDrag(e, 'table', t.id, 'resize')}
                  />
                )}
              </g>
            );
          })}

          {zone.tables.length === 0 && zone.elements.length === 0 && (
            <text x={FLOOR_W / 2} y={FLOOR_H / 2} textAnchor="middle" fontSize={20} fill="#b8ab8d">
              {labels.empty}
            </text>
          )}
        </svg>
      </div>

      {/* inspector */}
      <div className="mt-4 grid gap-4 sm:grid-cols-[2fr_1fr]">
        <div className="rounded-2xl border border-linen bg-white p-5 shadow-card">
          {selTable ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <label className="mb-1 block text-xs font-semibold text-espresso/60">{labels.name}</label>
                <input
                  value={selTable.name}
                  onChange={(e) => updateSel({ name: e.target.value })}
                  className={input}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-espresso/60">{labels.seats}</label>
                <div className="flex items-center gap-1.5">
                  <button
                    aria-label="-"
                    onClick={() => updateSel({ seats: Math.max(1, selTable.seats - 1) }, true)}
                    className="flex h-9 w-9 items-center justify-center rounded-lg border border-linen text-espresso/60 hover:border-caramel"
                  >
                    <Minus size={14} aria-hidden />
                  </button>
                  <span className="tabular w-8 text-center text-sm font-semibold text-espresso">
                    {selTable.seats}
                  </span>
                  <button
                    aria-label="+"
                    onClick={() => updateSel({ seats: Math.min(30, selTable.seats + 1) }, true)}
                    className="flex h-9 w-9 items-center justify-center rounded-lg border border-linen text-espresso/60 hover:border-caramel"
                  >
                    <Plus size={14} aria-hidden />
                  </button>
                </div>
              </div>
              <div className="col-span-2">
                <label className="mb-1 block text-xs font-semibold text-espresso/60">
                  {labels.group}
                </label>
                <input
                  value={selTable.combinable_group ?? ''}
                  onChange={(e) => updateSel({ combinable_group: e.target.value || null })}
                  placeholder="A"
                  className={input}
                />
                <p className="mt-1 text-[11px] text-espresso/50">{labels.groupHint}</p>
              </div>
            </div>
          ) : selElement ? (
            <div className="grid grid-cols-2 gap-3">
              {(selElement.kind === 'label' || selElement.kind === 'bar') && (
                <div className="col-span-2">
                  <label className="mb-1 block text-xs font-semibold text-espresso/60">
                    {labels.text}
                  </label>
                  <input
                    value={selElement.label ?? ''}
                    onChange={(e) => updateSel({ label: e.target.value })}
                    className={input}
                  />
                </div>
              )}
              <p className="col-span-2 text-xs text-espresso/50">
                {labels[selElement.kind] ?? selElement.kind}
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-3 text-sm text-espresso/50">
              <Armchair size={18} aria-hidden className="text-caramel" />
              {labels.empty}
            </div>
          )}
        </div>

        <div className="flex flex-wrap content-start items-start gap-2 rounded-2xl border border-linen bg-white p-5 shadow-card">
          <button onClick={() => sel && updateSel({ rotation: ((selTable ?? selElement)!.rotation + 45) % 360 }, true)} disabled={!sel} className={`${toolBtn} disabled:opacity-40`}>
            <RotateCw size={14} aria-hidden /> {labels.rotate}
          </button>
          <button onClick={duplicateSel} disabled={!sel} className={`${toolBtn} disabled:opacity-40`}>
            <Copy size={14} aria-hidden /> {labels.duplicate}
          </button>
          <button
            onClick={deleteSel}
            disabled={!sel}
            className="flex min-h-11 items-center gap-1.5 rounded-lg border border-wine/30 bg-white px-3 py-2 text-xs font-semibold text-wine transition hover:bg-wine/10 active:scale-95 disabled:opacity-40"
          >
            <Trash2 size={14} aria-hidden /> {labels.delete}
          </button>
          <button
            onClick={deleteZone}
            disabled={zones.length <= 1 || zone.tables.length > 0 || zone.elements.length > 0}
            className="flex min-h-11 items-center gap-1.5 rounded-lg border border-linen bg-white px-3 py-2 text-xs font-semibold text-espresso/50 transition hover:text-wine active:scale-95 disabled:opacity-40"
          >
            <Trash2 size={14} aria-hidden /> {labels.deleteZone}
          </button>
          <div className="w-full">
            <label className="mb-1 block text-xs font-semibold text-espresso/60">
              {labels.zoneName}
            </label>
            <input
              value={zone.name}
              onChange={(e) =>
                setZones((zs) => {
                  const next = zs.slice();
                  next[zi] = { ...next[zi], name: e.target.value };
                  return next;
                })
              }
              className={input}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
