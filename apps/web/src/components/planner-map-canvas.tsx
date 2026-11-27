'use client';

import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import { useEffect, useRef } from 'react';
import L from 'leaflet';
// Registers L.markerClusterGroup on the Leaflet global, which `leaflet` (imported above) sets.
import 'leaflet.markercluster';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import type { LatLng, MapPin } from '@mps/db/queries';
import { customerHref } from '@/components/customers';
import { deviceHref } from '@/lib/device-origin';
import { OSM_ATTRIBUTION, OSM_TILES, boardColumnText, pinDueText, pinTone, type Box, type PinTone } from '@/lib/planner-map';

/**
 * The Leaflet half of the PM map (client-only, loaded with `next/dynamic` and `ssr: false`): OSM
 * tiles, clustered PM pins, the engineers' calls as blue spanner markers, the `nearMiles` ring round the
 * picked call and the box-select rectangle. Pins are drawn locally; only tile requests leave the
 * browser, and they carry the viewport, never a customer.
 */

const BACK = '/pm/planner';
const METRES_PER_MILE = 1609.344;
/** Roughly the UK, until the pins are fitted. */
const START: [number, number] = [53.5, -2];
const RING = '#2563eb';

export interface MapCall {
  workUnitId: number;
  at: LatLng;
  label: string;
}

/** A single-machine action from a pin's popup. */
export type PinAction =
  | { kind: 'add'; id: number }
  | { kind: 'priority'; id: number; on: boolean }
  | { kind: 'dismiss'; id: number }
  | { kind: 'details'; id: number }
  | { kind: 'copy'; serial: string };

export interface PlannerMapCanvasProps {
  pins: MapPin[];
  /** DRMS device id per Vantage equipment id, for the popup's device link. */
  deviceIds: Record<number, string>;
  selected: ReadonlySet<number>;
  calls: MapCall[];
  pickedCallId: number | null;
  /** Fly to this call (its ring in view); `n` changes on every pick so picking it again flies again. */
  focus: { at: LatLng; n: number } | null;
  nearMiles: number;
  /** "Select area" is on: a plain drag draws a box. Shift+drag always does. */
  boxMode: boolean;
  onBox: (box: Box) => void;
  onPickCall: (workUnitId: number) => void;
  onPinAction: (action: PinAction) => void;
}

const TONE_CLASS: Record<PinTone, string> = {
  overdue: 'text-critical',
  due_soon: 'text-warn',
  when_in_area: 'text-muted-foreground/70',
  other: 'text-muted-foreground',
};

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);

function pinIcon(p: MapPin, selected: boolean): L.DivIcon {
  const tone = TONE_CLASS[pinTone(p)];
  // Outline: on the board. Hollow: approximate (district centre). Selected: brand outline.
  const ring = [p.boardColumn !== null ? 'ring-2 ring-foreground' : '', selected ? 'outline-2 outline-offset-2 outline-brand' : ''].join(' ');
  const shape = p.priority
    ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="${p.approximate ? 'var(--card)' : 'currentColor'}" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/></svg>`
    : `<span class="block size-3.5 rounded-full border-[3px] border-current ${p.approximate ? 'bg-card' : 'bg-current'}"></span>`;
  return L.divIcon({
    className: 'mps-map-pin',
    html: `<span class="flex size-[18px] items-center justify-center rounded-full ${tone} ${ring}">${shape}</span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -8],
  });
}

function callIcon(picked: boolean): L.DivIcon {
  return L.divIcon({
    className: 'mps-map-call',
    // A spanner in a blue disc (lucide "wrench" path), so calls read as engineer visits, not machines.
    html: `<span class="flex ${picked ? 'size-6 ring-2 ring-blue-300' : 'size-5'} items-center justify-center rounded-full border-2 border-white bg-blue-600 text-white shadow"><svg viewBox="0 0 24 24" class="${picked ? 'size-3.5' : 'size-3'}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg></span>`,
    iconSize: picked ? [24, 24] : [20, 20],
    iconAnchor: picked ? [12, 12] : [10, 10],
  });
}

function popupHtml(p: MapPin, drmsId: string | undefined): string {
  const lines: string[] = [`<strong>${esc(p.customerName ?? 'Unknown customer')}</strong>`];
  if (p.town) lines.push(esc(p.town));
  const machine = [p.model, p.serial].filter(Boolean).join(' · ');
  if (machine) lines.push(esc(machine));
  lines.push(esc(pinDueText(p)) + (p.priority ? ' · Priority' : ''));
  const column = boardColumnText(p.boardColumn);
  if (column) lines.push(`On the board: <strong>${esc(column)}</strong>`);
  if (p.approximate) lines.push('<em>approximate — district centre</em>');
  const links: string[] = [];
  if (drmsId) links.push(`<a href="${esc(deviceHref(drmsId, 'pm-planner', BACK))}">Device page</a>`);
  if (p.customerId !== null) links.push(`<a href="${esc(customerHref(p.customerId))}">Customer page</a>`);
  if (links.length) lines.push(links.join(' · '));
  const id = p.vantageEquipmentId;
  const btn = 'inline-flex h-7 items-center gap-1 rounded-md border border-line bg-card px-2 text-[12px] font-medium hover:bg-muted disabled:opacity-60 disabled:hover:bg-card';
  const onPlan = p.boardColumn !== null;
  const actions =
    `<div class="mt-2 flex flex-wrap gap-1.5">` +
    `<button type="button" class="${btn}" data-map-act="add" data-id="${id}"${onPlan ? ' disabled' : ''}>${onPlan ? 'On plan' : 'Add to plan'}</button>` +
    `<button type="button" class="${btn}" data-map-act="priority" data-id="${id}" data-on="${p.priority ? 'false' : 'true'}" aria-pressed="${p.priority}">` +
    `<span class="${p.priority ? 'text-critical' : 'text-muted-foreground'}" aria-hidden="true">${p.priority ? '★' : '☆'}</span> Priority</button>` +
    (p.serial
      ? `<button type="button" class="${btn}" data-map-act="copy" data-id="${id}" data-serial="${esc(p.serial)}" aria-label="Copy serial ${esc(p.serial)}">Copy serial</button>`
      : '') +
    `<button type="button" class="${btn}" data-map-act="dismiss" data-id="${id}">Dismiss</button>` +
    `<button type="button" class="${btn}" data-map-act="details" data-id="${id}">Device details</button>` +
    `</div>`;
  return `<div class="text-[13px] leading-snug">${lines.join('<br>')}${actions}</div>`;
}

/** Clustered PM pins. Rebuilt when the pins change; only icons change when the selection does. */
function PinLayer({ pins, deviceIds, selected }: Pick<PlannerMapCanvasProps, 'pins' | 'deviceIds' | 'selected'>) {
  const map = useMap();
  const markers = useRef(new Map<number, { marker: L.Marker; pin: MapPin; selected: boolean }>());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const fitted = useRef(false);

  useEffect(() => {
    const group = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 50 });
    const byId = new Map<number, { marker: L.Marker; pin: MapPin; selected: boolean }>();
    for (const p of pins) {
      const isSel = selectedRef.current.has(p.vantageEquipmentId);
      const marker = L.marker([p.at.lat, p.at.lng], { icon: pinIcon(p, isSel), keyboard: true, title: p.customerName ?? '' });
      marker.bindPopup(() => popupHtml(p, deviceIds[p.vantageEquipmentId]));
      group.addLayer(marker);
      byId.set(p.vantageEquipmentId, { marker, pin: p, selected: isSel });
    }
    map.addLayer(group);
    markers.current = byId;
    // Fit to the pins on the first load only: a refresh after an action keeps the user's view.
    if (!fitted.current && pins.length > 0) {
      fitted.current = true;
      map.fitBounds(L.latLngBounds(pins.map((p) => [p.at.lat, p.at.lng] as [number, number])), { padding: [24, 24], maxZoom: 12 });
    }
    return () => {
      map.removeLayer(group);
    };
  }, [map, pins, deviceIds]);

  useEffect(() => {
    for (const [id, m] of markers.current) {
      const isSel = selected.has(id);
      if (isSel !== m.selected) {
        m.marker.setIcon(pinIcon(m.pin, isSel));
        m.selected = isSel;
      }
    }
  }, [selected]);

  return null;
}

/** The day's located calls as blue spanner markers, and the ring round the picked one. */
function CallLayer({ calls, pickedCallId, focus, nearMiles, onPickCall }: Pick<PlannerMapCanvasProps, 'calls' | 'pickedCallId' | 'focus' | 'nearMiles' | 'onPickCall'>) {
  const map = useMap();
  const onPick = useRef(onPickCall);
  onPick.current = onPickCall;

  useEffect(() => {
    const layer = L.layerGroup();
    for (const c of calls) {
      const picked = c.workUnitId === pickedCallId;
      const marker = L.marker([c.at.lat, c.at.lng], { icon: callIcon(picked), zIndexOffset: picked ? 1000 : 500, title: c.label });
      marker.bindTooltip(esc(c.label), { direction: 'top', offset: [0, -8] });
      marker.on('click', () => onPick.current(c.workUnitId));
      layer.addLayer(marker);
      if (picked) {
        L.circle([c.at.lat, c.at.lng], { radius: nearMiles * METRES_PER_MILE, color: RING, weight: 1.5, fillOpacity: 0.06, interactive: false }).addTo(layer);
      }
    }
    layer.addTo(map);
    return () => {
      map.removeLayer(layer);
    };
  }, [map, calls, pickedCallId, nearMiles]);

  const miles = useRef(nearMiles);
  miles.current = nearMiles;
  useEffect(() => {
    // The whole ring in view (its square, with a little room round it). Only a new pick flies.
    if (focus) map.flyToBounds(L.latLng(focus.at.lat, focus.at.lng).toBounds(miles.current * METRES_PER_MILE * 2.2), { duration: 0.6 });
  }, [map, focus]);

  return null;
}

/**
 * Box select: in "Select area" mode, or with Shift held, a drag draws a rectangle instead of
 * panning; on release the pins inside it are reported. Leaflet's own Shift box-zoom is off.
 */
function BoxSelect({ boxMode, onBox }: Pick<PlannerMapCanvasProps, 'boxMode' | 'onBox'>) {
  const map = useMap();
  const modeRef = useRef(boxMode);
  modeRef.current = boxMode;
  const onBoxRef = useRef(onBox);
  onBoxRef.current = onBox;

  useEffect(() => {
    map.getContainer().style.cursor = boxMode ? 'crosshair' : '';
  }, [map, boxMode]);

  useEffect(() => {
    const container = map.getContainer();
    let start: { latlng: L.LatLng; x: number; y: number } | null = null;
    let rect: L.Rectangle | null = null;

    const move = (e: MouseEvent) => {
      if (!start) return;
      const bounds = L.latLngBounds(start.latlng, map.mouseEventToLatLng(e));
      if (rect) rect.setBounds(bounds);
      else rect = L.rectangle(bounds, { color: RING, weight: 1, dashArray: '4 3', fillOpacity: 0.08, interactive: false }).addTo(map);
    };
    const up = (e: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      map.dragging.enable();
      if (rect) {
        rect.remove();
        rect = null;
      }
      if (!start) return;
      const s = start;
      start = null;
      if (Math.abs(e.clientX - s.x) < 4 && Math.abs(e.clientY - s.y) < 4) return;
      const b = L.latLngBounds(s.latlng, map.mouseEventToLatLng(e));
      onBoxRef.current({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() });
    };
    const down = (e: MouseEvent) => {
      if (e.button !== 0 || !(modeRef.current || e.shiftKey)) return;
      // Capture phase: keep Leaflet's drag (and marker clicks) from seeing this press.
      e.stopPropagation();
      e.preventDefault();
      map.dragging.disable();
      start = { latlng: map.mouseEventToLatLng(e), x: e.clientX, y: e.clientY };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    };
    container.addEventListener('mousedown', down, true);
    return () => {
      container.removeEventListener('mousedown', down, true);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      rect?.remove();
      map.dragging.enable();
    };
  }, [map]);

  return null;
}

/**
 * The popups' Add to plan / Priority / Copy serial / Dismiss / Device details buttons. Leaflet stops clicks inside a popup from bubbling,
 * so one capture-phase listener on the map container picks them up by their data attributes.
 */
function PopupActions({ onPinAction }: Pick<PlannerMapCanvasProps, 'onPinAction'>) {
  const map = useMap();
  const onAction = useRef(onPinAction);
  onAction.current = onPinAction;

  useEffect(() => {
    const container = map.getContainer();
    const click = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target.closest<HTMLButtonElement>('button[data-map-act]') : null;
      if (!el || el.disabled) return;
      const id = Number(el.dataset.id);
      if (!Number.isSafeInteger(id) || id <= 0) return;
      e.preventDefault();
      // Copy, Dismiss (which opens a dialog) and Device details (the side panel) can be used again, so they stay enabled.
      if (el.dataset.mapAct === 'copy') {
        if (el.dataset.serial) onAction.current({ kind: 'copy', serial: el.dataset.serial });
        return;
      }
      if (el.dataset.mapAct === 'dismiss' || el.dataset.mapAct === 'details') {
        onAction.current({ kind: el.dataset.mapAct, id });
        return;
      }
      el.disabled = true;
      if (el.dataset.mapAct === 'add') onAction.current({ kind: 'add', id });
      else if (el.dataset.mapAct === 'priority') onAction.current({ kind: 'priority', id, on: el.dataset.on === 'true' });
    };
    container.addEventListener('click', click, true);
    return () => container.removeEventListener('click', click, true);
  }, [map]);

  return null;
}

export function PlannerMapCanvas(props: PlannerMapCanvasProps) {
  return (
    <MapContainer center={START} zoom={6} boxZoom={false} className="size-full" aria-label="PM map">
      <TileLayer url={OSM_TILES} attribution={OSM_ATTRIBUTION} maxZoom={19} />
      <PinLayer pins={props.pins} deviceIds={props.deviceIds} selected={props.selected} />
      <CallLayer
        calls={props.calls}
        pickedCallId={props.pickedCallId}
        focus={props.focus}
        nearMiles={props.nearMiles}
        onPickCall={props.onPickCall}
      />
      <BoxSelect boxMode={props.boxMode} onBox={props.onBox} />
      <PopupActions onPinAction={props.onPinAction} />
    </MapContainer>
  );
}

export default PlannerMapCanvas;
